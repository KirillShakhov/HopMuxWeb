import { useConfiguration } from './ConfigurationContext';
import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type BeforeMount } from '@monaco-editor/react';
import { Background, Handle, MarkerType, Panel as FlowPanel, Position, ReactFlow, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Check, Code2, ExternalLink, FileCode2, GitBranch, HardDrive, Maximize2, Plus, Search, Settings2, Terminal, Trash2 } from 'lucide-react';
import { findDetourLane, GraphEdge, graphNodeSize } from './GraphEdge';
import { json, routeLabel, type Model, type Route, type SecretOperation, type Theme } from './lib';
import { VisualRoutes } from './VisualRoutes';
import { useVault, VaultBindingSelect } from './VaultView';
import { Link } from 'react-router';

type Props = {
  model: Model | null;
  onDirty: (dirty: boolean) => void;
  onCreateConfiguration: () => void;
  theme: Theme;
  focusHost?: string;
  onSaved: (model: Model) => void;
  openTerminal: (target: string, route: string) => void;
  openTransfer: (target: string, route: string) => void;
  onError: (error: unknown) => void;
};

type Mode = 'graph' | 'visual' | 'raw';
type Inspector = 'route' | 'host';
type VisualSection = 'hosts' | 'routes';
type AuthMethod = 'key' | 'agent' | 'inline' | 'env' | 'vault';
type AuthReference = 'key' | 'env' | 'vault';

const authReferences = {
  key: { field: 'key_file', label: 'путь к файлу ключа' },
  env: { field: 'password_env', label: 'имя переменной окружения' },
  vault: { field: 'password_vault', label: 'имя записи в хранилище' },
} as const;

const hostFields = [
  ['host', 'Адрес / IP'],
  ['user', 'Пользователь'],
  ['port', 'Порт'],
  ['host_key', 'Отпечаток SHA-256'],
] as const;

function previewSecretOperations(operations: Record<string, SecretOperation>) {
  return Object.fromEntries(Object.entries(operations).filter(([, operation]) => operation.action === 'remove'));
}

const editorThemes: Record<Theme, string> = { light: 'vs', dark: 'vs-dark', pickme: 'pickme' };
const definePickme: BeforeMount = monaco => monaco.editor.defineTheme('pickme', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#fff8fc',
    'editor.foreground': '#392638',
    'editor.lineHighlightBackground': '#f9edf7',
    'editor.selectionBackground': '#efd6f0',
    'editorCursor.foreground': '#a12a72',
  },
});

const nodeTypes = {
  host: ({ data }: { data: { label: string; local?: boolean; selected?: boolean; onRoute?: boolean; dim?: boolean } }) =>
    <div className={'graph-node ' + (data.local ? 'local ' : '') + (data.selected ? 'selected ' : '') + (data.onRoute ? 'on-route ' : '') + (data.dim ? 'dim' : '')}>
      <Handle type="target" position={Position.Left}/><span title={data.label}>{data.label}</span><Handle type="source" position={Position.Right}/>
    </div>,
};
const edgeTypes = { detour: GraphEdge };

function graphElements(model: Model | null, selectedRoute: string, selectedHost: string) {
  if (!model) return { nodes: [] as Node[], edges: [] as Edge[] };
  const active = model.routes.find(route => route.name === selectedRoute);
  const routeNodes = new Set(active ? ['local', ...active.hops] : []);
  const routeEdges = new Set<string>();
  if (active) ['local', ...active.hops].slice(0, -1).forEach((from, index) => routeEdges.add(from + '\0' + ['local', ...active.hops][index + 1]));

  const adjacency = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  for (const name of Object.keys(model.nodes)) incoming.set(name, 0);
  incoming.set('local', 0);
  for (const route of model.routes.filter(route => !route.disabled)) {
    const chain = ['local', ...route.hops];
    for (let i = 0; i < chain.length - 1; i++) {
      const edges = adjacency.get(chain[i]) || new Set<string>();
      if (!edges.has(chain[i + 1])) {
        edges.add(chain[i + 1]);
        incoming.set(chain[i + 1], (incoming.get(chain[i + 1]) || 0) + 1);
      }
      adjacency.set(chain[i], edges);
    }
  }
  const depths = new Map<string, number>([['local', 0]]);
  const queue = [...incoming].filter(([, count]) => count === 0).map(([name]) => name);
  while (queue.length) {
    const from = queue.shift()!;
    for (const to of adjacency.get(from) || []) {
      depths.set(to, Math.max(depths.get(to) || 1, (depths.get(from) || 0) + 1));
      incoming.set(to, (incoming.get(to) || 0) - 1);
      if (incoming.get(to) === 0) queue.push(to);
    }
  }
  const groups = new Map<number, string[]>();
  for (const name of Object.keys(model.nodes)) {
    const depth = depths.get(name) || 1;
    groups.set(depth, [...(groups.get(depth) || []), name]);
  }
  const nodes: Node[] = [{ id: 'local', type: 'host', ...graphNodeSize, position: { x: 20, y: 50 }, data: { label: 'Local', local: true, onRoute: !!active } }];
  for (const [depth, names] of [...groups].sort(([a], [b]) => a - b)) {
    names.sort((a, b) => {
      const rank = (name: string) => model.routes.findIndex(route => route.hops.includes(name));
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    names.forEach((name, index) => nodes.push({
      id: name, type: 'host', ...graphNodeSize, position: { x: depth * 205 + 20, y: index * 92 + 50 },
      data: { label: name, selected: selectedHost === name, onRoute: routeNodes.has(name), dim: !!active && !routeNodes.has(name) },
    }));
  }
  const nodePositions = new Map(nodes.map(node => [node.id, node.position]));
  const obstacles = [...nodePositions.values()];
  const edges: Edge[] = [];
  for (const [from, tos] of adjacency) for (const to of tos) {
    const source = nodePositions.get(from);
    const target = nodePositions.get(to);
    if (!source || !target) continue;
    const lane = findDetourLane(source, target, obstacles);
    const selected = routeEdges.has(from + '\0' + to);
    const color = selected ? 'var(--accent)' : 'var(--graph-edge)';
    edges.push({ id: from + '→' + to, source: from, target: to,
      type: lane === undefined ? 'smoothstep' : 'detour', data: lane === undefined ? undefined : { lane }, zIndex: selected ? 10 : 0,
      animated: selected, markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      style: { stroke: color, strokeWidth: selected ? 3.2 : 1.5, opacity: active && !selected ? .16 : .82 },
    });
  }
  return { nodes, edges };
}

export function ConfigView({ onCreateConfiguration, onDirty, model, theme, focusHost, onSaved, openTerminal, openTransfer, onError }: Props) {
  const { api, config, url } = useConfiguration();
  const { selection: vaultSelection, status: vaultStatus, refresh: refreshVault, askUnlock } = useVault();
  useEffect(() => { refreshVault().catch(() => {}); }, [refreshVault]);
  const [stackGraph, setStackGraph] = useState(() => matchMedia('(max-width: 650px)').matches);
  const [mode, setMode] = useState<Mode>('graph');
  const [visualSection, setVisualSection] = useState<VisualSection>('hosts');
  const [rawText, setRawText] = useState('');
  const [visual, setVisual] = useState<Model | null>(null);

  useEffect(() => {
    const query = matchMedia('(max-width: 650px)');
    const resize = (event: MediaQueryListEvent) => setStackGraph(event.matches);
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);
  const [visualDirty, setVisualDirty] = useState(false);
  const [secretOperations, setSecretOperations] = useState<Record<string, SecretOperation>>({});
  const [authMethods, setAuthMethods] = useState<Partial<Record<string, AuthMethod>>>({});
  const [selectedHost, setSelectedHost] = useState('');
  const [selectedRoute, setSelectedRoute] = useState('');
  const [inspector, setInspector] = useState<Inspector>('route');
  const [routeSearch, setRouteSearch] = useState('');
  const [routeTarget, setRouteTarget] = useState('');
  const [newHost, setNewHost] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const flow = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!model) return;
    setRawText(model.text);
    setVisual(structuredClone(model));
    setVisualDirty(false);
    setSecretOperations({});
    setAuthMethods({});
    if (model.parse_error) { setMode('raw'); setMessage(model.parse_error); }
  }, [model?.version]);
  useEffect(() => {
    if (focusHost !== undefined) {
      setSelectedHost(focusHost);
      setInspector('host');
      setVisualSection('hosts');
      setMode('visual');
    }
  }, [focusHost]);

  const missingAuthReference = Object.entries(authMethods).find(([name, method]) =>
    (method === 'key' || method === 'env' || method === 'vault') && !visual?.nodes[name]?.[authReferences[method].field]);
  const dirty = !!model && (rawText !== model.text || visualDirty || Object.keys(secretOperations).length > 0 || !!missingAuthReference);
  useEffect(() => {
    onDirty(dirty);
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => {
      onDirty(false);
      window.removeEventListener('beforeunload', guard);
    };
  }, [dirty, onDirty]);

  const compose = async (working = visual, text = rawText) => {
    if (!working) throw new Error('Конфигурация ещё не загружена');
    const result = await api<Model>('/config/compose', json('POST', { text, model: working, legacy: working.legacy, secret_operations: previewSecretOperations(secretOperations) }));
    setRawText(result.text);
    setVisual(result);
    setVisualDirty(false);
    return result;
  };
  const preview = async (text = rawText) => {
    const result = await api<Model>('/config/preview', json('POST', { text, secret_operations: previewSecretOperations(secretOperations) }));
    if (result.parse_error) throw new Error(result.parse_error);
    setVisual(result);
    return result;
  };
  useEffect(() => {
    if (mode !== 'visual' || !visualDirty || !visual) return;
    const current = ++generation.current;
    const timer = window.setTimeout(() => {
      api<Model>('/config/compose', json('POST', { text: rawText, model: visual, legacy: visual.legacy, secret_operations: previewSecretOperations(secretOperations) }))
        .then(result => { if (generation.current === current) { setRawText(result.text); setVisual(result); setVisualDirty(false); setMessage(''); } })
        .catch(error => { if (generation.current === current) setMessage(error.message); });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [visual, visualDirty, mode, secretOperations]);
  useEffect(() => {
    if (mode !== 'raw' || !rawText || rawText === model?.text) return;
    const current = ++generation.current;
    const timer = window.setTimeout(() => {
      api<Model>('/config/preview', json('POST', { text: rawText, secret_operations: previewSecretOperations(secretOperations) }))
        .then(result => { if (generation.current === current) { setVisual(result); setMessage(result.parse_error || ''); } })
        .catch(error => { if (generation.current === current) setMessage(error.message); });
    }, 550);
    return () => window.clearTimeout(timer);
  }, [rawText, mode, secretOperations]);

  const validateAuthDrafts = () => {
    for (const [name, operation] of Object.entries(secretOperations)) {
      if (operation.action === 'replace' && !operation.value) throw new Error(`Введите пароль для хоста ${name}`);
    }
    const [name, method] = missingAuthReference || [];
    if (method === 'key' || method === 'env' || method === 'vault')
      throw new Error(`Укажите ${authReferences[method].label} для хоста ${name}`);
  };
  const switchMode = async (next: Mode) => {
    if (next === mode || busy) return;
    setBusy(true);
    try {
      generation.current++;
      if (mode === 'visual') validateAuthDrafts();
      if (mode === 'visual' && visualDirty) await compose();
      if (mode === 'raw' && next !== 'raw') await preview();
      if (next === 'raw') setAuthMethods({});
      setMode(next);
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!model) return;
    setBusy(true);
    try {
      generation.current++;
      validateAuthDrafts();
      const candidate = visualDirty ? (await compose()).text : rawText;
      const updated = await api<Model>('/config', json('PUT', { text: candidate, version: model.version, secret_operations: secretOperations }));
      onSaved(updated);
      setMessage(`Сохранено. Предыдущая версия находится в ${config}.bak`);
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true);
    try {
      generation.current++;
      validateAuthDrafts();
      const candidate = visualDirty ? (await compose()).text : rawText;
      const result = await api<{ message: string }>('/config/check', json('POST', { text: candidate, secret_operations: secretOperations }));
      setMessage(result.message);
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const changeVisual = (change: (previous: Model) => Model) => {
    generation.current++;
    setVisual(previous => previous ? change(previous) : previous);
    setVisualDirty(true);
    setMessage('');
  };
  const changeHost = (name: string, key: string, value: unknown) => changeVisual(previous => ({ ...previous, nodes: { ...previous.nodes, [name]: { ...previous.nodes[name], [key]: value } } }));
  const changeSecretOperation = (name: string, operation?: SecretOperation) => {
    generation.current++;
    setSecretOperations(previous => {
      if (operation) return { ...previous, [name]: operation };
      const updated = { ...previous };
      delete updated[name];
      return updated;
    });
    setMessage('');
  };
  const changeAuthMethod = (method: AuthMethod) => {
    setAuthMethods(previous => ({ ...previous, [selectedHost]: method }));
    changeVisual(previous => {
      const host = previous.nodes[selectedHost];
      return { ...previous, nodes: { ...previous.nodes, [selectedHost]: {
        ...host,
        agent: method === 'agent' ? true : undefined,
        key_file: method === 'key' ? host.key_file : undefined,
        key_passphrase_env: method === 'key' ? host.key_passphrase_env : undefined,
        password_env: method === 'env' ? host.password_env : undefined,
        password_vault: method === 'vault' ? host.password_vault : undefined,
      } } };
    });
    const hasSavedPassword = !!model?.nodes[selectedHost]?.has_inline_password;
    if (method === 'inline') changeSecretOperation(selectedHost, hasSavedPassword ? undefined : { action: 'replace' });
    else changeSecretOperation(selectedHost, hasSavedPassword ? { action: 'remove' } : undefined);
  };
  const changeAuthReference = (method: AuthReference, value: string) => {
    setAuthMethods(previous => ({ ...previous, [selectedHost]: method }));
    changeHost(selectedHost, authReferences[method].field, value);
  };
  const addHost = () => {
    const name = newHost.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name) || Object.hasOwn(visual?.nodes || {}, name)) { onError(new Error('Нужен новый alias из букв, цифр, _ или -')); return; }
    changeVisual(previous => ({ ...previous, nodes: { ...previous.nodes, [name]: { host: '', user: '', port: 22, agent: true } } }));
    setSelectedHost(name); setInspector('host'); setNewHost('');
  };
  const removeHost = () => {
    if (!visual) return;
    const used = visual.paths.some(path => path.includes(selectedHost)) || visual.direct_hosts.includes(selectedHost) || visual.routes.some(route => route.hops.includes(selectedHost));
    if (!confirm(used ? `Хост ${selectedHost} используется в маршрутах. Удалить его и связанные пути?` : `Удалить хост ${selectedHost}?`)) return;
    changeVisual(previous => {
      const nodes = { ...previous.nodes }; delete nodes[selectedHost];
      return { ...previous, nodes, direct_hosts: previous.direct_hosts.filter(name => name !== selectedHost), paths: previous.paths.filter(path => !path.includes(selectedHost)), routes: previous.routes.filter(route => !route.hops.includes(selectedHost)) };
    });
    setAuthMethods(previous => {
      const updated = { ...previous };
      delete updated[selectedHost];
      return updated;
    });
    changeSecretOperation(selectedHost, model?.nodes[selectedHost]?.has_inline_password ? { action: 'remove' } : undefined);
    setSelectedHost('');
  };

  const { nodes, edges } = useMemo(() => graphElements(visual, selectedRoute, selectedHost), [visual, selectedRoute, selectedHost]);
  const route = visual?.routes.find(item => item.name === selectedRoute);
  const host = selectedHost ? visual?.nodes[selectedHost] : undefined;
  const filteredRoutes = visual?.routes.filter(item => (!routeTarget || item.target === routeTarget) && (item.name + item.target + item.hops.join(' ')).toLowerCase().includes(routeSearch.toLowerCase())) || [];
  const chooseRoute = (item: Route) => {
    setSelectedRoute(item.name); setInspector('route');
    const ids = new Set(['local', ...item.hops]);
    window.setTimeout(() => flow.current?.fitView({ nodes: nodes.filter(node => ids.has(node.id)), duration: 250, padding: .25 }), 0);
  };
  const secretOperation = secretOperations[selectedHost];
  const hasSavedPassword = secretOperation?.action !== 'remove' && !!model?.nodes[selectedHost]?.has_inline_password;
  const preferredAuthMethod = Object.hasOwn(authMethods, selectedHost) ? authMethods[selectedHost] : undefined;
  const authMethod = preferredAuthMethod ??
    (host?.password_env ? 'env' : host?.password_vault ? 'vault' : hasSavedPassword || secretOperation?.action === 'replace' ? 'inline'
      : host?.key_file ? 'key' : host?.agent ? 'agent' : '');

  return <div className="page config-page">
    <div className="page-title"><div><h1>Конфигурация {dirty && <span className="dirty-dot" title="Есть несохранённые изменения" aria-label="Есть несохранённые изменения"/>}</h1><p>Хосты, маршруты и исходный TOML</p></div><div className="title-actions"><button className="subtle" disabled={busy} onClick={onCreateConfiguration}><Plus size={16}/> Создать конфигурацию</button><button className="subtle" disabled={busy} onClick={check}><Check size={16}/> Проверить</button><button className="primary" disabled={busy || !model || !dirty} onClick={save}>{busy ? 'Подождите…' : 'Сохранить'}</button></div></div>
    <div className="config-toolbar"><div className="segmented"><button className={mode === 'graph' ? 'on' : ''} onClick={() => switchMode('graph')}><GitBranch size={15}/> Граф</button><button className={mode === 'visual' ? 'on' : ''} onClick={() => switchMode('visual')}><Settings2 size={15}/> Визуально</button><button className={mode === 'raw' ? 'on' : ''} onClick={() => switchMode('raw')}><Code2 size={15}/> TOML</button></div><span className={message && !message.startsWith('Сохранено') && !message.startsWith('config OK') ? 'config-error' : ''}>{message}</span></div>
    {vaultSelection && <div className="config-vault-settings">
      <VaultBindingSelect disabled={busy} onError={onError}/>
    </div>}
    {mode === 'graph' && <div className="graph-layout"><PanelGroup key={stackGraph ? 'vertical' : 'horizontal'} direction={stackGraph ? 'vertical' : 'horizontal'}><Panel minSize={stackGraph ? 35 : 48} defaultSize={stackGraph ? 55 : 72}><div className="graph-canvas"><ReactFlow colorMode={theme === 'dark' ? 'dark' : 'light'} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance; }} onNodeClick={(_, node) => { if (node.id !== 'local') { setSelectedHost(node.id); setInspector('host'); } }} fitView minZoom={.2} maxZoom={2}><Background color="var(--graph-dot)" gap={22}/><FlowPanel position="top-left" className="graph-tools"><button title="Показать весь граф" onClick={() => flow.current?.fitView({ duration: 250, padding: .2 })}><Maximize2 size={15}/> Весь граф</button><button title="Сбросить масштаб" onClick={() => flow.current?.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 250 })}>100%</button><button title="Приблизить" onClick={() => flow.current?.zoomIn({ duration: 200 })}>+</button><button title="Отдалить" onClick={() => flow.current?.zoomOut({ duration: 200 })}>−</button></FlowPanel></ReactFlow><div className="graph-legend"><span className="legend-line"/> Стрелки показывают настроенные переходы</div></div></Panel><PanelResizeHandle className={stackGraph ? 'resize-handle vertical' : 'resize-handle'}/><Panel minSize={stackGraph ? 30 : 20} defaultSize={stackGraph ? 45 : 28}><div className="graph-side"><div className="side-heading">Маршруты <span>{filteredRoutes.length}</span></div><div className="graph-filter"><div className="search"><Search size={15}/><input aria-label="Поиск маршрута" placeholder="Маршрут или хост" value={routeSearch} onChange={event => setRouteSearch(event.target.value)}/></div><select aria-label="Фильтр по цели" value={routeTarget} onChange={event => setRouteTarget(event.target.value)}><option value="">Все цели</option>{[...new Set(visual?.routes.map(item => item.target) || [])].sort().map(target => <option key={target}>{target}</option>)}</select></div><div className="graph-route-list">{filteredRoutes.map(item => <button key={item.name} className={selectedRoute === item.name ? 'active' : ''} onClick={() => chooseRoute(item)}><GitBranch size={15}/><span><strong>{item.name}</strong><small>{routeLabel(item)}</small></span></button>)}</div><div className="graph-inspector"><div className="inspector-tabs"><button className={inspector === 'route' ? 'active' : ''} onClick={() => setInspector('route')}>Маршрут</button><button className={inspector === 'host' ? 'active' : ''} onClick={() => setInspector('host')}>Хост</button></div>{inspector === 'route' ? route ? <div className="inspector-body"><h3>{route.name}</h3><p>Цель: <strong>{route.target}</strong></p><ol>{['local', ...route.hops].map((hop, index) => <li key={index}>{hop}</li>)}</ol><div className="inspector-actions"><button onClick={() => openTerminal(route.target, route.name)}><Terminal size={14}/> Терминал</button><button onClick={() => openTransfer(route.target, route.name)}><ExternalLink size={14}/> Файлы</button></div></div> : <p className="inspector-empty">Выберите маршрут, чтобы увидеть точную цепочку.</p> : host ? <div className="inspector-body"><h3>{selectedHost}</h3><p>{host.user}@{host.host}:{host.port || 22}</p><p>Маршрутов: {visual?.routes.filter(item => item.target === selectedHost).length || 0}</p><div className="inspector-actions"><button onClick={() => openTerminal(selectedHost, '')}><Terminal size={14}/> Терминал</button><button onClick={() => openTransfer(selectedHost, '')}><ExternalLink size={14}/> Файлы</button><button onClick={() => { setVisualSection('hosts'); switchMode('visual'); }}><Settings2 size={14}/> Изменить</button></div></div> : <p className="inspector-empty">Выберите узел графа или хост слева.</p>}</div></div></Panel></PanelGroup></div>}
    {mode === 'visual' && <div className="visual-shell">
      <div className="segmented visual-section-switch" role="group" aria-label="Разделы визуального редактора">
        <button className={visualSection === 'hosts' ? 'on' : ''} aria-pressed={visualSection === 'hosts'} onClick={() => setVisualSection('hosts')}><HardDrive size={15}/> Хосты</button>
        <button className={visualSection === 'routes' ? 'on' : ''} aria-pressed={visualSection === 'routes'} onClick={() => setVisualSection('routes')}><GitBranch size={15}/> Маршруты</button>
      </div>
      <fieldset className="visual-content" disabled={busy || !visual}>
        {visualSection === 'hosts' ? <div className="visual-layout">
          <div className="card visual-list">
            <div className="side-heading">Хосты <span>{Object.keys(visual?.nodes || {}).length}</span></div>
            <div className="visual-add">
              <input aria-label="Имя нового хоста" placeholder="Имя нового хоста" autoFocus={focusHost === ''} value={newHost}
                onChange={event => setNewHost(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addHost(); }}/>
              <button title="Добавить хост" aria-label="Добавить хост" disabled={!newHost.trim()} onClick={addHost}><Plus size={16}/></button>
            </div>
            {Object.keys(visual?.nodes || {}).sort().map(name => <button key={name} className={selectedHost === name ? 'active' : ''}
              aria-pressed={selectedHost === name} onClick={() => { setSelectedHost(name); setInspector('host'); }}>
              <HardDrive size={16}/>{name}
            </button>)}
          </div>
          <section className="card visual-editor">
            <div className="section-head">
              <h2>{host ? selectedHost : 'Параметры хоста'}</h2>
              {host && <button className="danger" onClick={removeHost}><Trash2 size={14}/> Удалить хост</button>}
            </div>
            {host ? <>
              <div className="form-grid host-fields">
                {hostFields.map(([key, label]) => <label key={key}>{label}
                  <input type={key === 'port' ? 'number' : 'text'} value={String(host[key] ?? '')}
                    onChange={event => changeHost(selectedHost, key, key === 'port' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
                    placeholder={key === 'host_key' ? 'SHA256:…' : undefined}/>
                </label>)}
              </div>
              <fieldset className="secret-field">
                <legend>Аутентификация SSH</legend>
                <div className="form-grid password-fields">
                  <label>Способ входа
                    <select value={authMethod} onChange={event => changeAuthMethod(event.target.value as AuthMethod)}>
                      <option value="" disabled>Выберите способ</option>
                      <option value="agent">SSH-агент</option>
                      <option value="key">SSH-ключ</option>
                      <option value="inline">Встроенный пароль</option>
                      <option value="env">Переменная окружения</option>
                      <option value="vault">Хранилище mssh</option>
                    </select>
                  </label>
                  {authMethod === 'key' && <label>Файл ключа
                    <input required spellCheck={false} value={host.key_file || ''} placeholder="~/.ssh/id_ed25519"
                      onChange={event => changeAuthReference('key', event.target.value)}/>
                    <small>Путь к приватному ключу внутри контейнера.</small>
                  </label>}
                  {authMethod === 'inline' && <>
                    {secretOperation?.action === 'replace' ? <div className="password-value">
                      <label>{hasSavedPassword ? 'Новый пароль' : 'Пароль'}
                        <input type="password" autoComplete="new-password" required value={secretOperation.value || ''}
                          onChange={event => changeSecretOperation(selectedHost, { action: 'replace', value: event.target.value })}/>
                      </label>
                      {hasSavedPassword && <button className="text-action" onClick={() => changeSecretOperation(selectedHost)}>Отменить замену</button>}
                    </div> : <div className="password-saved">
                      <span className="secret-status">Пароль задан</span>
                      <button className="subtle" onClick={() => changeSecretOperation(selectedHost, { action: 'replace' })}>Заменить пароль</button>
                    </div>}
                  </>}
                  {authMethod === 'env' && <label>Имя переменной окружения
                    <input required spellCheck={false} value={host.password_env || ''} placeholder="SSH_PASSWORD"
                      onChange={event => changeAuthReference('env', event.target.value)}/>
                    <small>Переменная должна быть доступна внутри контейнера.</small>
                  </label>}
                  {authMethod === 'vault' && <div className="vault-entry-field">
                    <label>Запись в хранилище
                      <select aria-label="Запись в хранилище" value={host.password_vault || ''} disabled={!vaultStatus?.unlocked || !vaultStatus.entries.length}
                        onChange={event => changeAuthReference('vault', event.target.value)}>
                        <option value="" disabled>Выберите запись</option>
                        {host.password_vault && !vaultStatus?.entries.includes(host.password_vault)
                          && <option value={host.password_vault} disabled>{host.password_vault}{vaultStatus?.unlocked ? ' · недоступна' : ''}</option>}
                        {(vaultStatus?.entries ?? []).map(name => <option value={name} key={name}>{name}</option>)}
                      </select>
                    </label>
                    {vaultStatus?.exists && !vaultStatus.unlocked
                      ? <button type="button" className="text-action" onClick={() => void askUnlock()}>Разблокировать хранилище</button>
                      : !vaultStatus?.entries.length && <Link className="text-action" to={url('/vault')}>{vaultStatus?.unlocked ? 'Добавить запись' : 'Открыть хранилище'}</Link>}
                  </div>}
                </div>
                {authMethod === 'inline' && <p className="password-hint">Сохранённое значение скрыто в интерфейсе и редакторе TOML.</p>}
                {authMethod === 'agent' && <p className="password-hint">Ключи берутся из SSH-агента, доступного внутри контейнера.</p>}
              </fieldset>
            </> : <div className="details-empty"><HardDrive size={30}/><h3>Выберите или добавьте хост</h3></div>}
          </section>
        </div> : visual && <VisualRoutes model={visual} onChange={changeVisual}/>}
      </fieldset>
    </div>}
    {mode === 'raw' && <div className="raw-editor"><div className="raw-head"><FileCode2 size={16}/> {config} {dirty && <span>● Несохранённые изменения</span>}</div><div className="raw-notice">Встроенные пароли скрыты из текста. При сохранении прежние значения остаются на сервере; пароли настраиваются в разделе «Визуально → Хосты».</div><Editor language="toml" beforeMount={definePickme} theme={editorThemes[theme]} wrapperProps={{ className: 'raw-editor-body' }} value={rawText} onChange={value => { generation.current++; setRawText(value || ''); setMessage(''); }} options={{ readOnly: busy, fontSize: 14, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, lineNumbers: 'on', wordWrap: 'on' }}/><div className="raw-foot">Сначала проверка CLI, затем атомарная запись и резервная копия</div></div>}
  </div>;
}

