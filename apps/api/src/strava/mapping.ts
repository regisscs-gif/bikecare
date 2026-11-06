import type { StravaActivity } from './client';

/** Tipos aceitos por padrão (seção 8). Configurável no painel (app_settings: strava.activityTypes). */
export const DEFAULT_ACTIVITY_TYPES = ['Ride', 'MountainBikeRide', 'GravelRide', 'EBikeRide', 'EMountainBikeRide', 'VirtualRide'];

export type Skip = 'TYPE' | 'NO_DEFAULT_BIKE' | 'GEAR_NOT_IMPORTED';

export interface Normalized {
  externalId: string;
  date: Date;
  type: string;
  indoor: boolean;
  distanceM: number;
  movingS: number;
  elapsedS: number;
  bikeId: string;
}

/**
 * - É rolo quando o tipo é VirtualRide ou a atividade está marcada como "trainer".
 * - Conta para a bike do app vinculada à bike usada no Strava.
 * - Sem bike no Strava: vai para a bike padrão. Com bike do Strava não importada: ignorada.
 * Só o necessário é guardado: sem trajeto GPS, frequência cardíaca ou potência.
 */
export function mapStravaActivity(
  a: StravaActivity,
  opts: { acceptedTypes: string[]; gearToBike: Map<string, string>; defaultBikeId: string | null },
): { ok: true; value: Normalized } | { ok: false; skip: Skip } {
  const type = a.sport_type ?? a.type ?? '';
  if (!opts.acceptedTypes.includes(type)) return { ok: false, skip: 'TYPE' };
  let bikeId: string | undefined;
  if (!a.gear_id) {
    if (!opts.defaultBikeId) return { ok: false, skip: 'NO_DEFAULT_BIKE' };
    bikeId = opts.defaultBikeId;
  } else {
    bikeId = opts.gearToBike.get(a.gear_id);
    if (!bikeId) return { ok: false, skip: 'GEAR_NOT_IMPORTED' };
  }
  return {
    ok: true,
    value: {
      externalId: String(a.id),
      date: new Date(a.start_date),
      type,
      indoor: type === 'VirtualRide' || a.trainer === true,
      distanceM: a.distance ?? 0,
      movingS: a.moving_time ?? 0,
      elapsedS: a.elapsed_time ?? a.moving_time ?? 0,
      bikeId,
    },
  };
}
