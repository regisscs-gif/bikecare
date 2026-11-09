import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import * as s from '../db/schema';
import { BIKE_TYPES } from '../db/bike-templates';
import { HttpError, parse } from '../http';
import { getOwnedBike } from '../services/parts';
import { connectStrava, disconnectStrava, enqueue, importGear, linkGear, listGear, processJobs, resolveCreds } from '../strava/sync';
import { encryptToken } from '../strava/crypto';


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
    const [own] = await db.select().from(s.stravaCredentials).where(eq(s.stravaCredentials.userId, req.userId));
    return {
      connected: !!c && c.status !== 'REVOKED', status: c?.status ?? null, lastSyncAt: c?.lastSyncAt ?? null,
      pendingJobs: jobs.filter((j) => j.status === 'PENDING').length,
      configured: !!(await resolveCreds(api.deps, req.userId)),
      ownCredentials: own ? { clientId: own.clientId } : null, // o segredo nunca volta para o app
      sharedAvailable: !!(config.strava.clientId && config.strava.clientSecret),
    };
  });

  /**
   * Cada usuário pode usar o próprio app do Strava (strava.com/settings/api). O segredo é guardado criptografado
   * e nunca é devolvido. Trocar as credenciais exige desconectar antes (os tokens pertencem ao app antigo).
   */
  api.put('/strava/credentials', async (req) => {
    const b = parse(z.object({
      clientId: z.string().trim().regex(/^\d{3,10}$/, 'O Client ID do Strava é um número (ex.: 255143).'),
      clientSecret: z.string().trim().regex(/^[A-Za-z0-9]{20,64}$/, 'Client Secret inválido: copie o código completo da página do Strava.'),
    }), req.body);
    const [conn] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, req.userId));
    if (conn && conn.status !== 'REVOKED') throw new HttpError(409, 'STRAVA_CONNECTED', 'Desconecte o Strava antes de trocar as credenciais.');
    const values = { clientId: b.clientId, clientSecretEnc: encryptToken(b.clientSecret) };
    await db.insert(s.stravaCredentials).values({ userId: req.userId, ...values }).onConflictDoUpdate({ target: s.stravaCredentials.userId, set: values });
    return { ok: true, clientId: b.clientId };
  });

  api.delete('/strava/credentials', async (req, reply) => {
    const [conn] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, req.userId));
    if (conn && conn.status !== 'REVOKED') throw new HttpError(409, 'STRAVA_CONNECTED', 'Desconecte o Strava antes de remover as credenciais.');
    await db.delete(s.stravaCredentials).where(eq(s.stravaCredentials.userId, req.userId));
    return reply.status(204).send();
  });

  /** URL de autorização (botão "Conectar com Strava"). Permissões: ler atividades (inclusive privadas) e as bikes do perfil. */
  api.get('/strava/auth-url', async (req) => {
    const { redirectUri } = parse(z.object({ redirectUri: z.string().url() }), req.query);
    const creds = await resolveCreds(api.deps, req.userId);
    if (!creds) throw new HttpError(409, 'STRAVA_NOT_CONFIGURED', 'Informe as credenciais do seu app do Strava para conectar.');
    const p = new URLSearchParams({
      client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', approval_prompt: 'auto',
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

  /** Sincronização sob demanda. Sem `force`, ignora pedidos feitos menos de 2 minutos após a última sincronização. */
  api.post('/strava/sync', async (req) => {
    const { force } = parse(z.object({ force: z.boolean().default(false) }), req.body);
    const [c] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, req.userId));
    if (!c || c.status === 'REVOKED') throw new HttpError(409, 'STRAVA_NOT_CONNECTED', 'Strava não conectado.');
    if (!force && c.lastSyncAt && api.deps.now().getTime() - c.lastSyncAt.getTime() < 2 * 60_000) return { queued: false };
    await enqueue(api.deps, req.userId, { kind: c.lastSyncAt ? 'SYNC' : 'INITIAL' });
    setImmediate(() => { processJobs(api.deps).catch((e) => console.error('strava jobs', e)); });
    return { queued: true };
  });

  api.delete('/strava', async (req, reply) => {
    await disconnectStrava(api.deps, req.userId, { revokeRemote: true });
    return reply.status(204).send();
  });
}

export const stravaRoutes = { public: publicRoutes, private: privateRoutes };
