const MI = 0.621371;

/** O servidor guarda km; a unidade de exibição é preferência do usuário. */
export function distance(km: number, unit: 'km' | 'mi' = 'km'): string {
  const v = unit === 'mi' ? km * MI : km;
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: v < 100 ? 1 : 0 }).format(v)} ${unit}`;
}
export const toKm = (v: number, unit: 'km' | 'mi') => (unit === 'mi' ? v / MI : v);
export const fromKm = (v: number, unit: 'km' | 'mi') => (unit === 'mi' ? v * MI : v);

export const money = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);

/** "12,50" ou "12.50" -> 1250 (centavos). */
export function parseMoney(s: string): number {
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
export const parseNum = (s: string): number => Number(s.replace(',', '.'));

export function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function dateBR(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso) : iso;
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}
export function dateTimeBR(iso: string | number | Date): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function unitLabel(unit: string): string {
  return unit === 'km' ? 'km' : unit === 'hours' ? 'h' : 'dias';
}
