import { createContext, useContext } from 'react';
import { api } from './lib';

export type ConfigurationCatalog = { files: string[]; default: string; legacy: string };

export function configurationUrl(path: string, config: string) {
  const [pathname, search] = path.split('?', 2);
  const params = new URLSearchParams(search);
  params.set('config', config);
  return pathname + '?' + params.toString();
}

export function configurationScope(config: string, legacy: string) {
  const url = (path: string) => configurationUrl(path, config);
  return {
    config,
    url,
    api: <T,>(path: string, options?: RequestInit) => api<T>(url(path), options),
    storageKey: (key: string) => config === legacy ? key : key + ':' + config,
  };
}

export const ConfigurationContext = createContext<ReturnType<typeof configurationScope> | null>(null);

export function useConfiguration() {
  const scope = useContext(ConfigurationContext);
  if (!scope) throw new Error('ConfigurationContext is missing');
  return scope;
}
