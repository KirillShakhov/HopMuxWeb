import { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Background, Handle, MarkerType, Panel as FlowPanel, Position, ReactFlow, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowDown, ArrowRight, ArrowUp, Check, Code2, ExternalLink, FileCode2, GitBranch, HardDrive, Maximize2, Plus, Search, Settings2, Terminal, Trash2, X } from 'lucide-react';
import { api, json, routeLabel, type Model, type Route, type SecretOperation } from './lib';

type Props = {
  model: Model | null;
  theme: 'dark' | 'light';
  focusHost?: string;
  onSaved: (model: Model) => void;
  openTerminal: (target: string, route: string) => void;
  openTransfer: (target: string, route: string) => void;
  onError: (error: unknown) => void;
};

type Mode = 'graph' | 'visual' | 'raw';
type Inspector = 'route' | 'host';

const nodeTypes = {
  host: ({ data }: { data: { label: string; local?: boolean; selected?: boolean; onRoute?: boolean; dim?: boolean } }) =>
    <div className={'graph-node ' + (data.local ? 'local ' : '') + (data.selected ? 'selected ' : '') + (data.onRoute ? 'on-route ' : '') + (data.dim ? 'dim' : '')}>
      <Handle type="target" position={Position.Left}/>{data.label}<Handle type="source" position={Position.Right}/>
    </div>,
};

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
  const nodes: Node[] = [{ id: 'local', type: 'host', position: { x: 20, y: 50 }, data: { label: 'Local', local: true, onRoute: !!active } }];
  for (const [depth, names] of [...groups].sort(([a], [b]) => a - b)) {
    names.sort((a, b) => {
      const rank = (name: string) => model.routes.findIndex(route => route.hops.includes(name));
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    names.forEach((name, index) => nodes.push({
      id: name, type: 'host', position: { x: depth * 205 + 20, y: index * 92 + 50 },
      data: { label: name, selected: selectedHost === name, onRoute: routeNodes.has(name), dim: !!active && !routeNodes.has(name) },
    }));
  }
  const edges: Edge[] = [];
  for (const [from, tos] of adjacency) for (const to of tos) {
    const selected = routeEdges.has(from + '\0' + to);
    edges.push({ id: from + '→' + to, source: from, target: to, type: 'smoothstep', zIndex: selected ? 10 : 0,
      animated: selected, markerEnd: { type: MarkerType.ArrowClosed, color: selected ? '#15b7a5' : '#718a98', width: 14, height: 14 },
      style: { stroke: selected ? '#15b7a5' : '#718a98', strokeWidth: selected ? 3.2 : 1.5, opacity: active && !selected ? .16 : .82 },
    });
  }
  return { nodes, edges };
}

export function ConfigView({ model, theme, focusHost, onSaved, openTerminal, openTransfer, onError }: Props) {
  const [mode, setMode] = useState<Mode>('graph');
  const [rawText, setRawText] = useState('');
  const [visual, setVisual] = useState<Model | null>(null);
  const [visualDirty, setVisualDirty] = useState(false);
  const [secretOperations, setSecretOperations] = useState<Record<string, SecretOperation>>({});
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
    if (model.parse_error) { setMode('raw'); setMessage(model.parse_error); }
  }, [model?.version]);
  useEffect(() => { if (focusHost) { setSelectedHost(focusHost); setInspector('host'); setMode('visual'); } }, [focusHost]);

  const dirty = !!model && (rawText !== model.text || visualDirty || Object.keys(secretOperations).length > 0);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const compose = async (working = visual, text = rawText) => {
    if (!working) throw new Error('Конфигурация ещё не загружена');
    const result = await api<Model>('/config/compose', json('POST', { text, model: working, legacy: working.legacy, secret_operations: secretOperations }));
    setRawText(result.text);
    setVisual(result);
    setVisualDirty(false);
    return result;
  };
  const preview = async (text = rawText) => {
    const result = await api<Model>('/config/preview', json('POST', { text, secret_operations: secretOperations }));
    if (result.parse_error) throw new Error(result.parse_error);
    setVisual(result);
    return result;
  };
  useEffect(() => {
    if (mode !== 'visual' || !visualDirty || !visual) return;
    const current = ++generation.current;
    const timer = window.setTimeout(() => {
      api<Model>('/config/compose', json('POST', { text: rawText, model: visual, legacy: visual.legacy, secret_operations: secretOperations }))
        .then(result => { if (generation.current === current) { setRawText(result.text); setVisual(result); setVisualDirty(false); setMessage(''); } })
        .catch(error => { if (generation.current === current) setMessage(error.message); });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [visual, visualDirty, mode, secretOperations]);
  useEffect(() => {
    if (mode !== 'raw' || !rawText || rawText === model?.text) return;
    const current = ++generation.current;
    const timer = window.setTimeout(() => {
      api<Model>('/config/preview', json('POST', { text: rawText, secret_operations: secretOperations }))
        .then(result => { if (generation.current === current) { setVisual(result); setMessage(result.parse_error || ''); } })
        .catch(error => { if (generation.current === current) setMessage(error.message); });
    }, 550);
    return () => window.clearTimeout(timer);
  }, [rawText, mode, secretOperations]);

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    try {
      generation.current++;
      if (mode === 'visual' && visualDirty) await compose();
      if (mode === 'raw' && next !== 'raw') await preview();
      setMode(next);
    } catch (error) { onError(error); }
  };
  const save = async () => {
    if (!model) return;
    setBusy(true);
    try {
      generation.current++;
      const candidate = visualDirty ? (await compose()).text : rawText;
      const updated = await api<Model>('/config', json('PUT', { text: candidate, version: model.version, secret_operations: secretOperations }));
      onSaved(updated);
      setMessage('Сохранено. Предыдущая версия находится в config.toml.bak');
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true);
    try {
      generation.current++;
      const candidate = visualDirty ? (await compose()).text : rawText;
      const result = await api<{ message: string }>('/config/check', json('POST', { text: candidate, secret_operations: secretOperations }));
      setMessage(result.message);
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const changeVisual = (change: (previous: Model) => Model) => {
    setVisual(previous => previous ? change(previous) : previous);
    setVisualDirty(true);
    setMessage('');
  };
  const changeHost = (name: string, key: string, value: unknown) => changeVisual(previous => ({ ...previous, nodes: { ...previous.nodes, [name]: { ...previous.nodes[name], [key]: value } } }));
  const addHost = () => {
    const name = newHost.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name) || visual?.nodes[name]) { onError(new Error('Нужен новый alias из букв, цифр, _ или -')); return; }
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
  const updatePath = (index: number, path: string[]) => changeVisual(previous => ({ ...previous, paths: previous.paths.map((old, i) => i === index ? path : old) }));
  const updateLegacyRoute = (index: number, fields: Partial<Route>) => changeVisual(previous => ({ ...previous, routes: previous.routes.map((old, i) => i === index ? { ...old, ...fields } : old) }));
  const secretAction = selectedHost ? secretOperations[selectedHost]?.action || 'keep' : 'keep';

  return <div className="page config-page">
    <div className="page-title"><div><div className="eyebrow">ТОПОЛОГИЯ И НАСТРОЙКА</div><h1>Конфигурация {dirty && <span className="dirty-dot" title="Есть несохранённые изменения">●</span>}</h1><p>Хосты, маршруты и исходный TOML</p></div><div className="title-actions"><button className="subtle" disabled={busy} onClick={check}><Check size={16}/> Проверить</button><button className="primary" disabled={busy || !model || !dirty} onClick={save}>{busy ? 'Подождите…' : 'Сохранить'}</button></div></div>
    <div className="config-toolbar"><div className="segmented"><button className={mode === 'graph' ? 'on' : ''} onClick={() => switchMode('graph')}><GitBranch size={15}/> Граф</button><button className={mode === 'visual' ? 'on' : ''} onClick={() => switchMode('visual')}><Settings2 size={15}/> Визуально</button><button className={mode === 'raw' ? 'on' : ''} onClick={() => switchMode('raw')}><Code2 size={15}/> TOML</button></div><span className={message && !message.startsWith('Сохранено') && !message.startsWith('config OK') ? 'config-error' : ''}>{message}</span></div>
    {mode === 'graph' && <div className="graph-layout new-graph-layout"><PanelGroup direction="horizontal"><Panel minSize={48} defaultSize={72}><div className="graph-canvas"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance; }} onNodeClick={(_, node) => { if (node.id !== 'local') { setSelectedHost(node.id); setInspector('host'); } }} fitView minZoom={.2} maxZoom={2}><Background color={theme === 'light' ? '#d9e3e7' : '#27323d'} gap={22}/><FlowPanel position="top-left" className="graph-tools"><button title="Показать весь граф" onClick={() => flow.current?.fitView({ duration: 250, padding: .2 })}><Maximize2 size={15}/> Весь граф</button><button title="Сбросить масштаб" onClick={() => flow.current?.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 250 })}>100%</button><button title="Приблизить" onClick={() => flow.current?.zoomIn({ duration: 200 })}>+</button><button title="Отдалить" onClick={() => flow.current?.zoomOut({ duration: 200 })}>−</button></FlowPanel></ReactFlow><div className="graph-legend"><span className="legend-line"/> Стрелки показывают настроенные переходы</div></div></Panel><PanelResizeHandle className="resize-handle"/><Panel minSize={20} defaultSize={28}><div className="graph-side"><div className="side-heading">МАРШРУТЫ <span>{filteredRoutes.length}</span></div><div className="graph-filter"><div className="search"><Search size={15}/><input aria-label="Поиск маршрута" placeholder="Маршрут или хост" value={routeSearch} onChange={event => setRouteSearch(event.target.value)}/></div><select aria-label="Фильтр по цели" value={routeTarget} onChange={event => setRouteTarget(event.target.value)}><option value="">Все цели</option>{[...new Set(visual?.routes.map(item => item.target) || [])].sort().map(target => <option key={target}>{target}</option>)}</select></div><div className="graph-route-list">{filteredRoutes.map(item => <button key={item.name} className={selectedRoute === item.name ? 'active' : ''} onClick={() => chooseRoute(item)}><GitBranch size={15}/><span><strong>{item.name}</strong><small>{routeLabel(item)}</small></span></button>)}</div><div className="graph-inspector"><div className="inspector-tabs"><button className={inspector === 'route' ? 'active' : ''} onClick={() => setInspector('route')}>Маршрут</button><button className={inspector === 'host' ? 'active' : ''} onClick={() => setInspector('host')}>Хост</button></div>{inspector === 'route' ? route ? <div className="inspector-body"><h3>{route.name}</h3><p>Цель: <strong>{route.target}</strong></p><ol>{['local', ...route.hops].map((hop, index) => <li key={index}>{hop}</li>)}</ol><div className="inspector-actions"><button onClick={() => openTerminal(route.target, route.name)}><Terminal size={14}/> Терминал</button><button onClick={() => openTransfer(route.target, route.name)}><ExternalLink size={14}/> Файлы</button></div></div> : <p className="inspector-empty">Выберите маршрут, чтобы увидеть точную цепочку.</p> : host ? <div className="inspector-body"><h3>{selectedHost}</h3><p>{host.user}@{host.host}:{host.port || 22}</p><p>Маршрутов: {visual?.routes.filter(item => item.target === selectedHost).length || 0}</p><div className="inspector-actions"><button onClick={() => openTerminal(selectedHost, '')}><Terminal size={14}/> Терминал</button><button onClick={() => openTransfer(selectedHost, '')}><ExternalLink size={14}/> Файлы</button><button onClick={() => switchMode('visual')}><Settings2 size={14}/> Изменить</button></div></div> : <p className="inspector-empty">Выберите узел графа или хост слева.</p>}</div></div></Panel></PanelGroup></div>}
    {mode === 'visual' && <div className="visual-layout"><div className="card visual-list"><div className="side-heading">ХОСТЫ <span>{Object.keys(visual?.nodes || {}).length}</span></div><div className="visual-add"><input aria-label="Новый alias" placeholder="Новый alias" value={newHost} onChange={event => setNewHost(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addHost(); }}/><button title="Добавить хост" onClick={addHost}><Plus size={16}/></button></div>{Object.keys(visual?.nodes || {}).sort().map(name => <button key={name} className={selectedHost === name ? 'active' : ''} onClick={() => { setSelectedHost(name); setInspector('host'); }}><HardDrive size={16}/>{name}</button>)}</div><div className="card visual-editor"><section className="visual-host-section"><div className="section-head"><div><h2>Параметры хоста</h2><p>Адрес, пользователь и способ входа</p></div>{host && <button className="danger" onClick={removeHost}><Trash2 size={14}/> Удалить хост</button>}</div>{host ? <><div className="form-grid host-fields">{(['host', 'user', 'port', 'key_file', 'password_env', 'host_key'] as const).map(key => <label key={key}>{({ host: 'Адрес / IP', user: 'Пользователь', port: 'Порт', key_file: 'Файл ключа', password_env: 'Переменная пароля', host_key: 'Fingerprint SHA256' } as Record<string, string>)[key]}<input type={key === 'port' ? 'number' : 'text'} value={String(host[key] ?? '')} onChange={event => changeHost(selectedHost, key, key === 'port' ? Number(event.target.value) : event.target.value)} placeholder={key === 'host_key' ? 'SHA256:…' : undefined}/></label>)}</div><label className="agent-field"><input type="checkbox" checked={!!host.agent} onChange={event => changeHost(selectedHost, 'agent', event.target.checked)}/><span><strong>SSH-агент</strong><small>Использовать ключи агента, доступного внутри контейнера</small></span></label><div className="secret-field"><div><strong>Встроенный пароль</strong><small>Секрет хранится только на сервере и не попадает в браузер.</small></div><span className="secret-status">{host.has_inline_password ? 'Задан' : 'Не задан'}</span><select aria-label="Действие с паролем" value={secretAction} onChange={event => { const action = event.target.value as SecretOperation['action']; setSecretOperations(previous => ({ ...previous, [selectedHost]: { action } })); }}><option value="keep">{host.has_inline_password ? 'Сохранить прежний' : 'Без пароля'}</option><option value="replace">Заменить</option>{host.has_inline_password && <option value="remove">Удалить</option>}</select>{secretAction === 'replace' && <input aria-label="Новый пароль" type="password" autoComplete="new-password" placeholder="Новый пароль" value={secretOperations[selectedHost]?.value || ''} onChange={event => setSecretOperations(previous => ({ ...previous, [selectedHost]: { action: 'replace', value: event.target.value } }))}/>}</div></> : <div className="details-empty"><HardDrive size={30}/><h3>Выберите хост</h3></div>}</section><div className="divider"/><section className="visual-routes"><div className="section-head"><div><h2>{visual?.legacy ? 'Маршруты' : 'Прямые хосты и пути'}</h2><p>Порядок шагов определяет SSH-переходы.</p></div></div>{visual?.legacy ? <>{visual.routes.map((item, index) => <div className="path-card" key={index}><div className="path-card-head"><label>Название <input value={item.name} onChange={event => updateLegacyRoute(index, { name: event.target.value })}/></label><button title="Удалить маршрут" onClick={() => changeVisual(previous => ({ ...previous, routes: previous.routes.filter((_, i) => i !== index) }))}><X size={16}/></button></div><div className="path-steps">{item.hops.map((hop, step) => <div className="path-step" key={step}><span>{step + 1}</span><select value={hop} onChange={event => { const hops = [...item.hops]; hops[step] = event.target.value; updateLegacyRoute(index, { hops, target: hops.at(-1) || '' }); }}><option value="">Выберите хост</option>{Object.keys(visual.nodes).map(name => <option key={name}>{name}</option>)}</select><button title="Шаг раньше" disabled={step === 0} onClick={() => { const hops = [...item.hops]; [hops[step - 1], hops[step]] = [hops[step], hops[step - 1]]; updateLegacyRoute(index, { hops, target: hops.at(-1) || '' }); }}><ArrowUp size={14}/></button><button title="Шаг позже" disabled={step === item.hops.length - 1} onClick={() => { const hops = [...item.hops]; [hops[step + 1], hops[step]] = [hops[step], hops[step + 1]]; updateLegacyRoute(index, { hops, target: hops.at(-1) || '' }); }}><ArrowDown size={14}/></button><button title="Убрать шаг" onClick={() => { const hops = item.hops.filter((_, i) => i !== step); updateLegacyRoute(index, { hops, target: hops.at(-1) || '' }); }}><X size={14}/></button></div>)}</div><button className="text-action" onClick={() => updateLegacyRoute(index, { hops: [...item.hops, ''] })}><Plus size={14}/> Добавить шаг</button></div>)}<button className="subtle" onClick={() => changeVisual(previous => ({ ...previous, routes: [...previous.routes, { name: `route-${previous.routes.length + 1}`, target: '', hops: [''] }] }))}><Plus size={15}/> Добавить маршрут</button></> : <><div className="direct-hosts"><strong>Прямые хосты</strong><p>Доступны из контейнера без jump host.</p><div className="chip-list">{Object.keys(visual?.nodes || {}).sort().map(name => <button key={name} className={visual?.direct_hosts.includes(name) ? 'selected' : ''} onClick={() => changeVisual(previous => ({ ...previous, direct_hosts: previous.direct_hosts.includes(name) ? previous.direct_hosts.filter(item => item !== name) : [...previous.direct_hosts, name] }))}>{visual?.direct_hosts.includes(name) ? '✓ ' : '+ '}{name}</button>)}</div></div><div className="paths-heading"><strong>Пути</strong><span>Переходы между существующими хостами</span></div>{visual?.paths.map((path, index) => <div className="path-card" key={index}><div className="path-card-head"><strong>Путь {index + 1}</strong><div><button title="Выше" disabled={index === 0} onClick={() => changeVisual(previous => { const paths = [...previous.paths]; [paths[index - 1], paths[index]] = [paths[index], paths[index - 1]]; return { ...previous, paths }; })}><ArrowUp size={15}/></button><button title="Ниже" disabled={index === visual.paths.length - 1} onClick={() => changeVisual(previous => { const paths = [...previous.paths]; [paths[index + 1], paths[index]] = [paths[index], paths[index + 1]]; return { ...previous, paths }; })}><ArrowDown size={15}/></button><button title="Удалить путь" onClick={() => changeVisual(previous => ({ ...previous, paths: previous.paths.filter((_, i) => i !== index) }))}><Trash2 size={15}/></button></div></div><div className="path-steps">{path.map((hop, step) => <div className="path-step" key={step}><span>{step + 1}</span><select value={hop} onChange={event => { const updated = [...path]; updated[step] = event.target.value; updatePath(index, updated); }}><option value="">Выберите хост</option>{Object.keys(visual.nodes).sort().map(name => <option key={name}>{name}</option>)}</select>{step < path.length - 1 && <ArrowRight size={14}/>}<button title="Шаг раньше" disabled={step === 0} onClick={() => { const updated = [...path]; [updated[step - 1], updated[step]] = [updated[step], updated[step - 1]]; updatePath(index, updated); }}><ArrowUp size={14}/></button><button title="Шаг позже" disabled={step === path.length - 1} onClick={() => { const updated = [...path]; [updated[step + 1], updated[step]] = [updated[step], updated[step + 1]]; updatePath(index, updated); }}><ArrowDown size={14}/></button><button title="Убрать шаг" disabled={path.length <= 2} onClick={() => updatePath(index, path.filter((_, i) => i !== step))}><X size={14}/></button></div>)}</div><button className="text-action" onClick={() => updatePath(index, [...path, ''])}><Plus size={14}/> Добавить шаг</button></div>)}<button className="subtle" onClick={() => changeVisual(previous => ({ ...previous, paths: [...previous.paths, ['', '']] }))}><Plus size={15}/> Добавить путь</button></>}</section></div></div>}
    {mode === 'raw' && <div className="raw-editor"><div className="raw-head"><FileCode2 size={16}/> config.toml {dirty && <span>● Несохранённые изменения</span>}</div><div className="raw-notice">Встроенные пароли скрыты из текста. При сохранении прежние значения остаются на сервере; замена и удаление доступны в режиме «Визуально».</div><Editor language="toml" theme={theme === 'light' ? 'vs' : 'vs-dark'} value={rawText} onChange={value => { setRawText(value || ''); setMessage(''); }} options={{ fontSize: 14, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, lineNumbers: 'on', wordWrap: 'on' }}/><div className="raw-foot">Сначала проверка CLI, затем атомарная запись и резервная копия</div></div>}
  </div>;
}

