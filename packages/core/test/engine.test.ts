import { describe, expect, it } from 'vitest';
import {
  colorFor, computePartWear, PIN_NONE, evaluateBike, originLabel, redLabel, resolveRules, simulateReprocess,
  sumUsage, validateThresholds, worstColor,
  type Activity, type Installation, type Part, type PartEvalInput, type Rule,
} from '../src';

const d = (s: string) => new Date(s + 'T12:00:00Z');
const BIKE = 'b1';

const part = (o: Partial<Part> = {}): Part => ({
  id: 'p1', categoryId: 'C16', modelId: null, wearsIndoor: false, status: 'INSTALLED',
  initialKm: 0, initialHours: 0, ...o,
});
const inst = (o: Partial<Installation> = {}): Installation => ({
  partId: 'p1', bikeId: BIKE, positionId: 'pos1', start: d('2026-01-01'), end: null, ...o,
});
const ride = (o: Partial<Activity> & { id: string; date: Date }): Activity => ({
  bikeId: BIKE, indoor: false, distanceM: 0, movingS: 0, elapsedS: 0, ...o,
});
const rule = (o: Partial<Rule> & { id: string }): Rule => ({
  target: { kind: 'category', id: 'C16' }, serviceId: 'revisao', criteria: {}, origin: 'PLATFORM',
  version: 1, status: 'PUBLISHED', ...o,
});

describe('desgaste (exemplo da especificação)', () => {
  it('suspensão 50 h ou 12 meses: após 40 h e ~3 meses = 80%, faltam ~10 h', () => {
    const input: PartEvalInput = {
      part: part(),
      installations: [inst()],
      activities: [ride({ id: 'a1', date: d('2026-02-01'), movingS: 40 * 3600, distanceM: 600_000 })],
      rules: [rule({ id: 'r1', criteria: { hours: 50, days: 365 } })],
      asOf: d('2026-04-02'),
    };
    const w = computePartWear(input);
    expect(w.pct).toBeCloseTo(80, 5);
    expect(w.color).toBe('YELLOW');
    expect(w.worst?.nextDue?.unit).toBe('hours');
    expect(w.worst?.nextDue?.remaining).toBeCloseTo(10, 5);
  });

  it('vale o critério que ocorrer primeiro (dias vencem antes das horas)', () => {
    const w = computePartWear({
      part: part(), installations: [inst()], activities: [],
      rules: [rule({ id: 'r1', criteria: { hours: 50, days: 100 } })],
      asOf: d('2026-06-01'),
    });
    expect(w.worst?.nextDue?.unit).toBe('days');
    expect(w.color).toBe('RED');
  });
});

describe('contagem de uso', () => {
  const rolo = ride({ id: 'r', date: d('2026-03-01'), indoor: true, elapsedS: 3600, movingS: 3000, distanceM: 20_000 });
  const rua = ride({ id: 's', date: d('2026-03-02'), movingS: 7200, elapsedS: 9000, distanceM: 40_000 });

  it('rolo soma só horas (tempo total) e só em peça que desgasta no rolo', () => {
    const on = sumUsage({ part: part({ wearsIndoor: true }), installations: [inst()], activities: [rolo] });
    const off = sumUsage({ part: part({ wearsIndoor: false }), installations: [inst()], activities: [rolo] });
    expect(on).toEqual({ km: 0, hours: 1 });
    expect(off).toEqual({ km: 0, hours: 0 });
  });

  it('rua soma distância e tempo em movimento', () => {
    const u = sumUsage({ part: part(), installations: [inst()], activities: [rua] });
    expect(u.km).toBeCloseTo(40);
    expect(u.hours).toBeCloseTo(2);
  });

  it('peça movida recebe só o uso do período em que esteve na bike', () => {
    const acts = [
      ride({ id: 'x1', date: d('2026-02-01'), distanceM: 100_000 }),
      ride({ id: 'x2', date: d('2026-03-15'), distanceM: 50_000 }),
    ];
    const u = sumUsage({
      part: part(),
      installations: [inst({ end: d('2026-03-01') }), inst({ start: d('2026-04-01'), bikeId: 'outra' })],
      activities: acts,
    });
    expect(u.km).toBeCloseTo(100);
  });

  it('atividade de outra bike não conta', () => {
    const u = sumUsage({
      part: part(), installations: [inst()],
      activities: [ride({ id: 'o', bikeId: 'outra', date: d('2026-03-01'), distanceM: 10_000 })],
    });
    expect(u.km).toBe(0);
  });
});

describe('reset por serviço e uso inicial', () => {
  const rules = [
    rule({ id: 'lub', target: { kind: 'category', id: 'C01' }, serviceId: 'lubrificar', criteria: { km: 300 } }),
    rule({ id: 'sub', target: { kind: 'category', id: 'C01' }, serviceId: 'substituir', criteria: { km: 3000 } }),
  ];
  const base = {
    part: part({ categoryId: 'C01', wearsIndoor: true, initialKm: 1500 }),
    installations: [inst({ start: d('2026-01-01') })],
    activities: [
      ride({ id: 'a', date: d('2026-02-01'), distanceM: 200_000 }),
      ride({ id: 'b', date: d('2026-03-10'), distanceM: 100_000 }),
    ],
    rules, asOf: d('2026-04-01'),
  } satisfies PartEvalInput;

  it('zerar só o serviço marcado; os demais seguem contando', () => {
    const w = computePartWear({
      ...base,
      states: [
        { partId: 'p1', serviceId: 'lubrificar', resetAt: d('2026-03-01') },
        { partId: 'p1', serviceId: 'substituir', resetAt: null, lifetime: true },
      ],
    });
    const lub = w.rules.find((r) => r.serviceId === 'lubrificar')!;
    const sub = w.rules.find((r) => r.serviceId === 'substituir')!;
    expect(lub.usage.km).toBeCloseTo(100);
    expect(sub.usage.km).toBeCloseTo(1500 + 300); // uso inicial entra só em "Substituir"
  });

  it('uso inicial não entra em serviços que não são de vida útil', () => {
    const w = computePartWear({ ...base, states: [] });
    expect(w.rules.find((r) => r.serviceId === 'lubrificar')!.usage.km).toBeCloseTo(300);
  });
});

describe('qual regra vale', () => {
  const platform = [
    rule({ id: 'p-a', serviceId: 'A', criteria: { hours: 50 } }),
    rule({ id: 'p-b', serviceId: 'B', criteria: { hours: 200 } }),
  ];
  const maker = rule({
    id: 'm-a', serviceId: 'A', origin: 'MANUFACTURER', target: { kind: 'model', id: 'MD1' },
    criteria: { hours: 100 }, sourceIds: ['F01'],
  });
  const p = { categoryId: 'C16', modelId: 'MD1' };

  it('fabricante vence plataforma; serviço sem regra do fabricante cai na plataforma', () => {
    const r = resolveRules({ part: p, rules: [...platform, maker] });
    expect(r.find((x) => x.serviceId === 'A')).toMatchObject({ origin: 'MANUFACTURER', ruleId: 'm-a' });
    expect(r.find((x) => x.serviceId === 'B')).toMatchObject({ origin: 'PLATFORM', ruleId: 'p-b' });
  });

  it('usuário vence tudo e mostra "baseada em"', () => {
    const r = resolveRules({
      part: p, rules: [...platform, maker],
      overrides: [{ serviceId: 'A', criteria: { hours: 30 } }],
    });
    const a = r.find((x) => x.serviceId === 'A')!;
    expect(a.origin).toBe('USER');
    expect(a.criteria.hours).toBe(30);
    expect(originLabel(a, 'SRAM')).toBe('Personalizada (baseada em: Fabricante, SRAM)');
  });

  it('desligar regra a remove; regra de plataforma nunca aparece como fabricante', () => {
    const r = resolveRules({ part: p, rules: platform, overrides: [{ serviceId: 'B', disabled: true }] });
    expect(r.map((x) => x.serviceId)).toEqual(['A']);
    expect(originLabel(r[0]!)).toBe('Recomendação da plataforma');
  });

  it('rascunho e revisão não valem para o usuário', () => {
    const r = resolveRules({ part: p, rules: [rule({ id: 'x', status: 'DRAFT', criteria: { km: 1 } })] });
    expect(r).toHaveLength(0);
  });

  it('regra fixada (pin) mantém a versão antiga mesmo arquivada; PIN_NONE oculta regra nova', () => {
    const oldR = rule({ id: 'old', serviceId: 'A', status: 'ARCHIVED', criteria: { hours: 50 } });
    const newR = rule({ id: 'new', serviceId: 'A', version: 2, criteria: { hours: 40 } });
    const pr = { categoryId: 'C16', modelId: null };
    expect(resolveRules({ part: pr, rules: [oldR, newR], pinned: { A: 'old' } })[0]!.ruleId).toBe('old');
    expect(resolveRules({ part: pr, rules: [oldR, newR] })[0]!.ruleId).toBe('new');
    expect(resolveRules({ part: pr, rules: [newR], pinned: { A: PIN_NONE } })).toHaveLength(0);
  });

  it('versão mais alta publicada prevalece', () => {
    const v2 = { ...platform[0]!, id: 'p-a2', version: 2, criteria: { hours: 40 } };
    const r = resolveRules({ part: { categoryId: 'C16', modelId: null }, rules: [platform[0]!, v2] });
    expect(r.find((x) => x.serviceId === 'A')!.ruleId).toBe('p-a2');
  });
});

describe('semáforo', () => {
  it('cores padrão', () => {
    expect(colorFor(69.9)).toBe('GREEN');
    expect(colorFor(70)).toBe('YELLOW');
    expect(colorFor(85)).toBe('ORANGE');
    expect(colorFor(100)).toBe('RED');
  });
  it('limites precisam ser crescentes e entre 1% e 200%', () => {
    expect(validateThresholds({ yellow: 70, orange: 85, red: 100 })).toBeNull();
    expect(validateThresholds({ yellow: 90, orange: 85, red: 100 })).not.toBeNull();
    expect(validateThresholds({ yellow: 0, orange: 85, red: 100 })).not.toBeNull();
    expect(validateThresholds({ yellow: 70, orange: 85, red: 201 })).not.toBeNull();
  });
  it('texto do vermelho', () => {
    expect(redLabel(112)).toBe('+12% acima do intervalo');
    expect(redLabel(100)).toBe('Intervalo vencido');
    expect(redLabel(92, { yellow: 50, orange: 70, red: 90 })).toBe('Atingiu 92% do intervalo');
  });
  it('cor da bike = pior cor das peças instaladas; estoque não conta', () => {
    expect(worstColor(['GREEN', 'ORANGE', 'YELLOW'])).toBe('ORANGE');
    const mk = (id: string, status: Part['status'], hours: number): PartEvalInput => ({
      part: part({ id, status }),
      installations: [inst({ partId: id })],
      activities: [ride({ id: 'a' + id, date: d('2026-02-01'), movingS: hours * 3600 })],
      rules: [rule({ id: 'r', criteria: { hours: 50 } })],
      asOf: d('2026-02-10'),
    });
    const ev = evaluateBike([mk('a', 'INSTALLED', 10), mk('b', 'INSTALLED', 60), mk('c', 'STOCK', 500)]);
    expect(ev.color).toBe('RED');
    expect(ev.parts.map((p) => p.partId)).toEqual(['b', 'a']);
    expect(ev.counts.RED).toBe(1);
  });
  it('limites customizados recalculam a cor', () => {
    const w = computePartWear({
      part: part(), installations: [inst()],
      activities: [ride({ id: 'a', date: d('2026-02-01'), movingS: 30 * 3600 })],
      rules: [rule({ id: 'r', criteria: { hours: 50 } })],
      thresholds: { yellow: 30, orange: 50, red: 60 },
      asOf: d('2026-02-02'),
    });
    expect(w.color).toBe('RED');
  });
});

describe('previsão de data', () => {
  it('estima pela média dos últimos 30 dias; sem uso, não mostra', () => {
    const asOf = d('2026-04-01');
    const mk = (acts: Activity[]) => computePartWear({
      part: part({ categoryId: 'C01' }), installations: [inst()], activities: acts,
      rules: [rule({ id: 'r', target: { kind: 'category', id: 'C01' }, serviceId: 's', criteria: { km: 300 } })],
      asOf,
    });
    const withUse = mk([ride({ id: 'a', date: d('2026-03-20'), distanceM: 60_000 })]);
    // 60 km / 30 dias = 2 km/dia; faltam 240 km => 120 dias
    expect(withUse.worst?.forecastDate?.getTime()).toBeCloseTo(asOf.getTime() + 120 * 86_400_000, -3);
    expect(mk([]).worst?.forecastDate).toBeNull();
  });
  it('critério em dias sempre tem previsão', () => {
    const w = computePartWear({
      part: part(), installations: [inst()], activities: [],
      rules: [rule({ id: 'r', criteria: { days: 90 } })], asOf: d('2026-02-01'),
    });
    expect(w.worst?.forecastDate).toEqual(new Date(d('2026-01-01').getTime() + 90 * 86_400_000));
  });
});

describe('estoque e dias', () => {
  it('contador de dias conta o tempo em estoque; km e horas não', () => {
    const w = computePartWear({
      part: part({ status: 'STOCK' }),
      installations: [inst({ end: d('2026-02-01') })],
      activities: [ride({ id: 'a', date: d('2026-03-01'), distanceM: 99_000, movingS: 3600 })],
      rules: [rule({ id: 'r', criteria: { days: 90, hours: 50 } })],
      asOf: d('2026-03-15'),
    });
    expect(w.worst?.usage.days).toBe(73);
    expect(w.worst?.usage.hours).toBe(0);
  });
});

describe('reprocessamento (simulação)', () => {
  const oldRule = rule({ id: 'v1', target: { kind: 'category', id: 'C01' }, serviceId: 'substituir', criteria: { km: 3000 } });
  const newRule = rule({ id: 'v2', version: 2, target: { kind: 'category', id: 'C01' }, serviceId: 'substituir', criteria: { km: 2500 } });
  const mk = (id: string, overrides?: PartEvalInput['overrides']): PartEvalInput => ({
    part: part({ id, categoryId: 'C01' }),
    installations: [inst({ partId: id })],
    activities: [ride({ id: 'a' + id, date: d('2026-02-01'), distanceM: 2_400_000 })],
    rules: [oldRule], overrides, asOf: d('2026-03-01'),
  });

  it('mostra antes e depois sem alterar a entrada', () => {
    const input = mk('p1');
    const snapshot = JSON.stringify(input);
    const [diff] = simulateReprocess([input], [oldRule, newRule]);
    expect(diff!.before.pct).toBeCloseTo(80);
    expect(diff!.after.pct).toBeCloseTo(96);
    expect(diff!.before.color).toBe('YELLOW');
    expect(diff!.after.color).toBe('ORANGE');
    expect(diff!.changed).toBe(true);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('é determinístico', () => {
    const a = simulateReprocess([mk('p1')], [oldRule, newRule]);
    const b = simulateReprocess([mk('p1')], [oldRule, newRule]);
    expect(a).toEqual(b);
  });

  it('peça com ajuste do usuário nunca é alterada por nova versão', () => {
    const [diff] = simulateReprocess([mk('p1', [{ serviceId: 'substituir', criteria: { km: 2800 } }])], [oldRule, newRule]);
    expect(diff!.changed).toBe(false);
    expect(diff!.hasUserOverride).toBe(true);
  });

  it('mudança que não altera números não gera card', () => {
    const same = { ...oldRule, id: 'v1b', version: 2 };
    const [diff] = simulateReprocess([mk('p1')], [same]);
    expect(diff!.before.pct).toBeCloseTo(diff!.after.pct);
    expect(diff!.changed).toBe(false);
  });
});

describe('uso consolidado (desconexão do Strava)', () => {
  const rules = [rule({ id: 'sub', target: { kind: 'category', id: 'C01' }, serviceId: 'substituir', criteria: { km: 3000 } })];
  const base = {
    part: part({ categoryId: 'C01', initialKm: 500 }),
    installations: [inst()],
    rules,
    asOf: d('2026-06-01'),
  };
  it('mantém o contador sem as atividades antigas e soma o que vier depois', () => {
    const w = computePartWear({
      ...base,
      activities: [ride({ id: 'novo', date: d('2026-05-20'), distanceM: 100_000 })],
      states: [{ partId: 'p1', serviceId: 'substituir', resetAt: null, lifetime: true, consolidated: { at: d('2026-05-01'), km: 1200, hours: 0 } }],
    });
    expect(w.worst!.usage.km).toBeCloseTo(1300); // 1200 consolidados + 100 novos; uso inicial já está no consolidado
  });
  it('reset posterior ao consolidado descarta o consolidado', () => {
    const w = computePartWear({
      ...base,
      activities: [ride({ id: 'novo', date: d('2026-05-20'), distanceM: 100_000 })],
      states: [{ partId: 'p1', serviceId: 'substituir', resetAt: d('2026-05-10'), lifetime: true, consolidated: { at: d('2026-05-01'), km: 1200, hours: 0 } }],
    });
    expect(w.worst!.usage.km).toBeCloseTo(100);
  });
});
