import { useConfiguration } from './ConfigurationContext';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, ChevronRight, Download, File, Folder, RefreshCw, Upload } from 'lucide-react';
import { type FileEndpoint, type Model } from './lib';
import { useVault } from './VaultView';

type FileEntry = { name: string; directory: boolean; size: number | null };
type Directory = { path: string; entries: FileEntry[] };

export function fileChild(path: string, name: string) {
  return path === '.' ? name : path === '/' ? '/' + name : path + '/' + name;
}

export function useFilePane(initialHost = '', initialRoute = '', enabled = true) {
  const { api } = useConfiguration();
  const { request } = useVault();
  const [location, setLocation] = useState<FileEndpoint>({ host: initialHost, route: initialRoute, path: '.' });
  const [directory, setDirectory] = useState<Directory>();
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(enabled);
  const [revision, setRevision] = useState(0);
  const { host, route, path } = location;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ path });
    if (host) {
      query.set('host', host);
      query.set('route', route);
    }
    setLoading(true);
    setError('');
    request(() => api<Directory>((host ? '/files/remote?' : '/files?') + query, { signal: controller.signal }))
      .then(result => {
        if (!controller.signal.aborted) {
          setDirectory(result);
          setSelection(previous => new Set(result.entries.filter(entry => previous.has(entry.name)).map(entry => entry.name)));
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, enabled, host, route, path, request, revision]);

  const change = (next: FileEndpoint) => {
    setDirectory(undefined);
    setSelection(new Set());
    setLoading(true);
    setLocation(next);
    setRevision(previous => previous + 1);
  };
  const endpoint = { ...location, path: directory?.path ?? path };
  const refresh = useCallback(() => setRevision(previous => previous + 1), []);
  const toggleSelection = (name: string) => setSelection(previous => {
    const next = new Set(previous);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  return {
    endpoint, change, directory, error, loading, selection, setSelection,
    selected: directory?.entries.filter(entry => selection.has(entry.name)) ?? [],
    toggleSelection,
    refresh,
  };
}

type Props = {
  title: string;
  model: Model | null;
  pane: ReturnType<typeof useFilePane>;
};

export function FilePane({ title, model, pane }: Props) {
  const { api } = useConfiguration();
  const { endpoint, directory, selected } = pane;
  const entries = directory?.entries ?? [];
  const allSelected = entries.length > 0 && selected.length === entries.length;
  const download = selected.length === 1 && !selected[0].directory ? selected[0] : undefined;
  const { host, route, path } = endpoint;
  const routes = model?.routes.filter(item => item.target === host && !item.disabled) ?? [];
  const hosts = [...new Set(model?.routes.filter(item => !item.disabled).map(item => item.target))].sort();
  const [address, setAddress] = useState(path);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  useEffect(() => { setAddress(path); setUploadError(''); }, [host, route, path]);
  const openPath = (next: string) => pane.change({ ...endpoint, path: next });
  const up = () => {
    const parent = path.slice(0, path.lastIndexOf('/'));
    openPath(parent || (host ? '/' : '.'));
  };
  const upload = async (file: globalThis.File) => {
    const form = new FormData();
    form.append('file', file);
    setUploading(true);
    setUploadError('');
    try {
      await api('/files/upload?' + new URLSearchParams({ path }), { method: 'POST', body: form });
      pane.refresh();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  return <section className="file-pane" aria-label={title}>
    <div className="file-pane-controls">
      <div className="file-pane-location">
        <label>Хост
          <select aria-label="Хост" value={host} onChange={event => pane.change({ host: event.target.value, route: '', path: '.' })}>
            <option value="">Локальные файлы · /files</option>
            {host && !hosts.includes(host) && <option value={host}>{host}</option>}
            {hosts.map(name => <option key={name}>{name}</option>)}
          </select>
        </label>
        {host && <label>Маршрут
          <select aria-label="Маршрут" value={route} onChange={event => pane.change({ ...endpoint, route: event.target.value })}>
            <option value="">Автоматический</option>
            {route && !routes.some(item => item.name === route) && <option value={route}>{route}</option>}
            {routes.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>}
      </div>
      <form className="file-pane-address" onSubmit={event => { event.preventDefault(); if (address) openPath(address); }}>
        <button type="button" className="icon-button" title="Родительский каталог" aria-label="Родительский каталог" disabled={path === '/' || path === '.' || !directory} onClick={up}><ArrowUp size={16}/></button>
        <input aria-label={host ? 'Путь на хосте' : 'Путь внутри /files'} value={address} onChange={event => setAddress(event.target.value)} required/>
        <button type="submit" className="icon-button" title="Открыть каталог" aria-label="Открыть каталог"><ChevronRight size={16}/></button>
        <button type="button" className="icon-button" title="Обновить каталог" aria-label="Обновить каталог" disabled={pane.loading} onClick={pane.refresh}><RefreshCw size={15}/></button>
      </form>
    </div>
    {entries.length > 0 && <div className="file-selection">
      <label><input type="checkbox" checked={allSelected} ref={input => {
        if (input) input.indeterminate = selected.length > 0 && !allSelected;
      }} onChange={() => pane.setSelection(new Set(allSelected ? [] : entries.map(entry => entry.name)))}/> Выбрать всё</label>
      {selected.length > 0 && <span aria-live="polite">Выбрано: {selected.length}</span>}
    </div>}
    <div className="file-entries" aria-busy={pane.loading}>
      {pane.error && <p className="file-pane-error" role="alert">{pane.error}</p>}
      {pane.loading && !directory && <p className="file-pane-status" role="status">Загрузка каталога…</p>}
      {!pane.loading && !pane.error && !directory?.entries.length && <p className="file-pane-status">Каталог пуст</p>}
      {entries.map(entry => <div className={'file-entry' + (pane.selection.has(entry.name) ? ' selected' : '')} key={entry.name}>
        <input type="checkbox" aria-label={'Выбрать ' + entry.name} checked={pane.selection.has(entry.name)} onChange={() => pane.toggleSelection(entry.name)}/>
        <button type="button" className="file-entry-name" aria-pressed={pane.selection.has(entry.name)} onClick={event => {
          if (event.ctrlKey || event.metaKey) pane.toggleSelection(entry.name);
          else pane.setSelection(new Set([entry.name]));
        }}
          onDoubleClick={() => { if (entry.directory) openPath(fileChild(path, entry.name)); }}>
          {entry.directory ? <Folder size={16}/> : <File size={16}/>}
          <span title={entry.name}>{entry.name}</span>
          {entry.size !== null && <small>{entry.size.toLocaleString('ru-RU')} Б</small>}
        </button>
        {entry.directory && <button type="button" className="icon-button" title={'Открыть ' + entry.name} aria-label={'Открыть ' + entry.name} onClick={() => openPath(fileChild(path, entry.name))}><ChevronRight size={16}/></button>}
      </div>)}
    </div>
    {!host && <div className="file-pane-tools">
      <label className="subtle upload-button"><Upload size={15}/> {uploading ? 'Загрузка…' : 'Загрузить с компьютера'}
        <input type="file" aria-label="Загрузить с компьютера" disabled={uploading || !directory} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}/>
      </label>
      {download && <a className="subtle" href={'/api/files/download?' + new URLSearchParams({ path: fileChild(path, download.name) })}><Download size={15}/> Скачать</a>}
      {uploadError && <p className="file-pane-error" role="alert">{uploadError}</p>}
    </div>}
  </section>;
}
