import type { Criteria, Origin, Part, Rule, UserRuleOverride } from './types';

/** Valor de `pinned` que significa "este serviço ainda não se aplica a esta peça" (regra nova ainda não aceita pelo usuário). */
export const PIN_NONE = '__none__';

export interface ResolvedRule {
  serviceId: string;
  ruleId: string | null;
  origin: Origin;
  basedOn?: Exclude<Origin, 'USER'>;
  criteria: Criteria;
  note: string | null;
  sourceIds: string[];
}

const hasAnyCriterion = (c: Criteria) =>
  [c.km, c.hours, c.days].some((v) => typeof v === 'number' && v > 0);

/**
 * Para cada serviço, escolhe a regra nesta ordem (seção 7):
 * 1) Usuário  2) Fabricante (modelo específico)  3) Plataforma (categoria).
 * Só regras publicadas valem. Regras desligadas pelo usuário somem.
 * `pinned` mapeia serviço -> id de regra que o usuário escolheu manter ("Manter como está").
 */
export function resolveRules(opts: {
  part: Pick<Part, 'categoryId' | 'modelId'>;
  rules: Rule[];
  overrides?: UserRuleOverride[];
  pinned?: Record<string, string | undefined>;
}): ResolvedRule[] {
  const { part, rules, overrides = [], pinned = {} } = opts;
  const published = rules.filter((r) => r.status === 'PUBLISHED' || r.status === 'ARCHIVED');

  const manufacturer = new Map<string, Rule>();
  const platform = new Map<string, Rule>();
  const byId = new Map(published.map((r) => [r.id, r]));

  for (const r of published) {
    if (r.status === 'ARCHIVED') continue; // arquivada só vale se estiver fixada (pinned)
    if (r.origin === 'MANUFACTURER' && part.modelId && r.target.kind === 'model' && r.target.id === part.modelId) {
      pick(manufacturer, r);
    } else if (r.origin === 'PLATFORM' && r.target.kind === 'category' && r.target.id === part.categoryId) {
      pick(platform, r);
    }
  }

  const services = new Set<string>([...manufacturer.keys(), ...platform.keys()]);
  for (const s of Object.keys(pinned)) services.add(s);
  for (const o of overrides) services.add(o.serviceId);

  const out: ResolvedRule[] = [];
  for (const serviceId of services) {
    const override = overrides.find((o) => o.serviceId === serviceId);
    if (override?.disabled) continue;

    const pinnedRule = pinned[serviceId] ? byId.get(pinned[serviceId]!) : undefined;
    const pinnedNone = pinned[serviceId] === PIN_NONE;
    const base = pinnedNone ? undefined : (pinnedRule ?? manufacturer.get(serviceId) ?? platform.get(serviceId));

    if (override?.criteria && hasAnyCriterion(override.criteria)) {
      out.push({
        serviceId,
        ruleId: base?.id ?? null,
        origin: 'USER',
        basedOn: override.custom ? undefined : (override.basedOn ?? base?.origin),
        criteria: override.criteria,
        note: base?.note ?? null,
        sourceIds: base?.sourceIds ?? [],
      });
      continue;
    }
    if (!base) continue;
    out.push({
      serviceId,
      ruleId: base.id,
      origin: base.origin,
      criteria: base.criteria,
      note: base.note ?? null,
      sourceIds: base.sourceIds ?? [],
    });
  }
  return out.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
}

/** Mantém a versão mais alta publicada por serviço. */
function pick(map: Map<string, Rule>, r: Rule) {
  const cur = map.get(r.serviceId);
  if (!cur || r.version > cur.version) map.set(r.serviceId, r);
}

/** Rótulo de origem exibido ao usuário. Nunca apresenta regra da plataforma como do fabricante. */
export function originLabel(r: Pick<ResolvedRule, 'origin' | 'basedOn'>, manufacturerName?: string): string {
  const name = (o: Exclude<Origin, 'USER'>) =>
    o === 'MANUFACTURER' ? (manufacturerName ? `Fabricante, ${manufacturerName}` : 'Fabricante') : 'Recomendação da plataforma';
  if (r.origin === 'USER') return r.basedOn ? `Personalizada (baseada em: ${name(r.basedOn)})` : 'Personalizada';
  return name(r.origin);
}
