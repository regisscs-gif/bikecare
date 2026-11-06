import type { Activity, Installation, Part, Usage } from './types';

const DAY_MS = 86_400_000;

/** Horas e km que uma atividade soma numa peça, ou null se não conta. Spec seção 8. */
export function activityContribution(a: Activity, part: Pick<Part, 'wearsIndoor'>): { km: number; hours: number } | null {
  if (a.indoor) {
    if (!part.wearsIndoor) return null;
    return { km: 0, hours: a.elapsedS / 3600 }; // rolo: só horas, tempo total
  }
  return { km: a.distanceM / 1000, hours: a.movingS / 3600 };
}

/** Uma atividade conta para a peça se a data estiver num período de instalação, na mesma bike. [start, end). */
export function installationCovers(i: Installation, a: Activity): boolean {
  if (i.bikeId !== a.bikeId) return false;
  const t = a.date.getTime();
  return t >= i.start.getTime() && (i.end === null || t < i.end.getTime());
}

/** Soma km e horas das atividades que contam para a peça desde `since` (inclusive). */
export function sumUsage(opts: {
  part: Pick<Part, 'id' | 'wearsIndoor'>;
  installations: Installation[];
  activities: Activity[];
  since?: Date | null;
  until?: Date;
}): { km: number; hours: number } {
  const { part, activities, since, until } = opts;
  const mine = opts.installations.filter((i) => i.partId === part.id);
  let km = 0;
  let hours = 0;
  for (const a of activities) {
    if (since && a.date.getTime() < since.getTime()) continue;
    if (until && a.date.getTime() > until.getTime()) continue;
    if (!mine.some((i) => installationCovers(i, a))) continue;
    const c = activityContribution(a, part);
    if (!c) continue;
    km += c.km;
    hours += c.hours;
  }
  return { km, hours };
}

/** Dias corridos entre duas datas, inclusive o tempo em estoque. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

/** Data de instalação mais antiga da peça (para início do contador sem reset). */
export function firstInstallDate(partId: string, installations: Installation[]): Date | null {
  const dates = installations.filter((i) => i.partId === partId).map((i) => i.start.getTime());
  return dates.length ? new Date(Math.min(...dates)) : null;
}

/** Média diária de uso nos últimos 30 dias (para previsão de data). Sem uso, retorna zeros. */
export function recentDailyUsage(opts: {
  part: Pick<Part, 'id' | 'wearsIndoor'>;
  installations: Installation[];
  activities: Activity[];
  asOf: Date;
  windowDays?: number;
}): { kmPerDay: number; hoursPerDay: number } {
  const window = opts.windowDays ?? 30;
  const since = new Date(opts.asOf.getTime() - window * DAY_MS);
  const u = sumUsage({ part: opts.part, installations: opts.installations, activities: opts.activities, since, until: opts.asOf });
  return { kmPerDay: u.km / window, hoursPerDay: u.hours / window };
}

export type { Usage };
