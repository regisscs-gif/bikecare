import { asc, eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import * as s from '../db/schema';
import { HttpError } from '../http';
import { canAddActiveBike } from './entitlements';
import { createPart } from './parts';

export interface NewBike {
  name: string;
  type: string;
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  stravaGearId?: string | null;
  photoUrl?: string | null;
  makeDefault?: boolean;
  withSuggestedParts?: boolean;
  partsInstalledAt?: string | null;
}

/** Cria a bike com as posições sugeridas pelo tipo e, opcionalmente, uma peça genérica em cada posição. */
export async function createBike(db: DB, user: { id: string; timezone: string }, b: NewBike, now = new Date()) {
  if (!(await canAddActiveBike(db, user.id))) throw new HttpError(403, 'ENTITLEMENT', 'Seu plano não permite mais bikes ativas.');
  const owned = await db.select().from(s.bikes).where(eq(s.bikes.userId, user.id));
  const isFirstActive = owned.every((x) => x.status !== 'ACTIVE');

  const [bike] = await db.insert(s.bikes).values({
    userId: user.id, name: b.name, type: b.type, brand: b.brand ?? null, model: b.model ?? null, year: b.year ?? null,
    stravaGearId: b.stravaGearId ?? null, photoUrl: b.photoUrl ?? null, isDefault: false,
  }).returning();
  if (b.makeDefault || isFirstActive) {
    await db.update(s.bikes).set({ isDefault: false }).where(eq(s.bikes.userId, user.id));
    await db.update(s.bikes).set({ isDefault: true }).where(eq(s.bikes.id, bike!.id));
  }

  const tpl = await db.select().from(s.bikeTypeTemplates).where(eq(s.bikeTypeTemplates.bikeType, b.type)).orderBy(asc(s.bikeTypeTemplates.sortOrder));
  const positions = tpl.length
    ? await db.insert(s.positions).values(tpl.map((t) => ({ bikeId: bike!.id, categoryId: t.categoryId, name: t.name }))).returning()
    : [];
  if (b.withSuggestedParts ?? true) {
    for (const pos of positions) {
      await createPart(db, user, { categoryId: pos.categoryId, positionId: pos.id, bikeId: bike!.id, installedAt: b.partsInstalledAt ?? null }, now);
    }
  }
  return { bike: bike!, positions: positions.length };
}
