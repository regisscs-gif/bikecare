import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../db/schema';
import { HttpError, badRequest, notFound, parse } from '../http';
import { loadUserContext, installedOn, partInput } from '../services/context';
import { createMaintenance } from '../services/maintenance';
import { getOwnedBike } from '../services/parts';
import { loadLookups, partLabel } from '../services/present';
import { refreshUser } from '../services/notify';
import { computePartWear } from '@bikecare/core';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD');
const cents = z.number().int().min(0).max(100_000_000);

export function maintenanceRoutes(api: FastifyInstance) {
  const { db } = api.deps;
  const after = (userId: string) => refreshUser(db, userId, { now: api.deps.now(), sender: api.deps.sender });

  /**
   * Dados para o formulário de registro: peças instaladas com cor (amarelo, laranja e vermelho primeiro),
   * e os serviços de cada peça. Serviços vencidos ou próximos já vêm marcados.
   */
  api.get('/bikes/:id/maintenance/form', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await getOwnedBike(db, req.userId, id);
    const ctx = await loadUserContext(db, req.userId);
    const lk = await loadLookups(db, ctx);
    const now = api.deps.now();
    const items = installedOn(ctx, id).map((p) => {
      const w = computePartWear(partInput(ctx, p, now));
      return {
        partId: p.id, label: partLabel(p, lk), color: w.color, pct: Math.round(w.pct),
        services: w.rules.map((r) => ({
          serviceId: r.serviceId, name: lk.services.get(r.serviceId) ?? '', pct: Math.round(r.pct),
          preselected: r.pct >= ctx.user.yellowPct,
        })),
      };
    });
    const rank: Record<string, number> = { RED: 0, ORANGE: 1, YELLOW: 2, GREEN: 3 };
    return items.sort((a, b) => (rank[a.color]! - rank[b.color]!) || b.pct - a.pct);
  });

  api.post('/bikes/:id/maintenance', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({
      date: date.default(() => '' as string),
      shop: z.string().max(120).nullish(),
      partsCostCents: cents.optional(),
      laborCostCents: cents.optional(),
      notes: z.string().max(2000).nullish(),
      items: z.array(z.object({
        partId: z.string(),
        serviceIds: z.array(z.string()).default([]),
        other: z.string().max(500).nullish(),
        replacement: z.object({
          modelId: z.string().nullish(), nickname: z.string().max(80).nullish(),
          initialKm: z.number().min(0).optional(), initialHours: z.number().min(0).optional(),
          oldPart: z.enum(['RETIRE', 'STOCK']).default('RETIRE'),
        }).nullish(),
      })).min(1),
    }), req.body);
    const [user] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    const { localDate } = await import('../tz');
    const today = localDate(api.deps.now(), user!.timezone);
    const d = body.date || today;
    if (d > today) throw badRequest('A data da manutenção não pode estar no futuro.');
    const rec = await createMaintenance(db, user!, id, { ...body, date: d }, api.deps.now());
    await after(req.userId);
    return reply.status(201).send({ id: rec.id });
  });

  /** Histórico da bike: todos os registros, com filtro por peça e período. */
  api.get('/bikes/:id/maintenance', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const q = parse(z.object({ partId: z.string().optional(), from: date.optional(), to: date.optional() }), req.query);
    await getOwnedBike(db, req.userId, id);
    const recs = await db.select().from(s.maintenanceRecords)
      .where(and(eq(s.maintenanceRecords.bikeId, id), q.from ? gte(s.maintenanceRecords.date, new Date(`${q.from}T00:00:00Z`)) : undefined, q.to ? lte(s.maintenanceRecords.date, new Date(`${q.to}T23:59:59Z`)) : undefined))
      .orderBy(desc(s.maintenanceRecords.date));
    if (!recs.length) return [];
    const items = await db.select().from(s.maintenanceItems).where(inArray(s.maintenanceItems.recordId, recs.map((r) => r.id)));
    const ctx = await loadUserContext(db, req.userId);
    const lk = await loadLookups(db, ctx);
    return recs.map((r) => ({
      id: r.id, date: r.date.toISOString().slice(0, 10), shop: r.shop, notes: r.notes, partsCostCents: r.partsCostCents, laborCostCents: r.laborCostCents,
      items: items.filter((i) => i.recordId === r.id && (!q.partId || i.partId === q.partId)).map((i) => {
        const part = ctx.parts.find((p) => p.id === i.partId);
        return {
          partId: i.partId, part: part ? partLabel(part, lk) : '', services: i.serviceIds.map((x) => lk.services.get(x) ?? x),
          serviceIds: i.serviceIds, replaced: i.replaced, other: i.other, km: Math.round(i.kmAtDate), hours: Math.round(i.hoursAtDate * 10) / 10,
        };
      }),
    })).filter((r) => !q.partId || r.items.length);
  });

  /**
   * Editar um registro recalcula os contadores (eles são derivados dos registros).
   * Troca de peça (substituição) não é desfeita por edição; edite a peça diretamente.
   */
  api.patch('/maintenance/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({
      date: date.optional(), shop: z.string().max(120).nullish(), notes: z.string().max(2000).nullish(),
      items: z.array(z.object({ partId: z.string(), serviceIds: z.array(z.string()) })).optional(),
    }), req.body);
    const [rec] = await db.select().from(s.maintenanceRecords).where(and(eq(s.maintenanceRecords.id, id), eq(s.maintenanceRecords.userId, req.userId)));
    if (!rec) throw notFound('Registro');
    const [user] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    const { resetInstant, localDate } = await import('../tz');
    const set: Partial<typeof s.maintenanceRecords.$inferInsert> = {};
    if (body.shop !== undefined) set.shop = body.shop;
    if (body.notes !== undefined) set.notes = body.notes;
    if (body.date) {
      if (body.date > localDate(api.deps.now(), user!.timezone)) throw badRequest('A data não pode estar no futuro.');
      set.date = new Date(`${body.date}T12:00:00Z`);
      set.resetAt = resetInstant(body.date, user!.timezone, api.deps.now());
    }
    if (Object.keys(set).length) await db.update(s.maintenanceRecords).set(set).where(eq(s.maintenanceRecords.id, id));
    if (body.items) {
      const current = await db.select().from(s.maintenanceItems).where(eq(s.maintenanceItems.recordId, id));
      for (const it of body.items) {
        const row = current.find((c) => c.partId === it.partId);
        if (!row) throw badRequest('Peça não faz parte deste registro.');
        if (row.replaced) throw new HttpError(409, 'REPLACED_ITEM', 'Este item registra uma substituição; edite a peça diretamente.');
        await db.update(s.maintenanceItems).set({ serviceIds: it.serviceIds }).where(eq(s.maintenanceItems.id, row.id));
      }
    }
    await after(req.userId);
    return { ok: true };
  });

  api.delete('/maintenance/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const [rec] = await db.select().from(s.maintenanceRecords).where(and(eq(s.maintenanceRecords.id, id), eq(s.maintenanceRecords.userId, req.userId)));
    if (!rec) throw notFound('Registro');
    const items = await db.select().from(s.maintenanceItems).where(eq(s.maintenanceItems.recordId, id));
    if (items.some((i) => i.replaced)) throw new HttpError(409, 'REPLACED_ITEM', 'Este registro inclui uma substituição de peça e não pode ser apagado.');
    await db.delete(s.maintenanceRecords).where(eq(s.maintenanceRecords.id, id)); // itens e gastos ligados caem em cascata
    await after(req.userId);
    return reply.status(204).send();
  });
}
