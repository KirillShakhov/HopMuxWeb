import { useConfiguration } from './ConfigurationContext';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Download, KeyRound, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react';
import { ApiError, json, type Model } from './lib';
import './vault.css';

type VaultStatus = { exists: boolean; unlocked: boolean; entries: string[] };
type MasterAction = 'create' | 'unlock' | 'rotate';
type VaultContextValue = {
  status: VaultStatus | null;
  setStatus: (status: VaultStatus) => void;
  refresh: () => Promise<void>;
  request: <T>(action: () => Promise<T>) => Promise<T>;
};
const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault() {
  const value = useContext(VaultContext);
  if (!value) throw new Error('VaultProvider is missing');
  return value;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { api } = useConfiguration();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const pending = useRef<{ result: Promise<boolean>; resolve: (accepted: boolean) => void } | null>(null);
  const refresh = useCallback(async () => { setStatus(await api<VaultStatus>('/vault')); }, [api]);
  useEffect(() => () => pending.current?.resolve(false), []);

  const request = useCallback(async <T,>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 423) throw error;
      if (!pending.current) {
        let resolve!: (accepted: boolean) => void;
        const result = new Promise<boolean>(done => { resolve = done; });
        pending.current = { result, resolve };
        setAsking(true);
      }
      if (!await pending.current.result) throw new DOMException('Разблокировка отменена', 'AbortError');
      return await action();
    }
  }, []);

  const finish = (accepted: boolean) => {
    pending.current?.resolve(accepted);
    pending.current = null;
    setAsking(false);
  };
  return <VaultContext.Provider value={{ status, setStatus, refresh, request }}>
    {children}
    {asking && <UnlockDialog onClose={() => finish(false)} onUnlocked={value => { setStatus(value); finish(true); }}/>}
  </VaultContext.Provider>;
}

function UnlockDialog({ onClose, onUnlocked }: { onClose: () => void; onUnlocked: (status: VaultStatus) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  return <dialog className="vault-dialog card" ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>Разблокировать хранилище</h2>
    <p>Для выбранного SSH-маршрута нужны пароли из vault.</p>
    <MasterPasswordForm action="unlock" onSuccess={onUnlocked} onCancel={onClose} onBusyChange={setBusy}/>
  </dialog>;
}

function MasterPasswordForm({ action, onSuccess, onCancel, onBusyChange }: {
  action: MasterAction;
  onSuccess: (status: VaultStatus) => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { api } = useConfiguration();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fault, setFault] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = action !== 'unlock';
  const label = action === 'create' ? 'Создать хранилище' : action === 'rotate' ? 'Сменить мастер-пароль' : 'Разблокировать';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFault('');
    if (confirm && password !== confirmation) { setFault('Мастер-пароли не совпадают'); return; }
    setBusy(true);
    onBusyChange?.(true);
    try {
      const result = await api<VaultStatus>('/vault/' + action, json('POST', { password, confirmation }));
      setPassword(''); setConfirmation('');
      onSuccess(result);
    } catch (error) { setFault(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  return <form className="vault-form" onSubmit={submit}>
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

export function VaultView({ model, onError }: { model: Model | null; onError: (error: unknown) => void }) {
  const { api, url } = useConfiguration();
  const { status, setStatus, refresh } = useVault();
  const [name, setName] = useState('');
  const [entryPassword, setEntryPassword] = useState('');
  const [editing, setEditing] = useState('');
  const [rotate, setRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    refresh().catch(onError);
    const timer = window.setInterval(() => refresh().catch(() => {}), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (status?.unlocked) return;
    setEditing(''); setName(''); setEntryPassword(''); setRotate(false);
  }, [status?.unlocked]);

  const change = async (action: () => Promise<VaultStatus>) => {
    setBusy(true);
    try { setStatus(await action()); return true; }
    catch (error) {
      onError(error);
      if (error instanceof ApiError && error.status === 423) refresh().catch(() => {});
      return false;
    } finally { setBusy(false); }
  };
  const clearEntry = () => { setEditing(''); setName(''); setEntryPassword(''); };
  const saveEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (await change(() => api('/vault/entries', json('PUT', { name, password: entryPassword, replace: !!editing })))) clearEntry();
  };

  return <div className="page vault-page">
    <div className="page-title">
      <div><h1>Хранилище</h1><p>Пароли SSH в зашифрованном vault mssh.</p></div>
      {status?.unlocked && <div className="title-actions">
        <a className="subtle" href={url('/api/vault/backup')}><Download size={16}/> Скачать vault.json</a>
        <button className="subtle" disabled={busy} onClick={() => change(() => api('/vault/lock', { method: 'POST' }))}><LockKeyhole size={16}/> Заблокировать</button>
      </div>}
    </div>
    {!status ? <p>Проверка хранилища…</p> : !status.unlocked ? <section className="card vault-intro">
      <div className="host-avatar large"><LockKeyhole size={22}/></div>
      <h2>{status.exists ? 'Хранилище заблокировано' : 'Создайте хранилище'}</h2>
      <p>{status.exists ? 'Разблокировка действует для этого браузера 30 минут.' : 'Записи можно привязать к одному или нескольким хостам.'}</p>
      <MasterPasswordForm key={status.exists ? 'unlock' : 'create'} action={status.exists ? 'unlock' : 'create'} onSuccess={setStatus}/>
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
                  && await change(() => api('/vault/entries', json('DELETE', { name: entry })))
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
          {rotate ? <MasterPasswordForm action="rotate" onSuccess={value => { setStatus(value); setRotate(false); }} onCancel={() => setRotate(false)}/>
            : <button className="subtle" onClick={() => setRotate(true)}>Сменить мастер-пароль</button>}
        </section>
      </div>
    </div>}
  </div>;
}
