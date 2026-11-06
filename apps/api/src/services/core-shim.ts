import { DEFAULT_THRESHOLDS } from '@bikecare/core';
export * from '@bikecare/core';

/** Limites do usuário no formato do motor. */
export const thresholdsOrDefault = (u: { yellowPct: number; orangePct: number; redPct: number } | null | undefined) =>
  u ? { yellow: u.yellowPct, orange: u.orangePct, red: u.redPct } : DEFAULT_THRESHOLDS;
