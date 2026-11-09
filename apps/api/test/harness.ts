import { makeTestDb } from './helpers';
import { buildApp } from '../src/app';
import type { PushSender } from '../src/services/notify';
import type { StravaActivity, StravaClient, StravaGear } from '../src/strava/client';
import { StravaUnauthorized } from '../src/strava/client';

export const NOON_SP = new Date('2026-10-27T15:00:00Z'); // 12:00 em São Paulo

export class FakeStrava implements StravaClient {
  gear: StravaGear[] = [];
  activities: StravaActivity[] = [];
  athleteId = '9001';
  revoked = false;
  deauthorized = 0;
  credsUsed: Array<{ op: string; clientId: string }> = [];
  async exchangeCode(_code?: string, creds?: { clientId: string }) {
    this.credsUsed.push({ op: 'exchange', clientId: creds?.clientId ?? '' });
    return { accessToken: 'acc', refreshToken: 'ref', expiresAt: new Date(Date.now() + 3600_000), athleteId: this.athleteId };
  }
  async refresh(_rt?: string, creds?: { clientId: string }) {
    this.credsUsed.push({ op: 'refresh', clientId: creds?.clientId ?? '' });
    if (this.revoked) throw new StravaUnauthorized();
    return { accessToken: 'acc2', refreshToken: 'ref2', expiresAt: new Date(Date.now() + 3600_000), athleteId: '' };
  }
  async deauthorize() { this.deauthorized++; }
  async getGear() { return this.gear; }
  async listActivities(_t: string, after: number, page: number) {
    const rows = this.activities.filter((a) => new Date(a.start_date).getTime() / 1000 >= after);
    return page === 1 ? rows : [];
  }
  async getActivity(_t: string, id: string) { return this.activities.find((a) => String(a.id) === id) ?? null; }
}

export async function makeHarness() {
  process.env.TOKEN_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64');
  const { config } = await import('../src/config');
  config.tokenEncKey = Buffer.alloc(32, 7).toString('base64');
  config.strava.webhookVerifyToken = 'verify-me';
  config.strava.clientId = 'global-id';
  config.strava.clientSecret = 'global-secret';

  const { db } = await makeTestDb();
  const clock = { now: new Date(NOON_SP) };
  const pushes: Array<{ userId: string; body: string }> = [];
  const sender: PushSender = { async send(userId, _t, _title, body) { pushes.push({ userId, body }); } };
  const strava = new FakeStrava();
  const app = await buildApp({
    db, now: () => clock.now, sender, strava,
    googleVerifier: async (tok) => {
      const email = tok.replace(/^tok:/, '');
      return { sub: `sub-${email}`, email, name: email.split('@')[0]! };
    },
  });

  async function call(method: string, url: string, token?: string, payload?: unknown) {
    const res = await app.inject({ method: method as 'GET', url: `/v1${url}`, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
    let body: any = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body };
  }
  async function signup(email: string): Promise<{ token: string; isNew: boolean }> {
    const r = await call('POST', '/auth/google', undefined, { idToken: `tok:${email}` });
    if (r.status !== 200) throw new Error(`signup falhou: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  return { app, db, clock, pushes, strava, call, signup, sender };
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;
