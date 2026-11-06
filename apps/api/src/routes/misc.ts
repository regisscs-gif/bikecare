import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../db/schema';
import { evaluateBikeById, loadUserContext } from '../services/context';
import { decideUpdate, previewForUser } from '../services/updates';
import { notFound, parse } from '../http';
import { refreshUser } from '../services/notify';

export function miscRoutes(api: FastifyInstance) {
  const { db } = api.deps;

  // ───────── Notificações ─────────
  api.get('/notifications', async (req) => {
    const { unreadOnly } = parse(z.object({ unreadOnly: z.coerce.boolean().default(false) }), req.query);
    const rows = await db.select().from(s.notifications)
      .where(and(eq(s.notifications.userId, req.userId), unreadOnly ? eq(s.notifications.read, false) : undefined))
      .orderBy(desc(s.notifications.createdAt)).limit(100);
    const unread = await db.select({ id: s.notifications.id }).from(s.notifications).where(and(eq(s.notifications.userId, req.userId), eq(s.notifications.read, false)));
    return { unreadCount: unread.length, items: rows.map((n) => ({ id: n.id, type: n.type, partId: n.partId, text: n.text, read: n.read, createdAt: n.createdAt })) };
  });

  api.post('/notifications/read-all', async (req) => {
    await db.update(s.notifications).set({ read: true }).where(eq(s.notifications.userId, req.userId));
    return { ok: true };
  });

  api.post('/notifications/:id/read', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await db.update(s.notifications).set({ read: true }).where(and(eq(s.notifications.id, id), eq(s.notifications.userId, req.userId)));
    return { ok: true };
  });

  api.post('/push-tokens', async (req) => {
    const b = parse(z.object({ platform: z.enum(['ios', 'android']), token: z.string().min(10) }), req.body);
    await db.insert(s.pushTokens).values({ userId: req.userId, ...b }).onConflictDoUpdate({ target: s.pushTokens.token, set: { userId: req.userId, platform: b.platform } });
    return { ok: true };
  });

  api.delete('/push-tokens/:token', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    await db.delete(s.pushTokens).where(and(eq(s.pushTokens.token, token), eq(s.pushTokens.userId, req.userId)));
    return reply.status(204).send();
  });

  // ───────── Biblioteca ─────────
  api.get('/library/categories', async () => {
    const cats = await db.select().from(s.categories).orderBy(asc(s.categories.sortOrder));
    const links = await db.select({ categoryId: s.categoryServices.categoryId, id: s.services.id, name: s.services.name }).from(s.categoryServices).innerJoin(s.services, eq(s.categoryServices.serviceId, s.services.id));
    return cats.map((c) => ({
      id: c.id, name: c.name, wearsIndoorDefault: c.wearsIndoorDefault === 'YES', wearsIndoorApplicable: c.wearsIndoorDefault !== 'NA', typicalCriterion: c.typicalCriterion,
      services: links.filter((l) => l.categoryId === c.id).map((l) => ({ id: l.id, name: l.name })),
    }));
  });

  /** Busca de modelo: filtra por categoria, fabricante e nome. O genérico da categoria vem sempre primeiro. */
  api.get('/library/models', async (req) => {
    const q = parse(z.object({ categoryId: z.string(), q: z.string().max(80).optional(), manufacturerId: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }), req.query);
    const rows = await db.select({ m: s.models, maker: s.manufacturers.name }).from(s.models).leftJoin(s.manufacturers, eq(s.models.manufacturerId, s.manufacturers.id))
      .where(and(
        eq(s.models.categoryId, q.categoryId),
        q.manufacturerId ? eq(s.models.manufacturerId, q.manufacturerId) : undefined,
        q.q ? ilike(s.models.name, `%${q.q.replace(/[%_]/g, '')}%`) : undefined,
      ))
      .orderBy(desc(s.models.isGeneric), asc(s.models.name)).limit(q.limit);
    return rows.map((r) => ({ id: r.m.id, name: r.m.name, manufacturer: r.maker, isGeneric: r.m.isGeneric, code: r.m.code, speeds: r.m.speeds, segment: r.m.segment }));
  });

  api.get('/library/manufacturers', async (req) => {
    const { categoryId } = parse(z.object({ categoryId: z.string().optional() }), req.query);
    const makers = await db.select().from(s.manufacturers).orderBy(asc(s.manufacturers.name));
    if (!categoryId) return makers.map((m) => ({ id: m.id, name: m.name }));
    const used = await db.select({ id: s.models.manufacturerId }).from(s.models).where(eq(s.models.categoryId, categoryId));
    const ids = new Set(used.map((u) => u.id));
    return makers.filter((m) => ids.has(m.id)).map((m) => ({ id: m.id, name: m.name }));
  });

  /** Modelo que não existe na biblioteca: o usuário fica com o genérico e sugere (vai para a fila do painel). */
  api.post('/library/suggestions', async (req, reply) => {
    const b = parse(z.object({ categoryId: z.string(), manufacturer: z.string().min(1).max(80), name: z.string().min(1).max(120) }), req.body);
    const [cat] = await db.select().from(s.categories).where(eq(s.categories.id, b.categoryId));
    if (!cat) throw notFound('Categoria');
    const [row] = await db.insert(s.modelSuggestions).values({ userId: req.userId, ...b }).returning({ id: s.modelSuggestions.id });
    return reply.status(201).send({ id: row!.id });
  });

  // ───────── Atualizações de dados (reprocessamento com escolha do usuário) ─────────
  api.get('/updates', async (req) => {
    const decisions = await db.select().from(s.dataUpdateDecisions).where(and(eq(s.dataUpdateDecisions.userId, req.userId), inArray(s.dataUpdateDecisions.status, ['PENDING', 'LATER'])));
    const out = [];
    for (const d of decisions) {
      const preview = await previewForUser(db, req.userId, d.updateId, api.deps.now());
      if (preview.parts.length) out.push({ id: d.updateId, status: d.status, ...preview });
    }
    return out;
  });

  api.post('/updates/:id/decision', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { decision } = parse(z.object({ decision: z.enum(['APPLIED', 'DECLINED', 'LATER']) }), req.body);
    const [row] = await db.select().from(s.dataUpdateDecisions).where(and(eq(s.dataUpdateDecisions.updateId, id), eq(s.dataUpdateDecisions.userId, req.userId)));
    if (!row) throw notFound('Atualização');
    await decideUpdate(db, req.userId, id, decision, api.deps.now());
    if (decision === 'APPLIED') await refreshUser(db, req.userId, { now: api.deps.now(), sender: api.deps.sender });
    return { ok: true };
  });

  /** Tela principal: um card por bike (pior cor primeiro), atualizações pendentes e não lidas. */
  api.get('/home', async (req) => {
    const ctx = await loadUserContext(db, req.userId);
    const now = api.deps.now();
    const rank: Record<string, number> = { RED: 3, ORANGE: 2, YELLOW: 1, GREEN: 0 };
    const bikes = ctx.bikes.filter((b) => b.status === 'ACTIVE').map((b) => {
      const ev = evaluateBikeById(ctx, b.id, now);
      return { id: b.id, name: b.name, type: b.type, photoUrl: b.photoUrl, isDefault: b.isDefault, color: ev.color, counts: ev.counts };
    }).sort((a, b) => rank[b.color]! - rank[a.color]!);
    const unread = await db.select({ id: s.notifications.id }).from(s.notifications).where(and(eq(s.notifications.userId, req.userId), eq(s.notifications.read, false)));
    const pending = await db.select({ id: s.dataUpdateDecisions.updateId }).from(s.dataUpdateDecisions).where(and(eq(s.dataUpdateDecisions.userId, req.userId), inArray(s.dataUpdateDecisions.status, ['PENDING', 'LATER'])));
    const [strava] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, req.userId));
    return {
      bikes, unreadCount: unread.length, pendingUpdates: pending.length,
      strava: strava ? { status: strava.status, lastSyncAt: strava.lastSyncAt } : null,
    };
  });
}
