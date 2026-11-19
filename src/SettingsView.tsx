import { useEffect, useState } from 'react';
import { Check, Monitor, Shield, Terminal } from 'lucide-react';
import { api, themes, type UiSettings } from './lib';

type Props = { settings: UiSettings; setSettings: React.Dispatch<React.SetStateAction<UiSettings>> };

export function SettingsView({ settings, setSettings }: Props) {
  const [about, setAbout] = useState<{ ui: string; backend: string; cli: string } | null>(null);
  useEffect(() => { api<typeof about>('/about').then(setAbout).catch(() => {}); }, []);
  const update = <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => setSettings(previous => ({ ...previous, [key]: value }));

  return <div className="page settings-page">
    <div className="page-title"><div><h1>Настройки</h1><p>Предпочтения сохраняются в этом браузере.</p></div></div>
    <div className="settings-grid">
      <section className="card settings-card appearance-card">
        <h2>Внешний вид</h2>
        <fieldset className="theme-options">
          <legend>Тема интерфейса</legend>
          <div className="theme-option-list">
            {themes.map(([theme, label]) => <label key={theme} className="theme-option">
              <input type="radio" name="appearance-theme" value={theme} checked={settings.theme === theme} onChange={() => update('theme', theme)}/>
              <span className="theme-preview" data-preview={theme} aria-hidden="true"><i/><i/><i/></span>
              <span className="theme-option-name">{label}{settings.theme === theme && <Check size={16} aria-hidden="true"/>}</span>
            </label>)}
          </div>
        </fieldset>
        <label>Плотность интерфейса
          <select value={settings.density} onChange={event => update('density', event.target.value as UiSettings['density'])}>
            <option value="comfortable">Обычная</option><option value="compact">Компактная</option>
          </select>
        </label>
      </section>
      <section className="card settings-card">
        <h2><Terminal size={18}/> Терминал</h2>
        <label>Цвета терминала
          <select value={settings.terminalTheme} onChange={event => update('terminalTheme', event.target.value as UiSettings['terminalTheme'])}>
            <option value="follow">Как в интерфейсе</option><option value="dark">Тёмные</option><option value="light">Светлые</option>
          </select>
        </label>
        <div className="form-grid">
          <label>Размер шрифта<input type="number" min="10" max="24" value={settings.fontSize} onChange={event => update('fontSize', Number(event.target.value))}/></label>
          <label>Строк в истории<input type="number" min="100" max="50000" value={settings.scrollback} onChange={event => update('scrollback', Number(event.target.value))}/></label>
        </div>
        <label className="settings-check">
          <input type="checkbox" checked={settings.hideUnpinnedHostKeyWarnings} onChange={event => update('hideUnpinnedHostKeyWarnings', event.target.checked)}/>
          Скрывать предупреждения об отсутствии закреплённого отпечатка SSH
        </label>
      </section>
      <section className="card settings-card">
        <h2><Monitor size={18}/> Рабочее место и передачи</h2>
        <label className="settings-check"><input type="checkbox" checked={settings.restoreTabs} onChange={event => update('restoreTabs', event.target.checked)}/> Восстанавливать вкладки после обновления</label>
        <label className="settings-check"><input type="checkbox" checked={settings.confirmClose} onChange={event => update('confirmClose', event.target.checked)}/> Подтверждать закрытие при активной передаче</label>
        <label className="settings-check"><input type="checkbox" checked={settings.confirmTransfer} onChange={event => update('confirmTransfer', event.target.checked)}/> Подтверждать запуск передачи</label>
      </section>
      <section className="card settings-card">
        <h2><Shield size={18}/> Версии</h2>
        <div className="version-row"><span>Интерфейс</span><strong>{about?.ui || '—'}</strong></div>
        <div className="version-row"><span>Backend</span><strong>{about?.backend || '—'}</strong></div>
        <div className="version-row"><span>mssh CLI</span><strong>{about?.cli || '—'}</strong></div>
      </section>
    </div>
  </div>;
}
