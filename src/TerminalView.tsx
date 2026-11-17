import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AlertTriangle, ExternalLink, Minus, RefreshCw, Square, Terminal } from 'lucide-react';
import { api, stateLabel, type Session, type Theme, type UiSettings } from './lib';

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
  onError: (error: unknown) => void;
};

export function TerminalView({ sessionId, session, settings, onTerminate, onDetach, onEditConfig, onError }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const writerRef = useRef(false);
  const [writer, setWriter] = useState(false);
  const [state, setState] = useState(session?.state || 'connecting');
  const [error, setError] = useState(session?.error || '');
  const [activeRoute, setActiveRoute] = useState(session?.active_route || session?.route || '');
  const [rejectedHost, setRejectedHost] = useState('');
  const colors = terminalColors[settings.terminalTheme === 'follow' ? settings.theme : settings.terminalTheme];

  useEffect(() => {
    if (!session) return;
    setState(session.state);
    setError(session.error);
    setActiveRoute(session.active_route || session.route);
  }, [session?.state, session?.error, session?.active_route, session?.route]);

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
        if (typeof message.writer === 'boolean') {
          writerRef.current = message.writer;
          setWriter(message.writer);
          terminal.options.disableStdin = !message.writer;
        }
      } else if (message.type === 'writer') {
        writerRef.current = !!message.writer;
        setWriter(!!message.writer);
        terminal.options.disableStdin = !message.writer;
      } else if (message.type === 'host_key_rejected') {
        setRejectedHost(message.node);
      }
    };
    socket.onclose = () => setState(previous => previous === 'error' || previous === 'exited' ? previous : 'disconnected');
    const input = terminal.onData(data => {
      if (writerRef.current && socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(root.current);
    return () => {
      observer.disconnect();
      input.dispose();
      socket.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, settings.fontSize, settings.scrollback]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = colors;
  }, [colors]);

  const warningNodes = session?.warnings || [];
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
        <button title="Переподключить SSH" aria-label="Переподключить" onClick={() => api('/sessions/' + sessionId + '/reconnect', { method: 'POST' }).catch(onError)}><RefreshCw size={16}/></button>
        <button title="Открыть эту же сессию в новом окне" aria-label="В новое окно" onClick={() => window.open('/?session=' + sessionId, '_blank')}><ExternalLink size={16}/></button>
        <button title="Отсоединиться: SSH-процесс продолжит работу" aria-label="Отсоединиться" onClick={onDetach}><Minus size={16}/></button>
        <button title="Завершить SSH-процесс" aria-label="Завершить" onClick={() => onTerminate(sessionId)}><Square size={15}/></button>
      </div>
    </div>
    {(warningNodes.length > 0 || rejectedHost) && <div className="trust-warning" role="alert">
      <AlertTriangle size={17}/>
      <div>
        <strong>{rejectedHost ? `Ключ хоста ${rejectedHost} отклонён` : 'Ключи SSH не закреплены'}</strong>
        <span>{warningNodes.length ? warningNodes.map(item => item.node).join(', ') : rejectedHost}. Отпечаток CLI не предоставляет; сверяйте его по доверенному каналу и укажите <code>host_key = "SHA256:…"</code> в TOML.</span>
      </div>
      <button onClick={onEditConfig}>Открыть конфиг</button>
    </div>}
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div ref={root} className="terminal-canvas" style={{ background: colors.background }} onClick={() => terminalRef.current?.focus()}/>
    <div className="terminal-foot"><span>{writer ? '● Ввод активен' : '○ Только просмотр'}</span><span>Ctrl+C отправляет SIGINT · копирование через выделение</span></div>
  </div>;
}
