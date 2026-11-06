import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { get, getToken, post, setToken, setUnauthorizedHandler } from '../api/client';
import type { Me } from '../api/types';

interface AuthState {
  ready: boolean;
  me: Me | null;
  loginWithGoogleIdToken: (idToken: string) => Promise<{ isNew: boolean }>;
  logout: () => Promise<void>;
  reloadMe: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const qc = useQueryClient();

  const reloadMe = useCallback(async () => {
    try {
      setMe(await get<Me>('/me'));
    } catch (e: any) {
      if (e?.status === 401) { await setToken(null); setMe(null); }
      // offline: mantém o que já temos
    }
  }, []);

  const logout = useCallback(async () => {
    await setToken(null);
    setMe(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(() => { void logout(); });
    (async () => {
      if (await getToken()) await reloadMe();
      setReady(true);
    })();
  }, [logout, reloadMe]);

  const loginWithGoogleIdToken = useCallback(async (idToken: string) => {
    const r = await post<{ token: string; isNew: boolean }>('/auth/google', { idToken });
    await setToken(r.token);
    await reloadMe();
    return { isNew: r.isNew };
  }, [reloadMe]);

  const value = useMemo(() => ({ ready, me, loginWithGoogleIdToken, logout, reloadMe }), [ready, me, loginWithGoogleIdToken, logout, reloadMe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider ausente');
  return v;
}
