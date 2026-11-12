export type Host = {
  host: string;
  user: string;
  port?: number;
  key_file?: string;
  password_env?: string;
  host_key?: string;
  agent?: boolean;
  has_inline_password?: boolean;
  [key: string]: unknown;
};

export type Route = {
  name: string;
  target: string;
  hops: string[];
  disabled?: boolean;
  priority?: number;
  addresses?: Record<string, string>;
};

export type Model = {
  nodes: Record<string, Host>;
  direct_hosts: string[];
  paths: string[][];
  routes: Route[];
  legacy: boolean;
  text: string;
  version: string;
  parse_error?: string;
};

export type HostKeyWarning = { node: string; kind: string; fingerprint: string | null };
export type Session = {
  id: string;
  target: string;
  route: string;
  active_route?: string;
  state: string;
  error: string;
  warnings?: HostKeyWarning[];
  created?: number;
};

export type Transfer = {
  id: string;
  target: string;
  route: string;
  direction: 'upload' | 'download';
  local: string;
  remote: string;
  state: string;
  logs: string[];
};

export type Tab = {
  id: string;
  kind: 'terminal' | 'transfer';
  title: string;
  sessionId?: string;
  transferId?: string;
  target?: string;
  route?: string;
};

export type Layout = {
  panels: string[][];
  active: Record<number, string>;
  maximized: number | null;
  direction: 'horizontal' | 'vertical';
};

export type UiSettings = {
  theme: 'dark' | 'light';
  density: 'comfortable' | 'compact';
  fontSize: number;
  scrollback: number;
  terminalTheme: 'follow' | 'dark' | 'light';
  restoreTabs: boolean;
  confirmClose: boolean;
  confirmTransfer: boolean;
};

export type SecretOperation = { action: 'keep' | 'replace' | 'remove'; value?: string };

export const defaultSettings: UiSettings = {
  theme: 'dark',
  density: 'comfortable',
  fontSize: 14,
  scrollback: 5000,
  terminalTheme: 'follow',
  restoreTabs: true,
  confirmClose: true,
  confirmTransfer: true,
};

export const initialLayout: Layout = {
  panels: [[]], active: {}, maximized: null, direction: 'horizontal',
};

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: options?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* non-JSON error */ }
    throw new Error(detail);
  }
  return res.json();
}

export const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export function stored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || '') as T; } catch { return fallback; }
}

export const routeLabel = (route: Route) => `local → ${route.hops.join(' → ')}`;

export const stateLabel: Record<string, string> = {
  connecting: 'Подключение',
  verifying_host_key: 'Проверка ключа',
  connected: 'Подключён',
  disconnected: 'Отключён',
  exited: 'Завершён',
  error: 'Ошибка',
  queued: 'В очереди',
  running: 'Выполняется',
  done: 'Готово',
  cancelled: 'Отменено',
  interrupted: 'Прервано',
};
