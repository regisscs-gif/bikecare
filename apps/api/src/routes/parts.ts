import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { computePartWear, resolveRules, RED_DISCLAIMER } from '@bikecare/core';
import * as s from '../db/schema';
import { HttpError, badRequest, notFound, parse } from '../http';
import { loadUserContext, partInput } from '../services/context';
import { closeInstallation, createPart, getOwnedBike, getOwnedPart, occupantOf, openInstallation } from '../services/parts';
import { loadLookups, partLabel, presentPartSummary, presentRule } from '../services/present';
import { refreshUser } from '../services/notify';
import { localDate, startOfDay } from '../tz';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD');
const criteria = z.object({
  km: z.number().positive().nullish(),
  hours: z.number().positive().nullish(),
  days: z.number().positive().nullish(),
}).refine((c) => !!(c.km || c.hours || c.days), 'Informe ao menos um limite (km, horas ou dias).');

export function partRoutes(api: FastifyInstance) {
  const { db } = api.deps;
  const after = (userId: string) => refreshUser(db, userId, { now: api.deps.now(), sender: api.deps.sender });

  /** "Hoje" = agora; data passada = início daquele dia no fuso do usuário. */
  const instant = (d: string | null | undefined, tz: string) => {
    const now = api.deps.now();
    return !d || d >= localDate(now, tz) ? now : startOfDay(d, tz);
  };

  api.get('/parts', async (req) => {
    const { status } = parse(z.object({ status: z.enum(['INSTALLED', 'STOCK', 'RETIRED']).optional() }), req.query);
    const ctx = await loadUserContext(db, req.userId);
    const lk = await loadLookups(db, ctx);
    const now = api.deps.now();
    return ctx.parts.filter((p) => !status || p.status === status).map((p) => presentPartSummary(ctx, p, lk, now));
  });

  api.post('/parts', async (req, reply) => {
    const body = parse(z.object({
      categoryId: z.string(),
      modelId: z.string().nullish(),
      nickname: z.string().max(80).nullish(),
      positionId: z.string().nullish(),
      installedAt: date.nullish(),
      initialKm: z.number().min(0).max(1_000_000).optional(),
      initialHours: z.number().min(0).max(100_000).optional(),
      wearsIndoor: z.boolean().optional(),
      lastMaintenance: z.record(date).optional(),
    }), req.body);
    const ctx = await loadUserContext(db, req.userId);
    let bikeId: string | null = null;
    if (body.positionId) {
      const [pos] = await db.select().from(s.positions).where(eq(s.positions.id, body.positionId));
      if (!pos || pos.removedAt) throw badRequest('Posição inexistente.');
      const bike = await getOwnedBike(db, req.userId, pos.bikeId);
      if (pos.categoryId !== body.categoryId) throw badRequest('A categoria da peça não combina com a posição.');
      if (await occupantOf(db, pos.id)) throw new HttpError(409, 'POSITION_OCCUPIED', 'Já há uma peça nesta posição.');
      bikeId = bike.id;
    }
    const part = await createPart(db, ctx.user, { ...body, bikeId }, api.deps.now());
    await after(req.userId);
    return reply.status(201).send({ id: part.id });
  });

  api.get('/parts/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await getOwnedPart(db, req.userId, id);
    const ctx = await loadUserContext(db, req.userId);
    const part = ctx.parts.find((p) => p.id === id)!;
    const lk = await loadLookups(db, ctx);
    const now = api.deps.now();
    const wear = computePartWear(partInput(ctx, part, now));
    const model = part.modelId ? lk.models.get(part.modelId) : null;
    const hist = await db.select().from(s.partHistory).where(eq(s.partHistory.partId, id)).orderBy(desc(s.partHistory.at));
    const inst = await openInstallation(db, id);
    return {
      ...presentPartSummary(ctx, part, lk, now, wear),
      nickname: part.nickname,
      initialKm: part.initialKm,
      initialHours: part.initialHours,
      installedOn: inst ? { bikeId: inst.bikeId, positionId: inst.positionId, since: inst.startedAt } : null,
      rules: wear.rules.map((r) => presentRule(r, ctx, lk, r.origin === 'MANUFACTURER' || r.basedOn === 'MANUFACTURER' ? model?.manufacturerName : null)),
      disclaimer: RED_DISCLAIMER,
      history: hist.map((h) => ({ id: h.id, type: h.type, at: h.at, payload: h.payload })),
      label: partLabel(part, lk),
    };
  });

  api.patch('/parts/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ nickname: z.string().max(80).nullish(), wearsIndoor: z.boolean().optional() }), req.body);
    await getOwnedPart(db, req.userId, id);
    await db.update(s.parts).set(body).where(eq(s.parts.id, id));
    await after(req.userId);
    return { ok: true };
  });

  /**
   * Genérico -> específico (e vice-versa). Sem `confirm`, devolve a prévia do que muda nas regras e no desgaste.
   * A peça continua a mesma: histórico, uso e contadores mantidos; ajustes do usuário mantidos.
   */
  api.post('/parts/:id/model', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ modelId: z.string().nullable(), confirm: z.boolean().default(false) }), req.body);
    const part = await getOwnedPart(db, req.userId, id);
    if (body.modelId) {
      const [m] = await db.select().from(s.models).where(eq(s.models.id, body.modelId));
      if (!m || m.categoryId !== part.categoryId) throw badRequest('Modelo inexistente ou de outra categoria.');
    }
    const ctx = await loadUserContext(db, req.userId);
    const lk = await loadLookups(db, ctx);
    const now = api.deps.now();
    const beforeWear = computePartWear(partInput(ctx, ctx.parts.find((p) => p.id === id)!, now));
    const next = { ...part, modelId: body.modelId };
    const afterWear = computePartWear(partInput(ctx, next, now));

    const label = (r: (typeof beforeWear.rules)[number]) => `${r.criteria.map((c) => `${c.limit} ${c.unit === 'days' ? 'dias' : c.unit === 'hours' ? 'h' : 'km'}`).join(' ou ')} (${r.origin === 'MANUFACTURER' ? 'Fabricante' : r.origin === 'PLATFORM' ? 'Plataforma' : 'Personalizada'})`;
    const services = new Set([...beforeWear.rules, ...afterWear.rules].map((r) => r.serviceId));
    const changes = [...services].map((sid) => {
      const b = beforeWear.rules.find((r) => r.serviceId === sid);
      const a = afterWear.rules.find((r) => r.serviceId === sid);
      return {
        service: lk.services.get(sid) ?? '',
        before: b ? label(b) : null,
        after: a ? label(a) : null,
        changed: (b ? label(b) : null) !== (a ? label(a) : null),
      };
    }).filter((c) => c.changed);
    const preview = { changes, wearBefore: { pct: Math.round(beforeWear.pct), color: beforeWear.color }, wearAfter: { pct: Math.round(afterWear.pct), color: afterWear.color } };
    if (!body.confirm) return { applied: false, ...preview };

    await db.update(s.parts).set({ modelId: body.modelId }).where(eq(s.parts.id, id));
    await db.insert(s.partHistory).values({ partId: id, type: 'MODEL_CHANGED', at: now, payload: { from: part.modelId, to: body.modelId } });
    await after(req.userId);
    return { applied: true, ...preview };
  });

  /** Mover (ex.: trocar o par de rodas) ou instalar peça do estoque. O uso acumulado vai junto com a peça. */
  api.post('/parts/:id/move', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ positionId: z.string(), at: date.nullish() }), req.body);
    const part = await getOwnedPart(db, req.userId, id);
    if (part.status === 'RETIRED') throw badRequest('Peça aposentada não volta para a bike.');
    const [pos] = await db.select().from(s.positions).where(eq(s.positions.id, body.positionId));
    if (!pos || pos.removedAt) throw badRequest('Posição inexistente.');
    await getOwnedBike(db, req.userId, pos.bikeId);
    if (pos.categoryId !== part.categoryId) throw badRequest('A categoria da peça não combina com a posição.');
    const occ = await occupantOf(db, pos.id);
    if (occ && occ.partId !== id) throw new HttpError(409, 'POSITION_OCCUPIED', 'Já há uma peça nesta posição. Mande-a para o estoque ou mova-a antes.');
    const [user] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    const at = instant(body.at, user!.timezone);

    const cur = await openInstallation(db, id);
    if (cur) await closeInstallation(db, id, at);
    await db.insert(s.installations).values({ partId: id, bikeId: pos.bikeId, positionId: pos.id, startedAt: at });
    await db.update(s.parts).set({ status: 'INSTALLED' }).where(eq(s.parts.id, id));
    await db.insert(s.partHistory).values({ partId: id, type: cur ? 'MOVED' : 'INSTALLED', at, payload: { bikeId: pos.bikeId, positionId: pos.id } });
    await after(req.userId);
    return { ok: true };
  });

  for (const [path, status, history] of [['stock', 'STOCK', 'STOCKED'], ['retire', 'RETIRED', 'RETIRED']] as const) {
    api.post(`/parts/:id/${path}`, async (req) => {
      const { id } = parse(z.object({ id: z.string() }), req.params);
      await getOwnedPart(db, req.userId, id);
      const now = api.deps.now();
      await closeInstallation(db, id, now);
      await db.update(s.parts).set({ status }).where(eq(s.parts.id, id));
      await db.insert(s.partHistory).values({ partId: id, type: history, at: now });
      await after(req.userId);
      return { ok: true };
    });
  }

  /** Ajustar limites ou desligar uma regra da peça. */
  api.put('/parts/:id/rules/:serviceId', async (req) => {
    const { id, serviceId } = parse(z.object({ id: z.string(), serviceId: z.string() }), req.params);
    const body = parse(z.object({ disabled: z.boolean().optional(), criteria: criteria.optional() }), req.body);
    const part = await getOwnedPart(db, req.userId, id);
    const ctx = await loadUserContext(db, req.userId);
    const base = resolveRules({ part, rules: ctx.rules }).find((r) => r.serviceId === serviceId);
    const [existing] = await db.select().from(s.partRules).where(and(eq(s.partRules.partId, id), eq(s.partRules.serviceId, serviceId)));
    if (!base && !existing) throw notFound('Regra');

    const set = {
      ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      ...(body.criteria ? { userKm: body.criteria.km ?? null, userHours: body.criteria.hours ?? null, userDays: body.criteria.days ?? null } : {}),
      basedOn: existing?.basedOn ?? (base ? base.origin : null),
    };
    await db.insert(s.partRules).values({ partId: id, serviceId, ...set }).onConflictDoUpdate({ target: [s.partRules.partId, s.partRules.serviceId], set });
    await db.insert(s.partHistory).values({ partId: id, type: 'RULE_ADJUSTED', at: api.deps.now(), payload: { serviceId, ...body } });
    await after(req.userId);
    return { ok: true };
  });

  /** Voltar à recomendação original a qualquer momento. */
  api.delete('/parts/:id/rules/:serviceId', async (req, reply) => {
    const { id, serviceId } = parse(z.object({ id: z.string(), serviceId: z.string() }), req.params);
    await getOwnedPart(db, req.userId, id);
    const [row] = await db.select().from(s.partRules).where(and(eq(s.partRules.partId, id), eq(s.partRules.serviceId, serviceId)));
    if (row?.custom) await db.delete(s.partRules).where(eq(s.partRules.id, row.id));
    else if (row) await db.update(s.partRules).set({ disabled: false, userKm: null, userHours: null, userDays: null, basedOn: null }).where(eq(s.partRules.id, row.id));
    await db.insert(s.partHistory).values({ partId: id, type: 'RULE_ADJUSTED', at: api.deps.now(), payload: { serviceId, restored: true } });
    await after(req.userId);
    return reply.status(204).send();
  });

  /** Regra própria do usuário, com serviço e critérios livres. */
  api.post('/parts/:id/rules', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ name: z.string().min(2).max(80), criteria }), req.body);
    await getOwnedPart(db, req.userId, id);
    let [svc] = await db.select().from(s.services).where(and(eq(s.services.ownerUserId, req.userId), eq(s.services.name, body.name)));
    if (!svc) [svc] = await db.insert(s.services).values({ name: body.name, ownerUserId: req.userId }).returning();
    await db.insert(s.partRules).values({
      partId: id, serviceId: svc!.id, custom: true, userKm: body.criteria.km ?? null, userHours: body.criteria.hours ?? null, userDays: body.criteria.days ?? null,
    }).onConflictDoUpdate({ target: [s.partRules.partId, s.partRules.serviceId], set: { custom: true, disabled: false, userKm: body.criteria.km ?? null, userHours: body.criteria.hours ?? null, userDays: body.criteria.days ?? null } });
    await after(req.userId);
    return reply.status(201).send({ serviceId: svc!.id });
  });
}
