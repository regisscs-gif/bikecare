import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import * as s from '../db/schema';
import { BIKE_TYPES } from '../db/bike-templates';
import { HttpError, parse } from '../http';
import { getOwnedBike } from '../services/parts';
import { connectStrava, disconnectStrava, enqueue, importGear, linkGear, listGear, processJobs } from '../strava/sync';


/** Webhook sem autenticação de usuário: o Strava valida pela assinatura de inscrição (verify_token). */
async function publicRoutes(api: FastifyInstance) {
  const { db } = api.deps;

  api.get('/strava/webhook', async (req) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] !== 'subscribe' || !config.strava.webhookVerifyToken || q['hub.verify_token'] !== config.strava.webhookVerifyToken) {
      throw new HttpError(403, 'FORBIDDEN', 'Token inválido.');
    }
    return { 'hub.challenge': q['hub.challenge'] };
  });

  api.post('/strava/webhook', async (req, reply) => {
    const ev = parse(z.object({
      object_type: z.enum(['activity', 'athlete']),
      object_id: z.number(),
      aspect_type: z.enum(['create', 'update', 'delete']),
      owner_id: z.number(),
      updates: z.record(z.unknown()).optional(),
    }), req.body);
    const [conn] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.athleteId, String(ev.owner_id)));
    if (conn) {
      if (ev.object_type === 'athlete') {
        // Acesso revogado no Strava: apaga as atividades importadas e guarda o uso consolidado.
        if (ev.updates?.authorized === 'false') await disconnectStrava(api.deps, conn.userId, { revokeRemote: false });
      } else {
        await enqueue(api.deps, conn.userId, { kind: 'ACTIVITY', objectId: String(ev.object_id), aspect: ev.aspect_type, updates: ev.updates ?? {} });
        // O Strava exige resposta rápida; processa depois de responder.
        setImmediate(() => { processJobs(api.deps).catch((e) => console.error('strava jobs', e)); });
      }
    }
    return reply.status(200).send({ ok: true });
  });
}

function privateRoutes(api: FastifyInstance) {
  const { db } = api.deps;

  api.get('/strava/status', async (req) => {
    const [c] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, req.userId));
    const jobs = await db.select().from(s.stravaJobs).where(eq(s.stravaJobs.userId, req.userId));
    return {
      connected: !!c && c.status !== 'REVOKED', status: c?.status ?? null, lastSyncAt: c?.lastSyncAt ?? null,
      pendingJobs: jobs.filter((j) => j.status === 'PENDING').length,
      configured: !!config.strava.clientId,
    };
  });

  /** URL de autorização (botão "Conectar com Strava"). Permissões: ler atividades (inclusive privadas) e as bikes do perfil. */
  api.get('/strava/auth-url', async (req) => {
    const { redirectUri } = parse(z.object({ redirectUri: z.string().url() }), req.query);
    const p = new URLSearchParams({
      client_id: config.strava.clientId, redirect_uri: redirectUri, response_type: 'code', approval_prompt: 'auto',
      scope: 'read,activity:read_all,profile:read_all',
    });
    return { url: `https://www.strava.com/oauth/mobile/authorize?${p}`, webUrl: `https://www.strava.com/oauth/authorize?${p}` };
  });

  api.post('/strava/connect', async (req) => {
    const { code, scope } = parse(z.object({ code: z.string().min(5), scope: z.string() }), req.body);
    return connectStrava(api.deps, req.userId, code, scope);
  });

  api.get('/strava/gear', async (req) => listGear(api.deps, req.userId));

  api.post('/strava/import', async (req) => {
    const { picks } = parse(z.object({
      picks: z.array(z.object({ gearId: z.string(), type: z.enum(BIKE_TYPES as [string, ...string[]]), partsInstalledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() })).min(1),
    }), req.body);
    const out = await importGear(api.deps, req.userId, picks);
    setImmediate(() => { processJobs(api.deps).catch((e) => console.error('strava jobs', e)); });
    return out;
  });

  api.post('/bikes/:id/strava-link', async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { gearId } = parse(z.object({ gearId: z.string() }), req.body);
    await getOwnedBike(db, req.userId, id);
    await linkGear(api.deps, req.userId, id, gearId);
    setImmediate(() => { processJobs(api.deps).catch((e) => console.error('strava jobs', e)); });
    return { ok: true };
  });

  api.post('/strava/sync', async (req) => {
    await enqueue(api.deps, req.userId, { kind: 'INITIAL' });
    setImmediate(() => { processJobs(api.deps).catch((e) => console.error('strava jobs', e)); });
    return { queued: true };
  });

  api.delete('/strava', async (req, reply) => {
    await disconnectStrava(api.deps, req.userId, { revokeRemote: true });
    return reply.status(204).send();
  });
}

export const stravaRoutes = { public: publicRoutes, private: privateRoutes };
