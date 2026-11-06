import { and, eq, inArray, ne } from 'drizzle-orm';
import { PIN_NONE, colorFor, computePartWear, resolveRules, simulateChange, type PartEvalInput } from '@bikecare/core';
import type { DB } from '../db/client';
import * as s from '../db/schema';
import { loadUserContext, partInput, loadRules, type UserContext } from './context';
import { loadLookups, partLabel } from './present';

type RuleRow = typeof s.rules.$inferSelect;

const targetsPart = (r: RuleRow, p: { modelId: string | null; categoryId: string }) =>
  r.modelId ? r.modelId === p.modelId : r.categoryId === p.categoryId;

/**
 * Publica regras (seção 13/14). Existentes não mudam sem o usuário escolher:
 * 1) descobre, antes de publicar, que regra vale hoje para cada peça afetada (sem ajuste do usuário);
 * 2) publica as novas e arquiva as versões anteriores;
 * 3) fixa nas peças afetadas a regra que valia (ou PIN_NONE se não havia);
 * 4) cria a atualização e um card pendente para cada usuário cujos números mudam.
 * Usuários com ajuste próprio só recebem um aviso na central.
 */
export async function publishRules(
  db: DB,
  ruleIds: string[],
  opts: { actor: string; description?: string; mandatory?: boolean; now?: Date },
) {
  const now = opts.now ?? new Date();
  const newRules = await db.select().from(s.rules).where(inArray(s.rules.id, ruleIds));
  const oldRules = await loadRules(db); // conjunto publicado ANTES desta publicação
  const services = await db.select().from(s.services);
  const serviceSet = new Set(newRules.map((r) => r.serviceId));

  // Peças afetadas e a regra vigente de cada serviço
  const userRows = await db.select().from(s.users);
  const affected: Array<{ userId: string; partId: string; serviceId: string; currentRuleId: string | null; overridden: boolean }> = [];
  for (const u of userRows) {
    const ctx = await loadUserContext(db, u.id);
    for (const part of ctx.parts) {
      if (part.status === 'RETIRED') continue;
      for (const sid of serviceSet) {
        const rules = newRules.filter((r) => r.serviceId === sid && targetsPart(r, part));
        if (!rules.length) continue;
        const row = ctx.partRules.find((x) => x.partId === part.id && x.serviceId === sid);
        const overridden = !!(row && (row.disabled || row.userKm || row.userHours || row.userDays));
        if (row?.pinnedRuleId) continue; // já tem versão fixada de outra atualização
        const cur = resolveRules({ part, rules: oldRules, overrides: [] }).find((r) => r.serviceId === sid);
        affected.push({ userId: u.id, partId: part.id, serviceId: sid, currentRuleId: cur?.ruleId ?? null, overridden });
      }
    }
  }

  // Publica e arquiva versões anteriores do mesmo grupo
  for (const r of newRules) {
    await db.update(s.rules).set({ status: 'ARCHIVED' }).where(and(eq(s.rules.groupId, r.groupId), ne(s.rules.id, r.id), eq(s.rules.status, 'PUBLISHED')));
    await db.update(s.rules).set({ status: 'PUBLISHED', publishedAt: now, reviewedBy: opts.actor }).where(eq(s.rules.id, r.id));
  }

  const names = newRules.map((r) => services.find((x) => x.id === r.serviceId)?.name).filter(Boolean);
  const description = opts.description ?? `Nova recomendação: ${[...new Set(names)].join(', ')}.`;
  const [update] = await db.insert(s.dataUpdates).values({
    kind: 'RULE_VERSION', mandatory: !!opts.mandatory, description, newRuleIds: newRules.map((r) => r.id),
  }).returning();

  const byUser = new Map<string, typeof affected>();
  for (const a of affected) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);

  let cards = 0;
  let notices = 0;
  for (const [userId, list] of byUser) {
    const pinnable = list.filter((a) => !a.overridden);
    if (!pinnable.length) {
      await db.insert(s.notifications).values({ userId, type: 'DATA_UPDATE', text: `Há uma nova recomendação disponível. Suas peças têm ajustes seus, então nada foi alterado.`, push: false });
      notices++;
      continue;
    }
    if (opts.mandatory) {
      await db.insert(s.notifications).values({ userId, type: 'DATA_UPDATE', text: `Atualização aplicada: ${description}`, push: false });
      cards++;
      continue;
    }
    for (const a of pinnable) {
      const pin = a.currentRuleId ?? PIN_NONE;
      await db.insert(s.partRules).values({ partId: a.partId, serviceId: a.serviceId, pinnedRuleId: pin })
        .onConflictDoUpdate({ target: [s.partRules.partId, s.partRules.serviceId], set: { pinnedRuleId: pin } });
    }
    // Só vira card se os números mudam
    const preview = await previewForUser(db, userId, update!.id);
    if (preview.parts.some((p) => p.changed)) {
      await db.insert(s.dataUpdateDecisions).values({ updateId: update!.id, userId });
      await db.insert(s.notifications).values({ userId, type: 'DATA_UPDATE', text: `Há uma nova recomendação: ${description}`, push: false });
      cards++;
    } else {
      // números iguais: sem card; a peça segue com a versão nova sem pedir nada
      await clearPins(db, pinnable.map((a) => ({ partId: a.partId, serviceId: a.serviceId })));
    }
  }
  return { updateId: update!.id, cards, notices };
}

async function clearPins(db: DB, targets: Array<{ partId: string; serviceId: string }>) {
  for (const t of targets) {
    await db.update(s.partRules).set({ pinnedRuleId: null }).where(and(eq(s.partRules.partId, t.partId), eq(s.partRules.serviceId, t.serviceId)));
  }
}

/** Partes do usuário com versão fixada que esta atualização pode liberar. */
function pinnedTargets(ctx: UserContext, ruleRows: RuleRow[]) {
  const out: Array<{ partId: string; serviceId: string }> = [];
  for (const part of ctx.parts) {
    for (const r of ruleRows) {
      if (!targetsPart(r, part)) continue;
      const row = ctx.partRules.find((x) => x.partId === part.id && x.serviceId === r.serviceId);
      if (row?.pinnedRuleId) out.push({ partId: part.id, serviceId: r.serviceId });
    }
  }
  return [...new Map(out.map((t) => [`${t.partId}|${t.serviceId}`, t])).values()];
}

/** Prévia por peça: desgaste atual e depois da mudança. Modo de simulação: nada é gravado. */
export async function previewForUser(db: DB, userId: string, updateId: string, now = new Date()) {
  const [update] = await db.select().from(s.dataUpdates).where(eq(s.dataUpdates.id, updateId));
  const ruleRows = update?.newRuleIds.length ? await db.select().from(s.rules).where(inArray(s.rules.id, update.newRuleIds)) : [];
  const ctx = await loadUserContext(db, userId);
  const lk = await loadLookups(db, ctx);
  const targets = pinnedTargets(ctx, ruleRows);
  const partIds = [...new Set(targets.map((t) => t.partId))];
  const parts = ctx.parts.filter((p) => partIds.includes(p.id));

  const beforeInputs: PartEvalInput[] = parts.map((p) => partInput(ctx, p, now));
  const afterInputs: PartEvalInput[] = beforeInputs.map((inp) => ({
    ...inp,
    states: (inp.states ?? []).map((st) => (targets.some((t) => t.partId === st.partId && t.serviceId === st.serviceId) ? { ...st, pinnedRuleId: null } : st)),
  }));
  const diffs = simulateChange(beforeInputs, afterInputs);
  const th = { yellow: ctx.user.yellowPct, orange: ctx.user.orangePct, red: ctx.user.redPct };
  return {
    description: update?.description ?? '',
    mandatory: update?.mandatory ?? false,
    parts: diffs.map((d, i) => {
      const wb = computePartWear(beforeInputs[i]!);
      const wa = computePartWear(afterInputs[i]!);
      const services = [...new Set(targets.filter((t) => t.partId === d.partId).map((t) => t.serviceId))].map((sid) => {
        const rb = wb.rules.find((r) => r.serviceId === sid);
        const ra = wa.rules.find((r) => r.serviceId === sid);
        const fmt = (r?: typeof rb) => (r ? { pct: Math.round(r.pct), color: colorFor(r.pct, th) } : null);
        return { service: lk.services.get(sid) ?? '', before: fmt(rb), after: fmt(ra) };
      });
      return {
        partId: d.partId,
        label: partLabel(parts.find((p) => p.id === d.partId)!, lk),
        before: { pct: Math.round(d.before.pct), color: d.before.color },
        after: { pct: Math.round(d.after.pct), color: d.after.color },
        services,
        changed: d.changed,
      };
    }),
  };
}

export async function decideUpdate(db: DB, userId: string, updateId: string, decision: 'APPLIED' | 'DECLINED' | 'LATER', now = new Date()) {
  const [update] = await db.select().from(s.dataUpdates).where(eq(s.dataUpdates.id, updateId));
  if (!update) return false;
  if (decision === 'APPLIED') {
    const ruleRows = await db.select().from(s.rules).where(inArray(s.rules.id, update.newRuleIds));
    const ctx = await loadUserContext(db, userId);
    const targets = pinnedTargets(ctx, ruleRows);
    await clearPins(db, targets);
    for (const partId of new Set(targets.map((t) => t.partId))) {
      await db.insert(s.partHistory).values({ partId, type: 'REPROCESSED', at: now, payload: { updateId, description: update.description } });
    }
  }
  await db.update(s.dataUpdateDecisions).set({ status: decision, decidedAt: decision === 'LATER' ? null : now })
    .where(and(eq(s.dataUpdateDecisions.updateId, updateId), eq(s.dataUpdateDecisions.userId, userId)));
  return true;
}

/**
 * Arquivar (seção 13): deixa de valer para peças novas; peças que já usam continuam com ela
 * até o usuário aceitar outra. Por isso fixamos a regra nas peças que hoje a usam (sem ajuste do usuário).
 */
export async function archiveRule(db: DB, ruleId: string, actor: string) {
  const [rule] = await db.select().from(s.rules).where(eq(s.rules.id, ruleId));
  if (!rule) return;
  const rules = await loadRules(db);
  const users = await db.select().from(s.users);
  for (const u of users) {
    const ctx = await loadUserContext(db, u.id);
    for (const part of ctx.parts) {
      if (part.status === 'RETIRED' || !targetsPart(rule, part)) continue;
      const row = ctx.partRules.find((x) => x.partId === part.id && x.serviceId === rule.serviceId);
      if (row?.pinnedRuleId || row?.disabled || row?.userKm || row?.userHours || row?.userDays) continue;
      const cur = resolveRules({ part, rules, overrides: [] }).find((r) => r.serviceId === rule.serviceId);
      if (cur?.ruleId !== ruleId) continue;
      await db.insert(s.partRules).values({ partId: part.id, serviceId: rule.serviceId, pinnedRuleId: ruleId })
        .onConflictDoUpdate({ target: [s.partRules.partId, s.partRules.serviceId], set: { pinnedRuleId: ruleId } });
    }
  }
  await db.update(s.rules).set({ status: 'ARCHIVED', reviewedBy: actor }).where(eq(s.rules.id, ruleId));
}
