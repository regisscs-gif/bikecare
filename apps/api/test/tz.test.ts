import { describe, expect, it } from 'vitest';
import { endOfDay, localDate, localHour, resetInstant, startOfDay } from '../src/tz';

const SP = 'America/Sao_Paulo';
describe('fuso horário', () => {
  it('data local de um instante UTC', () => {
    expect(localDate(new Date('2026-10-28T01:30:00Z'), SP)).toBe('2026-10-27'); // 22:30 em SP
    expect(localHour(new Date('2026-10-28T01:30:00Z'), SP)).toBe(22);
  });
  it('início e fim do dia no fuso', () => {
    expect(startOfDay('2026-10-27', SP).toISOString()).toBe('2026-10-27T03:00:00.000Z');
    expect(endOfDay('2026-10-27', SP).toISOString()).toBe('2026-10-28T02:59:59.000Z');
    expect(endOfDay('2026-07-01', 'Europe/Lisbon').toISOString()).toBe('2026-07-01T22:59:59.000Z');
  });
  it('reset: hoje = agora; passado = fim do dia', () => {
    const now = new Date('2026-10-27T15:00:00Z');
    expect(resetInstant('2026-10-27', SP, now)).toEqual(now);
    expect(resetInstant('2026-10-20', SP, now).toISOString()).toBe('2026-10-21T02:59:59.000Z');
  });
});
