import { useConfiguration } from './ConfigurationContext';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Download, KeyRound, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react';
import { ApiError, json, type Model } from './lib';
import './vault.css';

type VaultStatus = { exists: boolean; unlocked: boolean; entries: string[] };
type VaultSelection = { selected: string; vaults: { id: string; name: string }[]; status: VaultStatus };
type MasterAction = 'create' | 'create-named' | 'unlock' | 'rotate';

const boundUrl = (path: string, vaultId?: string) => vaultId ? path + '?' + new URLSearchParams({ vault: vaultId }) : path;
type VaultContextValue = {
  selection: VaultSelection | null;
  setSelection: (selection: VaultSelection) => void;
  status: VaultStatus | null;
  setStatus: (status: VaultStatus) => void;
  refresh: () => Promise<void>;
  request: <T>(action: () => Promise<T>) => Promise<T>;
  askUnlock: () => Promise<boolean>;
};
const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault() {
  const value = useContext(VaultContext);
  if (!value) throw new Error('VaultProvider is missing');
  return value;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { api } = useConfiguration();
  const [selection, updateSelection] = useState<VaultSelection | null>(null);
  const version = useRef(0);
  const setSelection = (value: VaultSelection) => {
    version.current++;
    updateSelection(value);
  };
  const setStatus = (status: VaultStatus) => {
    version.current++;
    updateSelection(previous => previous && previous.selected === selection?.selected ? { ...previous, status } : previous);
  };
  const [asking, setAsking] = useState(false);
  const pending = useRef<{ result: Promise<boolean>; resolve: (accepted: boolean) => void } | null>(null);
  const refresh = useCallback(async () => {
    const revision = ++version.current;
    const value = await api<VaultSelection>('/vaults');
    if (revision === version.current) updateSelection(value);
  }, [api]);
  useEffect(() => () => pending.current?.resolve(false), []);

  const askUnlock = useCallback(() => {
    if (!pending.current) {
      let resolve!: (accepted: boolean) => void;
      const result = new Promise<boolean>(done => { resolve = done; });
      pending.current = { result, resolve };
      void refresh().catch(() => {}).finally(() => setAsking(true));
    }
    return pending.current.result;
  }, [refresh]);

  const request = useCallback(async <T,>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 423) throw error;
      if (!await askUnlock()) throw new DOMException('Разблокировка отменена', 'AbortError');
      return await action();
    }
  }, [askUnlock]);

  const finish = (accepted: boolean) => {
    pending.current?.resolve(accepted);
    pending.current = null;
    setAsking(false);
  };
  return <VaultContext.Provider value={{ selection, setSelection, status: selection?.status ?? null, setStatus, refresh, request, askUnlock }}>
    {children}
    {asking && <VaultDialog action="unlock" title={`Разблокировать: ${selection?.vaults.find(item => item.id === selection.selected)?.name ?? 'mssh'}`} onClose={() => finish(false)} onSuccess={value => { setStatus(value); finish(true); }}/>}
  </VaultContext.Provider>;
}

function VaultDialog({ action, title, onClose, onSuccess }: {
  action: 'unlock' | 'create-named';
  title: string;
  onClose: () => void;
  onSuccess: (status: VaultStatus) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  return <dialog className="vault-dialog card" ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>{title}</h2>
    <MasterPasswordForm action={action} onSuccess={onSuccess} onCancel={onClose} onBusyChange={setBusy}/>
  </dialog>;
}

function MasterPasswordForm({ action, onSuccess, onCancel, onBusyChange }: {
  action: MasterAction;
  onSuccess: (status: VaultStatus) => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { api } = useConfiguration();
  const { selection, setSelection } = useVault();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fault, setFault] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = action !== 'unlock';
  const named = action === 'create-named';
  const label = action === 'unlock' ? 'Разблокировать' : action === 'rotate' ? 'Сменить мастер-пароль' : 'Создать хранилище';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFault('');
    if (confirm && password !== confirmation) { setFault('Мастер-пароли не совпадают'); return; }
    setBusy(true);
    onBusyChange?.(true);
    try {
      const credentials = { password, confirmation };
      if (named) {
        const result = await api<VaultSelection>(boundUrl('/vaults', selection?.selected), json('POST', { name, ...credentials }));
        setSelection(result);
        onSuccess(result.status);
      } else {
        const status = await api<VaultStatus>(boundUrl('/vault/' + action, selection?.selected), json('POST', credentials));
        onSuccess(status);
      }
      setPassword(''); setConfirmation('');
    } catch (error) { setFault(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  return <form className="vault-form" onSubmit={submit}>
    {named && <label>Название хранилища<input value={name} onChange={event => setName(event.target.value)} autoFocus required/></label>}
    <label>{action === 'rotate' ? 'Новый мастер-пароль' : 'Мастер-пароль'}
      <input type="password" autoComplete={confirm ? 'new-password' : 'current-password'} value={password} required
        onChange={event => setPassword(event.target.value)} autoFocus={!confirm}/>
    </label>
    {confirm && <label>Повторите мастер-пароль<input type="password" autoComplete="new-password" value={confirmation} required
      onChange={event => setConfirmation(event.target.value)}/></label>}
    {fault && <p className="vault-error" role="alert">{fault}</p>}
    <div className="form-actions">
      <button className="primary" type="submit" disabled={busy}>{label}</button>
      {onCancel && <button className="subtle" type="button" disabled={busy} onClick={onCancel}>Отмена</button>}
    </div>
  </form>;
}

export function VaultBindingSelect({ disabled, onBusyChange, onError }: {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const { api } = useConfiguration();
  const { selection, setSelection, refresh } = useVault();
  const [binding, setBinding] = useState(false);
  if (!selection) return null;

  const bind = async (id: string) => {
    setBinding(true);
    onBusyChange?.(true);
    try {
      setSelection(await api<VaultSelection>(boundUrl('/vault/binding', selection.selected), json('PUT', { id })));
    } catch (error) {
      onError(error);
      refresh().catch(() => {});
    } finally {
      setBinding(false);
      onBusyChange?.(false);
    }
  };

  return <div className="field-block">
    <label>Хранилище конфигурации
      <select aria-label="Хранилище конфигурации" value={selection.selected} disabled={disabled || binding} onChange={event => void bind(event.target.value)}>
        {!selection.vaults.some(vault => vault.id === selection.selected) && <option value={selection.selected} disabled>Хранилище недоступно</option>}
        {selection.vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.name}</option>)}
      </select>
    </label>
  </div>;
}

export function VaultView({ model, onError }: { model: Model | null; onError: (error: unknown) => void }) {
  const { api, url } = useConfiguration();
  const { selection, status, setStatus, refresh } = useVault();
  const [name, setName] = useState('');
  const [entryPassword, setEntryPassword] = useState('');
  const [editing, setEditing] = useState('');
  const [rotate, setRotate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    refresh().catch(onError);
    const timer = window.setInterval(() => refresh().catch(() => {}), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    setEditing(''); setName(''); setEntryPassword(''); setRotate(false);
  }, [selection?.selected, status?.unlocked]);

  const change = async (action: () => Promise<VaultStatus>) => {
    setBusy(true);
    try { setStatus(await action()); return true; }
    catch (error) {
      onError(error);
      if (error instanceof ApiError && [409, 423].includes(error.status)) refresh().catch(() => {});
      return false;
    } finally { setBusy(false); }
  };
  const clearEntry = () => { setEditing(''); setName(''); setEntryPassword(''); };
  const saveEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (await change(() => api(boundUrl('/vault/entries', selection?.selected), json('PUT', { name, password: entryPassword, replace: !!editing })))) clearEntry();
  };

  return <div className="page vault-page">
    <div className="page-title">
      <div><h1>Хранилище</h1><p>Пароли SSH для активной конфигурации.</p></div>
      {status?.unlocked && <div className="title-actions">
        <a className="subtle" href={url(boundUrl('/api/vault/backup', selection?.selected))}><Download size={16}/> Скачать резервную копию</a>
        <button className="subtle" disabled={busy} onClick={() => change(() => api(boundUrl('/vault/lock', selection?.selected), { method: 'POST' }))}><LockKeyhole size={16}/> Заблокировать</button>
      </div>}
    </div>
    {selection && <section className="card vault-binding">
      <VaultBindingSelect disabled={busy} onBusyChange={setBusy} onError={onError}/>
      <button className="subtle" disabled={busy} onClick={() => setCreating(true)}><Plus size={16}/> Новое хранилище</button>
    </section>}
    {creating && <VaultDialog action="create-named" title="Новое хранилище" onClose={() => setCreating(false)} onSuccess={() => setCreating(false)}/>}
    {!status ? <p>Проверка хранилища…</p> : !selection?.vaults.some(vault => vault.id === selection.selected)
      ? <p>Назначенное хранилище недоступно. Выберите хранилище из списка.</p> : !status.unlocked ? <section className="card vault-intro">
      <div className="host-avatar large"><LockKeyhole size={22}/></div>
      <h2>{status.exists ? 'Хранилище заблокировано' : 'Создайте хранилище'}</h2>
      <p>{status.exists ? 'Разблокировка действует для этого браузера 30 минут.' : 'Записи можно привязать к одному или нескольким хостам.'}</p>
      <MasterPasswordForm key={selection?.selected + (status.exists ? 'unlock' : 'create')} action={status.exists ? 'unlock' : 'create'} onSuccess={setStatus} onBusyChange={setBusy}/>
    </section> : <div className="vault-layout">
      <section className="card vault-card">
        <h2>Записи <span className="muted">{status.entries.length}</span></h2>
        {status.entries.length === 0 && <p>Добавьте запись, чтобы выбрать её при настройке хоста.</p>}
        {status.entries.map(entry => {
          const hosts = Object.entries(model?.nodes || {}).filter(([, host]) => host.password_vault === entry).map(([host]) => host);
          return <div className="vault-row" key={entry}>
            <span className="host-avatar"><KeyRound size={16}/></span>
            <div><strong>{entry}</strong>{hosts.length > 0 && <small>{hosts.join(', ')}</small>}</div>
            <button className="icon-button" aria-label={'Заменить пароль записи ' + entry} title="Заменить пароль" disabled={busy}
              onClick={() => { setEditing(entry); setName(entry); setEntryPassword(''); }}><Pencil size={16}/></button>
            <button className="icon-button" aria-label={'Удалить запись ' + entry} title={hosts.length ? 'Запись используется хостами' : 'Удалить запись'} disabled={busy || hosts.length > 0}
              onClick={async () => {
                if (confirm('Удалить запись «' + entry + '»?')
                  && await change(() => api(boundUrl('/vault/entries', selection?.selected), json('DELETE', { name: entry })))
                  && editing === entry) clearEntry();
              }}><Trash2 size={16}/></button>
          </div>;
        })}
      </section>
      <div className="vault-side">
        <section className="card vault-card">
          <h2>{editing ? 'Заменить пароль записи' : 'Новая запись'}</h2>
          <form className="vault-form" onSubmit={saveEntry}>
            <label>Имя записи<input value={name} onChange={event => setName(event.target.value)} required readOnly={!!editing}/></label>
            <label>Пароль SSH<input type="password" autoComplete="new-password" value={entryPassword}
              onChange={event => setEntryPassword(event.target.value)} required/></label>
            <div className="form-actions">
              <button className="primary" disabled={busy} type="submit">{editing ? 'Заменить пароль' : <><Plus size={16}/> Добавить запись</>}</button>
              {editing && <button className="subtle" type="button" onClick={clearEntry}>Отмена</button>}
            </div>
          </form>
        </section>
        <section className="card vault-card">
          <h2>Мастер-пароль</h2>
          {rotate ? <MasterPasswordForm action="rotate" onSuccess={value => { setStatus(value); setRotate(false); }} onCancel={() => setRotate(false)} onBusyChange={setBusy}/>
            : <button className="subtle" onClick={() => setRotate(true)}>Сменить мастер-пароль</button>}
        </section>
      </div>
    </div>}
  </div>;
}
