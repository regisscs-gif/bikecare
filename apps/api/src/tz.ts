/** Utilidades de fuso horário sem dependências (Intl). Datas de negócio são sempre no fuso do usuário. */

function parts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** 'YYYY-MM-DD' da data no fuso. */
export function localDate(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export const localHour = (date: Date, tz: string) => parts(date, tz).hour;

/** Diferença (ms) entre o relógio local do fuso e UTC no instante dado. */
function offsetMs(date: Date, tz: string): number {
  const p = parts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante UTC correspondente a 'YYYY-MM-DD' HH:MM:SS no fuso. */
export function zonedTime(dateStr: string, tz: string, h = 0, m = 0, s = 0): Date {
  const [y, mo, d] = dateStr.split('-').map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, mo - 1, d, h, m, s));
  let t = new Date(guess.getTime() - offsetMs(guess, tz));
  t = new Date(guess.getTime() - offsetMs(t, tz)); // segunda passada cobre mudança de horário
  return t;
}

export const endOfDay = (dateStr: string, tz: string) => zonedTime(dateStr, tz, 23, 59, 59);
export const startOfDay = (dateStr: string, tz: string) => zonedTime(dateStr, tz, 0, 0, 0);

/** Instante do reset: agora se a data é hoje (ou futura); senão o fim daquele dia. */
export function resetInstant(dateStr: string, tz: string, now = new Date()): Date {
  return dateStr >= localDate(now, tz) ? now : endOfDay(dateStr, tz);
}
