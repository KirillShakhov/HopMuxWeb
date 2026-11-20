import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

type Props = {
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
};

export function NewConfigurationDialog({ onCreate, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCreate(name);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return <dialog ref={dialog} className="card configuration-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <h2 id={titleId}>Новая конфигурация</h2>
    <form onSubmit={submit}>
      <div className="field-block">
        <label htmlFor={titleId + '-name'}>Имя файла</label>
        <input id={titleId + '-name'} name="name" required autoFocus disabled={busy} placeholder="lab.toml" value={name} onChange={event => setName(event.target.value)}/>
      </div>
      {error && <p className="error-box" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !name.trim()}>{busy ? 'Создание…' : 'Создать'}</button>
        <button type="button" className="subtle" disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </form>
  </dialog>;
}
