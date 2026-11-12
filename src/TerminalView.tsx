import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AlertTriangle, ExternalLink, Minus, RefreshCw, Square, Terminal } from 'lucide-react';
import { api, stateLabel, type Session, type UiSettings } from './lib';

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

  useEffect(() => {
    if (!session) return;
    setState(session.state);
    setError(session.error);
    setActiveRoute(session.active_route || session.route);
  }, [session?.state, session?.error, session?.active_route, session?.route]);

  useEffect(() => {
    if (!root.current) return;
    const light = settings.terminalTheme === 'light' || settings.terminalTheme === 'follow' && settings.theme === 'light';
    const terminal = new XTerminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      disableStdin: true,
      theme: light
        ? { background: '#f9fbfc', foreground: '#233640', cursor: '#087e79', selectionBackground: '#a9d9d6' }
        : { background: '#101318', foreground: '#d8dee9', cursor: '#88c0d0', selectionBackground: '#3b536d' },
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
  }, [sessionId, settings.fontSize, settings.scrollback, settings.terminalTheme, settings.theme]);

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
    <div ref={root} className="terminal-canvas" onClick={() => terminalRef.current?.focus()}/>
    <div className="terminal-foot"><span>{writer ? '● Ввод активен' : '○ Только просмотр'}</span><span>Ctrl+C отправляет SIGINT · копирование через выделение</span></div>
  </div>;
}
