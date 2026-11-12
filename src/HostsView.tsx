import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowUpFromLine, HardDrive, Plus, Search, Star, Terminal } from 'lucide-react';
import { api, routeLabel, stateLabel, stored, type Model, type Session } from './lib';

type Props = {
  model: Model | null;
  sessions: Session[];
  openTerminal: (target: string, route: string) => void;
  openTransfer: (target: string, route: string) => void;
  onEdit: (target?: string) => void;
  onError: (error: unknown) => void;
};

export function HostsView({ model, sessions, openTerminal, openTransfer, onEdit, onError }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'favorites' | 'recent'>('all');
  const [favorites, setFavorites] = useState<string[]>(() => stored('hopmux-favorites', []));
  const [recent, setRecent] = useState<string[]>(() => stored('hopmux-recent', []));
  const [selected, setSelected] = useState('');
  const [selectedRoute, setSelectedRoute] = useState('');
  const [probe, setProbe] = useState<Record<string, 'checking' | 'up' | 'down' | 'error'>>({});

  useEffect(() => { localStorage.setItem('hopmux-favorites', JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => { localStorage.setItem('hopmux-recent', JSON.stringify(recent)); }, [recent]);

  const hosts = useMemo(() => Object.entries(model?.nodes || {})
    .filter(([name, host]) => (name + host.host + host.user).toLowerCase().includes(query.toLowerCase()))
    .filter(([name]) => filter === 'all' || filter === 'favorites' && favorites.includes(name) || filter === 'recent' && recent.includes(name))
    .sort(([a], [b]) => Number(favorites.includes(b)) - Number(favorites.includes(a)) || (recent.indexOf(a) < 0 ? 999 : recent.indexOf(a)) - (recent.indexOf(b) < 0 ? 999 : recent.indexOf(b)) || a.localeCompare(b)),
  [model, query, filter, favorites, recent]);

  const routes = model?.routes.filter(route => route.target === selected && !route.disabled) || [];
  const host = selected ? model?.nodes[selected] : undefined;
  const activeSession = sessions.find(session => session.target === selected && ['connected', 'connecting', 'verifying_host_key'].includes(session.state));
  const chosenRoute = routes.find(route => route.name === selectedRoute);

  const chooseHost = (name: string) => {
    setSelected(name);
    setSelectedRoute('');
  };
  const remember = () => {
    setRecent(previous => [selected, ...previous.filter(name => name !== selected)].slice(0, 12));
  };
  const runProbe = async () => {
    setProbe(previous => ({ ...previous, [selected]: 'checking' }));
    try {
      const result = await api<{ routes: { state: string }[] }>('/probe/' + selected, { method: 'POST' });
      setProbe(previous => ({ ...previous, [selected]: result.routes.some(route => route.state === 'UP') ? 'up' : 'down' }));
    } catch (error) {
      setProbe(previous => ({ ...previous, [selected]: 'error' }));
      onError(error);
    }
  };

  return <div className="page hosts-page">
    <div className="page-title"><div><div className="eyebrow">ПОДКЛЮЧЕНИЯ</div><h1>Хосты</h1><p>{Object.keys(model?.nodes || {}).length} хостов в конфигурации</p></div><button className="primary" onClick={() => onEdit()}><Plus size={16}/> Добавить хост</button></div>
    <div className="host-layout">
      <div className="card host-list">
        <div className="search"><Search size={17}/><input aria-label="Поиск хостов" placeholder="Alias, адрес или пользователь" value={query} onChange={event => setQuery(event.target.value)}/></div>
        <div className="host-filters">
          {([['all', 'Все'], ['favorites', 'Избранные'], ['recent', 'Недавние']] as const).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <div className="list-heading">ХОСТЫ <span>{hosts.length}</span></div>
        {hosts.map(([name, item]) => {
          const live = sessions.find(session => session.target === name && ['connected', 'connecting', 'verifying_host_key'].includes(session.state));
          return <div role="button" tabIndex={0} key={name} className={'host-row ' + (selected === name ? 'chosen' : '')} onClick={() => chooseHost(name)} onKeyDown={event => { if (event.key === 'Enter') chooseHost(name); }}>
            <span className="host-avatar"><HardDrive size={17}/></span>
            <span className="host-main"><strong>{name}</strong><small>{item.user}@{item.host}:{item.port || 22}</small></span>
            <span className={'host-state ' + (live?.state === 'connected' ? 'live' : '')}>{live ? stateLabel[live.state] : 'Нет сессии'}</span>
            <button className={'favorite ' + (favorites.includes(name) ? 'is-favorite' : '')} aria-pressed={favorites.includes(name)} aria-label={favorites.includes(name) ? `Убрать ${name} из избранного` : `Добавить ${name} в избранное`} onClick={event => { event.stopPropagation(); setFavorites(previous => previous.includes(name) ? previous.filter(item => item !== name) : [...previous, name]); }}><Star size={17} fill={favorites.includes(name) ? 'currentColor' : 'none'}/></button>
          </div>;
        })}
        {!hosts.length && <div className="empty-list">Хостов по этому запросу нет</div>}
      </div>
      <div className="card details">{host ? <>
        <div className="details-top"><span className="host-avatar large"><HardDrive size={23}/></span><div><div className="eyebrow">ПАРАМЕТРЫ ХОСТА</div><h2>{selected}</h2><span className="muted">{host.user}@{host.host}:{host.port || 22}</span></div></div>
        <div className="host-status-line"><span>Сессия: <strong>{activeSession ? stateLabel[activeSession.state] : 'нет активной'}</strong></span><span>Доступность: <strong>{probe[selected] === 'checking' ? 'проверяется' : probe[selected] === 'up' ? 'доступен' : probe[selected] === 'down' ? 'недоступен' : probe[selected] === 'error' ? 'ошибка проверки' : 'не проверялась'}</strong></span></div>
        <div className="detail-grid"><div><span>Адрес</span><strong>{host.host}</strong></div><div><span>Пользователь</span><strong>{host.user}</strong></div><div><span>Порт</span><strong>{host.port || 22}</strong></div><div><span>Авторизация</span><strong>{host.key_file ? 'SSH-ключ' : host.agent ? 'SSH-агент' : host.password_env ? 'Переменная окружения' : 'Настроена'}</strong></div></div>
        <div className="field-block"><label htmlFor="host-route">Маршрут подключения</label><select id="host-route" value={selectedRoute} onChange={event => setSelectedRoute(event.target.value)}><option value="">Авто — выбрать доступный маршрут</option>{routes.map(route => <option key={route.name} value={route.name}>{route.name} · {routeLabel(route)}</option>)}</select></div>
        <div className="route-preview"><span>{chosenRoute ? routeLabel(chosenRoute) : routes.length ? 'Авто: mssh выберет доступный маршрут' : 'Маршрут не настроен'}</span></div>
        <div className="details-actions"><button className="primary" disabled={!routes.length} onClick={() => { remember(); openTerminal(selected, selectedRoute); }}><Terminal size={16}/> Открыть терминал</button><button className="subtle" disabled={!routes.length} onClick={() => { remember(); openTransfer(selected, selectedRoute); }}><ArrowUpFromLine size={16}/> Передать файлы</button></div>
        <div className="divider"/>
        <div className="secondary-actions"><button onClick={() => onEdit(selected)}>Изменить хост</button><button onClick={runProbe}><Activity size={15}/> Проверить доступность</button></div>
      </> : <div className="details-empty"><HardDrive size={30}/><h3>Выберите хост</h3><p>Маршруты и действия появятся здесь.</p></div>}</div>
    </div>
  </div>;
}
