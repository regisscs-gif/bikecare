import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { compareColors, type TrafficColor } from '@bikecare/core';
import * as s from '../db/schema';
import { BIKE_TEMPLATES, BIKE_TYPES } from '../db/bike-templates';
import { HttpError, badRequest, parse } from '../http';
import { canAddActiveBike } from '../services/entitlements';
import { evaluateBikeById, installedOn, loadUserContext } from '../services/context';
import { createBike } from '../services/bikes';
import { getOwnedBike, occupantOf } from '../services/parts';
import { loadLookups, presentPartSummary } from '../services/present';
import { refreshUser } from '../services/notify';

const bikeBody = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(BIKE_TYPES as [string, ...string[]]),
  brand: z.string().max(80).nullish(),
  model: z.string().max(80).nullish(),
  year: z.number().int().min(1950).max(2100).nullish(),
  stravaGearId: z.string().nullish(),
  photoUrl: z.string().url().nullish(),
});

export function bikeRoutes(api: FastifyInstance) {
  const { db } = api.deps;

  /** Tipos de bike e posições sugeridas (configuráveis no painel). */
  api.get('/bike-types', async () => {
    const rows = await db.select().from(s.bikeTypeTemplates).orderBy(asc(s.bikeTypeTemplates.bikeType), asc(s.bikeTypeTemplates.sortOrder));
    const cats = await db.select().from(s.categories);
    const name = new Map(cats.map((c) => [c.id, c.name]));
    return BIKE_TYPES.map((type) => ({
      type,
      positions: rows.filter((r) => r.bikeType === type).map((r) => ({ categoryId: r.categoryId, category: name.get(r.categoryId), name: r.name })),
    }));
  });

  /** Cards da tela principal: bikes da pior para a melhor cor, com contagem por cor. */
  api.get('/bikes', async (req) => {
    const ctx = await loadUserContext(db, req.userId);
    const now = api.deps.now();
    const list = ctx.bikes.map((b) => {
      const ev = b.status === 'ACTIVE' ? evaluateBikeById(ctx, b.id, now) : null;
      return {
        id: b.id, name: b.name, type: b.type, brand: b.brand, model: b.model, year: b.year, photoUrl: b.photoUrl, status: b.status,
        isDefault: b.isDefault, stravaLinked: !!b.stravaGearId,
        color: (ev?.color ?? 'GREEN') as TrafficColor, counts: ev?.counts ?? { GREEN: 0, YELLOW: 0, ORANGE: 0, RED: 0 },
      };
    });
    return list.sort((a, b) => (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1) || compareColors(b.color, a.color));
  });

  api.post('/bikes', async (req, reply) => {
    const body = parse(bikeBody.extend({
      /** Cria uma peça genérica em cada posição sugerida (onboarding, seção 3). */
      withSuggestedParts: z.boolean().default(true),
      partsInstalledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    }), req.body);
    const ctx = await loadUserContext(db, req.userId);
    const { bike, positions } = await createBike(db, ctx.user, body, api.deps.now());
    await refreshUser(db, req.userId, { now: api.deps.now(), sender: api.deps.sender });
    return reply.status(201).send({ id: bike.id, positions });
  });

  api.get('/bikes/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const bike = await getOwnedBike(db, req.userId, id);
    const ctx = await loadUserContext(db, req.userId);
    const now = api.deps.now();
    const lk = await loadLookups(db, ctx);
    const ev = evaluateBikeById(ctx, bike.id, now);
    const wearBy = new Map(ev.parts.map((w) => [w.partId, w]));
    const positions = await db.select().from(s.positions).where(and(eq(s.positions.bikeId, bike.id), isNull(s.positions.removedAt)));
    const installed = installedOn(ctx, bike.id);
    const byPartId = new Map(installed.map((p) => [p.id, p]));
    const open = ctx.installations.filter((i) => i.bikeId === bike.id && i.end === null);
    return {
      bike: { id: bike.id, name: bike.name, type: bike.type, brand: bike.brand, model: bike.model, year: bike.year, photoUrl: bike.photoUrl, status: bike.status, isDefault: bike.isDefault, stravaGearId: bike.stravaGearId },
      color: ev.color,
      counts: ev.counts,
      // peças do maior para o menor desgaste
      parts: ev.parts.map((w) => ({
        ...presentPartSummary(ctx, byPartId.get(w.partId)!, lk, now, wearBy.get(w.partId)),
        positionId: open.find((i) => i.partId === w.partId)?.positionId ?? null,
        positionName: positions.find((p) => p.id === open.find((i) => i.partId === w.partId)?.positionId)?.name ?? null,
      })),
      positions: positions.map((p) => ({ id: p.id, name: p.name, categoryId: p.categoryId, partId: open.find((i) => i.positionId === p.id)?.partId ?? null })),
    };
  });

  api.patch('/bikes/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(bikeBody.partial(), req.body);
    await getOwnedBike(db, req.userId, id);
    if (body.stravaGearId) {
      const [dup] = await db.select().from(s.bikes).where(and(eq(s.bikes.userId, req.userId), eq(s.bikes.stravaGearId, body.stravaGearId)));
      if (dup && dup.id !== id) throw badRequest('Esta bike do Strava já está vinculada a outra bike.', 'STRAVA_GEAR_TAKEN');
    }
    await db.update(s.bikes).set(body).where(eq(s.bikes.id, id));
    return { ok: true };
  });

  api.post('/bikes/:id/default', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = await getOwnedBike(db, req.userId, id);
    if (b.status !== 'ACTIVE') throw badRequest('Só uma bike ativa pode ser a padrão.');
    await db.update(s.bikes).set({ isDefault: false }).where(eq(s.bikes.userId, req.userId));
    await db.update(s.bikes).set({ isDefault: true }).where(eq(s.bikes.id, id));
    return { ok: true };
  });

  /** Arquivar guarda o histórico, para de contar uso e libera o lugar no plano. */
  api.post('/bikes/:id/archive', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = await getOwnedBike(db, req.userId, id);
    await db.update(s.bikes).set({ status: 'ARCHIVED', isDefault: false }).where(eq(s.bikes.id, id));
    if (b.isDefault) {
      const [other] = await db.select().from(s.bikes).where(and(eq(s.bikes.userId, req.userId), eq(s.bikes.status, 'ACTIVE')));
      if (other) await db.update(s.bikes).set({ isDefault: true }).where(eq(s.bikes.id, other.id));
    }
    return { ok: true };
  });

  api.post('/bikes/:id/unarchive', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await getOwnedBike(db, req.userId, id);
    if (!(await canAddActiveBike(db, req.userId))) throw new HttpError(403, 'ENTITLEMENT', 'Sem lugar no plano para reativar esta bike.');
    await db.update(s.bikes).set({ status: 'ACTIVE' }).where(eq(s.bikes.id, id));
    return { ok: true };
  });

  /** Excluir apaga o histórico; exige confirmação explícita. */
  api.delete('/bikes/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { confirm } = parse(z.object({ confirm: z.coerce.boolean().default(false) }), req.query);
    await getOwnedBike(db, req.userId, id);
    if (!confirm) throw badRequest('Excluir a bike apaga todo o histórico. Confirme para continuar.', 'CONFIRM_REQUIRED');
    // Peças que só existiram nesta bike são apagadas junto; peças que passaram por outras bikes vão para o estoque.
    const ctx = await loadUserContext(db, req.userId);
    for (const part of ctx.parts) {
      const mine = ctx.installations.filter((i) => i.partId === part.id);
      if (!mine.some((i) => i.bikeId === id)) continue;
      if (mine.every((i) => i.bikeId === id)) await db.delete(s.parts).where(eq(s.parts.id, part.id));
      else if (mine.some((i) => i.bikeId === id && i.end === null)) await db.update(s.parts).set({ status: 'STOCK' }).where(eq(s.parts.id, part.id));
    }
    await db.delete(s.bikes).where(eq(s.bikes.id, id));
    return reply.status(204).send();
  });

  api.post('/bikes/:id/positions', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ categoryId: z.string(), name: z.string().min(1).max(80) }), req.body);
    await getOwnedBike(db, req.userId, id);
    const [pos] = await db.insert(s.positions).values({ bikeId: id, ...body }).returning();
    return reply.status(201).send(pos);
  });

  api.delete('/positions/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const [pos] = await db.select().from(s.positions).where(eq(s.positions.id, id));
    if (!pos) throw badRequest('Posição inexistente.');
    await getOwnedBike(db, req.userId, pos.bikeId);
    if (await occupantOf(db, id)) throw new HttpError(409, 'POSITION_OCCUPIED', 'Há uma peça instalada nesta posição. Tire a peça antes.');
    // Mantém o histórico de instalações (e o uso já contado): a posição só deixa de aparecer.
    await db.update(s.positions).set({ removedAt: api.deps.now() }).where(eq(s.positions.id, id));
    return reply.status(204).send();
  });
}
