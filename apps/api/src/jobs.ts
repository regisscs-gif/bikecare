import { and, eq, min } from 'drizzle-orm';
import type { AppDeps } from './app';
import * as s from './db/schema';
import { refreshUser } from './services/notify';
import { processJobs, scheduleSyncs } from './strava/sync';

/**
 * Rotina horária: recalcula todos os usuários (regras por tempo vencem mesmo sem pedalar, ex.: selante)
 * e envia push que ficaram retidos pelo horário silencioso ou limite diário.
 */
export async function hourlyJob(deps: AppDeps) {
  const queued = await scheduleSyncs(deps).catch((e) => { console.error('scheduleSyncs', e); return 0; });
  if (queued) await armWakeup(deps).catch((e) => console.error('armWakeup', e)); // processa os SYNC recém-enfileirados
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

/**
 * A fila de jobs do Strava NÃO é consultada em intervalo fixo: um SELECT a cada 30 s mantinha o Neon
 * (que só suspende após 5 min ocioso) ligado 24/7 e esgotou o plano gratuito. Agora o processamento é
 * disparado por eventos (webhook, conexão, rotina horária) e, se sobrar job com nova tentativa agendada,
 * um único timer acorda no horário do próximo (`armWakeup`).
 */
let wakeups = false;
let timer: NodeJS.Timeout | null = null;
const MIN_WAIT_MS = 5_000;
const MAX_WAIT_MS = 60 * 60_000;

/** Processa a fila e reagenda o próximo despertar, se houver job pendente com nova tentativa futura. */
export async function runJobs(deps: AppDeps) {
  try {
    return await processJobs(deps);
  } finally {
    await armWakeup(deps).catch((e) => console.error('armWakeup', e));
  }
}

async function armWakeup(deps: AppDeps) {
  if (!wakeups) return;
  if (timer) { clearTimeout(timer); timer = null; }
  const [row] = await deps.db.select({ next: min(s.stravaJobs.nextAttemptAt) }).from(s.stravaJobs).where(and(eq(s.stravaJobs.status, 'PENDING')));
  if (!row?.next) return; // fila vazia: nada a agendar, o banco pode suspender
  const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, row.next.getTime() - deps.now().getTime()));
  timer = setTimeout(() => { timer = null; void runJobs(deps).catch((e) => console.error('processJobs', e)); }, wait);
  timer.unref();
}

export function startBackgroundJobs(deps: AppDeps) {
  wakeups = true;
  void runJobs(deps).catch((e) => console.error('processJobs', e)); // jobs que ficaram pendentes antes do restart
  const hourly = setInterval(() => { hourlyJob(deps).catch((e) => console.error('hourlyJob', e)); }, 60 * 60_000);
  return () => { wakeups = false; clearInterval(hourly); if (timer) { clearTimeout(timer); timer = null; } };
}
