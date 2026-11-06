import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loginWithGoogle, realGoogleVerifier, signToken, verifyToken, type GoogleVerifier } from './auth';
import type { DB } from './db/client';
import { formatError, HttpError, parse } from './http';
import { noopPushSender, type PushSender } from './services/notify';
import type { StravaClient } from './strava/client';
import { activityRoutes } from './routes/activities';
import { adminRoutes } from './routes/admin';
import { bikeRoutes } from './routes/bikes';
import { expenseRoutes } from './routes/expenses';
import { maintenanceRoutes } from './routes/maintenance';
import { meRoutes } from './routes/me';
import { miscRoutes } from './routes/misc';
import { partRoutes } from './routes/parts';
import { stravaRoutes } from './routes/strava';

export interface AppDeps {
  db: DB;
  googleVerifier: GoogleVerifier;
  sender: PushSender;
  now: () => Date;
  strava?: StravaClient;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    userId: string;
  }
}

export async function buildApp(partial: Partial<AppDeps> & { db: DB }): Promise<FastifyInstance> {
  const deps: AppDeps = {
    googleVerifier: partial.googleVerifier ?? realGoogleVerifier(),
    sender: partial.sender ?? noopPushSender,
    now: partial.now ?? (() => new Date()),
    strava: partial.strava,
    db: partial.db,
  };
  const app = Fastify({ logger: false });
  app.decorate('deps', deps);
  await app.register(cors, { origin: true });

  app.setErrorHandler((err, _req, reply) => {
    const f = formatError(err);
    if (f.status === 500) console.error(err);
    reply.status(f.status).send(f.body);
  });

  app.get('/health', async () => ({ ok: true }));

  app.post('/v1/auth/google', async (req) => {
    const { idToken } = parse(z.object({ idToken: z.string().min(10) }), req.body);
    const profile = await deps.googleVerifier(idToken);
    const { userId, isNew } = await loginWithGoogle(deps.db, profile);
    return { token: await signToken(userId), isNew };
  });

  // Webhook do Strava e painel administrativo têm autenticação própria.
  await app.register(async (pub) => {
    await stravaRoutes.public(pub);
  }, { prefix: '/v1' });

  await app.register(async (api) => {
    api.addHook('preHandler', async (req: FastifyRequest) => {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'AUTH', 'Não autenticado.');
      req.userId = await verifyToken(h.slice(7));
    });
    meRoutes(api);
    bikeRoutes(api);
    partRoutes(api);
    activityRoutes(api);
    maintenanceRoutes(api);
    expenseRoutes(api);
    miscRoutes(api);
    stravaRoutes.private(api);
    adminRoutes(api);
  }, { prefix: '/v1' });

  return app;
}
