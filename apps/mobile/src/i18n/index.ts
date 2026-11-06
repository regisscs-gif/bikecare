import { ptBR, type TKey } from './pt-BR';

const dict: Record<string, string> = ptBR;

export function t(key: TKey, params?: Record<string, string | number>): string {
  let s = dict[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export type { TKey };
