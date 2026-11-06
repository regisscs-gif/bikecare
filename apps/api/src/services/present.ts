import { eq, inArray } from 'drizzle-orm';
import { computePartWear, originLabel, redLabel, RED_DISCLAIMER, thresholdsOrDefault, type PartWear, type RuleWear } from './core-shim';
import type { DB } from '../db/client';
import * as s from '../db/schema';
import { partInput, type UserContext } from './context';

export interface Lookups {
  categories: Map<string, typeof s.categories.$inferSelect>;
  models: Map<string, { id: string; name: string; isGeneric: boolean; manufacturerId: string | null; manufacturerName: string | null }>;
  services: Map<string, string>;
  sources: Map<string, { id: string; title: string; type: string; url: string | null }>;
}

export async function loadLookups(db: DB, ctx: UserContext): Promise<Lookups> {
  const cats = await db.select().from(s.categories);
  const modelIds = [...new Set(ctx.parts.map((p) => p.modelId).filter((x): x is string => !!x))];
  const rows = modelIds.length
    ? await db.select({ m: s.models, maker: s.manufacturers.name }).from(s.models).leftJoin(s.manufacturers, eq(s.models.manufacturerId, s.manufacturers.id)).where(inArray(s.models.id, modelIds))
    : [];
  const srcs = await db.select().from(s.sources);
  return {
    categories: new Map(cats.map((c) => [c.id, c])),
    models: new Map(rows.map((r) => [r.m.id, { id: r.m.id, name: r.m.name, isGeneric: r.m.isGeneric, manufacturerId: r.m.manufacturerId, manufacturerName: r.maker }])),
    services: new Map(ctx.services.map((x) => [x.id, x.name])),
    sources: new Map(srcs.map((x) => [x.id, { id: x.id, title: x.title, type: x.type, url: x.url }])),
  };
}

export const partLabel = (p: UserContext['parts'][number], lk: Lookups) =>
  p.nickname ?? (p.modelId ? lk.models.get(p.modelId)?.name : null) ?? lk.categories.get(p.categoryId)?.name ?? 'Componente';

export function presentRule(r: RuleWear, ctx: UserContext, lk: Lookups, makerName?: string | null) {
  const t = thresholdsOrDefault(ctx.user);
  const color = r.pct >= t.red ? 'RED' : r.pct >= t.orange ? 'ORANGE' : r.pct >= t.yellow ? 'YELLOW' : 'GREEN';
  return {
    serviceId: r.serviceId,
    service: lk.services.get(r.serviceId) ?? '',
    origin: r.origin,
    originLabel: originLabel(r, makerName ?? undefined),
    note: r.note,
    sources: r.sourceIds.map((id) => lk.sources.get(id)).filter(Boolean),
    pct: round(r.pct),
    color,
    overdueLabel: color === 'RED' ? redLabel(r.pct, t) : null,
    criteria: r.criteria.map((c) => ({ unit: c.unit, used: round(c.used), limit: c.limit, pct: round(c.pct), remaining: round(c.remaining) })),
    nextDue: r.nextDue ? { unit: r.nextDue.unit, remaining: round(r.nextDue.remaining) } : null,
    forecastDate: r.forecastDate ? r.forecastDate.toISOString().slice(0, 10) : null,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

export function presentPartSummary(ctx: UserContext, part: UserContext['parts'][number], lk: Lookups, asOf: Date, wear?: PartWear) {
  const w = wear ?? computePartWear(partInput(ctx, part, asOf));
  const t = thresholdsOrDefault(ctx.user);
  const model = part.modelId ? lk.models.get(part.modelId) : null;
  return {
    id: part.id,
    label: partLabel(part, lk),
    category: lk.categories.get(part.categoryId)?.name ?? '',
    categoryId: part.categoryId,
    modelId: part.modelId,
    manufacturer: model?.manufacturerName ?? null,
    isGeneric: !part.modelId,
    status: part.status,
    wearsIndoor: part.wearsIndoor,
    pct: round(w.pct),
    color: w.color,
    overdueLabel: w.color === 'RED' ? redLabel(w.pct, t) : null,
    next: w.worst ? { service: lk.services.get(w.worst.serviceId) ?? '', unit: w.worst.nextDue?.unit ?? null, remaining: w.worst.nextDue ? round(w.worst.nextDue.remaining) : null } : null,
  };
}

export { RED_DISCLAIMER };
