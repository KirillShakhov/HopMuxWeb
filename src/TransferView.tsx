import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpFromLine, Download, ExternalLink, File, FolderOpen, RefreshCw, X } from 'lucide-react';
import { FilePane, fileChild, useFilePane } from './FilePane';
import { api, json, stateLabel, transferDraft, type FileEndpoint, type Model, type Transfer, type TransferDraft, type UiSettings } from './lib';
import { useVault } from './VaultView';

type Props = {
  model: Model | null;
  transfers: Transfer[];
  settings: UiSettings;
  initialTarget?: string;
  initialRoute?: string;
  focusedId?: string;
  separate?: boolean;
  onCreated?: (transferId: string) => void;
  onRefresh: () => void;
  onError: (error: unknown) => void;
};

const endpointLabel = ({ host, path }: FileEndpoint) => host ? host + ':' + path : '/files/' + path;

export function TransferView({ model, transfers, settings, initialTarget = '', initialRoute = '', focusedId, separate = false, onCreated, onRefresh, onError }: Props) {
  const { request: vaultRequest } = useVault();
  const left = useFilePane('', '', !separate);
  const right = useFilePane(initialTarget, initialRoute, !separate);
  const [draft, setDraft] = useState<TransferDraft>();
  const [busy, setBusy] = useState(false);
  const [selectedTask, setSelectedTask] = useState(focusedId || '');
  const selected = transfers.find(item => item.id === selectedTask);
  const visible = separate ? transfers.filter(item => item.id === focusedId) : [...transfers].reverse();

  useEffect(() => { if (focusedId) setSelectedTask(focusedId); }, [focusedId]);
  const { refresh: refreshLeft } = left;
  const { refresh: refreshRight } = right;
  useEffect(() => {
    if (!separate && selected?.state === 'done') {
      refreshLeft();
      refreshRight();
    }
  }, [selected?.id, selected?.state, separate, refreshLeft, refreshRight]);

  const prepare = (from: typeof left, to: typeof right) => {
    const name = from.selected?.name;
    const destinationPath = to.endpoint.host && to.endpoint.path === '.' ? '/' : to.endpoint.path;
    setDraft({
      source: { ...from.endpoint, path: name ? fileChild(from.endpoint.path, name) : '' },
      destination: { ...to.endpoint, path: name && to.directory ? fileChild(destinationPath, name) : '' },
      recursive: Boolean(from.selected?.directory),
      verify: false,
    });
  };

  const start = async (job: TransferDraft) => {
    if (settings.confirmTransfer && !confirm(`Копировать ${endpointLabel(job.source)} → ${endpointLabel(job.destination)}?`)) return;
    setBusy(true);
    try {
      const created = await vaultRequest(() => api<Transfer>('/transfers', json('POST', job)));
      setSelectedTask(created.id);
      setDraft(undefined);
      onCreated?.(created.id);
      onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return <div className="transfer-view">
    <div className="tool-head">
      <div className="tool-identity"><span className="tool-icon"><ArrowUpFromLine size={16}/></span><strong>{separate ? 'Передача файла' : 'Передача файлов'}</strong></div>
      <div className="tool-actions">{selected && <button title="Открыть эту же операцию в новом окне" aria-label="Открыть операцию в новом окне" onClick={() => window.open('/?transfer=' + selected.id, '_blank')}><ExternalLink size={16}/></button>}</div>
    </div>
    <div className="transfer-scroll">
      {!separate && <div className="file-manager">
        <div className="file-panels">
          <FilePane title="Левая панель" model={model} pane={left}/>
          <FilePane title="Правая панель" model={model} pane={right}/>
        </div>
        <div className="file-copy-actions">
          <button type="button" className="subtle" aria-label="Копировать слева направо" disabled={busy || !left.endpoint.host && !right.endpoint.host} onClick={() => prepare(left, right)}>Копировать <ArrowRight size={16}/></button>
          <button type="button" className="subtle" aria-label="Копировать справа налево" disabled={busy || !left.endpoint.host && !right.endpoint.host} onClick={() => prepare(right, left)}><ArrowLeft size={16}/> Копировать</button>
        </div>
        {draft && <form className="file-copy-form" onSubmit={event => { event.preventDefault(); void start(draft); }}>
          <div className="form-grid">
            <label>Источник · {draft.source.host || '/files'}
              <input aria-label="Путь источника" value={draft.source.path} required disabled={busy}
                placeholder={draft.source.host ? '/путь/к/файлу' : 'каталог/файл'}
                onChange={event => setDraft({ ...draft, source: { ...draft.source, path: event.target.value } })}/>
            </label>
            <label>Назначение · {draft.destination.host || '/files'}
              <input aria-label="Путь назначения" value={draft.destination.path} required disabled={busy}
                placeholder={draft.destination.host ? '/путь/к/файлу' : 'каталог/файл'}
                onChange={event => setDraft({ ...draft, destination: { ...draft.destination, path: event.target.value } })}/>
            </label>
          </div>
          <div className="transfer-options">
            <label><input type="checkbox" checked={draft.recursive} disabled={busy} onChange={event => setDraft({ ...draft, recursive: event.target.checked })}/> Копировать каталог целиком</label>
            <label><input type="checkbox" checked={draft.verify} disabled={busy} onChange={event => setDraft({ ...draft, verify: event.target.checked })}/> Проверить SHA-256</label>
          </div>
          <div className="file-copy-actions">
            <button type="submit" className="primary" disabled={busy || !draft.source.path || !draft.destination.path}>{busy ? 'Запуск…' : 'Начать передачу'}</button>
            <button type="button" className="subtle" disabled={busy} onClick={() => setDraft(undefined)}>Отмена</button>
          </div>
        </form>}
      </div>}
      <div className="transfer-history">
        <h3>{separate ? 'Операция' : 'История передач'} <span>{visible.length}</span></h3>
        {visible.map(item => {
          const job = transferDraft(item);
          const { source, destination } = job;
          const routes = [source, destination].filter(endpoint => endpoint.host).map(endpoint => endpoint.route || 'Автомаршрут');
          const running = item.state === 'queued' || item.state === 'running';
          const retryable = !separate && ['error', 'cancelled', 'interrupted'].includes(item.state);
          return <div className={'transfer-item' + (selectedTask === item.id ? ' chosen' : '')} key={item.id}>
            <button type="button" className="transfer-info" aria-pressed={selectedTask === item.id} onClick={() => setSelectedTask(item.id)}>
              <strong>{endpointLabel(source)} → {endpointLabel(destination)}</strong>
              <small>{routes.join(' → ')} · {item.logs.at(-1) || stateLabel[item.state] || item.state}</small>
            </button>
            <span className={'state-pill ' + item.state}>{stateLabel[item.state] || item.state}</span>
            {!destination.host && !job.recursive && item.state === 'done' && <a href={'/api/files/download?' + new URLSearchParams({ path: destination.path })} aria-label="Скачать на компьютер" title="Скачать на компьютер"><Download size={16}/></a>}
            {running && <button type="button" className="icon-button" title="Отменить передачу" aria-label="Отменить передачу" onClick={() => api('/transfers/' + item.id + '/cancel', { method: 'POST' }).then(onRefresh).catch(onError)}><X size={16}/></button>}
            {retryable && <button type="button" className="icon-button" title="Повторить передачу" aria-label="Повторить передачу" disabled={busy} onClick={() => setDraft(job)}><RefreshCw size={16}/></button>}
          </div>;
        })}
        {!visible.length && <div className="empty-list"><FolderOpen size={24}/><p>{separate ? 'Операция не найдена' : 'Задачи появятся здесь после запуска передачи'}</p></div>}
        {selected && <div className="transfer-detail"><div><File size={16}/><strong>Подробности операции</strong><code>{selected.id.slice(0, 12)}</code></div><pre>{selected.logs.join('\n') || 'CLI пока не сообщил подробности.'}</pre></div>}
      </div>
    </div>
  </div>;
}
