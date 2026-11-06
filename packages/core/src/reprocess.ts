import { computePartWear, type PartEvalInput } from './wear';
import type { PartWear, Rule, TrafficColor } from './types';

export interface PartDiff {
  partId: string;
  before: { pct: number; color: TrafficColor };
  after: { pct: number; color: TrafficColor };
  changed: boolean;
  /** Peças com ajuste do usuário nunca são alteradas por nova versão; só informadas. */
  hasUserOverride: boolean;
}

const sig = (w: PartWear) => w.rules.map((r) => `${r.serviceId}:${r.pct.toFixed(4)}`).join('|');

/**
 * Modo de simulação (seção 14): calcula antes e depois sem gravar nada.
 * `newRules` substitui o conjunto de regras. Determinístico: mesma entrada, mesma saída.
 */
export function simulateReprocess(inputs: PartEvalInput[], newRules: Rule[]): PartDiff[] {
  return inputs.map((input) => {
    const hasUserOverride = (input.overrides ?? []).some((o) => o.criteria || o.disabled);
    const before = computePartWear(input);
    const after = hasUserOverride ? before : computePartWear({ ...input, rules: newRules });
    return {
      partId: input.part.id,
      before: { pct: before.pct, color: before.color },
      after: { pct: after.pct, color: after.color },
      changed: sig(before) !== sig(after),
      hasUserOverride,
    };
  });
}

/** Usuários cujos números não mudam não recebem card. */
export const onlyChanged = (diffs: PartDiff[]) => diffs.filter((d) => d.changed);

/** Compara dois conjuntos de entradas já montados (ex.: com e sem versões fixadas). Mesma ordem de peças nos dois. */
export function simulateChange(before: PartEvalInput[], after: PartEvalInput[]): PartDiff[] {
  return before.map((b, i) => {
    const a = after[i]!;
    const wb = computePartWear(b);
    const wa = computePartWear(a);
    return {
      partId: b.part.id,
      before: { pct: wb.pct, color: wb.color },
      after: { pct: wa.pct, color: wa.color },
      changed: sig(wb) !== sig(wa),
      hasUserOverride: (b.overrides ?? []).some((o) => o.criteria || o.disabled),
    };
  });
}
