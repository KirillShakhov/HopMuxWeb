import { Fragment, useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { AlertCircle, ArrowRight, ArrowUpFromLine, ChevronDown, Columns2, GitBranch, HardDrive, LayoutGrid, Maximize2, Minus, Moon, Plus, RefreshCw, Rows2, Settings2, Sparkles, Sun, Terminal, X } from 'lucide-react';
import { api, defaultSettings, initialLayout, json, stored, themes, type Layout, type Model, type Session, type Tab, type Theme, type Transfer, type UiSettings } from './lib';
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
  const [hostToView, setHostToView] = useState('');
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
  const browseHosts = (host = '') => { setHostToView(host); setSection('hosts'); };
  const leaveSingle = () => { setSingleSession(null); setSingleTransfer(null); history.replaceState(null, '', '/'); setSection('workspace'); };

  if (authorized === null) return <div className="loading">Загрузка HopMuxWeb…</div>;
  if (!authorized) return <div className="login"><div className="login-card"><div className="brand-mark"><GitBranch size={25}/></div><h1>HopMuxWeb</h1><p>Ваше рабочее место для SSH</p><form onSubmit={async event => { event.preventDefault(); try { await api('/login', json('POST', { token })); setAuthorized(true); } catch (error) { showError(error); } }}><label htmlFor="access-token">Токен доступа</label><input id="access-token" type="password" value={token} onChange={event => setToken(event.target.value)} autoFocus placeholder="Введите HOPMUX_TOKEN"/><button className="primary" type="submit">Войти</button></form>{notice && <div className="error-box">{notice}</div>}</div></div>;
  if (singleSession) return <div className="single-terminal"><div className="single-head"><span className="brand-mark small"><GitBranch size={17}/></span><strong>HopMuxWeb</strong><span>Отдельное окно терминала</span><button onClick={leaveSingle}>Рабочее место</button></div><TerminalView sessionId={singleSession} session={sessions.find(item => item.id === singleSession)} settings={settings} onTerminate={terminate} onDetach={leaveSingle} onEditConfig={() => { leaveSingle(); editConfig(sessions.find(item => item.id === singleSession)?.target); }} onError={showError}/></div>;
  if (singleTransfer) return <div className="single-terminal"><div className="single-head"><span className="brand-mark small"><GitBranch size={17}/></span><strong>HopMuxWeb</strong><span>Отдельное окно передачи</span><button onClick={leaveSingle}>Рабочее место</button></div><TransferView model={model} transfers={transfers} settings={settings} focusedId={singleTransfer} separate onRefresh={reloadTransfers} onError={showError}/></div>;

  const ThemeIcon = settings.theme === 'dark' ? Moon : settings.theme === 'pickme' ? Sparkles : Sun;
  const LayoutIcon = layout.direction === 'vertical' ? Columns2 : Rows2;
  const quickHosts = [...new Set([
    ...stored<string[]>('hopmux-favorites', []),
    ...stored<string[]>('hopmux-recent', []),
    ...Object.keys(model?.nodes || {}).sort(),
  ])].filter(name => model?.nodes[name] && model.routes.some(route => route.target === name && !route.disabled)).slice(0, 3);
  const activeSessions = sessions.filter(item => item.state === 'connected').length;
  const activeTransfers = transfers.filter(item => item.state === 'running').length;

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><GitBranch size={21}/></div>
        <strong>HopMux<span>Web</span></strong>
      </div>
      <nav aria-label="Основные разделы">
        {navItems.map(([key, Icon, label]) => <button
          key={key}
          className={section === key ? 'nav active' : 'nav'}
          aria-current={section === key ? 'page' : undefined}
          title={label}
          onClick={() => key === 'hosts' ? browseHosts() : setSection(key)}
        ><Icon size={18}/><span>{label}</span></button>)}
      </nav>
      <div className="sidebar-bottom">
        <span className={'connection-dot' + (model ? ' online' : '')}/>
        <span>{model ? 'Сервер доступен' : 'Ожидание данных'}</span>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="breadcrumb"><span>HopMuxWeb</span><span aria-hidden="true">/</span><strong>{navItems.find(([key]) => key === section)?.[2]}</strong></div>
        <div className="top-actions">
          <button className="icon-button" title="Обновить данные" aria-label="Обновить данные" onClick={() => reload().catch(showError)}><RefreshCw size={17}/></button>
          <div className="theme-select">
            <ThemeIcon size={16} aria-hidden="true"/>
            <select aria-label="Тема интерфейса" value={settings.theme} onChange={event => setSettings(previous => ({ ...previous, theme: event.target.value as Theme }))}>
              {themes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <ChevronDown size={13} aria-hidden="true"/>
          </div>
        </div>
      </header>
      {notice && <div className="toast" role="alert"><AlertCircle size={17}/><span>{notice}</span><button className="icon-button" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><X size={16}/></button></div>}

      {section === 'workspace' && <div className="page workspace">
        <div className="page-title">
          <div><h1>Рабочее место</h1><p>SSH-сессии и передача файлов</p></div>
          <div className="title-actions">
            <button className="subtle icon-button" title={layout.direction === 'vertical' ? 'Расположить панели рядом' : 'Расположить панели друг над другом'} aria-label={layout.direction === 'vertical' ? 'Расположить панели рядом' : 'Расположить панели друг над другом'} onClick={() => setLayout(previous => ({ ...previous, direction: previous.direction === 'vertical' ? 'horizontal' : 'vertical' }))}><LayoutIcon size={17}/></button>
            <button className="subtle" title="Добавить панель (до четырёх)" disabled={layout.panels.length >= 4} onClick={() => setLayout(previous => ({ ...previous, panels: [...previous.panels, []] }))}><Plus size={16}/> Панель</button>
            <button className="primary" onClick={() => browseHosts()}><Plus size={16}/> Новый терминал</button>
          </div>
        </div>

        <div className="workspace-frame">
          <div className="workspace-body">
            <PanelGroup direction={layout.direction || 'horizontal'} className="panel-group">
              {layout.panels.map((panel, index) => <Fragment key={index}>
                {index > 0 && <PanelResizeHandle className={'resize-handle' + (layout.direction === 'vertical' ? ' vertical' : '') + (layout.maximized !== null ? ' hidden-panel' : '')}/>}
                <Panel minSize={15} defaultSize={100 / layout.panels.length} className={layout.maximized !== null && layout.maximized !== index ? 'hidden-panel' : ''}>
                  <div className="work-panel" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); moveTab(index, event.dataTransfer.getData('text/tab')); }}>
                    <div className="tabstrip">
                      {!panel.length && <span className="tabstrip-label"><LayoutGrid size={15}/> Вкладки</span>}
                      {panel.map(id => {
                        const tab = tabs.find(item => item.id === id);
                        if (!tab) return null;
                        const isActive = layout.active[index] === id;
                        return <div key={id} className={'tab' + (isActive ? ' selected' : '')} draggable onDragStart={event => event.dataTransfer.setData('text/tab', id)}>
                          <button className="tab-select" aria-pressed={isActive} onClick={() => setLayout(previous => ({ ...previous, active: { ...previous.active, [index]: id } }))}>
                            {tab.kind === 'terminal' ? <Terminal size={15}/> : <ArrowUpFromLine size={15}/>}<span>{tab.title}</span>
                          </button>
                          <button className="icon-button tab-close" title={'Закрыть вкладку ' + tab.title} aria-label={'Закрыть ' + tab.title} onClick={() => closeTab(id)}><X size={14}/></button>
                        </div>;
                      })}
                      <button className="icon-button tab-add" title="Новая вкладка передачи" aria-label="Новая вкладка передачи" onClick={() => openTransfer()}><Plus size={17}/></button>
                      <div className="tab-spacer"/>
                      <button className="icon-button tab-tool" title="Развернуть или вернуть панель" aria-label="Развернуть или вернуть панель" onClick={() => setLayout(previous => ({ ...previous, maximized: previous.maximized === index ? null : index }))}><Maximize2 size={15}/></button>
                      {layout.panels.length > 1 && <button className="icon-button tab-tool" title="Убрать панель и перенести её вкладки" aria-label="Убрать панель" onClick={() => removePanel(index)}><Minus size={16}/></button>}
                    </div>

                    {panel.length ? tabs.filter(tab => tab.id === layout.active[index]).map(tab => <div className="panel-content" key={tab.id}>
                      {tab.kind === 'terminal' && tab.sessionId
                        ? <TerminalView sessionId={tab.sessionId} session={sessions.find(item => item.id === tab.sessionId)} settings={settings} onTerminate={terminate} onDetach={() => closeTab(tab.id)} onEditConfig={() => editConfig(tab.target)} onError={showError}/>
                        : <TransferView model={model} transfers={transfers} settings={settings} initialTarget={tab.target} initialRoute={tab.route} focusedId={tab.transferId} onCreated={transferId => setTabs(previous => previous.map(item => item.id === tab.id ? { ...item, transferId } : item))} onRefresh={reloadTransfers} onError={showError}/>}
                    </div>) : <div className="empty-panel">
                      <div className="empty-content">
                        <div className="empty-connect">
                          <div className="empty-icon"><Terminal size={28}/></div>
                          <h2>Нет открытых вкладок</h2>
                          <p>Подключитесь к хосту по SSH или откройте передачу файлов.</p>
                          <div className="empty-actions">
                            <button className="primary" onClick={() => browseHosts()}><Terminal size={16}/> Выбрать хост</button>
                            <button className="subtle" onClick={() => openTransfer()}><ArrowUpFromLine size={16}/> Передать файлы</button>
                          </div>
                        </div>
                        {layout.panels.length === 1 && quickHosts.length > 0 && <section className="quick-hosts" aria-label="Быстрый доступ к хостам">
                          <h3>Быстрый доступ</h3>
                          {quickHosts.map(name => {
                            const host = model!.nodes[name];
                            return <button className="quick-host" key={name} onClick={() => browseHosts(name)}>
                              <span className="host-avatar"><HardDrive size={16}/></span>
                              <span className="host-main"><strong>{name}</strong><small>{host.user}@{host.host}</small></span>
                              <ArrowRight size={16}/>
                            </button>;
                          })}
                        </section>}
                      </div>
                    </div>}
                  </div>
                </Panel>
              </Fragment>)}
            </PanelGroup>
          </div>
          <div className="statusbar">
            <span><Terminal size={14}/> Сессии <strong>{activeSessions}</strong></span>
            <span><ArrowUpFromLine size={14}/> Передачи <strong>{activeTransfers}</strong></span>
            <span className="status-right">Файлы контейнера <code>/files</code></span>
          </div>
        </div>
      </div>}
      {section === 'hosts' && <HostsView model={model} sessions={sessions} initialHost={hostToView} openTerminal={openTerminal} openTransfer={openTransfer} onEdit={editConfig} onError={showError}/>}
      {section === 'config' && <ConfigView model={model} theme={settings.theme} focusHost={focusHost} onSaved={setModel} openTerminal={openTerminal} openTransfer={openTransfer} onError={showError}/>}
      {section === 'settings' && <SettingsView settings={settings} setSettings={setSettings}/>}
    </main>
  </div>;
}
