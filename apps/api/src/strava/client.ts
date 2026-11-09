
/** Credenciais do app do Strava usadas na troca de código e na renovação de tokens. */
export interface StravaCreds { clientId: string; clientSecret: string }
export interface StravaTokens { accessToken: string; refreshToken: string; expiresAt: Date; athleteId: string; scope?: string }
export interface StravaGear { id: string; name: string; primary: boolean; brand?: string | null; model?: string | null }
export interface StravaActivity {
  id: number;
  type?: string;
  sport_type?: string;
  start_date: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  trainer?: boolean;
  gear_id?: string | null;
}

export class StravaRateLimited extends Error {
  constructor(public retryAfterSec = 900) { super('Limite de uso da API do Strava atingido'); }
}
export class StravaUnauthorized extends Error {
  constructor() { super('Acesso ao Strava revogado ou token inválido'); }
}

/** Fronteira com a API do Strava. Integração direta, sem plataformas intermediárias (condição do Strava). */
export interface StravaClient {
  exchangeCode(code: string, creds: StravaCreds): Promise<StravaTokens>;
  refresh(refreshToken: string, creds: StravaCreds): Promise<StravaTokens>;
  deauthorize(accessToken: string): Promise<void>;
  getGear(accessToken: string): Promise<StravaGear[]>;
  listActivities(accessToken: string, afterEpoch: number, page: number): Promise<StravaActivity[]>;
  getActivity(accessToken: string, id: string): Promise<StravaActivity | null>;
}

const BASE = 'https://www.strava.com';

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 429) throw new StravaRateLimited(Number(res.headers.get('retry-after') ?? 900));
  if (res.status === 401) throw new StravaUnauthorized();
  return res;
}

const tokens = (j: any): StravaTokens => ({
  accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: new Date(j.expires_at * 1000), athleteId: String(j.athlete?.id ?? ''),
});

export const realStravaClient: StravaClient = {
  async exchangeCode(code, creds) {
    const res = await call(`${BASE}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code, grant_type: 'authorization_code' }),
    });
    if (!res.ok) throw new StravaUnauthorized();
    return tokens(await res.json());
  },
  async refresh(refreshToken, creds) {
    const res = await call(`${BASE}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new StravaUnauthorized();
    const j = await res.json();
    return { ...tokens(j), athleteId: '' };
  },
  async deauthorize(accessToken) {
    await call(`${BASE}/oauth/deauthorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `access_token=${encodeURIComponent(accessToken)}` });
  },
  async getGear(accessToken) {
    const res = await call(`${BASE}/api/v3/athlete`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Strava /athlete ${res.status}`);
    const j: any = await res.json();
    return (j.bikes ?? []).map((b: any) => ({ id: String(b.id), name: b.name, primary: !!b.primary, brand: b.brand_name ?? null, model: b.model_name ?? null }));
  },
  async listActivities(accessToken, afterEpoch, page) {
    const res = await call(`${BASE}/api/v3/athlete/activities?after=${afterEpoch}&page=${page}&per_page=200`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Strava /athlete/activities ${res.status}`);
    return (await res.json()) as StravaActivity[];
  },
  async getActivity(accessToken, id) {
    const res = await call(`${BASE}/api/v3/activities/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Strava /activities ${res.status}`);
    return (await res.json()) as StravaActivity;
  },
};
