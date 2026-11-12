import { Fragment, useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowUpFromLine, CircleHelp, GitBranch, HardDrive, LayoutGrid, Maximize2, Minus, Plus, RefreshCw, Settings2, Terminal, X } from 'lucide-react';
import { api, defaultSettings, initialLayout, json, stored, type Layout, type Model, type Session, type Tab, type Transfer, type UiSettings } from './lib';
import { TerminalView } from './TerminalView';
import { HostsView } from './HostsView';
import { ConfigView } from './ConfigView';
import { TransferView } from './TransferView';
import { SettingsView } from './SettingsView';

type Section = 'workspace' | 'hosts' | 'config' | 'settings';
const navItems = [
  ['workspace', LayoutGrid, 'Рабочее место'],
  ['hosts', HardDrive, 'Хосты'],
  ['config', GitBranch, 'Конфигурация'],
  ['settings', Settings2, 'Настройки'],
] as const;

export function App() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [section, setSection] = useState<Section>('workspace');
  const [focusHost, setFocusHost] = useState('');
  const [model, setModel] = useState<Model | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [settings, setSettings] = useState<UiSettings>(() => ({ ...defaultSettings, ...stored('hopmux-settings', {}) }));
  const [tabs, setTabs] = useState<Tab[]>(() => stored<UiSettings>('hopmux-settings', defaultSettings).restoreTabs ? stored('hopmux-tabs', []) : []);
  const [layout, setLayout] = useState<Layout>(() => stored<UiSettings>('hopmux-settings', defaultSettings).restoreTabs ? { ...initialLayout, ...stored('hopmux-layout', initialLayout) } : initialLayout);
  const [notice, setNotice] = useState('');
  const [singleSession, setSingleSession] = useState(new URLSearchParams(location.search).get('session'));
  const [singleTransfer, setSingleTransfer] = useState(new URLSearchParams(location.search).get('transfer'));
  const showError = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error));
  const reload = async () => {
    const [config, sessionList, transferList] = await Promise.all([api<Model>('/config'), api<Session[]>('/sessions'), api<Transfer[]>('/transfers')]);
    setModel(config); setSessions(sessionList); setTransfers(transferList);
  };
  const reloadTransfers = () => api<Transfer[]>('/transfers').then(setTransfers).catch(showError);

  useEffect(() => { api<{ authenticated: boolean }>('/auth').then(result => setAuthorized(result.authenticated)).catch(() => setAuthorized(false)); }, []);
  useEffect(() => { if (authorized) reload().catch(showError); }, [authorized]);
  useEffect(() => {
    if (!authorized) return;
    const timer = window.setInterval(() => {
      api<Session[]>('/sessions').then(setSessions).catch(() => {});
      api<Transfer[]>('/transfers').then(setTransfers).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [authorized]);
  useEffect(() => { localStorage.setItem('hopmux-tabs', JSON.stringify(tabs)); }, [tabs]);
  useEffect(() => { localStorage.setItem('hopmux-layout', JSON.stringify(layout)); }, [layout]);
  useEffect(() => {
    localStorage.setItem('hopmux-settings', JSON.stringify(settings));
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.density = settings.density;
  }, [settings]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (transfers.some(item => item.state === 'running') && settings.confirmClose) event.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [transfers, settings.confirmClose]);

  const openTab = (tab: Tab) => {
    setTabs(previous => [...previous, tab]);
    setLayout(previous => {
      const panels = previous.panels.map(panel => [...panel]);
      panels[0].push(tab.id);
      return { ...previous, panels, active: { ...previous.active, 0: tab.id } };
    });
    setSection('workspace');
  };
  const openTerminal = async (target: string, route: string) => {
    try {
      const session = await api<Session>('/sessions', json('POST', { target, route }));
      setSessions(previous => [...previous, session]);
      openTab({ id: crypto.randomUUID(), kind: 'terminal', title: target, target, route, sessionId: session.id });
    } catch (error) { showError(error); }
  };
  const openTransfer = (target = '', route = '') => openTab({ id: crypto.randomUUID(), kind: 'transfer', title: target ? `Файлы · ${target}` : 'Передача файлов', target, route });
  const closeTab = (id: string) => {
    const tab = tabs.find(item => item.id === id);
    const activeTransfer = tab?.kind === 'transfer' && transfers.some(item => item.state === 'running' && (tab.transferId ? item.id === tab.transferId : item.target === tab.target));
    if (activeTransfer && settings.confirmClose && !confirm('Передача ещё выполняется. Закрыть представление? Задача продолжится на сервере.')) return;
    setTabs(previous => previous.filter(item => item.id !== id));
    setLayout(previous => {
      const panels = previous.panels.map(panel => panel.filter(item => item !== id));
      const active = { ...previous.active };
      panels.forEach((panel, index) => { if (active[index] === id) active[index] = panel[0] || ''; });
      return { ...previous, panels, active };
    });
  };
  const moveTab = (index: number, id: string) => {
    if (!tabs.some(tab => tab.id === id)) return;
    setLayout(previous => {
      const panels = previous.panels.map(panel => panel.filter(item => item !== id));
      panels[index].push(id);
      return { ...previous, panels, active: { ...previous.active, [index]: id } };
    });
  };
  const removePanel = (index: number) => setLayout(previous => {
    if (previous.panels.length <= 1) return previous;
    const panels = previous.panels.map(panel => [...panel]);
    const removed = panels.splice(index, 1)[0];
    panels[0].push(...removed);
    const active: Record<number, string> = {};
    panels.forEach((panel, i) => { active[i] = panel.includes(previous.active[i]) ? previous.active[i] : panel[0] || ''; });
    return { ...previous, panels, active, maximized: null };
  });
  const terminate = async (id: string) => {
    if (!confirm('Завершить SSH-процесс? Это прервёт удалённую shell-сессию.')) return;
    try { await api('/sessions/' + id, { method: 'DELETE' }); setSessions(await api('/sessions')); } catch (error) { showError(error); }
  };
  const editConfig = (host = '') => { setFocusHost(host); setSection('config'); };
  const leaveSingle = () => { setSingleSession(null); setSingleTransfer(null); history.replaceState(null, '', '/'); setSection('workspace'); };

  if (authorized === null) return <div className="loading">Загрузка HopMuxWeb…</div>;
  if (!authorized) return <div className="login"><div className="login-card"><div className="brand-mark"><GitBranch size={25}/></div><h1>HopMuxWeb</h1><p>Ваше рабочее место для SSH</p><form onSubmit={async event => { event.preventDefault(); try { await api('/login', json('POST', { token })); setAuthorized(true); } catch (error) { showError(error); } }}><label htmlFor="access-token">Токен доступа</label><input id="access-token" type="password" value={token} onChange={event => setToken(event.target.value)} autoFocus placeholder="Введите HOPMUX_TOKEN"/><button className="primary" type="submit">Войти</button></form>{notice && <div className="error-box">{notice}</div>}</div></div>;
  if (singleSession) return <div className="single-terminal"><div className="single-head"><span className="brand-mark small"><GitBranch size={17}/></span><strong>HopMuxWeb</strong><span>Отдельное окно терминала</span><button onClick={leaveSingle}>Рабочее место</button></div><TerminalView sessionId={singleSession} session={sessions.find(item => item.id === singleSession)} settings={settings} onTerminate={terminate} onDetach={leaveSingle} onEditConfig={() => { leaveSingle(); editConfig(sessions.find(item => item.id === singleSession)?.target); }} onError={showError}/></div>;
  if (singleTransfer) return <div className="single-terminal"><div className="single-head"><span className="brand-mark small"><GitBranch size={17}/></span><strong>HopMuxWeb</strong><span>Отдельное окно передачи</span><button onClick={leaveSingle}>Рабочее место</button></div><TransferView model={model} transfers={transfers} settings={settings} focusedId={singleTransfer} separate onRefresh={reloadTransfers} onError={showError}/></div>;

  return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><GitBranch size={21}/></div><div><strong>HopMux<span>Web</span></strong><small>SSH WORKSPACE</small></div></div><nav>{navItems.map(([key, Icon, label]) => <button key={key} className={section === key ? 'nav active' : 'nav'} title={label} aria-label={label} onClick={() => setSection(key)}><Icon size={18}/><span>{label}</span></button>)}</nav><div className="sidebar-bottom"><div className="connection-pill"><span className="pulse"/> Сервер доступен</div><div className="sidebar-version">HopMuxWeb v0.1.0</div></div></aside><main className="main"><header className="topbar"><div className="breadcrumb"><span>HopMuxWeb</span><span>/</span><strong>{navItems.find(([key]) => key === section)?.[2]}</strong></div><div className="top-actions"><button title="Обновить данные" aria-label="Обновить данные" onClick={() => reload().catch(showError)}><RefreshCw size={17}/></button><div className="avatar">H</div></div></header>{notice && <div className="toast" role="alert" onClick={() => setNotice('')}><CircleHelp size={16}/>{notice}<X size={15}/></div>}
    {section === 'workspace' && <div className="page workspace"><div className="page-title workspace-title"><div><h1>Рабочее место</h1><p>Терминалы и передачи</p></div><div className="title-actions"><button className="subtle" title="Переключить горизонтальное или вертикальное разделение" onClick={() => setLayout(previous => ({ ...previous, direction: previous.direction === 'vertical' ? 'horizontal' : 'vertical' }))}><LayoutGrid size={16}/> {layout.direction === 'vertical' ? 'Рядом' : 'Друг над другом'}</button><button className="subtle" title="Добавить панель (до четырёх)" disabled={layout.panels.length >= 4} onClick={() => setLayout(previous => ({ ...previous, panels: [...previous.panels, []] }))}><Plus size={16}/> Панель</button><button className="primary" title="Выбрать хост для новой SSH-сессии" onClick={() => setSection('hosts')}><Plus size={16}/> Терминал</button></div></div><div className="workspace-body"><PanelGroup direction={layout.direction || 'horizontal'} className="panel-group">{layout.panels.map((panel, index) => <Fragment key={index}>{index > 0 && <PanelResizeHandle className={layout.direction === 'vertical' ? 'resize-handle vertical' : 'resize-handle'}/>}<Panel minSize={15} defaultSize={100 / layout.panels.length} className={layout.maximized !== null && layout.maximized !== index ? 'hidden-panel' : ''}><div className="work-panel" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); moveTab(index, event.dataTransfer.getData('text/tab')); }}><div className="tabstrip">{panel.map(id => { const tab = tabs.find(item => item.id === id); if (!tab) return null; return <div key={id} draggable onDragStart={event => event.dataTransfer.setData('text/tab', id)} className={'tab ' + (layout.active[index] === id ? 'selected' : '')} onClick={() => setLayout(previous => ({ ...previous, active: { ...previous.active, [index]: id } }))}>{tab.kind === 'terminal' ? <Terminal size={14}/> : <ArrowUpFromLine size={14}/>}<span>{tab.title}</span><button title={`Закрыть вкладку ${tab.title}`} aria-label={`Закрыть ${tab.title}`} onClick={event => { event.stopPropagation(); closeTab(id); }}><X size={13}/></button></div>; })}<button className="tab-add" title="Новая вкладка передачи" aria-label="Новая вкладка передачи" onClick={() => openTransfer()}><Plus size={16}/></button><div className="tab-spacer"/><button className="tab-tool" title="Развернуть или вернуть панель" aria-label="Развернуть панель" onClick={() => setLayout(previous => ({ ...previous, maximized: previous.maximized === index ? null : index }))}><Maximize2 size={14}/></button>{layout.panels.length > 1 && <button className="tab-tool" title="Убрать панель и перенести её вкладки" aria-label="Убрать панель" onClick={() => removePanel(index)}><Minus size={14}/></button>}</div>{panel.length ? tabs.filter(tab => tab.id === layout.active[index]).map(tab => <div className="panel-content" key={tab.id}>{tab.kind === 'terminal' && tab.sessionId ? <TerminalView sessionId={tab.sessionId} session={sessions.find(item => item.id === tab.sessionId)} settings={settings} onTerminate={terminate} onDetach={() => closeTab(tab.id)} onEditConfig={() => editConfig(tab.target)} onError={showError}/> : <TransferView model={model} transfers={transfers} settings={settings} initialTarget={tab.target} initialRoute={tab.route} focusedId={tab.transferId} onCreated={transferId => setTabs(previous => previous.map(item => item.id === tab.id ? { ...item, transferId } : item))} onRefresh={reloadTransfers} onError={showError}/>}</div>) : <div className="empty-panel"><div className="empty-icon"><Terminal size={27}/></div><h3>Готово к подключению</h3><p>Откройте хост или начните передачу файлов.</p><div><button className="primary" onClick={() => setSection('hosts')}><Plus size={15}/> Открыть терминал</button><button className="subtle" onClick={() => openTransfer()}><ArrowUpFromLine size={15}/> Передать файлы</button></div></div>}</div></Panel></Fragment>)}</PanelGroup></div><div className="statusbar"><span><span className="status-dot"/> {sessions.filter(item => item.state === 'connected').length} активных сессий</span><span>{transfers.filter(item => item.state === 'running').length} передач</span><span className="status-right">Локальные файлы контейнера: /files</span></div></div>}
    {section === 'hosts' && <HostsView model={model} sessions={sessions} openTerminal={openTerminal} openTransfer={openTransfer} onEdit={editConfig} onError={showError}/>}
    {section === 'config' && <ConfigView model={model} theme={settings.theme} focusHost={focusHost} onSaved={setModel} openTerminal={openTerminal} openTransfer={openTransfer} onError={showError}/>}
    {section === 'settings' && <SettingsView settings={settings} setSettings={setSettings}/>}</main></div>;
}
