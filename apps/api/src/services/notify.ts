import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { compareColors, type BikeEval, type CriterionWear, type PartWear, type TrafficColor } from '@bikecare/core';
import type { DB } from '../db/client';
import * as s from '../db/schema';
import { config } from '../config';
import { localDate, localHour, startOfDay } from '../tz';
import { installedOn, loadUserContext, partInput, type UserContext } from './context';
import { computePartWear } from '@bikecare/core';

export const DAY_MS = 86_400_000;

export interface NotifPart {
  partId: string;
  label: string; // "Suspensão dianteira"
  serviceName: string; // "Revisão completa"
  color: TrafficColor;
  nextDue: CriterionWear | null;
}
export interface PartNotifState { notifiedColor: TrafficColor; lastRedReminder: Date | null }
export interface NotifPrefs { notifyWear: boolean; notifyRedWeekly: boolean }
export interface PlannedNotification {
  type: 'WEAR_YELLOW' | 'WEAR_ORANGE' | 'WEAR_RED' | 'RED_REMINDER' | 'TIME_RULE' | 'WEAR_GROUP';
  partId: string | null;
  text: string;
  push: boolean;
}
export interface Plan {
  notifications: PlannedNotification[];
  states: Map<string, { notifiedColor: TrafficColor; color: TrafficColor; lastRedReminder: Date | null }>;
}

export function formatRemaining(c: CriterionWear | null): string {
  if (!c) return '';
  const n = Math.max(0, Math.round(c.remaining));
  if (c.unit === 'km') return `~${n} km`;
  if (c.unit === 'hours') return `~${n} ${n === 1 ? 'hora' : 'horas'}`;
  return `~${n} ${n === 1 ? 'dia' : 'dias'}`;
}

const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

function textFor(p: NotifPart, kind: 'YELLOW' | 'ORANGE' | 'RED'): { type: PlannedNotification['type']; text: string } {
  const time = p.nextDue?.unit === 'days';
  if (kind === 'RED') return { type: 'WEAR_RED', text: `O intervalo de manutenção de ${lower(p.label)} foi atingido (${lower(p.serviceName)}).` };
  if (time) return { type: 'TIME_RULE', text: `O prazo para ${lower(p.serviceName)} de ${lower(p.label)} está próximo: faltam ${formatRemaining(p.nextDue)}.` };
  if (kind === 'YELLOW') return { type: 'WEAR_YELLOW', text: `${p.label} está em atenção: faltam ${formatRemaining(p.nextDue)} para ${lower(p.serviceName)}.` };
  return { type: 'WEAR_ORANGE', text: `Faltam aproximadamente ${formatRemaining(p.nextDue).replace('~', '')} para ${lower(p.serviceName)} de ${lower(p.label)}.` };
}

/**
 * Regras (seção 12):
 * - Aviso dispara uma vez, só ao entrar numa cor pior. Voltar ao verde reinicia o ciclo.
 * - Vermelho persistente gera lembrete semanal enquanto não houver registro.
 * - Mudanças da mesma rodada viram um push só.
 */
export function planNotifications(opts: {
  parts: NotifPart[];
  states: Map<string, PartNotifState>;
  prefs: NotifPrefs;
  now: Date;
}): Plan {
  const { parts, states, prefs, now } = opts;
  const out: PlannedNotification[] = [];
  const next: Plan['states'] = new Map();

  for (const p of parts) {
    const prev = states.get(p.partId) ?? { notifiedColor: 'GREEN' as TrafficColor, lastRedReminder: null };
    let notified = prev.notifiedColor;
    let lastRed = prev.lastRedReminder;

    if (p.color === 'GREEN') {
      notified = 'GREEN';
      lastRed = null;
    } else if (compareColors(p.color, notified) > 0) {
      notified = p.color;
      if (prefs.notifyWear && (p.color === 'YELLOW' || p.color === 'ORANGE' || p.color === 'RED')) {
        const t = textFor(p, p.color);
        out.push({ type: t.type, partId: p.partId, text: t.text, push: true });
      }
      if (p.color === 'RED') lastRed = now;
    } else if (p.color === 'RED' && prefs.notifyRedWeekly) {
      if (!lastRed || now.getTime() - lastRed.getTime() >= config.notify.redReminderDays * DAY_MS) {
        out.push({ type: 'RED_REMINDER', partId: p.partId, text: `${p.label} segue com o intervalo de manutenção atingido (${lower(p.serviceName)}).`, push: true });
        lastRed = now;
      }
    }
    next.set(p.partId, { notifiedColor: notified, color: p.color, lastRedReminder: lastRed });
  }

  // Agrupamento: vários avisos na mesma rodada viram um push só.
  const pushing = out.filter((n) => n.push);
  if (pushing.length > 1) {
    for (const n of pushing) n.push = false;
    out.push({ type: 'WEAR_GROUP', partId: null, text: `${pushing.length} componentes precisam de atenção.`, push: true });
  }
  return { notifications: out, states: next };
}

/** Horário silencioso e limite diário (seção 12). Erros do Strava ignoram o limite diário. */
export function canPushNow(opts: { now: Date; tz: string; pushedToday: number; type: string }): boolean {
  const h = localHour(opts.now, opts.tz);
  const quiet = h >= config.notify.quietStartHour || h < config.notify.quietEndHour;
  if (quiet) return false;
  if (opts.type === 'STRAVA_ERROR') return true;
  return opts.pushedToday < config.notify.maxPushPerDay;
}

export interface PushSender {
  send(userId: string, tokens: string[], title: string, body: string, data: Record<string, string>): Promise<void>;
}

export const noopPushSender: PushSender = { async send() {} };

/** Envio via Expo Push (app Expo). Troque aqui se a escolha de push mudar. */
export const expoPushSender: PushSender = {
  async send(_userId, tokens, title, body, data) {
    if (!tokens.length) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((to) => ({ to, title, body, data, sound: 'default' }))),
    });
  },
};

function labelOf(ctx: UserContext, part: UserContext['parts'][number], modelNames: Map<string, string>, catNames: Map<string, string>) {
  return part.nickname ?? (part.modelId ? modelNames.get(part.modelId) : null) ?? catNames.get(part.categoryId) ?? 'Componente';
}

/** Recalcula as cores do usuário, cria avisos e envia os push pendentes. Chamar após qualquer mudança de uso ou manutenção. */
export async function refreshUser(db: DB, userId: string, opts: { now?: Date; sender?: PushSender } = {}): Promise<{ created: number }> {
  const now = opts.now ?? new Date();
  const ctx = await loadUserContext(db, userId);
  const models = await db.select({ id: s.models.id, name: s.models.name }).from(s.models);
  const cats = await db.select({ id: s.categories.id, name: s.categories.name }).from(s.categories);
  const modelNames = new Map(models.map((m) => [m.id, m.name]));
  const catNames = new Map(cats.map((c) => [c.id, c.name]));
  const svcName = new Map(ctx.services.map((x) => [x.id, x.name]));

  const parts: NotifPart[] = [];
  for (const bike of ctx.bikes.filter((b) => b.status === 'ACTIVE')) {
    for (const p of installedOn(ctx, bike.id)) {
      const w: PartWear = computePartWear(partInput(ctx, p, now));
      if (!w.worst) continue;
      parts.push({
        partId: p.id, label: labelOf(ctx, p, modelNames, catNames), serviceName: svcName.get(w.worst.serviceId) ?? 'manutenção',
        color: w.color, nextDue: w.worst.nextDue,
      });
    }
  }

  const stateRows = parts.length ? await db.select().from(s.partColorState) : [];
  const states = new Map<string, PartNotifState>(
    stateRows.map((r) => [r.partId, { notifiedColor: r.notifiedColor as TrafficColor, lastRedReminder: r.lastRedReminder }]),
  );
  const plan = planNotifications({ parts, states, prefs: ctx.user, now });

  for (const [partId, st] of plan.states) {
    await db.insert(s.partColorState).values({ partId, color: st.color, notifiedColor: st.notifiedColor, lastRedReminder: st.lastRedReminder })
      .onConflictDoUpdate({ target: s.partColorState.partId, set: { color: st.color, notifiedColor: st.notifiedColor, lastRedReminder: st.lastRedReminder } });
  }
  for (const n of plan.notifications) {
    await db.insert(s.notifications).values({ userId, type: n.type, partId: n.partId, text: n.text, push: n.push });
  }
  await flushPush(db, userId, ctx.user.timezone, now, opts.sender ?? noopPushSender);
  return { created: plan.notifications.length };
}

/** Envia push pendentes respeitando horário silencioso e limite diário. O que cair no silêncio sai depois das 8h. */
export async function flushPush(db: DB, userId: string, tz: string, now: Date, sender: PushSender): Promise<number> {
  const pending = await db.select().from(s.notifications)
    .where(and(eq(s.notifications.userId, userId), eq(s.notifications.push, true), isNull(s.notifications.pushedAt)))
    .orderBy(s.notifications.createdAt);
  if (!pending.length) return 0;
  const since = startOfDay(localDate(now, tz), tz);
  const [{ n: sentToday = 0 } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.notifications)
    .where(and(eq(s.notifications.userId, userId), gte(s.notifications.pushedAt, since), sql`${s.notifications.type} <> 'STRAVA_ERROR'`));
  const tokens = (await db.select().from(s.pushTokens).where(eq(s.pushTokens.userId, userId))).map((t) => t.token);

  let sent = 0;
  let pushedToday = sentToday;
  for (const n of pending) {
    if (!canPushNow({ now, tz, pushedToday, type: n.type })) continue;
    await sender.send(userId, tokens, 'Manutenção da bike', n.text, { partId: n.partId ?? '', notificationId: n.id });
    await db.update(s.notifications).set({ pushedAt: now }).where(eq(s.notifications.id, n.id));
    if (n.type !== 'STRAVA_ERROR') pushedToday++;
    sent++;
  }
  return sent;
}

export type { BikeEval };
