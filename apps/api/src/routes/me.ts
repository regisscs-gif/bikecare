import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { validateThresholds } from '@bikecare/core';
import * as s from '../db/schema';
import { badRequest, parse } from '../http';
import { allEntitlements } from '../services/entitlements';
import { loadUserContext } from '../services/context';
import { refreshUser } from '../services/notify';
import { revokeStrava } from '../strava/sync';

export const CURRENT_TERMS_VERSION = '2026-10-27';

export function meRoutes(api: FastifyInstance) {
  const { db } = api.deps;

  const publicUser = (u: typeof s.users.$inferSelect) => ({
    id: u.id, name: u.name, email: u.email, photoUrl: u.photoUrl, distanceUnit: u.distanceUnit, locale: u.locale, timezone: u.timezone,
    thresholds: { yellow: u.yellowPct, orange: u.orangePct, red: u.redPct },
    notifications: { wear: u.notifyWear, redWeekly: u.notifyRedWeekly, strava: u.notifyStrava },
    termsAccepted: u.termsVersion === CURRENT_TERMS_VERSION, termsVersion: u.termsVersion, plan: u.planId,
  });

  api.get('/me', async (req) => {
    const [u] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    const [strava] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, req.userId));
    return {
      ...publicUser(u!),
      entitlements: await allEntitlements(db, req.userId),
      strava: strava ? { connected: strava.status !== 'REVOKED', status: strava.status, lastSyncAt: strava.lastSyncAt } : { connected: false },
      requiredTermsVersion: CURRENT_TERMS_VERSION,
    };
  });

  api.patch('/me', async (req) => {
    const body = parse(z.object({
      name: z.string().min(1).max(120).optional(),
      distanceUnit: z.enum(['km', 'mi']).optional(),
      locale: z.enum(['pt-BR']).optional(),
      timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Fuso inválido').optional(),
      thresholds: z.object({ yellow: z.number(), orange: z.number(), red: z.number() }).optional(),
      notifications: z.object({ wear: z.boolean().optional(), redWeekly: z.boolean().optional(), strava: z.boolean().optional() }).optional(),
    }), req.body);

    const set: Partial<typeof s.users.$inferInsert> = {};
    if (body.name) set.name = body.name;
    if (body.distanceUnit) set.distanceUnit = body.distanceUnit;
    if (body.locale) set.locale = body.locale;
    if (body.timezone) set.timezone = body.timezone;
    if (body.thresholds) {
      const err = validateThresholds(body.thresholds);
      if (err) throw badRequest(err, 'INVALID_THRESHOLDS');
      set.yellowPct = Math.round(body.thresholds.yellow);
      set.orangePct = Math.round(body.thresholds.orange);
      set.redPct = Math.round(body.thresholds.red);
    }
    if (body.notifications) {
      if (body.notifications.wear !== undefined) set.notifyWear = body.notifications.wear;
      if (body.notifications.redWeekly !== undefined) set.notifyRedWeekly = body.notifications.redWeekly;
      if (body.notifications.strava !== undefined) set.notifyStrava = body.notifications.strava;
    }
    if (Object.keys(set).length) await db.update(s.users).set(set).where(eq(s.users.id, req.userId));
    // Mudar limites recalcula as cores na hora, sem gerar aviso retroativo: alinhamos o estado de cor ao novo cálculo.
    if (body.thresholds) await silentRealign(api, req.userId);
    const [u] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    return publicUser(u!);
  });

  /** Aceite dos termos, registrado com data e versão. */
  api.post('/me/terms', async (req) => {
    const { version } = parse(z.object({ version: z.string() }), req.body);
    if (version !== CURRENT_TERMS_VERSION) throw badRequest('Versão dos termos desatualizada.', 'TERMS_VERSION');
    await db.update(s.users).set({ termsVersion: version, termsAcceptedAt: api.deps.now() }).where(eq(s.users.id, req.userId));
    return { ok: true };
  });

  /** Exclusão de conta dentro do app: apaga tudo e revoga o Strava. */
  api.delete('/me', async (req, reply) => {
    await revokeStrava(api.deps, req.userId).catch(() => undefined);
    await db.delete(s.users).where(eq(s.users.id, req.userId));
    return reply.status(204).send();
  });

  /** Exportação de dados (LGPD). Sem atividades do Strava no arquivo além do necessário já guardado. */
  api.get('/me/export', async (req) => {
    const ctx = await loadUserContext(db, req.userId);
    const [records, items, expenses, history] = await Promise.all([
      db.select().from(s.maintenanceRecords).where(eq(s.maintenanceRecords.userId, req.userId)),
      db.select().from(s.maintenanceItems),
      db.select().from(s.expenses).where(eq(s.expenses.userId, req.userId)),
      db.select().from(s.partHistory),
    ]);
    const partIds = new Set(ctx.parts.map((p) => p.id));
    const recIds = new Set(records.map((r) => r.id));
    return {
      exportedAt: api.deps.now().toISOString(),
      user: publicUser(ctx.user),
      bikes: ctx.bikes,
      parts: ctx.parts,
      installations: ctx.installations,
      activities: ctx.activities,
      maintenanceRecords: records,
      maintenanceItems: items.filter((i) => recIds.has(i.recordId)),
      expenses,
      partHistory: history.filter((h) => partIds.has(h.partId)),
    };
  });
}

/** Realinha o estado de notificação ao novo semáforo sem criar avisos. */
async function silentRealign(api: FastifyInstance, userId: string) {
  const { db } = api.deps;
  const { computePartWear } = await import('@bikecare/core');
  const { installedOn, loadUserContext: load, partInput } = await import('../services/context');
  const ctx = await load(db, userId);
  const now = api.deps.now();
  for (const b of ctx.bikes.filter((x) => x.status === 'ACTIVE')) {
    for (const p of installedOn(ctx, b.id)) {
      const w = computePartWear(partInput(ctx, p, now));
      await db.insert(s.partColorState).values({ partId: p.id, color: w.color, notifiedColor: w.color, lastRedReminder: w.color === 'RED' ? now : null })
        .onConflictDoUpdate({ target: s.partColorState.partId, set: { color: w.color, notifiedColor: w.color } });
    }
  }
}
export { refreshUser };
