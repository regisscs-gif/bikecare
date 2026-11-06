import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../db/schema';
import { notFound, parse } from '../http';
import { getOwnedBike, getOwnedPart } from '../services/parts';
import { localDate, startOfDay, endOfDay, zonedTime } from '../tz';

const CATEGORIES = ['PARTS', 'MAINTENANCE', 'LABOR', 'ACCESSORIES', 'TOOLS', 'TIRES', 'OTHER'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD');

export function expenseRoutes(api: FastifyInstance) {
  const { db } = api.deps;

  /** Lista com filtro por bike, período e categoria; totais do mês e do ano (no fuso do usuário). */
  api.get('/expenses', async (req) => {
    const q = parse(z.object({ bikeId: z.string().optional(), from: date.optional(), to: date.optional(), category: z.enum(CATEGORIES).optional() }), req.query);
    const [user] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    const tz = user!.timezone;
    const now = api.deps.now();
    const today = localDate(now, tz);
    const [y, m] = today.split('-') as [string, string];

    const rows = await db.select().from(s.expenses).where(and(
      eq(s.expenses.userId, req.userId),
      q.bikeId ? eq(s.expenses.bikeId, q.bikeId) : undefined,
      q.category ? eq(s.expenses.category, q.category) : undefined,
      q.from ? gte(s.expenses.date, startOfDay(q.from, tz)) : undefined,
      q.to ? lte(s.expenses.date, endOfDay(q.to, tz)) : undefined,
    )).orderBy(desc(s.expenses.date));

    const sumRange = async (from: Date, to: Date) => {
      const r = await db.select().from(s.expenses).where(and(
        eq(s.expenses.userId, req.userId), q.bikeId ? eq(s.expenses.bikeId, q.bikeId) : undefined, gte(s.expenses.date, from), lt(s.expenses.date, to),
      ));
      return r.reduce((a, e) => a + e.amountCents, 0);
    };
    const nextMonth = Number(m) === 12 ? `${Number(y) + 1}-01-01` : `${y}-${String(Number(m) + 1).padStart(2, '0')}-01`;
    return {
      items: rows.map((e) => ({ id: e.id, bikeId: e.bikeId, date: localDate(e.date, tz), amountCents: e.amountCents, category: e.category, description: e.description, partId: e.partId, recordId: e.recordId })),
      totals: {
        monthCents: await sumRange(zonedTime(`${y}-${m}-01`, tz), zonedTime(nextMonth, tz)),
        yearCents: await sumRange(zonedTime(`${y}-01-01`, tz), zonedTime(`${Number(y) + 1}-01-01`, tz)),
        filteredCents: rows.reduce((a, e) => a + e.amountCents, 0),
      },
    };
  });

  const body = z.object({
    bikeId: z.string(),
    date: date.optional(),
    amountCents: z.number().int().positive().max(100_000_000),
    category: z.enum(CATEGORIES),
    description: z.string().max(200).nullish(),
    partId: z.string().nullish(),
  });

  api.post('/expenses', async (req, reply) => {
    const b = parse(body, req.body);
    await getOwnedBike(db, req.userId, b.bikeId);
    if (b.partId) await getOwnedPart(db, req.userId, b.partId);
    const [user] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    const d = b.date ?? localDate(api.deps.now(), user!.timezone);
    const [e] = await db.insert(s.expenses).values({
      userId: req.userId, bikeId: b.bikeId, date: zonedTime(d, user!.timezone, 12), amountCents: b.amountCents,
      category: b.category, description: b.description ?? null, partId: b.partId ?? null,
    }).returning({ id: s.expenses.id });
    return reply.status(201).send({ id: e!.id });
  });

  api.patch('/expenses/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = parse(body.partial(), req.body);
    const [e] = await db.select().from(s.expenses).where(and(eq(s.expenses.id, id), eq(s.expenses.userId, req.userId)));
    if (!e) throw notFound('Gasto');
    const [user] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    if (b.bikeId) await getOwnedBike(db, req.userId, b.bikeId);
    const { date: d, ...rest } = b;
    await db.update(s.expenses).set({ ...rest, ...(d ? { date: zonedTime(d, user!.timezone, 12) } : {}) }).where(eq(s.expenses.id, id));
    return { ok: true };
  });

  api.delete('/expenses/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const [e] = await db.select().from(s.expenses).where(and(eq(s.expenses.id, id), eq(s.expenses.userId, req.userId)));
    if (!e) throw notFound('Gasto');
    await db.delete(s.expenses).where(eq(s.expenses.id, id));
    return reply.status(204).send();
  });
}
