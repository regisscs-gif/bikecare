import { and, eq, inArray, lte, max, sql } from 'drizzle-orm';
import { computePartWear } from '@bikecare/core';
import type { AppDeps } from '../app';
import * as s from '../db/schema';
import { badRequest, HttpError } from '../http';
import { createBike } from '../services/bikes';
import { installedOn, loadUserContext, partInput } from '../services/context';
import { refreshUser } from '../services/notify';
import { realStravaClient, StravaRateLimited, StravaUnauthorized, type StravaActivity, type StravaClient } from './client';
import { decryptToken, encryptToken } from './crypto';
import { DEFAULT_ACTIVITY_TYPES, mapStravaActivity } from './mapping';

const client = (deps: AppDeps): StravaClient => deps.strava ?? realStravaClient;

export async function acceptedTypes(deps: AppDeps): Promise<string[]> {
  const [row] = await deps.db.select().from(s.appSettings).where(eq(s.appSettings.key, 'strava.activityTypes'));
  return Array.isArray(row?.value) && row.value.length ? (row.value as string[]) : DEFAULT_ACTIVITY_TYPES;
}

/** Token válido; renova se faltar menos de 1 minuto. Falha de autorização marca a conexão e avisa o usuário. */
export async function accessToken(deps: AppDeps, userId: string): Promise<string> {
  const { db } = deps;
  const [conn] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, userId));
  if (!conn || conn.status === 'REVOKED') throw new HttpError(409, 'STRAVA_NOT_CONNECTED', 'Strava não conectado.');
  if (conn.expiresAt.getTime() - deps.now().getTime() > 60_000) return decryptToken(conn.accessTokenEnc);
  try {
    const t = await client(deps).refresh(decryptToken(conn.refreshTokenEnc));
    await db.update(s.stravaConnections).set({
      accessTokenEnc: encryptToken(t.accessToken), refreshTokenEnc: encryptToken(t.refreshToken), expiresAt: t.expiresAt, status: 'OK',
    }).where(eq(s.stravaConnections.userId, userId));
    return t.accessToken;
  } catch (e) {
    if (e instanceof StravaUnauthorized) await markStravaError(deps, userId);
    throw e;
  }
}

/** "Token expirado ou acesso revogado": notificação pedindo para reconectar. */
export async function markStravaError(deps: AppDeps, userId: string) {
  const { db } = deps;
  await db.update(s.stravaConnections).set({ status: 'ERROR' }).where(eq(s.stravaConnections.userId, userId));
  const [u] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!u?.notifyStrava) return;
  const recent = await db.select().from(s.notifications).where(and(eq(s.notifications.userId, userId), eq(s.notifications.type, 'STRAVA_ERROR'), eq(s.notifications.read, false)));
  if (recent.length) return; // um aviso não lido basta
  await db.insert(s.notifications).values({ userId, type: 'STRAVA_ERROR', text: 'Reconecte o Strava para continuar contando seus pedais.', push: true });
  await refreshUser(db, userId, { now: deps.now(), sender: deps.sender });
}

export async function connectStrava(deps: AppDeps, userId: string, code: string, scope: string) {
  const { db } = deps;
  if (!scope.includes('activity:read')) throw badRequest('É preciso autorizar a leitura de atividades.', 'STRAVA_SCOPE');
  const t = await client(deps).exchangeCode(code);
  const [taken] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.athleteId, t.athleteId));
  if (taken && taken.userId !== userId) throw new HttpError(409, 'STRAVA_ATHLETE_TAKEN', 'Esta conta do Strava já está ligada a outro usuário.');
  const values = {
    athleteId: t.athleteId, accessTokenEnc: encryptToken(t.accessToken), refreshTokenEnc: encryptToken(t.refreshToken),
    expiresAt: t.expiresAt, scope, status: 'OK',
  };
  await db.insert(s.stravaConnections).values({ userId, ...values }).onConflictDoUpdate({ target: s.stravaConnections.userId, set: values });
  return { athleteId: t.athleteId };
}

export async function listGear(deps: AppDeps, userId: string) {
  const gear = await client(deps).getGear(await accessToken(deps, userId));
  const linked = await deps.db.select({ g: s.bikes.stravaGearId, id: s.bikes.id }).from(s.bikes).where(eq(s.bikes.userId, userId));
  return gear.map((g) => ({ ...g, linkedBikeId: linked.find((l) => l.g === g.id)?.id ?? null }));
}

/**
 * Importa as bikes escolhidas: cria a bike com o nome do Strava, já vinculada. O tipo é informado pelo usuário.
 * A bike marcada como principal no Strava vira a bike padrão do app.
 */
export async function importGear(deps: AppDeps, userId: string, picks: Array<{ gearId: string; type: string; partsInstalledAt?: string | null }>) {
  const gear = await listGear(deps, userId);
  const [user] = await deps.db.select().from(s.users).where(eq(s.users.id, userId));
  const created: string[] = [];
  for (const p of picks) {
    const g = gear.find((x) => x.id === p.gearId);
    if (!g) throw badRequest(`Bike do Strava não encontrada: ${p.gearId}`);
    if (g.linkedBikeId) continue;
    const { bike } = await createBike(deps.db, user!, {
      name: g.name, type: p.type, brand: g.brand ?? null, model: g.model ?? null, stravaGearId: g.id,
      makeDefault: g.primary, partsInstalledAt: p.partsInstalledAt ?? null,
    }, deps.now());
    created.push(bike.id);
  }
  if (created.length) await enqueue(deps, userId, { kind: 'INITIAL' });
  return { created };
}

/** Vincular uma bike já cadastrada a uma bike do Strava, sem perder histórico. */
export async function linkGear(deps: AppDeps, userId: string, bikeId: string, gearId: string) {
  const { db } = deps;
  const gear = await listGear(deps, userId);
  const g = gear.find((x) => x.id === gearId);
  if (!g) throw badRequest('Bike do Strava não encontrada.');
  if (g.linkedBikeId && g.linkedBikeId !== bikeId) throw badRequest('Esta bike do Strava já está vinculada a outra bike.', 'STRAVA_GEAR_TAKEN');
  await db.update(s.bikes).set({ stravaGearId: gearId }).where(and(eq(s.bikes.id, bikeId), eq(s.bikes.userId, userId)));
  await enqueue(deps, userId, { kind: 'INITIAL' });
}

// ───────── Fila com nova tentativa ─────────

export async function enqueue(deps: AppDeps, userId: string, job: { kind: 'INITIAL' | 'ACTIVITY'; objectId?: string; aspect?: string; updates?: unknown }) {
  const [row] = await deps.db.insert(s.stravaJobs).values({
    userId, kind: job.kind, objectId: job.objectId ?? null, aspect: job.aspect ?? null, updates: (job.updates ?? null) as never, nextAttemptAt: deps.now(),
  }).returning({ id: s.stravaJobs.id });
  return row!.id;
}

/** Processa os trabalhos vencidos. Limite de uso da API: reagenda; outras falhas: recuo exponencial até 6 tentativas. */
export async function processJobs(deps: AppDeps, limit = 25): Promise<{ done: number; retried: number; failed: number }> {
  const { db } = deps;
  const now = deps.now();
  const due = await db.select().from(s.stravaJobs).where(and(eq(s.stravaJobs.status, 'PENDING'), lte(s.stravaJobs.nextAttemptAt, now))).orderBy(s.stravaJobs.createdAt).limit(limit);
  const out = { done: 0, retried: 0, failed: 0 };
  const touched = new Set<string>();
  for (const job of due) {
    try {
      if (job.kind === 'INITIAL') await initialImport(deps, job.userId);
      else await applyActivityEvent(deps, job.userId, { id: job.objectId!, aspect: job.aspect as string, updates: (job.updates ?? {}) as Record<string, unknown> });
      await db.update(s.stravaJobs).set({ status: 'DONE', lastError: null }).where(eq(s.stravaJobs.id, job.id));
      await db.update(s.stravaConnections).set({ lastSyncAt: deps.now() }).where(eq(s.stravaConnections.userId, job.userId));
      touched.add(job.userId);
      out.done++;
    } catch (e) {
      const attempts = job.attempts + 1;
      if (e instanceof StravaUnauthorized) {
        await markStravaError(deps, job.userId);
        await db.update(s.stravaJobs).set({ status: 'FAILED', attempts, lastError: 'unauthorized' }).where(eq(s.stravaJobs.id, job.id));
        out.failed++;
      } else if (attempts >= 6) {
        await db.update(s.stravaJobs).set({ status: 'FAILED', attempts, lastError: String((e as Error).message) }).where(eq(s.stravaJobs.id, job.id));
        out.failed++;
      } else {
        const waitSec = e instanceof StravaRateLimited ? e.retryAfterSec : 30 * 2 ** attempts;
        await db.update(s.stravaJobs).set({ attempts, lastError: String((e as Error).message), nextAttemptAt: new Date(now.getTime() + waitSec * 1000) }).where(eq(s.stravaJobs.id, job.id));
        out.retried++;
      }
    }
  }
  // Uma atualização por usuário por rodada: avisos da mesma sincronização viram um push só.
  for (const userId of touched) await refreshUser(db, userId, { now: deps.now(), sender: deps.sender });
  return out;
}

async function gearMap(deps: AppDeps, userId: string) {
  const bikes = await deps.db.select().from(s.bikes).where(and(eq(s.bikes.userId, userId), eq(s.bikes.status, 'ACTIVE')));
  return {
    gearToBike: new Map(bikes.filter((b) => b.stravaGearId).map((b) => [b.stravaGearId!, b.id])),
    defaultBikeId: bikes.find((b) => b.isDefault)?.id ?? null,
    linkedBikeIds: bikes.filter((b) => b.stravaGearId).map((b) => b.id),
  };
}

/** Importação inicial: atividades desde a data de instalação mais antiga entre as peças das bikes vinculadas (e depois do último consolidado). */
export async function initialImport(deps: AppDeps, userId: string) {
  const { db } = deps;
  const token = await accessToken(deps, userId);
  const types = await acceptedTypes(deps);
  const maps = await gearMap(deps, userId);
  const ctx = await loadUserContext(db, userId);
  const starts = ctx.installations.filter((i) => maps.linkedBikeIds.includes(i.bikeId) || (maps.defaultBikeId && i.bikeId === maps.defaultBikeId)).map((i) => i.start.getTime());
  if (!starts.length) return 0;
  let after = Math.min(...starts);
  const [{ at } = { at: null }] = await db.select({ at: max(s.partRules.consolidatedAt) }).from(s.partRules)
    .where(inArray(s.partRules.partId, ctx.parts.map((p) => p.id).concat('none')));
  if (at && at.getTime() > after) after = at.getTime();

  let imported = 0;
  for (let page = 1; page <= 50; page++) {
    const batch = await client(deps).listActivities(token, Math.floor(after / 1000), page);
    for (const a of batch) if (await upsertActivity(deps, userId, a, { types, ...maps })) imported++;
    if (batch.length < 200) break;
  }
  return imported;
}

async function upsertActivity(
  deps: AppDeps, userId: string, a: StravaActivity,
  m: { types: string[]; gearToBike: Map<string, string>; defaultBikeId: string | null },
  opts: { keepBike?: boolean } = {},
): Promise<boolean> {
  const { db } = deps;
  const [existing] = await db.select().from(s.activities).where(and(eq(s.activities.userId, userId), eq(s.activities.source, 'STRAVA'), eq(s.activities.externalId, String(a.id))));
  const mapped = mapStravaActivity(a, { acceptedTypes: m.types, gearToBike: m.gearToBike, defaultBikeId: m.defaultBikeId });
  if (!mapped.ok) {
    if (existing) await db.delete(s.activities).where(eq(s.activities.id, existing.id)); // passou a ser ignorada (ex.: mudou de tipo)
    return false;
  }
  const v = mapped.value;
  const values = { date: v.date, type: v.type, indoor: v.indoor, distanceM: v.distanceM, movingS: v.movingS, elapsedS: v.elapsedS, bikeId: opts.keepBike && existing ? existing.bikeId : v.bikeId };
  if (existing) await db.update(s.activities).set(values).where(eq(s.activities.id, existing.id));
  else await db.insert(s.activities).values({ userId, source: 'STRAVA', kind: 'RIDE', externalId: v.externalId, ...values });
  return true;
}

/** Evento do webhook: criar/editar reprocessa a atividade; apagar remove e recalcula. */
export async function applyActivityEvent(deps: AppDeps, userId: string, ev: { id: string; aspect: string; updates: Record<string, unknown> }) {
  const { db } = deps;
  if (ev.aspect === 'delete') {
    await db.delete(s.activities).where(and(eq(s.activities.userId, userId), eq(s.activities.source, 'STRAVA'), eq(s.activities.externalId, ev.id)));
    return;
  }
  const token = await accessToken(deps, userId);
  const a = await client(deps).getActivity(token, ev.id);
  if (!a) {
    await db.delete(s.activities).where(and(eq(s.activities.userId, userId), eq(s.activities.source, 'STRAVA'), eq(s.activities.externalId, ev.id)));
    return;
  }
  const maps = await gearMap(deps, userId);
  // Se o usuário trocou a bike da atividade dentro do app e o Strava não mudou a bike, preserva a escolha.
  await upsertActivity(deps, userId, a, { types: await acceptedTypes(deps), ...maps }, { keepBike: ev.aspect === 'update' && !('gear_id' in ev.updates) });
}

/**
 * Desconexão (ou revogação no Strava): apaga as atividades importadas e guarda o uso já acumulado
 * nas peças como "uso consolidado até <data>". Validar com os termos da API (spec, seção 17, item 4).
 */
export async function disconnectStrava(deps: AppDeps, userId: string, opts: { revokeRemote: boolean }) {
  const { db } = deps;
  const now = deps.now();
  const [conn] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, userId));
  if (!conn) return;

  // 1) consolida o contador de cada regra de cada peça
  const ctx = await loadUserContext(db, userId);
  for (const bike of ctx.bikes) {
    for (const part of installedOn(ctx, bike.id)) {
      const w = computePartWear(partInput(ctx, part, now));
      for (const r of w.rules) {
        await db.insert(s.partRules).values({ partId: part.id, serviceId: r.serviceId, consolidatedAt: now, consolidatedKm: r.usage.km, consolidatedHours: r.usage.hours })
          .onConflictDoUpdate({ target: [s.partRules.partId, s.partRules.serviceId], set: { consolidatedAt: now, consolidatedKm: r.usage.km, consolidatedHours: r.usage.hours } });
      }
    }
  }
  // 2) apaga as atividades importadas e a conexão
  await db.delete(s.activities).where(and(eq(s.activities.userId, userId), eq(s.activities.source, 'STRAVA')));
  await db.delete(s.stravaJobs).where(eq(s.stravaJobs.userId, userId));
  if (opts.revokeRemote) {
    try { await client(deps).deauthorize(decryptToken(conn.accessTokenEnc)); } catch { /* o token pode já estar revogado */ }
  }
  await db.update(s.stravaConnections).set({ status: 'REVOKED' }).where(eq(s.stravaConnections.userId, userId));
  await db.delete(s.stravaConnections).where(eq(s.stravaConnections.userId, userId));
  void sql;
}

/** Exclusão de conta: revoga o acesso ao Strava (sem consolidar, tudo será apagado). */
export async function revokeStrava(deps: AppDeps, userId: string) {
  const [conn] = await deps.db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, userId));
  if (!conn) return;
  try { await client(deps).deauthorize(decryptToken(conn.accessTokenEnc)); } catch { /* ignora */ }
}
