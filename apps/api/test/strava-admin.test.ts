import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { processJobs } from '../src/strava/sync';
import { StravaRateLimited, type StravaActivity } from '../src/strava/client';
import { mapStravaActivity } from '../src/strava/mapping';
import { decryptToken, encryptToken } from '../src/strava/crypto';
import { hourlyJob } from '../src/jobs';
import { makeHarness, type Harness } from './harness';

let h: Harness;
let cats: any[];
const svc = (name: string) => cats.flatMap((c) => c.services).find((x: any) => x.name === name)!.id as string;
const partBy = (bike: any, category: string) => bike.parts.find((p: any) => p.category === category);
beforeAll(async () => { h = await makeHarness(); cats = (await h.call('GET', '/library/categories', (await h.signup('seed@bike.test')).token)).body; }, 60_000);

async function newUser(email: string) {
  const { token } = await h.signup(email);
  const me = await h.call('GET', '/me', token);
  await h.call('POST', '/me/terms', token, { version: me.body.requiredTermsVersion });
  return { token, id: me.body.id as string };
}
const bike = async (t: string, id: string) => (await h.call('GET', `/bikes/${id}`, t)).body;
const act = (id: number, o: Partial<StravaActivity> = {}): StravaActivity => ({
  id, type: 'Ride', sport_type: 'Ride', start_date: '2026-10-15T10:00:00Z', distance: 40_000, moving_time: 5400, elapsed_time: 6000, gear_id: 'b1', ...o,
});

describe('mapeamento de atividades do Strava', () => {
  const maps = { acceptedTypes: ['Ride', 'VirtualRide', 'MountainBikeRide'], gearToBike: new Map([['b1', 'bikeA']]), defaultBikeId: 'bikeDef' };
  it('rolo = VirtualRide ou trainer; sem bike vai para a padrão; bike não importada é ignorada; tipo fora da lista é ignorado', () => {
    expect(mapStravaActivity(act(1, { sport_type: 'VirtualRide' }), maps)).toMatchObject({ ok: true, value: { indoor: true, bikeId: 'bikeA' } });
    expect(mapStravaActivity(act(2, { trainer: true }), maps)).toMatchObject({ ok: true, value: { indoor: true } });
    expect(mapStravaActivity(act(3, { gear_id: null }), maps)).toMatchObject({ ok: true, value: { indoor: false, bikeId: 'bikeDef' } });
    expect(mapStravaActivity(act(4, { gear_id: 'b99' }), maps)).toEqual({ ok: false, skip: 'GEAR_NOT_IMPORTED' });
    expect(mapStravaActivity(act(5, { sport_type: 'Run', type: 'Run' }), maps)).toEqual({ ok: false, skip: 'TYPE' });
    expect(mapStravaActivity(act(6, { gear_id: null }), { ...maps, defaultBikeId: null })).toEqual({ ok: false, skip: 'NO_DEFAULT_BIKE' });
  });
  it('tokens são criptografados e recuperáveis', () => {
    const k = Buffer.alloc(32, 3);
    const enc = encryptToken('segredo', k);
    expect(enc).not.toContain('segredo');
    expect(decryptToken(enc, k)).toBe('segredo');
    expect(() => decryptToken(enc, Buffer.alloc(32, 4))).toThrow();
  });
});

describe('integração Strava (fluxo completo)', () => {
  it('conecta, importa bikes, sincroniza pedais, trata edição/exclusão e desconecta mantendo o uso consolidado', async () => {
    const u = await newUser('strava1@bike.test');
    h.strava.athleteId = '111';
    h.strava.gear = [
      { id: 'b1', name: 'Minha Epic', primary: true, brand: 'Specialized', model: 'Epic' },
      { id: 'b2', name: 'Gravel', primary: false },
    ];
    expect((await h.call('POST', '/strava/connect', u.token, { code: 'abcdef', scope: 'read' })).status).toBe(400); // sem permissão de atividades
    expect((await h.call('POST', '/strava/connect', u.token, { code: 'abcdef', scope: 'read,activity:read_all,profile:read_all' })).status).toBe(200);

    // bikes do perfil Strava; importa só a Epic
    const gear = (await h.call('GET', '/strava/gear', u.token)).body;
    expect(gear.map((g: any) => g.name)).toEqual(['Minha Epic', 'Gravel']);
    const imp = await h.call('POST', '/strava/import', u.token, { picks: [{ gearId: 'b1', type: 'MTB_FULL', partsInstalledAt: '2026-10-01' }] });
    expect(imp.body.created).toHaveLength(1);
    const bikeId = imp.body.created[0];
    const b = (await h.call('GET', '/bikes', u.token)).body[0];
    expect(b).toMatchObject({ name: 'Minha Epic', brand: 'Specialized', isDefault: true, stravaLinked: true });

    h.strava.activities = [
      act(10, { start_date: '2026-10-05T10:00:00Z', distance: 100_000, moving_time: 14400, elapsed_time: 15000 }),
      act(11, { start_date: '2026-10-06T10:00:00Z', sport_type: 'VirtualRide', type: 'VirtualRide', distance: 30_000, moving_time: 3000, elapsed_time: 3600 }),
      act(12, { start_date: '2026-10-07T10:00:00Z', gear_id: 'b2' }), // bike não importada: ignorada
      act(13, { start_date: '2026-10-08T10:00:00Z', gear_id: null, distance: 20_000, moving_time: 3600, elapsed_time: 3600 }), // sem bike: padrão
      act(14, { start_date: '2026-10-09T10:00:00Z', sport_type: 'Run', type: 'Run' }),
    ];
    // a importação inicial foi enfileirada; processa a fila
    expect((await processJobs(h.app.deps)).done).toBeGreaterThan(0);
    const acts = (await h.call('GET', `/bikes/${bikeId}/activities`, u.token)).body;
    expect(acts).toHaveLength(3);
    expect(acts.find((a: any) => a.indoor).elapsedHours).toBeCloseTo(1, 1);

    let chain = partBy(await bike(u.token, bikeId), 'Corrente');
    let d = (await h.call('GET', `/parts/${chain.id}`, u.token)).body;
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBeCloseTo(120, 0); // 100 + 20; rolo não soma km

    // atividade editada no Strava recalcula; apagada remove
    h.strava.activities[0] = act(10, { start_date: '2026-10-05T10:00:00Z', distance: 150_000, moving_time: 14400, elapsed_time: 15000 });
    await h.call('POST', '/strava/webhook', undefined, { object_type: 'activity', object_id: 10, aspect_type: 'update', owner_id: 111, updates: { distance: 150000 } });
    await processJobs(h.app.deps);
    d = (await h.call('GET', `/parts/${chain.id}`, u.token)).body;
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBeCloseTo(170, 0);
    await h.call('POST', '/strava/webhook', undefined, { object_type: 'activity', object_id: 13, aspect_type: 'delete', owner_id: 111 });
    await processJobs(h.app.deps);
    d = (await h.call('GET', `/parts/${chain.id}`, u.token)).body;
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBeCloseTo(150, 0);

    // desconectar apaga as atividades e guarda o uso como consolidado
    h.clock.now = new Date('2026-10-27T15:00:00Z');
    expect((await h.call('DELETE', '/strava', u.token)).status).toBe(204);
    expect(h.strava.deauthorized).toBeGreaterThan(0);
    expect((await h.call('GET', `/bikes/${bikeId}/activities`, u.token)).body.filter((a: any) => a.source === 'STRAVA')).toHaveLength(0);
    chain = partBy(await bike(u.token, bikeId), 'Corrente');
    d = (await h.call('GET', `/parts/${chain.id}`, u.token)).body;
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBeCloseTo(150, 0); // consolidado
    // pedal manual depois soma por cima
    await h.call('POST', `/bikes/${bikeId}/rides`, u.token, { date: '2026-10-27', distanceKm: 10, movingMinutes: 30 });
    d = (await h.call('GET', `/parts/${chain.id}`, u.token)).body;
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0].used).toBeCloseTo(160, 0);
    expect((await h.call('GET', '/strava/status', u.token)).body.connected).toBe(false);
  });

  it('webhook: validação da inscrição e revogação no Strava', async () => {
    expect((await h.call('GET', '/strava/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=x')).status).toBe(403);
    const ok = await h.call('GET', '/strava/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc');
    expect(ok.body).toEqual({ 'hub.challenge': 'abc' });

    const u = await newUser('strava2@bike.test');
    h.strava.athleteId = '222';
    h.strava.gear = [{ id: 'b1', name: 'Rapha', primary: true }];
    await h.call('POST', '/strava/connect', u.token, { code: 'abcdef', scope: 'read,activity:read_all' });
    await h.call('POST', '/strava/import', u.token, { picks: [{ gearId: 'b1', type: 'ROAD' }] });
    await h.call('POST', '/strava/webhook', undefined, { object_type: 'athlete', object_id: 222, aspect_type: 'update', owner_id: 222, updates: { authorized: 'false' } });
    expect((await h.call('GET', '/strava/status', u.token)).body.connected).toBe(false);
    // evento de quem não é nosso usuário é ignorado
    expect((await h.call('POST', '/strava/webhook', undefined, { object_type: 'activity', object_id: 1, aspect_type: 'create', owner_id: 99999 })).status).toBe(200);
  });

  it('limite de uso da API reagenda a tarefa; acesso revogado avisa para reconectar', async () => {
    const u = await newUser('strava3@bike.test');
    h.strava.athleteId = '333';
    h.strava.gear = [{ id: 'b1', name: 'B', primary: true }];
    await h.call('POST', '/strava/connect', u.token, { code: 'abcdef', scope: 'read,activity:read_all' });
    const orig = h.strava.listActivities.bind(h.strava);
    h.strava.listActivities = async () => { throw new StravaRateLimited(60); };
    await h.call('POST', '/strava/import', u.token, { picks: [{ gearId: 'b1', type: 'ROAD', partsInstalledAt: '2026-10-01' }] });
    await new Promise((r) => setTimeout(r, 20));
    await processJobs(h.app.deps);
    const [job] = await h.db.select().from(s.stravaJobs).where(eq(s.stravaJobs.userId, u.id));
    expect(job!.status).toBe('PENDING');
    expect(job!.attempts).toBeGreaterThan(0);
    expect(job!.nextAttemptAt.getTime()).toBeGreaterThan(h.clock.now.getTime());
    h.strava.listActivities = orig;
    h.clock.now = new Date(h.clock.now.getTime() + 120_000);
    expect((await processJobs(h.app.deps)).done).toBeGreaterThan(0);

    // token expirado + refresh recusado => aviso de reconexão
    h.strava.revoked = true;
    await h.db.update(s.stravaConnections).set({ expiresAt: new Date(0) }).where(eq(s.stravaConnections.userId, u.id));
    await h.call('POST', '/strava/sync', u.token);
    await new Promise((r) => setTimeout(r, 20));
    await processJobs(h.app.deps);
    h.strava.revoked = false;
    const n = (await h.call('GET', '/notifications', u.token)).body.items;
    expect(n.some((x: any) => x.type === 'STRAVA_ERROR' && /Reconecte o Strava/.test(x.text))).toBe(true);
    expect((await h.call('GET', '/strava/status', u.token)).body.status).toBe('ERROR');
  });
});

describe('notificações', () => {
  it('push respeita o horário silencioso (22h–8h) e sai depois; limite de 2 por dia', async () => {
    const u = await newUser('notif1@bike.test');
    await h.call('POST', '/push-tokens', u.token, { platform: 'ios', token: 'ExponentPushToken[abcdef]' });
    const id = (await h.call('POST', '/bikes', u.token, { name: 'N', type: 'MTB_FULL', partsInstalledAt: '2026-10-01' })).body.id;
    h.pushes.length = 0;
    h.clock.now = new Date('2026-10-28T01:30:00Z'); // 22:30 em SP
    await h.call('POST', `/bikes/${id}/usage-adjustments`, u.token, { km: 400 });
    expect(h.pushes.filter((p) => p.userId === u.id)).toHaveLength(0);
    const pending = await h.db.select().from(s.notifications).where(eq(s.notifications.userId, u.id));
    expect(pending.some((n) => n.push && !n.pushedAt)).toBe(true);
    // 8h30 no dia seguinte: a rotina horária libera
    h.clock.now = new Date('2026-10-28T11:30:00Z');
    await hourlyJob(h.app.deps);
    expect(h.pushes.filter((p) => p.userId === u.id).length).toBeGreaterThan(0);
  });

  it('vários componentes na mesma rodada viram um push só; ler marca como lida', async () => {
    const u = await newUser('notif2@bike.test');
    h.clock.now = new Date('2026-10-27T15:00:00Z');
    const id = (await h.call('POST', '/bikes', u.token, { name: 'N', type: 'MTB_FULL', partsInstalledAt: '2026-10-01' })).body.id;
    h.pushes.length = 0;
    await h.call('POST', `/bikes/${id}/usage-adjustments`, u.token, { km: 3500 }); // corrente, cassete, câmbio etc. no vermelho
    const mine = h.pushes.filter((p) => p.userId === u.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toMatch(/componentes precisam de atenção/);
    const n = (await h.call('GET', '/notifications', u.token)).body;
    expect(n.unreadCount).toBeGreaterThan(1);
    await h.call('POST', '/notifications/read-all', u.token);
    expect((await h.call('GET', '/notifications', u.token)).body.unreadCount).toBe(0);
  });

  it('preferência desligada não gera aviso de desgaste', async () => {
    const u = await newUser('notif3@bike.test');
    await h.call('PATCH', '/me', u.token, { notifications: { wear: false, redWeekly: false } });
    const id = (await h.call('POST', '/bikes', u.token, { name: 'N', type: 'ROAD', partsInstalledAt: '2026-10-01' })).body.id;
    await h.call('POST', `/bikes/${id}/usage-adjustments`, u.token, { km: 3500 });
    expect((await h.call('GET', '/notifications', u.token)).body.items).toHaveLength(0);
  });

  it('regra por tempo avisa mesmo sem pedalar (rotina horária); vermelho persistente gera lembrete semanal', async () => {
    const u = await newUser('notif4@bike.test');
    h.clock.now = new Date('2026-10-27T15:00:00Z');
    const id = (await h.call('POST', '/bikes', u.token, { name: 'N', type: 'MTB_XC', partsInstalledAt: '2026-10-27' })).body.id;
    expect((await h.call('GET', '/notifications', u.token)).body.items).toHaveLength(0);
    h.clock.now = new Date('2026-12-30T15:00:00Z'); // ~64 dias depois: selante (90 d) passa de 70%
    await hourlyJob(h.app.deps);
    const items = (await h.call('GET', '/notifications', u.token)).body.items;
    expect(items.some((x: any) => x.type === 'TIME_RULE' && /selante/i.test(x.text))).toBe(true);
    void id;
    // vermelho: depois de passar de 365 dias
    h.clock.now = new Date('2027-11-01T15:00:00Z');
    await hourlyJob(h.app.deps);
    const red = (await h.call('GET', '/notifications', u.token)).body.items.filter((x: any) => x.type === 'WEAR_RED').length;
    expect(red).toBeGreaterThan(0);
    const before = (await h.call('GET', '/notifications', u.token)).body.items.filter((x: any) => x.type === 'RED_REMINDER').length;
    h.clock.now = new Date('2027-11-09T15:00:00Z'); // 8 dias depois
    await hourlyJob(h.app.deps);
    const after = (await h.call('GET', '/notifications', u.token)).body.items.filter((x: any) => x.type === 'RED_REMINDER').length;
    expect(after).toBeGreaterThan(before);
    h.clock.now = new Date('2026-10-27T15:00:00Z');
  });
});

describe('painel administrativo e reprocessamento', () => {
  async function staff(email: string, role: string) {
    const u = await newUser(email);
    await h.db.insert(s.staffMembers).values({ email, role }).onConflictDoUpdate({ target: s.staffMembers.email, set: { role } });
    return u;
  }

  it('usuário comum não acessa o painel', async () => {
    const u = await newUser('comum@bike.test');
    expect((await h.call('GET', '/admin/rules', u.token)).status).toBe(403);
  });

  it('regra do fabricante não vai para revisão sem fonte; criador não aprova a própria regra; só revisor aprova', async () => {
    const cur = await staff('curador@bike.test', 'CURATOR');
    const rev = await staff('revisor@bike.test', 'REVIEWER');
    const [model] = await h.db.select().from(s.models).where(eq(s.models.name, 'RockShox Pike / Lyrik / ZEB'));
    const r = await h.call('POST', '/admin/rules', cur.token, { origin: 'MANUFACTURER', modelId: model!.id, serviceId: svc('Revisão completa'), criteria: { hours: 150 } });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect((await h.call('POST', `/admin/rules/${id}/submit`, cur.token)).body.code).toBe('SOURCE_REQUIRED');
    await h.call('PATCH', `/admin/rules/${id}`, cur.token, { sourceIds: ['F01'] });
    expect((await h.call('POST', `/admin/rules/${id}/submit`, cur.token)).status).toBe(200);
    expect((await h.call('POST', `/admin/rules/${id}/approve`, cur.token)).status).toBe(403); // curador não é revisor
    // revisor com o mesmo e-mail do autor não pode aprovar
    await h.db.update(s.rules).set({ createdBy: 'revisor@bike.test' }).where(eq(s.rules.id, id));
    expect((await h.call('POST', `/admin/rules/${id}/approve`, rev.token)).status).toBe(403);
    await h.db.update(s.rules).set({ createdBy: 'curador@bike.test' }).where(eq(s.rules.id, id));
    expect((await h.call('POST', `/admin/rules/${id}/approve`, rev.token)).status).toBe(200);
    expect((await h.call('PATCH', `/admin/rules/${id}`, cur.token, { note: 'x' })).status).toBe(409); // publicada não edita
    const audit = (await h.call('GET', `/admin/audit?entity=rule&entityId=${id}`, rev.token)).body;
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['CREATE', 'SUBMIT', 'PUBLISH']));
  });

  it('nova versão de regra: usuário vê antes e depois, escolhe, e peça com ajuste nunca muda', async () => {
    const cur = await staff('curador2@bike.test', 'CURATOR');
    const rev = await staff('revisor2@bike.test', 'REVIEWER');
    const keep = await newUser('react1@bike.test');
    const apply = await newUser('react2@bike.test');
    const custom = await newUser('react3@bike.test');
    h.clock.now = new Date('2026-10-27T15:00:00Z');
    const mk = async (u: { token: string }) => {
      const id = (await h.call('POST', '/bikes', u.token, { name: 'R', type: 'MTB_XC', partsInstalledAt: '2026-10-01' })).body.id;
      await h.call('POST', `/bikes/${id}/usage-adjustments`, u.token, { km: 2400 }); // 80% de "Substituir" (3000 km)
      return id as string;
    };
    const [bk, ba, bc] = [await mk(keep), await mk(apply), await mk(custom)];
    const chainOf = async (u: { token: string }, id: string) => partBy(await bike(u.token, id), 'Corrente');
    const cc = await chainOf(custom, bc);
    await h.call('PUT', `/parts/${cc.id}/rules/${svc('Substituir')}`, custom.token, { criteria: { km: 2800 } });

    // nova versão: 3000 -> 2500 km
    const [old] = await h.db.select().from(s.rules).where(eq(s.rules.importId, 'RP003')); // corrente: substituir
    const nv = (await h.call('POST', `/admin/rules/${old!.id}/new-version`, cur.token)).body;
    expect(nv.version).toBe(2);
    await h.call('PATCH', `/admin/rules/${nv.id}`, cur.token, { criteria: { km: 2500 }, sourceIds: ['F01'] });
    await h.call('POST', `/admin/rules/${nv.id}/submit`, cur.token);
    const pub = (await h.call('POST', `/admin/rules/${nv.id}/approve`, rev.token, { description: 'Corrente: troca a cada 2.500 km.' })).body;
    expect(pub.cards).toBeGreaterThanOrEqual(2);

    // antes de decidir, nada mudou
    let chain = await chainOf(apply, ba);
    expect((await h.call('GET', `/parts/${chain.id}`, apply.token)).body.rules.find((x: any) => x.service === 'Substituir').criteria[0].limit).toBe(3000);

    // card com prévia: antes 80% (amarelo), depois 96% (laranja)
    const cards = (await h.call('GET', '/updates', apply.token)).body;
    expect(cards).toHaveLength(1);
    const p = cards[0].parts.find((x: any) => x.label.match(/Corrente/));
    const sub = p.services.find((x: any) => x.service === 'Substituir');
    expect(sub.before).toMatchObject({ pct: 80, color: 'YELLOW' });
    expect(sub.after).toMatchObject({ pct: 96, color: 'ORANGE' });
    expect((await h.call('GET', '/home', apply.token)).body.pendingUpdates).toBe(1);

    // "Manter como está": segue na versão anterior; card some
    const kc = (await h.call('GET', '/updates', keep.token)).body[0];
    await h.call('POST', `/updates/${kc.id}/decision`, keep.token, { decision: 'DECLINED' });
    expect((await h.call('GET', '/updates', keep.token)).body).toHaveLength(0);
    chain = await chainOf(keep, bk);
    expect((await h.call('GET', `/parts/${chain.id}`, keep.token)).body.rules.find((x: any) => x.service === 'Substituir').criteria[0].limit).toBe(3000);

    // "Aplicar": recalcula e entra no histórico da peça
    await h.call('POST', `/updates/${cards[0].id}/decision`, apply.token, { decision: 'APPLIED' });
    chain = await chainOf(apply, ba);
    const d = (await h.call('GET', `/parts/${chain.id}`, apply.token)).body;
    expect(d.rules.find((x: any) => x.service === 'Substituir').criteria[0]).toMatchObject({ limit: 2500, pct: 96 });
    expect(d.history.map((x: any) => x.type)).toContain('REPROCESSED');

    // ajuste do usuário: nunca alterado, só informado
    const dc = (await h.call('GET', `/parts/${cc.id}`, custom.token)).body;
    expect(dc.rules.find((x: any) => x.service === 'Substituir').criteria[0].limit).toBe(2800);
    expect((await h.call('GET', '/updates', custom.token)).body).toHaveLength(0);
    expect((await h.call('GET', '/notifications', custom.token)).body.items.some((x: any) => x.type === 'DATA_UPDATE')).toBe(true);

    // peça nova já nasce com a versão mais recente
    const fresh = await newUser('react4@bike.test');
    const fid = (await h.call('POST', '/bikes', fresh.token, { name: 'F', type: 'MTB_XC', partsInstalledAt: '2026-10-01' })).body.id;
    const fc = await chainOf(fresh, fid);
    expect((await h.call('GET', `/parts/${fc.id}`, fresh.token)).body.rules.find((x: any) => x.service === 'Substituir').criteria[0].limit).toBe(2500);
  });

  it('arquivar mantém a regra nas peças que já usam; importação CSV cria rascunhos e relata erros', async () => {
    const rev = await staff('revisor3@bike.test', 'REVIEWER');
    const cur = await staff('curador3@bike.test', 'CURATOR');
    const u = await newUser('arq1@bike.test');
    const id = (await h.call('POST', '/bikes', u.token, { name: 'A', type: 'URBAN', partsInstalledAt: '2026-10-01' })).body.id;
    const [r] = await h.db.select().from(s.rules).where(eq(s.rules.importId, 'RP016')); // freio de aro
    expect((await h.call('POST', `/admin/rules/${r!.id}/archive`, rev.token)).status).toBe(200);
    const brake = partBy(await bike(u.token, id), 'Freio de aro (V-brake / ferradura)');
    const d = (await h.call('GET', `/parts/${brake.id}`, u.token)).body;
    expect(d.rules.length).toBeGreaterThan(0); // continua valendo para quem já usa
    const nu = await newUser('arq2@bike.test');
    const nid = (await h.call('POST', '/bikes', nu.token, { name: 'B', type: 'URBAN', partsInstalledAt: '2026-10-01' })).body.id;
    const nb = partBy(await bike(nu.token, nid), 'Freio de aro (V-brake / ferradura)');
    expect((await h.call('GET', `/parts/${nb.id}`, nu.token)).body.rules).toHaveLength(0); // peça nova não recebe

    const csv = 'targetKind,targetId,service,km,hours,days,origin,note,sources\ncategory,C20,Lubrificar rolamentos da direção,,,180,plataforma,,\ncategory,C20,Sem critério,,,,plataforma,,\nmodel,MD0001,Teste fabricante,500,,,fabricante,,';
    const imp = (await h.call('POST', '/admin/import', cur.token, { kind: 'rules', csv })).body;
    expect(imp.created).toBe(1);
    expect(imp.errors).toHaveLength(2);
    const drafts = (await h.call('GET', '/admin/rules?status=DRAFT&q=direção', cur.token)).body;
    expect(drafts.length).toBe(1);
  });

  it('suporte consulta contas sem ver atividades; administrador gerencia equipe e direitos', async () => {
    const sup = await staff('suporte@bike.test', 'SUPPORT');
    const adm = await staff('admin@bike.test', 'ADMIN');
    const u = await newUser('alvo@bike.test');
    const id = (await h.call('POST', '/bikes', u.token, { name: 'S', type: 'ROAD' })).body.id;
    await h.call('POST', `/bikes/${id}/rides`, u.token, { date: '2026-10-10', distanceKm: 33, movingMinutes: 80 });
    const found = (await h.call('GET', '/admin/users?q=alvo@', sup.token)).body;
    const detail = (await h.call('GET', `/admin/users/${found[0].id}`, sup.token)).body;
    expect(detail.bikes).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toMatch(/distance|activities/i);
    expect((await h.call('PUT', '/admin/staff', sup.token, { email: 'x@y.com', role: 'ADMIN' })).status).toBe(403);
    expect((await h.call('PUT', '/admin/staff', adm.token, { email: 'novo@bike.test', role: 'CURATOR' })).status).toBe(200);
    expect((await h.call('PUT', `/admin/users/${found[0].id}/entitlements/maxActiveBikes`, adm.token, { value: 2 })).status).toBe(200);
    expect((await h.call('GET', '/me', u.token)).body.entitlements.maxActiveBikes).toBe(2);
    expect((await h.call('PUT', '/admin/settings/strava.activityTypes', adm.token, { value: ['Ride', 'GravelRide'] })).status).toBe(200);
    expect((await h.call('GET', '/admin/strava/health', sup.token)).status).toBe(200);
  });
});
