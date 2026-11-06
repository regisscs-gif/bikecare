import { beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, NOON_SP, type Harness } from './harness';

let h: Harness;
let cats: any[];
const svc = (name: string) => cats.flatMap((c) => c.services).find((x: any) => x.name === name)!.id as string;
const partBy = (bike: any, category: string) => bike.parts.find((p: any) => p.category === category);

beforeAll(async () => { h = await makeHarness(); cats = (await h.call('GET', '/library/categories', (await h.signup('seed@bike.test')).token)).body; }, 60_000);

async function newUser(email: string) {
  const { token } = await h.signup(email);
  const me = await h.call('GET', '/me', token);
  await h.call('POST', '/me/terms', token, { version: me.body.requiredTermsVersion });
  return token;
}
async function newBike(token: string, body: Record<string, unknown> = {}) {
  const r = await h.call('POST', '/bikes', token, { name: 'Minha Epic', type: 'MTB_FULL', partsInstalledAt: '2026-10-01', ...body });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const bike = async (token: string, id: string) => (await h.call('GET', `/bikes/${id}`, token)).body;

describe('conta e onboarding', () => {
  it('login Google cria a conta; aceite de termos é registrado', async () => {
    const a = await h.signup('ana@bike.test');
    expect(a.isNew).toBe(true);
    expect((await h.signup('ana@bike.test')).isNew).toBe(false);
    const me = await h.call('GET', '/me', a.token);
    expect(me.body.termsAccepted).toBe(false);
    expect((await h.call('POST', '/me/terms', a.token, { version: 'velha' })).status).toBe(400);
    await h.call('POST', '/me/terms', a.token, { version: me.body.requiredTermsVersion });
    expect((await h.call('GET', '/me', a.token)).body.termsAccepted).toBe(true);
  });

  it('exige autenticação', async () => {
    expect((await h.call('GET', '/bikes')).status).toBe(401);
    expect((await h.call('GET', '/bikes', 'lixo')).status).toBe(401);
  });

  it('bike nova sugere as posições do tipo, com peças genéricas, tudo verde', async () => {
    const t = await newUser('bia@bike.test');
    const id = await newBike(t);
    const b = await bike(t, id);
    expect(b.positions.length).toBeGreaterThan(15);
    expect(b.parts.length).toBe(b.positions.length);
    expect(b.parts.every((p: any) => p.isGeneric)).toBe(true);
    expect(b.color).toBe('GREEN');
    expect(b.bike.isDefault).toBe(true);
    // MTB full tem suspensão dianteira e traseira; Road não tem
    expect(partBy(b, 'Suspensão traseira (amortecedor)')).toBeTruthy();
    const road = await bike(t, await newBike(t, { name: 'Estrada', type: 'ROAD' }));
    expect(partBy(road, 'Suspensão dianteira')).toBeUndefined();
    expect(partBy(road, 'Fita de guidão')).toBeTruthy();
  });
});

describe('uso e desgaste', () => {
  it('pedal manual leva a corrente ao vermelho, avisa uma vez e mostra o texto do vermelho', async () => {
    const t = await newUser('caio@bike.test');
    const id = await newBike(t);
    const r = await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-10', distanceKm: 400, movingMinutes: 1200 });
    expect(r.status).toBe(201);
    const b = await bike(t, id);
    const chain = partBy(b, 'Corrente');
    expect(chain.color).toBe('RED');
    const detail = (await h.call('GET', `/parts/${chain.id}`, t)).body;
    const lub = detail.rules.find((x: any) => x.service === 'Lubrificar');
    expect(lub.pct).toBeCloseTo(133.3, 0);
    expect(lub.overdueLabel).toBe('+33% acima do intervalo');
    expect(lub.originLabel).toBe('Recomendação da plataforma');
    expect(detail.disclaimer).toMatch(/não que a peça vai falhar/);
    // aviso criado e enviado (12h em SP, fora do silêncio)
    const n = await h.call('GET', '/notifications', t);
    expect(n.body.items.some((x: any) => x.type === 'WEAR_RED')).toBe(true);
    const before = n.body.items.length;
    // novo pedal na mesma cor: não repete aviso
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-11', distanceKm: 20, movingMinutes: 60 });
    expect((await h.call('GET', '/notifications', t)).body.items.length).toBe(before);
  });

  it('rolo soma só horas e só nas peças que desgastam no rolo', async () => {
    const t = await newUser('duda@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-12', distanceKm: 30, movingMinutes: 120, indoor: true });
    const b = await bike(t, id);
    const chain = (await h.call('GET', `/parts/${partBy(b, 'Corrente').id}`, t)).body;
    const tire = (await h.call('GET', `/parts/${b.parts.find((p: any) => p.category === 'Pneu').id}`, t)).body;
    expect(chain.rules.every((r: any) => r.criteria.every((c: any) => c.unit !== 'km' || c.used === 0))).toBe(true);
    expect(tire.rules.every((r: any) => r.criteria.every((c: any) => c.used === 0))).toBe(true);
    // suspensão (não desgasta no rolo) continua com 0 h
    const fork = (await h.call('GET', `/parts/${partBy(b, 'Suspensão dianteira').id}`, t)).body;
    expect(fork.rules[0].criteria.find((c: any) => c.unit === 'hours').used).toBe(0);
  });

  it('pedal manual no mesmo dia de uma atividade do Strava pede confirmação', async () => {
    const t = await newUser('edu@bike.test');
    const id = await newBike(t);
    const { db } = h;
    const s = await import('../src/db/schema');
    const [u] = await db.select().from(s.users);
    void u;
    const me = await h.call('GET', '/me', t);
    await db.insert(s.activities).values({ userId: me.body.id, bikeId: id, source: 'STRAVA', externalId: 'x1', date: new Date('2026-10-15T12:00:00Z'), distanceM: 10_000, movingS: 1800, elapsedS: 1800 });
    const dup = await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-15', distanceKm: 10, movingMinutes: 30 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('POSSIBLE_DUPLICATE');
    expect((await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-15', distanceKm: 10, movingMinutes: 30, confirm: true })).status).toBe(201);
  });

  it('ajuste de uso soma km direto na bike; validações', async () => {
    const t = await newUser('fabi@bike.test');
    const id = await newBike(t);
    expect((await h.call('POST', `/bikes/${id}/usage-adjustments`, t, { km: 200 })).status).toBe(201);
    expect((await h.call('POST', `/bikes/${id}/usage-adjustments`, t, {})).status).toBe(400);
    expect((await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-10' })).status).toBe(400);
    const chain = await h.call('GET', `/parts/${partBy(await bike(t, id), 'Corrente').id}`, t);
    expect(chain.body.rules.find((x: any) => x.service === 'Lubrificar').criteria[0].used).toBe(200);
  });
});

describe('registro de manutenção', () => {
  it('zera só os serviços marcados, mantém os demais e grava km/horas e gastos', async () => {
    const t = await newUser('gabi@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-10', distanceKm: 400, movingMinutes: 1200 });
    let chain = partBy(await bike(t, id), 'Corrente');
    expect(chain.color).toBe('RED');

    const form = await h.call('GET', `/bikes/${id}/maintenance/form`, t);
    expect(form.body[0].label).toMatch(/Corrente/); // vermelho primeiro
    expect(form.body[0].services.find((s: any) => s.name === 'Lubrificar').preselected).toBe(true);

    const rec = await h.call('POST', `/bikes/${id}/maintenance`, t, {
      date: '2026-10-27', shop: 'Bike Shop', partsCostCents: 4500, laborCostCents: 3000,
      items: [{ partId: chain.id, serviceIds: [svc('Lubrificar')] }],
    });
    expect(rec.status).toBe(201);
    chain = partBy(await bike(t, id), 'Corrente');
    const d = (await h.call('GET', `/parts/${chain.id}`, t)).body;
    expect(d.rules.find((x: any) => x.service === 'Lubrificar').criteria[0].used).toBe(0);
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBe(400); // não zerou
    expect(chain.color).toBe('GREEN');
    // histórico com km na data
    const hist = (await h.call('GET', `/bikes/${id}/maintenance`, t)).body;
    expect(hist[0].items[0]).toMatchObject({ km: 400, services: ['Lubrificar'] });
    // custos viraram gastos ligados ao registro
    const ex = (await h.call('GET', `/expenses?bikeId=${id}`, t)).body;
    expect(ex.items.map((e: any) => e.category).sort()).toEqual(['LABOR', 'PARTS']);
    expect(ex.totals.monthCents).toBe(7500);
    expect(ex.items.every((e: any) => e.recordId === rec.body.id)).toBe(true);
  });

  it('manutenção no passado: pedais depois da data contam no novo ciclo', async () => {
    const t = await newUser('hugo@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-05', distanceKm: 150, movingMinutes: 500 });
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-20', distanceKm: 100, movingMinutes: 300 });
    const chain = partBy(await bike(t, id), 'Corrente');
    await h.call('POST', `/bikes/${id}/maintenance`, t, { date: '2026-10-10', items: [{ partId: chain.id, serviceIds: [svc('Lubrificar')] }] });
    const d = (await h.call('GET', `/parts/${chain.id}`, t)).body;
    expect(d.rules.find((x: any) => x.service === 'Lubrificar').criteria[0].used).toBe(100);
  });

  it('validações: sem serviço, futuro, peça de outra bike', async () => {
    const t = await newUser('iris@bike.test');
    const id = await newBike(t);
    const chain = partBy(await bike(t, id), 'Corrente');
    expect((await h.call('POST', `/bikes/${id}/maintenance`, t, { items: [{ partId: chain.id, serviceIds: [] }] })).status).toBe(400);
    expect((await h.call('POST', `/bikes/${id}/maintenance`, t, { date: '2026-12-31', items: [{ partId: chain.id, serviceIds: [svc('Lubrificar')] }] })).status).toBe(400);
    const other = await newBike(t, { name: 'Outra' });
    expect((await h.call('POST', `/bikes/${other}/maintenance`, t, { items: [{ partId: chain.id, serviceIds: [svc('Lubrificar')] }] })).status).toBe(400);
  });

  it('substituir: peça antiga aposentada, nova entra zerada na mesma posição, histórico de ambas', async () => {
    const t = await newUser('jose@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/usage-adjustments`, t, { km: 3200 });
    const b0 = await bike(t, id);
    const oldChain = partBy(b0, 'Corrente');
    expect(oldChain.color).toBe('RED');
    h.clock.now = new Date(h.clock.now.getTime() + 60_000); // o uso lançado vem antes da troca
    await h.call('POST', `/bikes/${id}/maintenance`, t, {
      date: '2026-10-27',
      items: [{ partId: oldChain.id, serviceIds: [], replacement: { oldPart: 'RETIRE', nickname: 'Corrente nova' } }],
    });
    const b1 = await bike(t, id);
    const fresh = partBy(b1, 'Corrente');
    expect(fresh.id).not.toBe(oldChain.id);
    expect(fresh.label).toBe('Corrente nova');
    expect(fresh.color).toBe('GREEN');
    expect(fresh.positionId).toBe(oldChain.positionId);
    const old = (await h.call('GET', `/parts/${oldChain.id}`, t)).body;
    expect(old.status).toBe('RETIRED');
    expect(old.history.map((x: any) => x.type)).toEqual(expect.arrayContaining(['MAINTENANCE', 'RETIRED', 'INSTALLED']));
    expect((await h.call('GET', '/parts?status=RETIRED', t)).body).toHaveLength(1);
    h.clock.now = new Date(NOON_SP);
  });

  it('editar o registro recalcula; apagar volta o contador', async () => {
    const t = await newUser('katia@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-10', distanceKm: 400, movingMinutes: 1200 });
    const chain = partBy(await bike(t, id), 'Corrente');
    const rec = (await h.call('POST', `/bikes/${id}/maintenance`, t, { date: '2026-10-27', items: [{ partId: chain.id, serviceIds: [svc('Lubrificar')] }] })).body.id;
    const used = async () => (await h.call('GET', `/parts/${chain.id}`, t)).body.rules.find((x: any) => x.service === 'Lubrificar').criteria[0].used;
    expect(await used()).toBe(0);
    await h.call('PATCH', `/maintenance/${rec}`, t, { date: '2026-10-05' });
    expect(await used()).toBe(400); // pedal de 10/10 passou a contar depois da manutenção
    expect((await h.call('DELETE', `/maintenance/${rec}`, t)).status).toBe(204);
    expect(await used()).toBe(400);
  });
});

describe('peças: genérico -> específico, ajustes, mover', () => {
  it('trocar modelo mostra prévia e mantém uso; regra do fabricante cita a fonte', async () => {
    const t = await newUser('lia@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/usage-adjustments`, t, { hours: 40 });
    const fork = partBy(await bike(t, id), 'Suspensão dianteira');
    const models = (await h.call('GET', `/library/models?categoryId=${fork.categoryId}&q=Pike`, t)).body;
    expect(models.length).toBeGreaterThan(0);
    const pike = models.find((m: any) => /Pike/.test(m.name));
    expect(pike.manufacturer).toBe('RockShox');

    const preview = await h.call('POST', `/parts/${fork.id}/model`, t, { modelId: pike.id });
    expect(preview.body.applied).toBe(false);
    expect(preview.body.changes.length).toBeGreaterThan(0);
    expect(preview.body.changes[0].after).toMatch(/Fabricante/);
    // ainda genérico
    expect((await h.call('GET', `/parts/${fork.id}`, t)).body.isGeneric).toBe(true);

    await h.call('POST', `/parts/${fork.id}/model`, t, { modelId: pike.id, confirm: true });
    const d = (await h.call('GET', `/parts/${fork.id}`, t)).body;
    expect(d.isGeneric).toBe(false);
    const lower = d.rules.find((r: any) => r.service === 'Revisão das pernas inferiores');
    expect(lower.origin).toBe('MANUFACTURER');
    expect(lower.originLabel).toBe('Fabricante, RockShox');
    expect(lower.sources.length).toBeGreaterThan(0);
    expect(lower.sources[0].url).toMatch(/^https:/);
    expect(lower.criteria.find((c: any) => c.unit === 'hours')).toMatchObject({ used: 40, limit: 50 }); // uso mantido
    expect(d.history.map((x: any) => x.type)).toContain('MODEL_CHANGED');
  });

  it('ajuste do usuário vence, aparece como personalizada e pode voltar ao original; modelo mantém o ajuste', async () => {
    const t = await newUser('maria@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/usage-adjustments`, t, { km: 250 });
    const chain = partBy(await bike(t, id), 'Corrente');
    const lub = svc('Lubrificar');
    expect((await h.call('PUT', `/parts/${chain.id}/rules/${lub}`, t, { criteria: { km: 0 } })).status).toBe(400);
    await h.call('PUT', `/parts/${chain.id}/rules/${lub}`, t, { criteria: { km: 500 } });
    let d = (await h.call('GET', `/parts/${chain.id}`, t)).body;
    let r = d.rules.find((x: any) => x.service === 'Lubrificar');
    expect(r.origin).toBe('USER');
    expect(r.originLabel).toBe('Personalizada (baseada em: Recomendação da plataforma)');
    expect(r.criteria[0]).toMatchObject({ limit: 500, used: 250, pct: 50 });
    await h.call('PUT', `/parts/${chain.id}/rules/${lub}`, t, { disabled: true });
    d = (await h.call('GET', `/parts/${chain.id}`, t)).body;
    expect(d.rules.find((x: any) => x.service === 'Lubrificar')).toBeUndefined();
    expect((await h.call('DELETE', `/parts/${chain.id}/rules/${lub}`, t)).status).toBe(204);
    d = (await h.call('GET', `/parts/${chain.id}`, t)).body;
    r = d.rules.find((x: any) => x.service === 'Lubrificar');
    expect(r.origin).toBe('PLATFORM');
    expect(r.criteria[0].limit).toBe(300);
  });

  it('regra própria com serviço livre', async () => {
    const t = await newUser('nuno@bike.test');
    const id = await newBike(t);
    const chain = partBy(await bike(t, id), 'Corrente');
    const r = await h.call('POST', `/parts/${chain.id}/rules`, t, { name: 'Limpar com desengraxante', criteria: { km: 150 } });
    expect(r.status).toBe(201);
    const d = (await h.call('GET', `/parts/${chain.id}`, t)).body;
    expect(d.rules.find((x: any) => x.service === 'Limpar com desengraxante')).toMatchObject({ origin: 'USER', originLabel: 'Personalizada' });
  });

  it('mover peça leva o uso junto; só o período instalado conta; posição ocupada é recusada', async () => {
    const t = await newUser('olga@bike.test');
    const a = await newBike(t, { name: 'A', type: 'MTB_XC' });
    const b = await newBike(t, { name: 'B', type: 'MTB_XC' });
    await h.call('POST', `/bikes/${a}/rides`, t, { date: '2026-10-10', distanceKm: 100, movingMinutes: 300 });
    const ba = await bike(t, a);
    const wheelF = ba.parts.find((p: any) => p.category === 'Cubos / rodas' && p.positionId);
    const chainA = partBy(ba, 'Corrente');
    const bb = await bike(t, b);
    const posChainB = bb.positions.find((p: any) => p.categoryId === chainA.categoryId);
    // ocupada
    const busy = await h.call('POST', `/parts/${chainA.id}/move`, t, { positionId: posChainB.id });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('POSITION_OCCUPIED');
    // libera a posição da B e move
    const chainB = partBy(bb, 'Corrente');
    expect((await h.call('POST', `/parts/${chainB.id}/stock`, t)).status).toBe(200);
    expect((await h.call('POST', `/parts/${chainA.id}/move`, t, { positionId: posChainB.id })).status).toBe(200);
    // pedal depois da mudança na bike B
    await h.call('POST', `/bikes/${b}/rides`, t, { date: '2026-10-27', distanceKm: 50, movingMinutes: 120 });
    const d = (await h.call('GET', `/parts/${chainA.id}`, t)).body;
    expect(d.installedOn.bikeId).toBe(b);
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBe(150); // 100 na A + 50 na B
    // categoria errada
    expect((await h.call('POST', `/parts/${wheelF.id}/move`, t, { positionId: posChainB.id })).status).toBe(400);
    // estoque não acumula uso
    const stocked = (await h.call('GET', `/parts/${chainB.id}`, t)).body;
    expect(stocked.status).toBe('STOCK');
  });

  it('peça usada: uso inicial só entra em "Substituir"; última manutenção informada define o contador', async () => {
    const t = await newUser('paulo@bike.test');
    const id = await newBike(t, { withSuggestedParts: false });
    const b = await bike(t, id);
    const pos = b.positions.find((p: any) => p.name === 'Corrente');
    const r = await h.call('POST', '/parts', t, {
      categoryId: pos.categoryId, positionId: pos.id, installedAt: '2026-09-01', initialKm: 1500,
      lastMaintenance: { [svc('Lubrificar')]: '2026-10-20' },
    });
    expect(r.status).toBe(201);
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-05', distanceKm: 200, movingMinutes: 600 });
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-25', distanceKm: 40, movingMinutes: 120 });
    const d = (await h.call('GET', `/parts/${r.body.id}`, t)).body;
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBe(1740);
    expect(d.rules.find((x: any) => x.service === 'Lubrificar').criteria[0].used).toBe(40);
  });
});

describe('semáforo e plano', () => {
  it('limites precisam ser crescentes; mudar recalcula na hora sem aviso retroativo', async () => {
    const t = await newUser('quim@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-10', distanceKm: 240, movingMinutes: 600 }); // 80% de lubrificar
    expect(partBy(await bike(t, id), 'Corrente').color).toBe('YELLOW');
    expect((await h.call('PATCH', '/me', t, { thresholds: { yellow: 90, orange: 85, red: 100 } })).body.code).toBe('INVALID_THRESHOLDS');
    expect((await h.call('PATCH', '/me', t, { thresholds: { yellow: 0, orange: 85, red: 100 } })).status).toBe(400);
    const before = (await h.call('GET', '/notifications', t)).body.items.length;
    await h.call('PATCH', '/me', t, { thresholds: { yellow: 30, orange: 50, red: 75 } });
    const chain = partBy(await bike(t, id), 'Corrente');
    expect(chain.color).toBe('RED');
    expect(chain.overdueLabel).toBe('Atingiu 80% do intervalo');
    expect((await h.call('GET', '/notifications', t)).body.items.length).toBe(before); // sem aviso retroativo
  });

  it('limite de bikes vem do servidor (direito do plano ou do usuário)', async () => {
    const t = await newUser('rui@bike.test');
    const me = (await h.call('GET', '/me', t)).body;
    await newBike(t);
    const s = await import('../src/db/schema');
    await h.db.insert(s.userEntitlements).values({ userId: me.id, key: 'maxActiveBikes', value: 1 });
    const r = await h.call('POST', '/bikes', t, { name: 'Segunda', type: 'ROAD' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ENTITLEMENT');
    expect((await h.call('GET', '/me', t)).body.entitlements.maxActiveBikes).toBe(1);
  });

  it('arquivar libera o lugar e para de contar; excluir exige confirmação', async () => {
    const t = await newUser('sara@bike.test');
    const me = (await h.call('GET', '/me', t)).body;
    const s = await import('../src/db/schema');
    await h.db.insert(s.userEntitlements).values({ userId: me.id, key: 'maxActiveBikes', value: 1 });
    const a = await newBike(t, { name: 'A' });
    await h.call('POST', `/bikes/${a}/archive`, t);
    const b = await newBike(t, { name: 'B' });
    expect((await h.call('POST', `/bikes/${a}/unarchive`, t)).status).toBe(403); // sem lugar
    expect((await h.call('POST', `/bikes/${a}/rides`, t, { date: '2026-10-10', distanceKm: 10 })).status).toBe(400);
    expect((await h.call('DELETE', `/bikes/${b}`, t)).body.code).toBe('CONFIRM_REQUIRED');
    expect((await h.call('DELETE', `/bikes/${b}?confirm=true`, t)).status).toBe(204);
    const list = (await h.call('GET', '/bikes', t)).body;
    expect(list.map((x: any) => x.name)).toEqual(['A']);
  });

  it('tela principal ordena bikes da pior para a melhor cor', async () => {
    const t = await newUser('tania@bike.test');
    const ok = await newBike(t, { name: 'Verde' });
    const bad = await newBike(t, { name: 'Vermelha' });
    await h.call('POST', `/bikes/${bad}/rides`, t, { date: '2026-10-10', distanceKm: 400, movingMinutes: 900 });
    const home = (await h.call('GET', '/home', t)).body;
    expect(home.bikes.map((b: any) => b.name)).toEqual(['Vermelha', 'Verde']);
    expect(home.bikes[0].counts.RED).toBeGreaterThan(0);
    void ok;
    const detail = await bike(t, bad);
    const pcts = detail.parts.map((p: any) => p.pct);
    expect([...pcts].sort((a: number, b: number) => b - a)).toEqual(pcts); // peças do maior para o menor desgaste
  });
});

describe('gastos', () => {
  it('lançamento simples, filtros e totais do mês e do ano', async () => {
    const t = await newUser('ugo@bike.test');
    const id = await newBike(t);
    await h.call('POST', '/expenses', t, { bikeId: id, amountCents: 15000, category: 'TIRES', description: 'Pneu', date: '2026-10-02' });
    await h.call('POST', '/expenses', t, { bikeId: id, amountCents: 5000, category: 'TOOLS', date: '2026-03-02' });
    const all = (await h.call('GET', '/expenses', t)).body;
    expect(all.totals).toMatchObject({ monthCents: 15000, yearCents: 20000, filteredCents: 20000 });
    const tires = (await h.call('GET', '/expenses?category=TIRES', t)).body;
    expect(tires.items).toHaveLength(1);
    expect((await h.call('POST', '/expenses', t, { bikeId: id, amountCents: 0, category: 'TOOLS' })).status).toBe(400);
  });
});

describe('privacidade (LGPD)', () => {
  it('exporta os dados e exclui a conta dentro do app', async () => {
    const t = await newUser('vera@bike.test');
    const id = await newBike(t);
    await h.call('POST', `/bikes/${id}/rides`, t, { date: '2026-10-10', distanceKm: 10, movingMinutes: 30 });
    const ex = (await h.call('GET', '/me/export', t)).body;
    expect(ex.bikes).toHaveLength(1);
    expect(ex.activities).toHaveLength(1);
    expect(ex.parts.length).toBeGreaterThan(10);
    const me = (await h.call('GET', '/me', t)).body;
    expect((await h.call('DELETE', '/me', t)).status).toBe(204);
    const s = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    expect(await h.db.select().from(s.bikes).where(eq(s.bikes.userId, me.id))).toHaveLength(0);
    expect(await h.db.select().from(s.parts).where(eq(s.parts.userId, me.id))).toHaveLength(0);
    expect(await h.db.select().from(s.activities).where(eq(s.activities.userId, me.id))).toHaveLength(0);
  });

  it('isola dados entre usuários', async () => {
    const a = await newUser('xena@bike.test');
    const b = await newUser('yago@bike.test');
    const id = await newBike(a);
    expect((await h.call('GET', `/bikes/${id}`, b)).status).toBe(404);
    const chain = partBy(await bike(a, id), 'Corrente');
    expect((await h.call('GET', `/parts/${chain.id}`, b)).status).toBe(404);
    expect((await h.call('POST', `/bikes/${id}/rides`, b, { date: '2026-10-10', distanceKm: 5 })).status).toBe(404);
  });
});

void NOON_SP;
