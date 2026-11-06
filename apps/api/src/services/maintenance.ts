import { eq, inArray } from 'drizzle-orm';
import { sumUsage } from '@bikecare/core';
import type { DB } from '../db/client';
import * as s from '../db/schema';
import { badRequest } from '../http';
import { resetInstant } from '../tz';
import { loadUserContext } from './context';
import { closeInstallation, createPart, getOwnedBike, getOwnedPart, openInstallation } from './parts';

export interface MaintenanceItemInput {
  partId: string;
  serviceIds: string[];
  other?: string | null;
  replacement?: {
    modelId?: string | null;
    nickname?: string | null;
    initialKm?: number;
    initialHours?: number;
    /** O que fazer com a peça antiga. */
    oldPart: 'RETIRE' | 'STOCK';
  } | null;
}

export interface MaintenanceInput {
  date: string; // YYYY-MM-DD
  shop?: string | null;
  partsCostCents?: number;
  laborCostCents?: number;
  notes?: string | null;
  items: MaintenanceItemInput[];
}

/**
 * Efeitos ao salvar (seção 10): cada serviço marcado zera só o contador da regra correspondente;
 * substituição tira a peça antiga e instala a nova zerada; km/horas na data são gravados automaticamente;
 * custos viram gastos.
 */
export async function createMaintenance(
  db: DB,
  user: { id: string; timezone: string },
  bikeId: string,
  input: MaintenanceInput,
  now = new Date(),
) {
  const bike = await getOwnedBike(db, user.id, bikeId);
  if (!input.items.length) throw badRequest('Selecione ao menos uma peça.');
  const resetAt = resetInstant(input.date, user.timezone, now);

  const ctx = await loadUserContext(db, user.id);
  const serviceIds = [...new Set(input.items.flatMap((i) => i.serviceIds))];
  if (serviceIds.length) {
    const found = await db.select({ id: s.services.id }).from(s.services).where(inArray(s.services.id, serviceIds));
    if (found.length !== serviceIds.length) throw badRequest('Serviço inexistente.');
  }

  const parts = [];
  for (const item of input.items) {
    const part = await getOwnedPart(db, user.id, item.partId);
    const inst = await openInstallation(db, part.id);
    if (!inst || inst.bikeId !== bike.id) throw badRequest('A peça não está instalada nesta bike.');
    if (!item.serviceIds.length && !item.replacement && !item.other?.trim()) {
      throw badRequest('Informe ao menos um serviço, a substituição ou uma observação para cada peça.');
    }
    parts.push({ item, part, inst });
  }

  const [record] = await db.insert(s.maintenanceRecords).values({
    userId: user.id, bikeId: bike.id, date: new Date(`${input.date}T12:00:00Z`), resetAt, shop: input.shop ?? null,
    partsCostCents: input.partsCostCents ?? 0, laborCostCents: input.laborCostCents ?? 0, notes: input.notes ?? null,
  }).returning();

  for (const { item, part, inst } of parts) {
    // km e horas da peça na data: uso de vida + uso inicial
    const u = sumUsage({
      part: { id: part.id, wearsIndoor: part.wearsIndoor },
      installations: ctx.installations, activities: ctx.activities, until: resetAt,
    });
    await db.insert(s.maintenanceItems).values({
      recordId: record!.id, partId: part.id, serviceIds: item.serviceIds, replaced: !!item.replacement, other: item.other ?? null,
      kmAtDate: u.km + part.initialKm, hoursAtDate: u.hours + part.initialHours,
    });
    await db.insert(s.partHistory).values({
      partId: part.id, type: 'MAINTENANCE', at: resetAt,
      payload: { recordId: record!.id, serviceIds: item.serviceIds, other: item.other ?? null, replaced: !!item.replacement, kmAtDate: u.km + part.initialKm, hoursAtDate: u.hours + part.initialHours },
    });

    if (item.replacement) {
      await closeInstallation(db, part.id, resetAt);
      const to = item.replacement.oldPart === 'STOCK' ? 'STOCK' : 'RETIRED';
      await db.update(s.parts).set({ status: to }).where(eq(s.parts.id, part.id));
      await db.insert(s.partHistory).values({ partId: part.id, type: to === 'STOCK' ? 'STOCKED' : 'RETIRED', at: resetAt, payload: { reason: 'replaced', recordId: record!.id } });
      const fresh = await createPart(db, user, {
        categoryId: part.categoryId, modelId: item.replacement.modelId ?? null, nickname: item.replacement.nickname ?? null,
        positionId: inst.positionId, bikeId: bike.id, initialKm: item.replacement.initialKm ?? 0, initialHours: item.replacement.initialHours ?? 0,
      }, resetAt);
      // instalação da nova peça começa exatamente no instante do reset
      await db.update(s.installations).set({ startedAt: resetAt }).where(eq(s.installations.partId, fresh.id));
    }
  }

  // Custos informados viram gastos, ligados ao registro (digitados uma vez só)
  const day = new Date(`${input.date}T12:00:00Z`);
  if (input.partsCostCents) {
    await db.insert(s.expenses).values({ userId: user.id, bikeId: bike.id, date: day, amountCents: input.partsCostCents, category: 'PARTS', description: 'Peças da manutenção', recordId: record!.id });
  }
  if (input.laborCostCents) {
    await db.insert(s.expenses).values({ userId: user.id, bikeId: bike.id, date: day, amountCents: input.laborCostCents, category: 'LABOR', description: input.shop ? `Mão de obra — ${input.shop}` : 'Mão de obra', recordId: record!.id });
  }
  return record!;
}
