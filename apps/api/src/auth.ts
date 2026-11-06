import { OAuth2Client } from 'google-auth-library';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import type { DB } from './db/client';
import * as s from './db/schema';
import { config } from './config';
import { HttpError } from './http';

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}
export type GoogleVerifier = (idToken: string) => Promise<GoogleProfile>;

export function realGoogleVerifier(): GoogleVerifier {
  const client = new OAuth2Client();
  return async (idToken) => {
    if (!config.googleClientIds.length) throw new HttpError(500, 'CONFIG', 'GOOGLE_CLIENT_IDS não configurado.');
    const ticket = await client.verifyIdToken({ idToken, audience: config.googleClientIds });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw new HttpError(401, 'AUTH', 'Conta Google inválida.');
    return { sub: p.sub, email: p.email, name: p.name ?? p.email, picture: p.picture };
  };
}

const key = () => new TextEncoder().encode(config.jwtSecret);

export const signToken = (userId: string) =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('30d').sign(key());

export async function verifyToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, key());
    if (!payload.sub) throw new Error('sem sub');
    return payload.sub;
  } catch {
    throw new HttpError(401, 'AUTH', 'Sessão inválida ou expirada.');
  }
}

/**
 * Login Google. A conta não depende do provedor: a identidade é uma linha separada,
 * então Apple pode entrar depois ligada à mesma conta (por e-mail verificado) sem migração.
 */
export async function loginWithGoogle(db: DB, p: GoogleProfile): Promise<{ userId: string; isNew: boolean }> {
  const [ident] = await db.select().from(s.identities).where(eq(s.identities.subject, p.sub));
  if (ident && ident.provider === 'GOOGLE') return { userId: ident.userId, isNew: false };

  const [existing] = await db.select().from(s.users).where(eq(s.users.email, p.email));
  if (existing) {
    await db.insert(s.identities).values({ userId: existing.id, provider: 'GOOGLE', subject: p.sub });
    return { userId: existing.id, isNew: false };
  }
  const [user] = await db.insert(s.users).values({ name: p.name, email: p.email, photoUrl: p.picture ?? null }).returning({ id: s.users.id });
  await db.insert(s.identities).values({ userId: user!.id, provider: 'GOOGLE', subject: p.sub });
  return { userId: user!.id, isNew: true };
}
