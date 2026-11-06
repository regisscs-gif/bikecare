import { and, eq, inArray } from 'drizzle-orm';
import {
  evaluateBike, type Activity, type BikeEval, type Installation, type Part, type PartEvalInput, type PartRuleState,
  type Rule, type Thresholds, type UserRuleOverride,
} from '@bikecare/core';
import type { DB } from '../db/client';
import * as s from '../db/schema';

/** Tudo de um usuário que o motor precisa. Os dados por usuário são pequenos; carregar de uma vez é simples e determinístico. */
export interface UserContext {
  user: typeof s.users.$inferSelect;
  bikes: Array<typeof s.bikes.$inferSelect>;
  parts: Array<typeof s.parts.$inferSelect>;
  installations: Installation[];
  activities: Activity[];
  rules: Rule[];
  services: Array<typeof s.services.$inferSelect>;
  partRules: Array<typeof s.partRules.$inferSelect>;
  /** max(reset) por peça+serviço derivado dos registros de manutenção */
  recordResets: Map<string, Date>;
}

export const thresholdsOf = (u: { yellowPct: number; orangePct: number; redPct: number }): Thresholds => ({
  yellow: u.yellowPct, orange: u.orangePct, red: u.redPct,
});

export function toCoreRule(r: typeof s.rules.$inferSelect, sourceIds: string[]): Rule {
  return {
    id: r.id,
    target: r.modelId ? { kind: 'model', id: r.modelId } : { kind: 'category', id: r.categoryId! },
    serviceId: r.serviceId,
    criteria: { km: r.kmLimit, hours: r.hoursLimit, days: r.daysLimit },
    origin: r.origin as Rule['origin'],
    version: r.version,
    status: r.status as Rule['status'],
    note: r.note,
    sourceIds,
  };
}

export async function loadRules(db: DB): Promise<Rule[]> {
  const rows = await db.select().from(s.rules).where(inArray(s.rules.status, ['PUBLISHED', 'ARCHIVED']));
  const links = await db.select().from(s.ruleSources);
  const byRule = new Map<string, string[]>();
  for (const l of links) byRule.set(l.ruleId, [...(byRule.get(l.ruleId) ?? []), l.sourceId]);
  return rows.map((r) => toCoreRule(r, byRule.get(r.id) ?? []));
}

export async function loadUserContext(db: DB, userId: string): Promise<UserContext> {
  const [user] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!user) throw new Error('Usuário não encontrado');
  const bikes = await db.select().from(s.bikes).where(eq(s.bikes.userId, userId));
  const parts = await db.select().from(s.parts).where(eq(s.parts.userId, userId));
  const partIds = parts.map((p) => p.id);
  const insts = partIds.length ? await db.select().from(s.installations).where(inArray(s.installations.partId, partIds)) : [];
  const acts = await db.select().from(s.activities).where(eq(s.activities.userId, userId));
  const partRules = partIds.length ? await db.select().from(s.partRules).where(inArray(s.partRules.partId, partIds)) : [];
  const services = await db.select().from(s.services);

  const items = partIds.length
    ? await db
        .select({ partId: s.maintenanceItems.partId, serviceIds: s.maintenanceItems.serviceIds, resetAt: s.maintenanceRecords.resetAt })
        .from(s.maintenanceItems)
        .innerJoin(s.maintenanceRecords, eq(s.maintenanceItems.recordId, s.maintenanceRecords.id))
        .where(and(eq(s.maintenanceRecords.userId, userId)))
    : [];
  const recordResets = new Map<string, Date>();
  for (const it of items) {
    for (const sid of it.serviceIds) {
      const k = `${it.partId}|${sid}`;
      const cur = recordResets.get(k);
      if (!cur || it.resetAt > cur) recordResets.set(k, it.resetAt);
    }
  }

  return {
    user,
    bikes,
    parts,
    installations: insts.map((i) => ({ partId: i.partId, bikeId: i.bikeId, positionId: i.positionId, start: i.startedAt, end: i.endedAt })),
    activities: acts.map((a) => ({
      id: a.id, bikeId: a.bikeId, date: a.date, indoor: a.indoor, distanceM: a.distanceM, movingS: a.movingS, elapsedS: a.elapsedS,
    })),
    rules: await loadRules(db),
    services,
    partRules,
    recordResets,
  };
}

/** Estado de cada regra da peça, derivado de eventos: reset = o mais recente entre o informado no cadastro e os registros de manutenção. */
export function buildStates(ctx: UserContext, partId: string): PartRuleState[] {
  const rows = ctx.partRules.filter((r) => r.partId === partId);
  const states: PartRuleState[] = [];
  const seen = new Set<string>();
  const add = (serviceId: string) => {
    if (seen.has(serviceId)) return;
    seen.add(serviceId);
    const row = rows.find((r) => r.serviceId === serviceId);
    const rec = ctx.recordResets.get(`${partId}|${serviceId}`) ?? null;
    const base = row?.resetAt ?? null;
    const resetAt = rec && base ? (rec > base ? rec : base) : (rec ?? base);
    const lifetime = ctx.services.find((x) => x.id === serviceId)?.lifetime ?? false;
    const consolidated = row?.consolidatedAt ? { at: row.consolidatedAt, km: row.consolidatedKm ?? 0, hours: row.consolidatedHours ?? 0 } : null;
    states.push({ partId, serviceId, resetAt, lifetime, pinnedRuleId: row?.pinnedRuleId ?? null, consolidated });
  };
  for (const svc of ctx.services) if (svc.lifetime) add(svc.id);
  for (const r of rows) add(r.serviceId);
  for (const k of ctx.recordResets.keys()) {
    const [p, sid] = k.split('|');
    if (p === partId && sid) add(sid);
  }
  return states;
}

export function buildOverrides(ctx: UserContext, partId: string): UserRuleOverride[] {
  return ctx.partRules
    .filter((r) => r.partId === partId && (r.disabled || r.custom || r.userKm || r.userHours || r.userDays))
    .map((r) => ({
      serviceId: r.serviceId,
      disabled: r.disabled,
      custom: r.custom,
      basedOn: (r.basedOn as 'MANUFACTURER' | 'PLATFORM' | null) ?? undefined,
      criteria: r.userKm || r.userHours || r.userDays ? { km: r.userKm, hours: r.userHours, days: r.userDays } : undefined,
    }));
}

export function partInput(ctx: UserContext, part: typeof s.parts.$inferSelect, asOf: Date, rules = ctx.rules): PartEvalInput {
  const corePart: Part = {
    id: part.id, categoryId: part.categoryId, modelId: part.modelId, wearsIndoor: part.wearsIndoor,
    status: part.status as Part['status'], initialKm: part.initialKm, initialHours: part.initialHours,
  };
  return {
    part: corePart,
    installations: ctx.installations,
    activities: ctx.activities,
    rules,
    overrides: buildOverrides(ctx, part.id),
    states: buildStates(ctx, part.id),
    thresholds: thresholdsOf(ctx.user),
    asOf,
  };
}

/** Peças instaladas hoje numa bike (instalação aberta). */
export function installedOn(ctx: UserContext, bikeId: string) {
  const open = new Set(ctx.installations.filter((i) => i.bikeId === bikeId && i.end === null).map((i) => i.partId));
  return ctx.parts.filter((p) => open.has(p.id) && p.status === 'INSTALLED');
}

export function evaluateBikeById(ctx: UserContext, bikeId: string, asOf = new Date()): BikeEval {
  return evaluateBike(installedOn(ctx, bikeId).map((p) => partInput(ctx, p, asOf)));
}
