import { ArrowDown, ArrowRight, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { Model, Route } from './lib';

type Props = {
  model: Model;
  onChange: (change: (previous: Model) => Model) => void;
};

type StepsProps = {
  hosts: string[];
  hops: string[];
  minSteps: number;
  onChange: (hops: string[]) => void;
};

function moveItem<T>(items: T[], index: number, delta: number) {
  const updated = [...items];
  [updated[index], updated[index + delta]] = [updated[index + delta], updated[index]];
  return updated;
}

function RouteSteps({ hosts, hops, minSteps, onChange }: StepsProps) {
  return <>
    <div className="path-steps">
      {hops.map((hop, index) => <div className="path-step" key={index}>
        <span aria-hidden="true">{index + 1}</span>
        <select aria-label={`Хост на шаге ${index + 1}`} value={hop} onChange={event => {
          const updated = [...hops];
          updated[index] = event.target.value;
          onChange(updated);
        }}>
          <option value="">Выберите хост</option>
          {hosts.map(name => <option key={name}>{name}</option>)}
        </select>
        {index < hops.length - 1 && <ArrowRight size={14} aria-hidden="true"/>}
        <button title="Шаг раньше" disabled={index === 0} onClick={() => onChange(moveItem(hops, index, -1))}><ArrowUp size={14}/></button>
        <button title="Шаг позже" disabled={index === hops.length - 1} onClick={() => onChange(moveItem(hops, index, 1))}><ArrowDown size={14}/></button>
        <button title="Убрать шаг" disabled={hops.length <= minSteps} onClick={() => onChange(hops.filter((_, i) => i !== index))}><Trash2 size={14}/></button>
      </div>)}
    </div>
    <button className="text-action" onClick={() => onChange([...hops, ''])}><Plus size={14}/> Добавить шаг</button>
  </>;
}

export function VisualRoutes({ model, onChange }: Props) {
  const hosts = Object.keys(model.nodes).sort();
  const updateRoute = (index: number, fields: Partial<Route>) => onChange(previous => ({
    ...previous, routes: previous.routes.map((route, i) => i === index ? { ...route, ...fields } : route),
  }));
  const addRoute = () => onChange(previous => {
    let suffix = previous.routes.length + 1;
    while (previous.routes.some(route => route.name === `route-${suffix}`)) suffix++;
    return { ...previous, routes: [...previous.routes, { name: `route-${suffix}`, target: '', hops: [''] }] };
  });
  const updatePath = (index: number, hops: string[]) => onChange(previous => ({
    ...previous, paths: previous.paths.map((path, i) => i === index ? hops : path),
  }));

  return <section className="card visual-editor visual-routes">
    <div className="section-head">
      <div><h2>Маршруты</h2><p>Порядок шагов определяет SSH-переходы.</p></div>
    </div>
    {model.legacy ? <>
      {model.routes.map((route, index) => <div className="path-card" key={index}>
        <div className="path-card-head">
          <label>Название маршрута<input value={route.name} onChange={event => updateRoute(index, { name: event.target.value })}/></label>
          <button title="Удалить маршрут" onClick={() => onChange(previous => ({
            ...previous, routes: previous.routes.filter((_, i) => i !== index),
          }))}><Trash2 size={16}/></button>
        </div>
        <RouteSteps hosts={hosts} hops={route.hops} minSteps={1} onChange={hops => updateRoute(index, { hops, target: hops.at(-1) || '' })}/>
      </div>)}
      <button className="subtle" disabled={!hosts.length} onClick={addRoute}><Plus size={15}/> Добавить маршрут</button>
    </> : <>
      <div className="direct-hosts">
        <h3>Прямые хосты</h3>
        <p>Доступны из контейнера без промежуточного SSH-хоста.</p>
        <div className="chip-list">
          {hosts.map(name => {
            const direct = model.direct_hosts.includes(name);
            return <button key={name} className={direct ? 'selected' : ''} aria-pressed={direct} onClick={() => onChange(previous => ({
              ...previous, direct_hosts: direct ? previous.direct_hosts.filter(item => item !== name) : [...previous.direct_hosts, name],
            }))}>{name}</button>;
          })}
        </div>
      </div>
      <h3>Пути между хостами</h3>
      {model.paths.map((path, index) => <div className="path-card" key={index}>
        <div className="path-card-head">
          <strong>Путь {index + 1}</strong>
          <div>
            <button title="Поднять путь" disabled={index === 0} onClick={() => onChange(previous => ({
              ...previous, paths: moveItem(previous.paths, index, -1),
            }))}><ArrowUp size={15}/></button>
            <button title="Опустить путь" disabled={index === model.paths.length - 1} onClick={() => onChange(previous => ({
              ...previous, paths: moveItem(previous.paths, index, 1),
            }))}><ArrowDown size={15}/></button>
            <button title="Удалить путь" onClick={() => onChange(previous => ({
              ...previous, paths: previous.paths.filter((_, i) => i !== index),
            }))}><Trash2 size={15}/></button>
          </div>
        </div>
        <RouteSteps hosts={hosts} hops={path} minSteps={2} onChange={hops => updatePath(index, hops)}/>
      </div>)}
      <button className="subtle" disabled={!hosts.length} onClick={() => onChange(previous => ({
        ...previous, paths: [...previous.paths, ['', '']],
      }))}><Plus size={15}/> Добавить путь</button>
    </>}
    {!hosts.length && <p className="hint">Добавьте хосты в разделе «Хосты».</p>}
  </section>;
}
