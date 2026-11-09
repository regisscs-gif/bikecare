import type { AppDeps } from './app';
import * as s from './db/schema';
import { refreshUser } from './services/notify';
import { processJobs, scheduleSyncs } from './strava/sync';

/**
 * Rotina horária: recalcula todos os usuários (regras por tempo vencem mesmo sem pedalar, ex.: selante)
 * e envia push que ficaram retidos pelo horário silencioso ou limite diário.
 */
export async function hourlyJob(deps: AppDeps) {
  await scheduleSyncs(deps).catch((e) => console.error('scheduleSyncs', e));
  const users = await deps.db.select({ id: s.users.id }).from(s.users);
  let created = 0;
  for (const u of users) {
    try {
      created += (await refreshUser(deps.db, u.id, { now: deps.now(), sender: deps.sender })).created;
    } catch (e) {
      console.error('hourlyJob user', u.id, e);
    }
  }
  return { users: users.length, created };
}

export function startBackgroundJobs(deps: AppDeps) {
  const timers = [
    setInterval(() => { processJobs(deps).catch((e) => console.error('processJobs', e)); }, 30_000),
    setInterval(() => { hourlyJob(deps).catch((e) => console.error('hourlyJob', e)); }, 60 * 60_000),
  ];
  return () => timers.forEach(clearInterval);
}
