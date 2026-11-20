import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Link, matchPath, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AlertCircle, ArrowRight, ArrowUpFromLine, ChevronDown, Columns2, GitBranch, HardDrive, LayoutGrid, LockKeyhole, Maximize2, Minus, Moon, Plus, RefreshCw, Rows2, Settings2, Sparkles, Sun, Terminal, X } from 'lucide-react';
import { ApiError, api, defaultSettings, initialLayout, isResumableSession, json, sessionLabel, stored, terminalWindowUrl, themes, transferDraft, type Layout, type Model, type Session, type Tab, type Theme, type Transfer, type UiSettings } from './lib';
import { TerminalView } from './TerminalView';
import { HostsView } from './HostsView';
import { ConfigView } from './ConfigView';
import { NewConfigurationDialog } from './NewConfigurationDialog';
import { TransferView } from './TransferView';
import { SettingsView } from './SettingsView';
import { useVault, VaultProvider, VaultView } from './VaultView';
import { ConfigurationContext, configurationScope, configurationUrl, useConfiguration, type ConfigurationCatalog } from './ConfigurationContext';

const navItems = [
  ['/', LayoutGrid, 'Рабочее место'],
  ['/hosts', HardDrive, 'Хосты'],
  ['/config', GitBranch, 'Конфигурация'],
  ['/vault', LockKeyhole, 'Хранилище'],
  ['/settings', Settings2, 'Настройки'],
] as const;

type WorkspaceSnapshot = { tabs: Tab[]; layout: Layout };

type WorkspaceProps = {
  catalog: ConfigurationCatalog;
  catalogError: string;
  workspaceCache: Map<string, WorkspaceSnapshot>;
  enabled: string[];
  selectConfiguration: (name: string) => void;
  toggleConfiguration: (name: string) => void;
  refreshConfigurations: () => void;
  openNewConfiguration: () => void;
  onConfigDirty: (dirty: boolean) => void;
};

export function App() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');
  const [catalog, setCatalog] = useState<ConfigurationCatalog>();
  const [creatingConfiguration, setCreatingConfiguration] = useState(false);
  const [hidden, setHidden] = useState<string[]>(() => stored('hopmux-hidden-configs', []));
  const [preferred, setPreferred] = useState(() => stored<string>('hopmux-active-config', ''));
  const workspaceCache = useRef(new Map<string, WorkspaceSnapshot>());
  const catalogRevision = useRef(0);
  const dirty = useRef(false);
  const onConfigDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const refreshConfigurations = useCallback(() => {
    const revision = ++catalogRevision.current;
    api<ConfigurationCatalog>('/configurations').then(result => {
      if (revision !== catalogRevision.current) return;
      setCatalog(result);
      setNotice('');
    }).catch(error => {
      if (revision === catalogRevision.current) setNotice(error.message);
    });
  }, []);
  useEffect(() => { api<{ authenticated: boolean }>('/auth').then(result => setAuthorized(result.authenticated)).catch(() => setAuthorized(false)); }, []);
  useEffect(() => { if (authorized) refreshConfigurations(); }, [authorized, refreshConfigurations]);

  const available = catalog?.files ?? [];
  const visible = available.filter(name => !hidden.includes(name));
  const enabled = visible.length ? visible : available.slice(0, 1);
  const explicit = params.get('config');
  const detached = pathname === '/' && Boolean(params.get('session') || params.get('transfer'));
  const fallback = enabled.includes(preferred) ? preferred : enabled.includes(catalog?.default ?? '') ? catalog?.default : enabled[0];
  const selected = explicit ?? (detached ? catalog?.legacy : fallback);
  const config = selected && available.includes(selected) ? selected : '';
  const scope = useMemo(() => configurationScope(config, catalog?.legacy ?? ''), [config, catalog?.legacy]);

  const selectConfiguration = (name: string) => {
    if (name === config) return;
    if (dirty.current && !confirm('Переключить конфигурацию и сбросить несохранённые изменения?')) return;
    localStorage.setItem('hopmux-active-config', JSON.stringify(name));
    setPreferred(name);
    navigate(configurationUrl(pathname, name), { replace: true });
  };

  const toggleConfiguration = (name: string) => {
    const next = enabled.includes(name) ? enabled.filter(item => item !== name) : [...enabled, name];
    if (!next.length) return;
    const hiddenFiles = available.filter(item => !next.includes(item));
    setHidden(hiddenFiles);
    localStorage.setItem('hopmux-hidden-configs', JSON.stringify(hiddenFiles));
    if (!next.includes(config)) selectConfiguration(next[0]);
  };

  const openNewConfiguration = () => {
    if (dirty.current && !confirm('После создания откроется новая конфигурация. Сбросить несохранённые изменения?')) return;
    setCreatingConfiguration(true);
  };

  const createConfiguration = async (name: string) => {
    const result = await api<{ name: string; catalog: ConfigurationCatalog }>('/configurations', json('POST', { name }));
    catalogRevision.current++;
    setCatalog(result.catalog);
    setNotice('');
    const hiddenFiles = hidden.filter(name => name !== result.name);
    setHidden(hiddenFiles);
    localStorage.setItem('hopmux-hidden-configs', JSON.stringify(hiddenFiles));
    setPreferred(result.name);
    localStorage.setItem('hopmux-active-config', JSON.stringify(result.name));
    navigate(configurationUrl('/config?host=', result.name));
    setCreatingConfiguration(false);
  };
  const creationDialog = creatingConfiguration && <NewConfigurationDialog onCreate={createConfiguration} onClose={() => setCreatingConfiguration(false)}/>;

  if (authorized === null) return <div className="loading">Загрузка HopMuxWeb…</div>;
  if (!authorized) return <div className="login"><div className="login-card"><div className="brand-mark"><GitBranch size={25}/></div><h1>HopMuxWeb</h1><p>Ваше рабочее место для SSH</p><form onSubmit={async event => { event.preventDefault(); setNotice(''); try { await api('/login', json('POST', { token })); setAuthorized(true); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }}><label htmlFor="access-token">Токен доступа</label><input id="access-token" type="password" value={token} onChange={event => setToken(event.target.value)} autoFocus placeholder="Введите HOPMUX_TOKEN"/><button className="primary" type="submit">Войти</button></form>{notice && <div className="error-box">{notice}</div>}</div></div>;
  if (!catalog && !notice) return <div className="loading">Загрузка конфигураций…</div>;
  if (!catalog || !config) return <div className="loading">
    <section className="card configuration-empty">
      <p role="alert">{notice || (selected ? 'Конфигурация больше недоступна.' : 'В каталоге конфигураций нет файлов TOML.')}</p>
      <div className="title-actions">
        <button className="primary" onClick={openNewConfiguration}>Создать конфигурацию</button>
        <button className="subtle" onClick={refreshConfigurations}>Обновить список</button>
      </div>
      {fallback && <Link to={configurationUrl('/', fallback)} replace>Открыть рабочее место</Link>}
    </section>
    {creationDialog}
  </div>;

  return <>
    <ConfigurationContext.Provider key={config} value={scope}>
      <VaultProvider>
        <Workspace catalog={catalog} catalogError={notice} workspaceCache={workspaceCache.current} enabled={enabled} selectConfiguration={selectConfiguration} toggleConfiguration={toggleConfiguration} refreshConfigurations={refreshConfigurations} openNewConfiguration={openNewConfiguration} onConfigDirty={onConfigDirty}/>
      </VaultProvider>
    </ConfigurationContext.Provider>
    {creationDialog}
  </>;
}

function Workspace({ catalog, catalogError, workspaceCache, enabled, selectConfiguration, toggleConfiguration, refreshConfigurations, openNewConfiguration, onConfigDirty }: WorkspaceProps) {
  const { api, url, config, storageKey } = useConfiguration();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const currentSection = navItems.find(([path]) => matchPath(path, pathname));
  const section = currentSection?.[0];
  const hostToView = params.get('host') ?? '';
  const focusHost = params.get('host') ?? undefined;
  const singleSession = section === '/' ? params.get('session') : null;
  const singleTransfer = section === '/' ? params.get('transfer') : null;
  const { refresh: refreshVault, request: vaultRequest } = useVault();
  const [model, setModel] = useState<Model | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const sessionListVersion = useRef(0);
  const sessionActions = useRef(new Set<string>());
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [settings, setSettings] = useState<UiSettings>(() => ({ ...defaultSettings, ...stored('hopmux-settings', {}) }));
  const [tabs, setTabs] = useState<Tab[]>(() => workspaceCache.get(config)?.tabs ?? (settings.restoreTabs ? stored(storageKey('hopmux-tabs'), []) : []));
  const [layout, setLayout] = useState<Layout>(() => workspaceCache.get(config)?.layout ?? (settings.restoreTabs ? { ...initialLayout, ...stored(storageKey('hopmux-layout'), initialLayout) } : initialLayout));
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const showError = (error: unknown) => {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };
  const reloadSessions = async () => {
    const version = ++sessionListVersion.current;
    const sessionList = await api<Session[]>('/sessions');
    if (version === sessionListVersion.current) setSessions(sessionList);
  };
  const reload = () => Promise.all([api<Model>('/config').then(setModel), reloadSessions(), api<Transfer[]>('/transfers').then(setTransfers)]);
  const reloadTransfers = () => api<Transfer[]>('/transfers').then(setTransfers).catch(showError);
  const rememberSession = (session: Session, previousId = session.id) => {
    sessionListVersion.current++;
    setSessions(previous => [...previous.filter(item => item.id !== previousId && item.id !== session.id), session]);
  };
  const createTerminalSession = (target: string, route: string) =>
    vaultRequest(() => api<Session>('/sessions', json('POST', { target, route })));

  useEffect(() => {
    mounted.current = true;
    reload().catch(showError);
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { refreshVault().catch(() => {}); }, [refreshVault]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      reloadSessions().catch(() => {});
      api<Transfer[]>('/transfers').then(setTransfers).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    workspaceCache.set(config, { tabs, layout });
    localStorage.setItem(storageKey('hopmux-tabs'), JSON.stringify(tabs));
    localStorage.setItem(storageKey('hopmux-layout'), JSON.stringify(layout));
  }, [config, layout, storageKey, tabs, workspaceCache]);
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

  const openTab = (tab: Tab, panelIndex = 0) => {
    setTabs(previous => [...previous, tab]);
    setLayout(previous => {
      const panels = previous.panels.map(panel => [...panel]);
      const index = panelIndex < panels.length ? panelIndex : 0;
      panels[index].push(tab.id);
      return { ...previous, panels, active: { ...previous.active, [index]: tab.id } };
    });
    if (mounted.current && section !== '/') navigate(url('/'));
  };
  const showTerminalSession = (session: Session, panelIndex = 0) => {
    const tab = tabs.find(item => item.sessionId === session.id);
    const index = tab ? layout.panels.findIndex(panel => panel.includes(tab.id)) : -1;
    if (tab && index >= 0) {
      setLayout(previous => ({
        ...previous,
        active: { ...previous.active, [index]: tab.id },
        maximized: previous.maximized === null ? null : index,
      }));
      if (mounted.current && section !== '/') navigate(url('/'));
      return;
    }
    openTab({ id: crypto.randomUUID(), kind: 'terminal', title: session.target, target: session.target, route: session.route, sessionId: session.id }, panelIndex);
  };
  const openTerminal = async (target: string, route: string, panelIndex = 0) => {
    try {
      const session = await createTerminalSession(target, route);
      rememberSession(session);
      showTerminalSession(session, panelIndex);
    } catch (error) { showError(error); }
  };
  const reconnectTerminal = async (id: string, target?: string, route = '', separate = false) => {
    if (sessionActions.current.has(id)) return;
    sessionActions.current.add(id);
    try {
      try {
        const session = await vaultRequest(() => api<Session>('/sessions/' + id + '/reconnect', { method: 'POST' }));
        rememberSession(session);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
        if (!target) throw new Error('Сессия больше недоступна. Выберите хост на рабочем месте.');
        const session = await createTerminalSession(target, route);
        rememberSession(session, id);
        setTabs(previous => previous.map(tab => tab.sessionId === id
          ? { ...tab, sessionId: session.id, target: session.target, route: session.route }
          : tab));
        if (mounted.current && separate) navigate(url(terminalWindowUrl(session.id, session.target, session.route)), { replace: true });
      }
    } finally {
      sessionActions.current.delete(id);
    }
  };
  const openTransfer = (target = '', route = '', panelIndex = 0) => openTab({ id: crypto.randomUUID(), kind: 'transfer', title: target ? `Файлы · ${target}` : 'Передача файлов', target, route }, panelIndex);
  const selectTab = (panelIndex: number, id: string) =>
    setLayout(previous => ({ ...previous, active: { ...previous.active, [panelIndex]: id } }));
  const removeTab = (id: string) => {
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
    if (sessionActions.current.has(id)) return false;
    sessionActions.current.add(id);
    try {
      const current = await api<Session>('/sessions/' + id);
      if (current.running) {
        if (!confirm('Завершить SSH-процесс? Это прервёт удалённую shell-сессию.')) return false;
        const { session } = await api<{ session: Session }>('/sessions/' + id, { method: 'DELETE' });
        rememberSession(session);
      } else {
        rememberSession(current);
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        showError(error);
        return false;
      }
      sessionListVersion.current++;
      setSessions(previous => previous.filter(item => item.id !== id));
    } finally {
      sessionActions.current.delete(id);
    }
    return true;
  };
  const closeTab = async (id: string) => {
    const tab = tabs.find(item => item.id === id);
    if (tab?.kind === 'terminal' && tab.sessionId && !await terminate(tab.sessionId)) return;
    const activeTransfer = tab?.kind === 'transfer' && transfers.some(item => {
      if (item.state !== 'queued' && item.state !== 'running') return false;
      if (tab.transferId) return item.id === tab.transferId;
      const { source, destination } = transferDraft(item);
      return Boolean(tab.target && (source.host === tab.target || destination.host === tab.target));
    });
    if (activeTransfer && settings.confirmClose && !confirm('Передача ещё выполняется. Закрыть представление? Задача продолжится на сервере.')) return;
    removeTab(id);
  };
  const editConfig = (host = '', replace = false) =>
    navigate(url('/config?' + new URLSearchParams({ host })), { replace });
  const browseHosts = (host = '') =>
    navigate(url(host ? '/hosts?' + new URLSearchParams({ host }) : '/hosts'));
  const leaveSingle = () => navigate(url('/'), { replace: true });


  if (singleSession) {
    const session = sessions.find(item => item.id === singleSession);
    const tab = tabs.find(item => item.sessionId === singleSession);
    const target = session?.target || tab?.target || tab?.title || params.get('host') || undefined;
    const route = session?.route ?? tab?.route ?? params.get('route') ?? '';
    return <div className="single-terminal">
      <div className="single-head"><span className="brand-mark small"><GitBranch size={17}/></span><strong>HopMuxWeb</strong><span>Отдельное окно терминала</span><button onClick={leaveSingle}>Рабочее место</button></div>
      <TerminalView key={singleSession} sessionId={singleSession} session={session} target={target} route={route} settings={settings} onReconnect={id => reconnectTerminal(id, target, route, true)} onTerminate={terminate} onDetach={leaveSingle} onEditConfig={() => editConfig(target, true)} onConfigSaved={setModel} onError={showError}/>
    </div>;
  }
  if (singleTransfer) return <div className="single-terminal"><div className="single-head"><span className="brand-mark small"><GitBranch size={17}/></span><strong>HopMuxWeb</strong><span>Отдельное окно передачи</span><button onClick={leaveSingle}>Рабочее место</button></div><TransferView model={model} transfers={transfers} settings={settings} focusedId={singleTransfer} separate onRefresh={reloadTransfers} onError={showError}/></div>;

  const ThemeIcon = settings.theme === 'dark' ? Moon : settings.theme === 'pickme' ? Sparkles : Sun;
  const LayoutIcon = layout.direction === 'vertical' ? Columns2 : Rows2;
  const tabSessionIds = new Set(tabs.map(tab => tab.sessionId));
  const resumableSessions = sessions.filter(session => isResumableSession(session) && !tabSessionIds.has(session.id));
  const connectableHosts = new Set(model?.routes.filter(route => !route.disabled).map(route => route.target));
  const canConnect = (name: string) => Boolean(model?.nodes[name] && connectableHosts.has(name));
  const favoriteHosts = stored<string[]>(storageKey('hopmux-favorites'), []).filter(canConnect);
  const quickHosts = favoriteHosts.length ? favoriteHosts : [...new Set([
    ...stored<string[]>(storageKey('hopmux-recent'), []),
    ...Object.keys(model?.nodes || {}).sort(),
  ])].filter(canConnect).slice(0, 3);
  const activeSessions = sessions.filter(item => item.state === 'connected').length;
  const activeTransfers = transfers.filter(item => item.state === 'running').length;

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><GitBranch size={21}/></div>
        <strong>HopMux<span>Web</span></strong>
      </div>
      <nav aria-label="Основные разделы">
        {navItems.map(([path, Icon, label]) => <Link
          key={path}
          to={url(path)}
          className={section === path ? 'nav active' : 'nav'}
          aria-current={section === path ? 'page' : undefined}
          title={label}
        ><Icon size={18}/><span>{label}</span></Link>)}
      </nav>
      <div className="sidebar-bottom">
        <span className={'connection-dot' + (model ? ' online' : '')}/>
        <span>{model ? 'Сервер доступен' : 'Ожидание данных'}</span>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="breadcrumb"><span>HopMuxWeb</span><span aria-hidden="true">/</span><strong>{currentSection?.[2] ?? 'Страница не найдена'}</strong></div>
        <div className="top-actions">
          <label className="theme-select configuration-select" title="Конфигурация">
            <GitBranch size={16} aria-hidden="true"/>
            <select aria-label="Активная конфигурация" value={config} onChange={event => selectConfiguration(event.target.value)}>
              {!enabled.includes(config) && <option value={config} hidden>{config}</option>}
              {enabled.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <ChevronDown size={13} aria-hidden="true"/>
          </label>
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

      {section === '/' && <div className="page workspace">
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
              {layout.panels.map((panel, index) => {
                const tab = tabs.find(item => item.id === layout.active[index] && panel.includes(item.id));
                const terminalSession = tab?.sessionId ? sessions.find(item => item.id === tab.sessionId) : undefined;
                return <Fragment key={index}>
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
                              <button className="tab-select" aria-pressed={isActive} onClick={() => selectTab(index, id)}>
                                {tab.kind === 'terminal' ? <Terminal size={15}/> : <ArrowUpFromLine size={15}/>}<span>{tab.title}</span>
                              </button>
                              <button className="icon-button tab-close" title={'Закрыть вкладку ' + tab.title} aria-label={'Закрыть ' + tab.title} onClick={() => closeTab(id)}><X size={14}/></button>
                            </div>;
                          })}
                          <button className="icon-button tab-add" title="Показать экран выбора" aria-label="Показать экран выбора" onClick={() => selectTab(index, '')}><Plus size={17}/></button>
                          <div className="tab-spacer"/>
                          <button className="icon-button tab-tool" title="Развернуть или вернуть панель" aria-label="Развернуть или вернуть панель" onClick={() => setLayout(previous => ({ ...previous, maximized: previous.maximized === index ? null : index }))}><Maximize2 size={15}/></button>
                          {layout.panels.length > 1 && <button className="icon-button tab-tool" title="Убрать панель и перенести её вкладки" aria-label="Убрать панель" onClick={() => removePanel(index)}><Minus size={16}/></button>}
                        </div>

                        {tab ? <div className="panel-content" key={tab.id}>
                          {tab.kind === 'terminal' && tab.sessionId
                            ? <TerminalView key={tab.sessionId} sessionId={tab.sessionId} session={terminalSession} target={tab.target || tab.title} route={tab.route} settings={settings} onReconnect={id => reconnectTerminal(id, tab.target || tab.title, tab.route)} onTerminate={terminate} onDetach={() => removeTab(tab.id)} onEditConfig={() => editConfig(tab.target || tab.title)} onConfigSaved={setModel} onError={showError}/>
                            : <TransferView model={model} transfers={transfers} settings={settings} initialTarget={tab.target} initialRoute={tab.route} focusedId={tab.transferId} onCreated={transferId => setTabs(previous => previous.map(item => item.id === tab.id ? { ...item, transferId } : item))} onRefresh={reloadTransfers} onError={showError}/>}
                        </div> : <div className="empty-panel">
                          <div className="empty-content">
                            <div className="empty-connect">
                              <div className="empty-icon"><Terminal size={28}/></div>
                              <h2>{panel.length ? 'Подключение и передача файлов' : 'Нет открытых вкладок'}</h2>
                              <p>Подключитесь к хосту по SSH или откройте передачу файлов.</p>
                              <div className="empty-actions">
                                <button className="primary" onClick={() => browseHosts()}><Terminal size={16}/> Выбрать хост</button>
                                <button className="subtle" onClick={() => openTransfer('', '', index)}><ArrowUpFromLine size={16}/> Передать файлы</button>
                              </div>
                            </div>
                            {(resumableSessions.length > 0 || quickHosts.length > 0) && <section className="quick-hosts" aria-label="Быстрый доступ к хостам">
                              <h3>Быстрый доступ</h3>
                              {resumableSessions.length > 0 && <>
                                <h4>Открытые сессии</h4>
                                {resumableSessions.map(session => <button className="quick-host" key={session.id} onClick={() => showTerminalSession(session, index)}>
                                  <span className="host-avatar"><Terminal size={16}/></span>
                                  <span className="host-main"><strong>{session.target}</strong><small>{sessionLabel(session)}</small></span>
                                  <ArrowRight size={16}/>
                                </button>)}
                              </>}
                              {favoriteHosts.length > 0 && <h4>Избранные хосты</h4>}
                              {!favoriteHosts.length && quickHosts.length > 0 && resumableSessions.length > 0 && <h4>Хосты</h4>}
                              {quickHosts.map(name => {
                                const host = model!.nodes[name];
                                return <button className="quick-host" key={name} onClick={() => openTerminal(name, '', index)}>
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
                </Fragment>;
              })}
            </PanelGroup>
          </div>
          <div className="statusbar">
            <span><Terminal size={14}/> Сессии <strong>{activeSessions}</strong></span>
            <span><ArrowUpFromLine size={14}/> Передачи <strong>{activeTransfers}</strong></span>
            <span className="status-right">Файлы контейнера <code>/files</code></span>
          </div>
        </div>
      </div>}
      {section === '/hosts' && <HostsView model={model} sessions={sessions} selectedHost={hostToView} onSelectHost={browseHosts} openTerminal={openTerminal} onResumeSession={showTerminalSession} openTransfer={openTransfer} onEdit={editConfig} onError={showError}/>}
      {section === '/config' && <ConfigView onCreateConfiguration={openNewConfiguration} onDirty={onConfigDirty} model={model} theme={settings.theme} focusHost={focusHost} onSaved={setModel} openTerminal={openTerminal} openTransfer={openTransfer} onError={showError}/>}
      {section === '/vault' && <VaultView model={model} onError={showError}/>}
      {section === '/settings' && <SettingsView settings={settings} setSettings={setSettings} configurations={catalog.files} configurationError={catalogError} enabledConfigurations={enabled} onToggleConfiguration={toggleConfiguration} onRefreshConfigurations={refreshConfigurations} onCreateConfiguration={openNewConfiguration}/>}
      {!section && <div className="page"><div className="page-title"><h1>Страница не найдена</h1></div><Link to={url('/')} replace>Вернуться на рабочее место</Link></div>}
    </main>
  </div>;
}
