import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, File, FolderOpen, RefreshCw, Upload, X } from 'lucide-react';
import { api, json, stateLabel, type Model, type Transfer, type UiSettings } from './lib';

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

export function TransferView({ model, transfers, settings, initialTarget = '', initialRoute = '', focusedId, separate = false, onCreated, onRefresh, onError }: Props) {
  const [target, setTarget] = useState(initialTarget);
  const [route, setRoute] = useState(initialRoute);
  const [direction, setDirection] = useState<'upload' | 'download'>('upload');
  const [local, setLocal] = useState('');
  const [remote, setRemote] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [verify, setVerify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<{ name: string; directory: boolean; size: number | null }[]>([]);
  const [selectedTask, setSelectedTask] = useState(focusedId || '');
  useEffect(() => { api<{ entries: typeof files }>('/files').then(result => setFiles(result.entries)).catch(() => {}); }, []);
  useEffect(() => { if (focusedId) setSelectedTask(focusedId); }, [focusedId]);

  const selected = transfers.find(item => item.id === selectedTask);
  const visible = separate ? transfers.filter(item => item.id === focusedId) : [...transfers].reverse();
  const start = async () => {
    if (settings.confirmTransfer && !confirm(`${direction === 'upload' ? 'Отправить' : 'Скачать'} ${direction === 'upload' ? '/files/' + local : target + ':' + remote} → ${direction === 'upload' ? target + ':' + remote : '/files/' + local}?`)) return;
    setBusy(true);
    try {
      const created = await api<Transfer>('/transfers', json('POST', { target, route, direction, local, remote, recursive, verify }));
      setSelectedTask(created.id);
      onCreated?.(created.id);
      onRefresh();
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const uploadFromBrowser = async (file: globalThis.File) => {
    const form = new FormData(); form.append('file', file);
    try {
      await api('/files/upload', { method: 'POST', body: form });
      setLocal(file.name);
      const result = await api<{ entries: typeof files }>('/files');
      setFiles(result.entries);
    } catch (error) { onError(error); }
  };

  return <div className="transfer-view">
    <div className="tool-head"><div className="tool-identity"><span className="tool-icon"><ArrowUpFromLine size={16}/></span><strong>{separate ? 'Передача файла' : 'Передача файлов'}</strong><span className="route-label">Контейнер /files ↔ SSH-хост</span></div><div className="tool-actions">{selected && <button title="Открыть эту же операцию в новом окне" onClick={() => window.open('/?transfer=' + selected.id, '_blank')}><ExternalLink size={16}/></button>}</div></div>
    <div className="transfer-scroll">
      {!separate && <div className="transfer-form"><div className="segmented"><button className={direction === 'upload' ? 'on' : ''} onClick={() => setDirection('upload')}><ArrowUpFromLine size={15}/> Отправить</button><button className={direction === 'download' ? 'on' : ''} onClick={() => setDirection('download')}><ArrowDownToLine size={15}/> Скачать</button></div>
        <p className="transfer-explainer">«Локальный» означает каталог <code>/files</code>, примонтированный в контейнер. Файл с компьютера браузера сначала загрузите кнопкой ниже.</p>
        <div className="form-grid"><label>SSH-хост<select value={target} onChange={event => { setTarget(event.target.value); setRoute(''); }}><option value="">Выберите хост</option>{Object.keys(model?.nodes || {}).sort().map(name => <option key={name}>{name}</option>)}</select></label><label>Маршрут<select value={route} onChange={event => setRoute(event.target.value)}><option value="">Автоматически: все доступные</option>{model?.routes.filter(item => item.target === target && !item.disabled).map(item => <option key={item.name} value={item.name}>{item.name} · local → {item.hops.join(' → ')}</option>)}</select></label><label>{direction === 'upload' ? 'Источник в /files' : 'Назначение в /files'}<input value={local} onChange={event => setLocal(event.target.value)} placeholder="archive.zip" list="local-files"/><datalist id="local-files">{files.map(file => <option value={file.name} key={file.name}/>)}</datalist></label><label>{direction === 'upload' ? 'Назначение на SSH-хосте' : 'Источник на SSH-хосте'}<input value={remote} onChange={event => setRemote(event.target.value)} placeholder="/home/user/archive.zip"/></label></div>
        <div className="transfer-options"><label><input type="checkbox" checked={recursive} onChange={event => setRecursive(event.target.checked)}/> Директория</label><label><input type="checkbox" checked={verify} onChange={event => setVerify(event.target.checked)}/> Проверить SHA-256</label></div>
        <div className="form-actions"><button className="primary" onClick={start} disabled={busy || !target || !local || !remote}>{busy ? 'Запуск…' : 'Начать передачу'}</button><label className="subtle upload-button" title="Сначала поместить файл браузера в /files"><Upload size={15}/> Загрузить с компьютера<input type="file" hidden onChange={event => { const file = event.target.files?.[0]; if (file) uploadFromBrowser(file); }}/></label></div>
      </div>}
      <div className="transfer-history"><h3>{separate ? 'Операция' : 'История передач'} <span>{visible.length}</span></h3>{visible.map(item => <div className={'transfer-item ' + (selectedTask === item.id ? 'chosen' : '')} key={item.id} onClick={() => setSelectedTask(item.id)}><div className="transfer-icon">{item.direction === 'upload' ? <ArrowUpFromLine size={17}/> : <ArrowDownToLine size={17}/>}</div><div className="transfer-info"><strong>{item.direction === 'upload' ? '/files/' + item.local : item.target + ':' + item.remote} <span>→</span> {item.direction === 'upload' ? item.target + ':' + item.remote : '/files/' + item.local}</strong><small>{item.route || 'Все маршруты'} · {item.logs.at(-1) || stateLabel[item.state] || item.state}</small></div><span className={'state-pill ' + item.state}>{stateLabel[item.state] || item.state}</span>{item.direction === 'download' && item.state === 'done' && <a href={'/api/files/download?path=' + encodeURIComponent(item.local)} title="Скачать на компьютер браузера" onClick={event => event.stopPropagation()}><ArrowDownToLine size={16}/></a>}{item.state === 'running' && <button title="Отменить" onClick={event => { event.stopPropagation(); api('/transfers/' + item.id + '/cancel', { method: 'POST' }).then(onRefresh).catch(onError); }}><X size={16}/></button>}{!separate && ['error', 'cancelled', 'interrupted'].includes(item.state) && <button title="Подставить параметры для повтора" onClick={event => { event.stopPropagation(); setTarget(item.target); setRoute(item.route); setDirection(item.direction); setLocal(item.local); setRemote(item.remote); }}><RefreshCw size={16}/></button>}</div>)}{!visible.length && <div className="empty-list"><FolderOpen size={24}/><p>{separate ? 'Операция не найдена' : 'Задачи появятся здесь после запуска передачи'}</p></div>}
        {selected && <div className="transfer-detail"><div><File size={16}/><strong>Подробности операции</strong><code>{selected.id.slice(0, 12)}</code></div><pre>{selected.logs.join('\n') || 'CLI пока не сообщил подробности.'}</pre><p>Проценты, скорость и ETA не показываются: CLI не отдаёт надёжный поток этих данных.</p></div>}
      </div>
    </div>
  </div>;
}
