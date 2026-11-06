import { colorFor, DEFAULT_THRESHOLDS, worstColor } from './semaphore';
import { resolveRules, type ResolvedRule } from './rules';
import { daysBetween, firstInstallDate, recentDailyUsage, sumUsage } from './usage';
import type {
  Activity, CriterionUnit, CriterionWear, Installation, Part, PartRuleState, PartWear,
  Rule, RuleWear, Thresholds, TrafficColor, UserRuleOverride,
} from './types';

const DAY_MS = 86_400_000;

export interface PartEvalInput {
  part: Part;
  installations: Installation[];
  activities: Activity[];
  rules: Rule[];
  overrides?: UserRuleOverride[];
  states?: PartRuleState[];
  thresholds?: Thresholds;
  /** Data de referência explícita: o cálculo é determinístico (seção 14). */
  asOf: Date;
}

function criterionWear(unit: CriterionUnit, used: number, limit: number): CriterionWear {
  return { unit, used, limit, pct: (used / limit) * 100, remaining: limit - used };
}

/** Desgaste de uma regra = maior percentual entre os critérios (seção 7). */
export function computeRuleWear(input: PartEvalInput, rule: ResolvedRule): RuleWear {
  const { part, installations, activities, asOf } = input;
  const state = input.states?.find((s) => s.partId === part.id && s.serviceId === rule.serviceId);
  const first = firstInstallDate(part.id, installations);
  const start = state?.resetAt ?? first;

  let km = 0;
  let hours = 0;
  let days = 0;
  if (start) {
    const c = state?.consolidated;
    // Consolidado só vale se não houve reset depois dele; o que veio antes já está no consolidado.
    const useBaseline = !!c && (!state?.resetAt || state.resetAt.getTime() < c.at.getTime());
    const since = useBaseline ? c!.at : (state?.resetAt ?? null);
    const u = sumUsage({ part, installations, activities, since, until: asOf });
    km = u.km;
    hours = u.hours;
    days = daysBetween(start, asOf);
    if (useBaseline) {
      km += c!.km;
      hours += c!.hours; // o consolidado já inclui o uso inicial, quando houver
    } else if (state?.lifetime && !state.resetAt) {
      km += part.initialKm;
      hours += part.initialHours;
    }
  } else if (state?.lifetime) {
    km += part.initialKm;
    hours += part.initialHours;
  }

  const criteria: CriterionWear[] = [];
  const c = rule.criteria;
  if (c.km && c.km > 0) criteria.push(criterionWear('km', km, c.km));
  if (c.hours && c.hours > 0) criteria.push(criterionWear('hours', hours, c.hours));
  if (c.days && c.days > 0) criteria.push(criterionWear('days', days, c.days));

  const nextDue = criteria.reduce<CriterionWear | null>((acc, x) => (!acc || x.pct > acc.pct ? x : acc), null);
  const pct = nextDue ? nextDue.pct : 0;

  return {
    serviceId: rule.serviceId,
    ruleId: rule.ruleId,
    origin: rule.origin,
    basedOn: rule.basedOn,
    sourceIds: rule.sourceIds,
    note: rule.note,
    criteria,
    pct,
    nextDue,
    forecastDate: forecast(input, criteria, start),
    usage: { km, hours, days },
  };
}

/** Previsão pela média dos últimos 30 dias. Sem uso suficiente, não mostra (exceto critério em dias). */
function forecast(input: PartEvalInput, criteria: CriterionWear[], start: Date | null): Date | null {
  const dates: number[] = [];
  const rate = recentDailyUsage({
    part: input.part, installations: input.installations, activities: input.activities, asOf: input.asOf,
  });
  for (const c of criteria) {
    if (c.remaining <= 0) return null; // já vencida
    if (c.unit === 'days' && start) dates.push(start.getTime() + c.limit * DAY_MS);
    if (c.unit === 'km' && rate.kmPerDay > 0) dates.push(input.asOf.getTime() + (c.remaining / rate.kmPerDay) * DAY_MS);
    if (c.unit === 'hours' && rate.hoursPerDay > 0) dates.push(input.asOf.getTime() + (c.remaining / rate.hoursPerDay) * DAY_MS);
  }
  return dates.length ? new Date(Math.min(...dates)) : null;
}

/** Desgaste da peça = maior desgaste entre as regras ativas dela. */
export function computePartWear(input: PartEvalInput): PartWear {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const pinned: Record<string, string | undefined> = {};
  for (const s of input.states ?? []) if (s.partId === input.part.id && s.pinnedRuleId) pinned[s.serviceId] = s.pinnedRuleId;

  const resolved = resolveRules({ part: input.part, rules: input.rules, overrides: input.overrides, pinned });
  const rules = resolved.map((r) => computeRuleWear(input, r)).filter((r) => r.criteria.length > 0);
  const worst = rules.reduce<RuleWear | null>((acc, r) => (!acc || r.pct > acc.pct ? r : acc), null);
  const pct = worst?.pct ?? 0;
  return {
    partId: input.part.id,
    pct,
    color: colorFor(pct, t),
    rules: rules.sort((a, b) => b.pct - a.pct),
    worst,
  };
}

export interface BikeEval {
  parts: PartWear[];
  color: TrafficColor;
  counts: Record<TrafficColor, number>;
}

/** Peças instaladas ordenadas do maior para o menor desgaste; cor da bike = pior cor. */
export function evaluateBike(inputs: PartEvalInput[]): BikeEval {
  const parts = inputs
    .filter((i) => i.part.status === 'INSTALLED')
    .map(computePartWear)
    .sort((a, b) => b.pct - a.pct);
  const counts: Record<TrafficColor, number> = { GREEN: 0, YELLOW: 0, ORANGE: 0, RED: 0 };
  for (const p of parts) counts[p.color]++;
  return { parts, color: worstColor(parts.map((p) => p.color)), counts };
}
