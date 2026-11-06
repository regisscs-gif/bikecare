import type { Thresholds, TrafficColor } from './types';

export const DEFAULT_THRESHOLDS: Thresholds = { yellow: 70, orange: 85, red: 100 };

const ORDER: TrafficColor[] = ['GREEN', 'YELLOW', 'ORANGE', 'RED'];

/** Limites crescentes (amarelo < laranja < vermelho), de 1% a 200%. */
export function validateThresholds(t: Thresholds): string | null {
  for (const v of [t.yellow, t.orange, t.red]) {
    if (!Number.isFinite(v) || v < 1 || v > 200) return 'Os limites devem estar entre 1% e 200%.';
  }
  if (!(t.yellow < t.orange && t.orange < t.red)) {
    return 'Os limites precisam ser crescentes: amarelo < laranja < vermelho.';
  }
  return null;
}

export function colorFor(pct: number, t: Thresholds = DEFAULT_THRESHOLDS): TrafficColor {
  if (pct >= t.red) return 'RED';
  if (pct >= t.orange) return 'ORANGE';
  if (pct >= t.yellow) return 'YELLOW';
  return 'GREEN';
}

export function worstColor(colors: TrafficColor[]): TrafficColor {
  let worst = 0;
  for (const c of colors) worst = Math.max(worst, ORDER.indexOf(c));
  return ORDER[worst] ?? 'GREEN';
}

export function compareColors(a: TrafficColor, b: TrafficColor): number {
  return ORDER.indexOf(a) - ORDER.indexOf(b);
}

/** Texto do estado vermelho. Vermelho não significa que a peça vai quebrar. */
export function redLabel(pct: number, t: Thresholds = DEFAULT_THRESHOLDS): string {
  if (t.red < 100 && pct < 100) return `Atingiu ${Math.round(pct)}% do intervalo`;
  if (pct > 100) return `+${Math.round(pct - 100)}% acima do intervalo`;
  return 'Intervalo vencido';
}

export const RED_DISCLAIMER =
  'Vermelho indica que o intervalo de manutenção foi atingido, não que a peça vai falhar.';

/** Avisos disparam só ao entrar numa cor pior (seção 12). */
export function isWorse(next: TrafficColor, prev: TrafficColor): boolean {
  return compareColors(next, prev) > 0;
}
