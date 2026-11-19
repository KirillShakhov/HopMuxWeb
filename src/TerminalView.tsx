import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AlertTriangle, ExternalLink, Minus, RefreshCw, Square, Terminal } from 'lucide-react';
import { api, json, stateLabel, type HostKeyWarning, type Model, type Session, type Theme, type UiSettings } from './lib';
import { useVault } from './VaultView';

const lightAnsi = {
  black: '#242638', red: '#a82936', green: '#087345', yellow: '#805900',
  blue: '#2449bc', magenta: '#8a347e', cyan: '#076c7c', white: '#555d6e',
  brightBlack: '#626875', brightRed: '#af202c', brightGreen: '#167847', brightYellow: '#866000',
  brightBlue: '#3050ba', brightMagenta: '#933b89', brightCyan: '#137481', brightWhite: '#313749',
};

const terminalColors = {
  light: { ...lightAnsi, background: '#ffffff', foreground: '#1e2432', cursor: '#3454d1', selectionBackground: '#dbe4ff' },
  dark: { background: '#111216', foreground: '#e8e8ee', cursor: '#aebaff', selectionBackground: '#3a456e' },
  pickme: { ...lightAnsi, background: '#fff8fc', foreground: '#392638', cursor: '#a12a72', selectionBackground: '#f6d7ee' },
} satisfies Record<Theme, NonNullable<XTerminal['options']['theme']>>;

type Props = {
  sessionId: string;
  session?: Session;
  settings: UiSettings;
  onTerminate: (id: string) => void;
  onDetach: () => void;
  onEditConfig: () => void;
  onConfigSaved: (model: Model) => void;
  onError: (error: unknown) => void;
};

export function TerminalView({ sessionId, session, settings, onTerminate, onDetach, onEditConfig, onConfigSaved, onError }: Props) {
  const { request: vaultRequest } = useVault();
  const root = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [writer, setWriter] = useState(false);
  const [state, setState] = useState(session?.state || 'connecting');
  const [error, setError] = useState(session?.error || '');
  const [activeRoute, setActiveRoute] = useState(session?.active_route || session?.route || '');
  const [warnings, setWarnings] = useState<HostKeyWarning[]>(session?.warnings || []);
  const [savingKey, setSavingKey] = useState(false);
  const visibleWarnings = settings.hideUnpinnedHostKeyWarnings ? warnings.filter(warning => warning.kind !== 'unpinned') : warnings;
  const colors = terminalColors[settings.terminalTheme === 'follow' ? settings.theme : settings.terminalTheme];

  useEffect(() => {
    if (!session) return;
    setState(session.state);
    setError(session.error);
    setActiveRoute(session.active_route || session.route);
  }, [session?.state, session?.error, session?.active_route, session?.route]);
  useEffect(() => { if (session?.warnings) setWarnings(session.warnings); }, [session?.warnings]);

  useEffect(() => {
    if (!root.current) return;
    const terminal = new XTerminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      disableStdin: true,
      theme: colors,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(root.current);
    terminalRef.current = terminal;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal/${sessionId}`);
    socketRef.current = socket;
    socket.binaryType = 'arraybuffer';
    let ownsInput = false;
    let replayingHistory = true;
    const syncInput = () => {
      const canWrite = ownsInput && !replayingHistory;
      terminal.options.disableStdin = !canWrite;
      setWriter(canWrite);
    };
    syncInput();
    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    socket.onopen = resize;
    socket.onmessage = event => {
      if (typeof event.data !== 'string') {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      const message = JSON.parse(event.data);
      if (message.type === 'state') {
        setState(message.state);
        setError(message.error || '');
        setActiveRoute(message.active_route || message.route || '');
        if (message.warnings) setWarnings(message.warnings);
        if (typeof message.writer === 'boolean') {
          ownsInput = message.writer;
          syncInput();
        }
      } else if (message.type === 'writer') {
        ownsInput = !!message.writer;
        syncInput();
      } else if (message.type === 'history_end') {
        // The socket marker can arrive while xterm is still parsing the replay.
        terminal.write(new Uint8Array(0), () => {
          replayingHistory = false;
          syncInput();
        });
      } else if (message.type === 'host_keys') {
        setWarnings(message.warnings);
      }
    };
    socket.onclose = () => {
      ownsInput = false;
      syncInput();
      setState(previous => previous === 'error' || previous === 'exited' ? previous : 'disconnected');
    };
    const input = terminal.onData(data => {
      if (ownsInput && !replayingHistory && socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(root.current);
    return () => {
      observer.disconnect();
      input.dispose();
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, settings.fontSize, settings.scrollback]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = colors;
  }, [colors]);

  const reconnect = () => vaultRequest(() => api('/sessions/' + sessionId + '/reconnect', { method: 'POST' }));
  const saveHostKey = async (warning: HostKeyWarning) => {
    const { id, node, fingerprint, expected } = warning;
    if (!id || !fingerprint || savingKey) return;
    const endpoint = warning.host ? ` (${warning.host}:${warning.port})` : '';
    const previous = expected ? `Текущий отпечаток: ${expected}\n` : '';
    if (!confirm(`Хост ${node}${endpoint}\n${previous}Полученный отпечаток: ${fingerprint}\n\nСверьте отпечаток по доверенному каналу. Сохранить его и переподключить терминал?`)) return;
    setSavingKey(true);
    try {
      const model = await api<Model>('/sessions/' + sessionId + '/host-key', json('PUT', { id, fingerprint }));
      onConfigSaved(model);
      await reconnect();
    } catch (error) { onError(error); } finally { setSavingKey(false); }
  };

  return <div className="terminal-view">
    <div className="tool-head terminal-head">
      <div className="tool-identity">
        <span className="tool-icon"><Terminal size={16}/></span>
        <strong>{session?.target || 'Терминал'}</strong>
        <span className="route-label">{activeRoute || 'Автоматический маршрут'}</span>
        <span className={'state-pill ' + state}>{stateLabel[state] || state}</span>
      </div>
      <div className="tool-actions">
        {!writer && <button title="Взять управление вводом в этом окне" onClick={() => socketRef.current?.send(JSON.stringify({ type: 'claim' }))}>Взять ввод</button>}
        <button title="Переподключить SSH" aria-label="Переподключить" disabled={savingKey} onClick={() => reconnect().catch(onError)}><RefreshCw size={16}/></button>
        <button title="Открыть эту же сессию в новом окне" aria-label="В новое окно" onClick={() => window.open('/?session=' + sessionId, '_blank')}><ExternalLink size={16}/></button>
        <button title="Отсоединиться: SSH-процесс продолжит работу" aria-label="Отсоединиться" onClick={onDetach}><Minus size={16}/></button>
        <button title="Завершить SSH-процесс" aria-label="Завершить" onClick={() => onTerminate(sessionId)}><Square size={15}/></button>
      </div>
    </div>
    {visibleWarnings.map(warning => <div className={'trust-warning' + (warning.kind === 'unpinned' ? '' : ' mismatch')} role="alert" key={warning.id || warning.node}>
      <AlertTriangle size={17}/>
      <div>
        <strong>{warning.kind === 'mismatch' ? 'Отпечаток SSH не совпадает' : warning.kind === 'rejected' ? 'Ключ SSH отклонён' : 'Ключ SSH не закреплён'} · {warning.node}</strong>
        {warning.route_path && <span className="trust-route">{warning.route_path}</span>}
        {warning.expected && <span>Закреплённый <code>{warning.expected}</code></span>}
        {warning.fingerprint ? <span>Полученный <code>{warning.fingerprint}</code></span>
          : <span>Отпечаток пока недоступен. Его можно указать вручную в конфигурации.</span>}
      </div>
      {warning.id && warning.fingerprint
        ? <button className={warning.kind === 'mismatch' ? 'danger' : 'subtle'} disabled={savingKey} onClick={() => saveHostKey(warning)}>
          {warning.kind === 'mismatch' ? 'Заменить отпечаток' : 'Закрепить отпечаток'}
        </button>
        : <button className="text-action" onClick={onEditConfig}>Открыть конфиг</button>}
    </div>)}
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div ref={root} className="terminal-canvas" style={{ background: colors.background }} onClick={() => terminalRef.current?.focus()}/>
    <div className="terminal-foot"><span>{writer ? '● Ввод активен' : '○ Только просмотр'}</span><span>Ctrl+C отправляет SIGINT · копирование через выделение</span></div>
  </div>;
}
