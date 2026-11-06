import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../db/schema';
import { HttpError, badRequest, notFound, parse } from '../http';
import { getOwnedBike } from '../services/parts';
import { refreshUser } from '../services/notify';
import { endOfDay, localDate, startOfDay, zonedTime } from '../tz';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD');

export function activityRoutes(api: FastifyInstance) {
  const { db } = api.deps;
  const after = (userId: string) => refreshUser(db, userId, { now: api.deps.now(), sender: api.deps.sender });

  const userTz = async (userId: string) => (await db.select({ tz: s.users.timezone }).from(s.users).where(eq(s.users.id, userId)))[0]!.tz;

  api.get('/bikes/:id/activities', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const q = parse(z.object({ from: date.optional(), to: date.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    await getOwnedBike(db, req.userId, id);
    const tz = await userTz(req.userId);
    const rows = await db.select().from(s.activities)
      .where(and(eq(s.activities.bikeId, id), q.from ? gte(s.activities.date, startOfDay(q.from, tz)) : undefined, q.to ? lte(s.activities.date, endOfDay(q.to, tz)) : undefined))
      .orderBy(desc(s.activities.date)).limit(q.limit);
    return rows.map((a) => ({
      id: a.id, date: a.date, source: a.source, kind: a.kind, type: a.type, indoor: a.indoor, note: a.note,
      km: Math.round(a.distanceM / 10) / 100, movingHours: Math.round((a.movingS / 3600) * 100) / 100, elapsedHours: Math.round((a.elapsedS / 3600) * 100) / 100,
    }));
  });

  /**
   * Pedal manual. Só a data e a distância ou o tempo são obrigatórios.
   * Se cair no mesmo dia de uma atividade do Strava, avisa e pergunta se é o mesmo pedal.
   */
  api.post('/bikes/:id/rides', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({
      date,
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      distanceKm: z.number().min(0).max(5000).optional(),
      movingMinutes: z.number().min(0).max(24 * 60).optional(),
      indoor: z.boolean().default(false),
      confirm: z.boolean().default(false),
    }).refine((b) => (b.distanceKm ?? 0) > 0 || (b.movingMinutes ?? 0) > 0, 'Informe a distância ou o tempo.'), req.body);
    const bike = await getOwnedBike(db, req.userId, id);
    if (bike.status !== 'ACTIVE') throw badRequest('Bike arquivada não recebe pedais.');
    const tz = await userTz(req.userId);
    const now = api.deps.now();

    if (!body.confirm) {
      const same = await db.select().from(s.activities).where(and(
        eq(s.activities.userId, req.userId), eq(s.activities.source, 'STRAVA'),
        gte(s.activities.date, startOfDay(body.date, tz)), lte(s.activities.date, endOfDay(body.date, tz)),
      ));
      if (same.length) {
        throw new HttpError(409, 'POSSIBLE_DUPLICATE', 'Já existe um pedal do Strava neste dia. É o mesmo pedal? Reenvie com confirm=true para lançar mesmo assim.');
      }
    }
    // Hoje sem hora = agora (para o pedal contar já); outro dia sem hora = meio-dia local.
    const when = body.time ? zonedTime(body.date, tz, Number(body.time.slice(0, 2)), Number(body.time.slice(3))) : body.date >= localDate(now, tz) ? now : zonedTime(body.date, tz, 12);
    const movingS = (body.movingMinutes ?? 0) * 60;
    const [a] = await db.insert(s.activities).values({
      userId: req.userId, bikeId: id, source: 'MANUAL', kind: 'RIDE', date: when > now ? now : when, indoor: body.indoor,
      distanceM: (body.distanceKm ?? 0) * 1000, movingS, elapsedS: movingS,
    }).returning({ id: s.activities.id });
    await after(req.userId);
    return reply.status(201).send({ id: a!.id });
  });

  /** Ajuste de uso: somar km ou horas direto na bike (ex.: "+200 km de pedais que não registrei"). */
  api.post('/bikes/:id/usage-adjustments', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ km: z.number().min(0).max(100_000).optional(), hours: z.number().min(0).max(10_000).optional(), note: z.string().max(200).optional() })
      .refine((b) => (b.km ?? 0) > 0 || (b.hours ?? 0) > 0, 'Informe km ou horas.'), req.body);
    await getOwnedBike(db, req.userId, id);
    const now = api.deps.now();
    const [a] = await db.insert(s.activities).values({
      userId: req.userId, bikeId: id, source: 'MANUAL', kind: 'ADJUSTMENT', date: now, indoor: false,
      distanceM: (body.km ?? 0) * 1000, movingS: (body.hours ?? 0) * 3600, elapsedS: (body.hours ?? 0) * 3600, note: body.note ?? null,
    }).returning({ id: s.activities.id });
    await after(req.userId);
    return reply.status(201).send({ id: a!.id });
  });

  /** Pedais manuais podem ser editados e apagados. Em qualquer atividade dá para mudar a bike. */
  api.patch('/activities/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({
      bikeId: z.string().optional(), date: date.optional(), distanceKm: z.number().min(0).max(5000).optional(),
      movingMinutes: z.number().min(0).max(24 * 60).optional(), indoor: z.boolean().optional(),
    }), req.body);
    const [a] = await db.select().from(s.activities).where(and(eq(s.activities.id, id), eq(s.activities.userId, req.userId)));
    if (!a) throw notFound('Atividade');
    const set: Partial<typeof s.activities.$inferInsert> = {};
    if (body.bikeId) { await getOwnedBike(db, req.userId, body.bikeId); set.bikeId = body.bikeId; }
    const editsData = body.date || body.distanceKm !== undefined || body.movingMinutes !== undefined || body.indoor !== undefined;
    if (editsData) {
      if (a.source !== 'MANUAL') throw badRequest('Atividades do Strava são editadas no Strava.', 'STRAVA_READONLY');
      const tz = await userTz(req.userId);
      if (body.date) set.date = zonedTime(body.date, tz, 12);
      if (body.distanceKm !== undefined) set.distanceM = body.distanceKm * 1000;
      if (body.movingMinutes !== undefined) { set.movingS = body.movingMinutes * 60; set.elapsedS = body.movingMinutes * 60; }
      if (body.indoor !== undefined) set.indoor = body.indoor;
    }
    if (Object.keys(set).length) await db.update(s.activities).set(set).where(eq(s.activities.id, id));
    await after(req.userId);
    return { ok: true };
  });

  api.delete('/activities/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const [a] = await db.select().from(s.activities).where(and(eq(s.activities.id, id), eq(s.activities.userId, req.userId)));
    if (!a) throw notFound('Atividade');
    if (a.source !== 'MANUAL') throw badRequest('Atividades do Strava são apagadas no Strava.', 'STRAVA_READONLY');
    await db.delete(s.activities).where(eq(s.activities.id, id));
    await after(req.userId);
    return reply.status(204).send();
  });
}
