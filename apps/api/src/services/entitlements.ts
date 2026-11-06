import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import * as s from '../db/schema';

/** Direitos são lidos do servidor: o direito do usuário (se houver) vence o do plano (seção 15). */
export async function getEntitlement(db: DB, userId: string, key: string): Promise<unknown> {
  const [u] = await db.select().from(s.userEntitlements).where(and(eq(s.userEntitlements.userId, userId), eq(s.userEntitlements.key, key)));
  if (u) return u.value;
  const [user] = await db.select({ planId: s.users.planId }).from(s.users).where(eq(s.users.id, userId));
  if (!user) return undefined;
  const [p] = await db.select().from(s.entitlements).where(and(eq(s.entitlements.planId, user.planId), eq(s.entitlements.key, key)));
  return p?.value;
}

export async function allEntitlements(db: DB, userId: string): Promise<Record<string, unknown>> {
  const [user] = await db.select({ planId: s.users.planId }).from(s.users).where(eq(s.users.id, userId));
  const plan = user ? await db.select().from(s.entitlements).where(eq(s.entitlements.planId, user.planId)) : [];
  const own = await db.select().from(s.userEntitlements).where(eq(s.userEntitlements.userId, userId));
  return { ...Object.fromEntries(plan.map((e) => [e.key, e.value])), ...Object.fromEntries(own.map((e) => [e.key, e.value])) };
}

/** Limite de bikes ativas. 'unlimited' ou número. */
export async function canAddActiveBike(db: DB, userId: string): Promise<boolean> {
  const max = await getEntitlement(db, userId, 'maxActiveBikes');
  if (max === undefined || max === 'unlimited' || max === null) return true;
  const active = await db.select({ id: s.bikes.id }).from(s.bikes).where(and(eq(s.bikes.userId, userId), eq(s.bikes.status, 'ACTIVE')));
  return active.length < Number(max);
}
