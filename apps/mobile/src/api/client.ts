import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3333').replace(/\/$/, '');
const TOKEN_KEY = 'bikecare.token';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: Array<{ path: string; message: string }>) {
    super(message);
  }
  get offline() { return this.status === 0; }
}

// ---- token (SecureStore no celular, localStorage na web) ----
let memToken: string | null = null;
export async function getToken(): Promise<string | null> {
  if (memToken) return memToken;
  try {
    memToken = Platform.OS === 'web' ? globalThis.localStorage?.getItem(TOKEN_KEY) ?? null : await SecureStore.getItemAsync(TOKEN_KEY);
  } catch { memToken = null; }
  return memToken;
}
export async function setToken(token: string | null): Promise<void> {
  memToken = token;
  try {
    if (Platform.OS === 'web') {
      if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token); else globalThis.localStorage?.removeItem(TOKEN_KEY);
    } else if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch { /* sem armazenamento: o token vale só nesta sessão */ }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'Sem conexão. Para salvar, conecte-se à internet.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    const msg = data?.issues?.[0]?.message ?? data?.message ?? 'Algo deu errado. Tente de novo.';
    throw new ApiError(res.status, data?.code ?? 'ERROR', msg, data?.issues);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {});
export const del = <T = any>(p: string) => api<T>('DELETE', p);
