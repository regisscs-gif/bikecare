import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../db/client';
import * as s from '../db/schema';
import { resetInstant, startOfDay } from '../tz';
import { badRequest, notFound } from '../http';

export interface NewPart {
  categoryId: string;
  modelId?: string | null;
  nickname?: string | null;
  positionId?: string | null;
  bikeId?: string | null;
  /** 'YYYY-MM-DD' (início do dia no fuso do usuário). Omitido = agora. */
  installedAt?: string | null;
  initialKm?: number;
  initialHours?: number;
  wearsIndoor?: boolean;
  /** serviceId -> 'YYYY-MM-DD' da última manutenção */
  lastMaintenance?: Record<string, string>;
}

export async function defaultWearsIndoor(db: DB, categoryId: string): Promise<boolean> {
  const [c] = await db.select().from(s.categories).where(eq(s.categories.id, categoryId));
  if (!c) throw badRequest('Categoria inexistente.');
  return c.wearsIndoorDefault === 'YES';
}

export async function createPart(db: DB, user: { id: string; timezone: string }, p: NewPart, now = new Date()) {
  if (p.modelId) {
    const [m] = await db.select().from(s.models).where(eq(s.models.id, p.modelId));
    if (!m) throw badRequest('Modelo inexistente.');
    if (m.categoryId !== p.categoryId) throw badRequest('O modelo não pertence à categoria da peça.');
  }
  // Modelo genérico = sem modelo específico
  const wearsIndoor = p.wearsIndoor ?? (await defaultWearsIndoor(db, p.categoryId));
  const [part] = await db.insert(s.parts).values({
    userId: user.id, categoryId: p.categoryId, modelId: p.modelId ?? null, nickname: p.nickname ?? null,
    initialKm: p.initialKm ?? 0, initialHours: p.initialHours ?? 0, wearsIndoor, status: p.positionId ? 'INSTALLED' : 'STOCK',
  }).returning();

  if (p.positionId && p.bikeId) {
    const start = p.installedAt ? startOfDay(p.installedAt, user.timezone) : now;
    await db.insert(s.installations).values({ partId: part!.id, bikeId: p.bikeId, positionId: p.positionId, startedAt: start });
    await db.insert(s.partHistory).values({ partId: part!.id, type: 'INSTALLED', at: now, payload: { bikeId: p.bikeId, positionId: p.positionId } });
  }
  for (const [serviceId, date] of Object.entries(p.lastMaintenance ?? {})) {
    await db.insert(s.partRules).values({ partId: part!.id, serviceId, resetAt: resetInstant(date, user.timezone, now) })
      .onConflictDoUpdate({ target: [s.partRules.partId, s.partRules.serviceId], set: { resetAt: resetInstant(date, user.timezone, now) } });
  }
  return part!;
}

export async function getOwnedPart(db: DB, userId: string, partId: string) {
  const [p] = await db.select().from(s.parts).where(and(eq(s.parts.id, partId), eq(s.parts.userId, userId)));
  if (!p) throw notFound('Peça');
  return p;
}

export async function getOwnedBike(db: DB, userId: string, bikeId: string) {
  const [b] = await db.select().from(s.bikes).where(and(eq(s.bikes.id, bikeId), eq(s.bikes.userId, userId)));
  if (!b) throw notFound('Bike');
  return b;
}

export async function openInstallation(db: DB, partId: string) {
  const [i] = await db.select().from(s.installations).where(and(eq(s.installations.partId, partId), isNull(s.installations.endedAt)));
  return i ?? null;
}

/** Encerra a instalação aberta da peça no instante dado. */
export async function closeInstallation(db: DB, partId: string, at: Date) {
  await db.update(s.installations).set({ endedAt: at }).where(and(eq(s.installations.partId, partId), isNull(s.installations.endedAt)));
}

export async function occupantOf(db: DB, positionId: string) {
  const [i] = await db.select().from(s.installations).where(and(eq(s.installations.positionId, positionId), isNull(s.installations.endedAt)));
  return i ?? null;
}
