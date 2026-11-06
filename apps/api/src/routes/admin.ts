import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../db/schema';
import { BIKE_TYPES } from '../db/bike-templates';
import { config } from '../config';
import { HttpError, badRequest, forbidden, notFound, parse } from '../http';
import { archiveRule, publishRules } from '../services/updates';

type Role = 'ADMIN' | 'CURATOR' | 'REVIEWER' | 'SUPPORT';
const criteria = z.object({ km: z.number().positive().nullish(), hours: z.number().positive().nullish(), days: z.number().positive().nullish() });
const hasCriterion = (c: { km?: number | null; hours?: number | null; days?: number | null }) => !!(c.km || c.hours || c.days);

/** Parser CSV mínimo (aspas duplas, vírgula ou ponto e vírgula) para a importação em lote. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  const delim = (text.split('\n')[0] ?? '').includes(';') ? ';' : ',';
  let cur: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); field = '';
      if (cur.some((x) => x.trim())) rows.push(cur);
      cur = [];
    } else field += ch;
  }
  cur.push(field);
  if (cur.some((x) => x.trim())) rows.push(cur);
  const [hdr = [], ...body] = rows;
  const keys = hdr.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export function adminRoutes(api: FastifyInstance) {
  const { db } = api.deps;

  /** Papel da equipe. Os primeiros administradores vêm de ADMIN_EMAILS. */
  async function role(req: FastifyRequest): Promise<{ email: string; role: Role }> {
    const [u] = await db.select().from(s.users).where(eq(s.users.id, req.userId));
    const email = (u?.email ?? '').toLowerCase();
    const [row] = await db.select().from(s.staffMembers).where(eq(s.staffMembers.email, email));
    if (row) return { email, role: row.role as Role };
    if (config.adminEmails.includes(email)) {
      await db.insert(s.staffMembers).values({ email, role: 'ADMIN' }).onConflictDoNothing();
      return { email, role: 'ADMIN' };
    }
    throw forbidden('Acesso restrito à equipe.');
  }
  const need = async (req: FastifyRequest, ...roles: Role[]) => {
    const r = await role(req);
    if (r.role !== 'ADMIN' && !roles.includes(r.role)) throw forbidden('Seu papel não permite esta ação.');
    return r;
  };
  const audit = (actor: string, action: string, entity: string, entityId?: string | null, payload?: unknown) =>
    db.insert(s.auditLog).values({ actor, action, entity, entityId: entityId ?? null, payload: (payload ?? null) as never });

  api.get('/admin/me', async (req) => role(req));

  // ───────── Regras: rascunho -> revisão -> publicada -> arquivada ─────────

  api.get('/admin/rules', async (req) => {
    await need(req, 'CURATOR', 'REVIEWER', 'SUPPORT');
    const q = parse(z.object({ status: z.string().optional(), origin: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const rows = await db.select({ r: s.rules, svc: s.services.name, model: s.models.name }).from(s.rules)
      .innerJoin(s.services, eq(s.rules.serviceId, s.services.id)).leftJoin(s.models, eq(s.rules.modelId, s.models.id))
      .where(and(q.status ? eq(s.rules.status, q.status) : undefined, q.origin ? eq(s.rules.origin, q.origin) : undefined, q.q ? or(ilike(s.services.name, `%${q.q}%`), ilike(s.models.name, `%${q.q}%`)) : undefined))
      .orderBy(desc(s.rules.createdAt)).limit(q.limit);
    const links = rows.length ? await db.select().from(s.ruleSources).where(inArray(s.ruleSources.ruleId, rows.map((x) => x.r.id))) : [];
    return rows.map(({ r, svc, model }) => ({ ...r, service: svc, modelName: model, sourceIds: links.filter((l) => l.ruleId === r.id).map((l) => l.sourceId) }));
  });

  const ruleBody = z.object({
    origin: z.enum(['MANUFACTURER', 'PLATFORM']),
    modelId: z.string().nullish(),
    categoryId: z.string().nullish(),
    serviceId: z.string(),
    criteria,
    note: z.string().max(300).nullish(),
    sourceIds: z.array(z.string()).default([]),
  });

  api.post('/admin/rules', async (req, reply) => {
    const me = await need(req, 'CURATOR');
    const b = parse(ruleBody, req.body);
    if (!hasCriterion(b.criteria)) throw badRequest('Informe ao menos um critério (km, horas ou dias).');
    if (b.origin === 'MANUFACTURER' && !b.modelId) throw badRequest('Regra do fabricante precisa de um modelo específico.');
    if (b.origin === 'PLATFORM' && !b.categoryId) throw badRequest('Regra da plataforma precisa de uma categoria.');
    let categoryId = b.categoryId ?? null;
    if (b.modelId) {
      const [m] = await db.select().from(s.models).where(eq(s.models.id, b.modelId));
      if (!m) throw notFound('Modelo');
      categoryId = m.categoryId;
    }
    const [r] = await db.insert(s.rules).values({
      groupId: crypto.randomUUID(), origin: b.origin, modelId: b.origin === 'MANUFACTURER' ? b.modelId : null, categoryId, serviceId: b.serviceId,
      kmLimit: b.criteria.km ?? null, hoursLimit: b.criteria.hours ?? null, daysLimit: b.criteria.days ?? null, note: b.note ?? null, createdBy: me.email,
    }).returning();
    if (b.sourceIds.length) await db.insert(s.ruleSources).values(b.sourceIds.map((sourceId) => ({ ruleId: r!.id, sourceId })));
    await audit(me.email, 'CREATE', 'rule', r!.id, b);
    return reply.status(201).send({ id: r!.id });
  });

  const getRule = async (id: string) => {
    const [r] = await db.select().from(s.rules).where(eq(s.rules.id, id));
    if (!r) throw notFound('Regra');
    return r;
  };

  api.patch('/admin/rules/:id', async (req) => {
    const me = await need(req, 'CURATOR');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = parse(z.object({ criteria: criteria.optional(), note: z.string().max(300).nullish(), sourceIds: z.array(z.string()).optional() }), req.body);
    const r = await getRule(id);
    if (r.status !== 'DRAFT') throw new HttpError(409, 'NOT_DRAFT', 'Só rascunhos podem ser editados. Para mudar uma regra publicada, crie uma nova versão.');
    if (b.criteria && !hasCriterion(b.criteria)) throw badRequest('Informe ao menos um critério.');
    const set = {
      ...(b.criteria ? { kmLimit: b.criteria.km ?? null, hoursLimit: b.criteria.hours ?? null, daysLimit: b.criteria.days ?? null } : {}),
      ...(b.note !== undefined ? { note: b.note } : {}),
    };
    if (Object.keys(set).length) await db.update(s.rules).set(set).where(eq(s.rules.id, id));
    if (b.sourceIds) {
      await db.delete(s.ruleSources).where(eq(s.ruleSources.ruleId, id));
      if (b.sourceIds.length) await db.insert(s.ruleSources).values(b.sourceIds.map((sourceId) => ({ ruleId: id, sourceId })));
    }
    await audit(me.email, 'UPDATE', 'rule', id, b);
    return { ok: true };
  });

  /** Editar uma regra publicada cria uma nova versão em rascunho; a anterior continua valendo até a nova ser publicada. */
  api.post('/admin/rules/:id/new-version', async (req, reply) => {
    const me = await need(req, 'CURATOR');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const r = await getRule(id);
    if (r.status !== 'PUBLISHED') throw new HttpError(409, 'NOT_PUBLISHED', 'Só regras publicadas ganham nova versão.');
    const open = await db.select().from(s.rules).where(and(eq(s.rules.groupId, r.groupId), inArray(s.rules.status, ['DRAFT', 'REVIEW'])));
    if (open.length) throw new HttpError(409, 'VERSION_OPEN', 'Já existe uma versão em rascunho ou revisão para esta regra.');
    const { id: _id, createdAt: _c, publishedAt: _p, reviewedBy: _r, ...rest } = r;
    const [v] = await db.insert(s.rules).values({ ...rest, version: r.version + 1, status: 'DRAFT', createdBy: me.email }).returning();
    const links = await db.select().from(s.ruleSources).where(eq(s.ruleSources.ruleId, id));
    if (links.length) await db.insert(s.ruleSources).values(links.map((l) => ({ ruleId: v!.id, sourceId: l.sourceId })));
    await audit(me.email, 'NEW_VERSION', 'rule', v!.id, { from: id });
    return reply.status(201).send({ id: v!.id, version: v!.version });
  });

  /** Regra do fabricante não vai para revisão sem fonte. */
  api.post('/admin/rules/:id/submit', async (req) => {
    const me = await need(req, 'CURATOR');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const r = await getRule(id);
    if (r.status !== 'DRAFT') throw new HttpError(409, 'NOT_DRAFT', 'Só rascunhos vão para revisão.');
    if (r.origin === 'MANUFACTURER') {
      const links = await db.select().from(s.ruleSources).where(eq(s.ruleSources.ruleId, id));
      if (!links.length) throw badRequest('Regra com origem Fabricante não pode ir para revisão sem fonte.', 'SOURCE_REQUIRED');
    }
    await db.update(s.rules).set({ status: 'REVIEW' }).where(eq(s.rules.id, id));
    await audit(me.email, 'SUBMIT', 'rule', id);
    return { ok: true };
  });

  api.post('/admin/rules/:id/return', async (req) => {
    const me = await need(req, 'REVIEWER');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { comment } = parse(z.object({ comment: z.string().min(2).max(500) }), req.body);
    const r = await getRule(id);
    if (r.status !== 'REVIEW') throw new HttpError(409, 'NOT_REVIEW', 'A regra não está em revisão.');
    await db.update(s.rules).set({ status: 'DRAFT' }).where(eq(s.rules.id, id));
    await audit(me.email, 'RETURN', 'rule', id, { comment });
    return { ok: true };
  });

  /** Aprovar = publicar. Uma regra não pode ser aprovada por quem a escreveu. */
  api.post('/admin/rules/:id/approve', async (req) => {
    const me = await need(req, 'REVIEWER');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = parse(z.object({ mandatory: z.boolean().default(false), description: z.string().max(300).optional() }), req.body);
    const r = await getRule(id);
    if (r.status !== 'REVIEW') throw new HttpError(409, 'NOT_REVIEW', 'A regra não está em revisão.');
    if (r.createdBy && r.createdBy === me.email) throw forbidden('Uma regra não pode ser aprovada pela mesma pessoa que a escreveu.');
    if (r.origin === 'MANUFACTURER') {
      const links = await db.select().from(s.ruleSources).where(eq(s.ruleSources.ruleId, id));
      if (!links.length) throw badRequest('Regra com origem Fabricante exige fonte.', 'SOURCE_REQUIRED');
    }
    const out = await publishRules(db, [id], { actor: me.email, description: b.description, mandatory: b.mandatory, now: api.deps.now() });
    await audit(me.email, 'PUBLISH', 'rule', id, out);
    return out;
  });

  api.post('/admin/rules/:id/archive', async (req) => {
    const me = await need(req, 'REVIEWER');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const r = await getRule(id);
    if (r.status !== 'PUBLISHED') throw new HttpError(409, 'NOT_PUBLISHED', 'Só regras publicadas podem ser arquivadas.');
    await archiveRule(db, id, me.email);
    await audit(me.email, 'ARCHIVE', 'rule', id);
    return { ok: true };
  });

  // ───────── Fontes, fabricantes, modelos ─────────

  api.get('/admin/sources', async (req) => {
    await need(req, 'CURATOR', 'REVIEWER', 'SUPPORT');
    return db.select().from(s.sources).orderBy(asc(s.sources.id));
  });

  api.post('/admin/sources', async (req, reply) => {
    const me = await need(req, 'CURATOR');
    const b = parse(z.object({
      id: z.string().min(2).max(20), type: z.enum(['MANUAL', 'SITE', 'BULLETIN', 'OTHER']), title: z.string().min(2).max(300),
      url: z.string().url().nullish(), filePath: z.string().nullish(), page: z.string().nullish(), consultedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).refine((x) => x.url || x.filePath, 'Informe o link ou o arquivo da fonte.'), req.body);
    await db.insert(s.sources).values({ ...b, url: b.url ?? null, filePath: b.filePath ?? null, page: b.page ?? null, consultedAt: new Date(`${b.consultedAt}T12:00:00Z`) });
    await audit(me.email, 'CREATE', 'source', b.id);
    return reply.status(201).send({ id: b.id });
  });

  api.post('/admin/manufacturers', async (req, reply) => {
    const me = await need(req, 'CURATOR');
    const b = parse(z.object({ name: z.string().min(1).max(80), site: z.string().url().nullish() }), req.body);
    const id = `FB${String(Date.now()).slice(-6)}`;
    await db.insert(s.manufacturers).values({ id, name: b.name, site: b.site ?? null });
    await audit(me.email, 'CREATE', 'manufacturer', id, b);
    return reply.status(201).send({ id });
  });

  api.post('/admin/models', async (req, reply) => {
    const me = await need(req, 'CURATOR');
    const b = parse(z.object({ manufacturerId: z.string(), categoryId: z.string(), name: z.string().min(1).max(120), code: z.string().nullish(), segment: z.string().nullish() }), req.body);
    const id = `MD${String(Date.now()).slice(-7)}`;
    await db.insert(s.models).values({ id, manufacturerId: b.manufacturerId, categoryId: b.categoryId, name: b.name, code: b.code ?? null, segment: b.segment ?? null });
    await audit(me.email, 'CREATE', 'model', id, b);
    return reply.status(201).send({ id });
  });

  // ───────── Sugestões de modelo dos usuários ─────────

  api.get('/admin/suggestions', async (req) => {
    await need(req, 'CURATOR', 'REVIEWER');
    const { status } = parse(z.object({ status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']).default('PENDING') }), req.query);
    return db.select().from(s.modelSuggestions).where(eq(s.modelSuggestions.status, status)).orderBy(asc(s.modelSuggestions.createdAt));
  });

  /** Aceitar vira modelo da biblioteca (fabricante existente ou novo). */
  api.post('/admin/suggestions/:id/accept', async (req) => {
    const me = await need(req, 'CURATOR');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const b = parse(z.object({ manufacturerId: z.string().optional(), name: z.string().optional() }), req.body);
    const [sug] = await db.select().from(s.modelSuggestions).where(eq(s.modelSuggestions.id, id));
    if (!sug) throw notFound('Sugestão');
    if (sug.status !== 'PENDING') throw new HttpError(409, 'DECIDED', 'Sugestão já decidida.');
    let makerId = b.manufacturerId;
    if (!makerId) {
      const [m] = await db.select().from(s.manufacturers).where(ilike(s.manufacturers.name, sug.manufacturer));
      makerId = m?.id;
      if (!makerId) {
        makerId = `FB${String(Date.now()).slice(-6)}`;
        await db.insert(s.manufacturers).values({ id: makerId, name: sug.manufacturer });
      }
    }
    const modelId = `MD${String(Date.now()).slice(-7)}`;
    await db.insert(s.models).values({ id: modelId, manufacturerId: makerId, categoryId: sug.categoryId, name: b.name ?? sug.name });
    await db.update(s.modelSuggestions).set({ status: 'ACCEPTED' }).where(eq(s.modelSuggestions.id, id));
    await audit(me.email, 'ACCEPT', 'suggestion', id, { modelId });
    return { modelId };
  });

  api.post('/admin/suggestions/:id/reject', async (req) => {
    const me = await need(req, 'CURATOR');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await db.update(s.modelSuggestions).set({ status: 'REJECTED' }).where(eq(s.modelSuggestions.id, id));
    await audit(me.email, 'REJECT', 'suggestion', id);
    return { ok: true };
  });

  // ───────── Importação em lote (CSV) ─────────

  /**
   * kind=manufacturers: id?,name,site?
   * kind=models: id?,manufacturer,category (id),name,code?,segment?
   * kind=rules: targetKind(model|category),targetId,service,km?,hours?,days?,origin,note?,sources? (ids com ;)
   * Regras entram sempre como Rascunho e passam pela revisão.
   */
  api.post('/admin/import', async (req) => {
    const me = await need(req, 'CURATOR');
    const { kind, csv } = parse(z.object({ kind: z.enum(['manufacturers', 'models', 'rules']), csv: z.string().min(5) }), req.body);
    const rows = parseCsv(csv);
    const errors: string[] = [];
    let created = 0;
    const num = (v?: string) => (v && Number(v.replace(',', '.')) > 0 ? Number(v.replace(',', '.')) : null);

    if (kind === 'manufacturers') {
      for (const [i, r] of rows.entries()) {
        if (!r.name) { errors.push(`linha ${i + 2}: nome vazio`); continue; }
        await db.insert(s.manufacturers).values({ id: r.id || `FB${Date.now().toString().slice(-6)}${i}`, name: r.name, site: r.site || null }).onConflictDoNothing();
        created++;
      }
    } else if (kind === 'models') {
      const makers = await db.select().from(s.manufacturers);
      for (const [i, r] of rows.entries()) {
        const mk = makers.find((m) => m.name.toLowerCase() === (r.manufacturer ?? '').toLowerCase());
        if (!mk) { errors.push(`linha ${i + 2}: fabricante "${r.manufacturer}" não existe`); continue; }
        if (!r.category || !r.name) { errors.push(`linha ${i + 2}: categoria e nome são obrigatórios`); continue; }
        await db.insert(s.models).values({ id: r.id || `MD${Date.now().toString().slice(-7)}${i}`, manufacturerId: mk.id, categoryId: r.category, name: r.name, code: r.code || null, segment: r.segment || null }).onConflictDoNothing();
        created++;
      }
    } else {
      const svcs = await db.select().from(s.services);
      for (const [i, r] of rows.entries()) {
        const where = `linha ${i + 2}`;
        const origin = (r.origin ?? '').toUpperCase() === 'FABRICANTE' || (r.origin ?? '').toUpperCase() === 'MANUFACTURER' ? 'MANUFACTURER' : 'PLATFORM';
        const km = num(r.km), hours = num(r.hours), days = num(r.days);
        if (!km && !hours && !days) { errors.push(`${where}: sem critério`); continue; }
        const sources = (r.sources ?? '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
        if (origin === 'MANUFACTURER' && !sources.length) { errors.push(`${where}: regra do fabricante precisa de fonte`); continue; }
        let svc = svcs.find((x) => x.name.toLowerCase() === (r.service ?? '').toLowerCase() && !x.ownerUserId);
        if (!svc) {
          [svc] = await db.insert(s.services).values({ name: r.service!, lifetime: /^substituir/i.test(r.service ?? '') }).returning();
          svcs.push(svc!);
        }
        let modelId: string | null = null, categoryId: string | null = null;
        if (r.targetKind === 'model') {
          const [m] = await db.select().from(s.models).where(eq(s.models.id, r.targetId ?? ''));
          if (!m) { errors.push(`${where}: modelo "${r.targetId}" não existe`); continue; }
          modelId = m.id; categoryId = m.categoryId;
        } else categoryId = r.targetId ?? null;
        const [rule] = await db.insert(s.rules).values({ groupId: crypto.randomUUID(), origin, modelId, categoryId, serviceId: svc!.id, kmLimit: km, hoursLimit: hours, daysLimit: days, note: r.note || null, createdBy: me.email }).returning();
        if (sources.length) await db.insert(s.ruleSources).values(sources.map((sourceId) => ({ ruleId: rule!.id, sourceId }))).onConflictDoNothing();
        created++;
      }
    }
    await audit(me.email, 'IMPORT', kind, null, { created, errors: errors.length });
    return { created, errors };
  });

  // ───────── Tipos de bike, configuração, planos ─────────

  /** Posições sugeridas para cada tipo de bike. */
  api.put('/admin/bike-types/:type', async (req) => {
    const me = await need(req, 'CURATOR');
    const { type } = parse(z.object({ type: z.enum(BIKE_TYPES as [string, ...string[]]) }), req.params);
    const { positions } = parse(z.object({ positions: z.array(z.object({ categoryId: z.string(), name: z.string().min(1).max(80) })).min(1) }), req.body);
    await db.delete(s.bikeTypeTemplates).where(eq(s.bikeTypeTemplates.bikeType, type));
    await db.insert(s.bikeTypeTemplates).values(positions.map((p, sortOrder) => ({ bikeType: type, ...p, sortOrder })));
    await audit(me.email, 'UPDATE', 'bike-type', type, { count: positions.length });
    return { ok: true };
  });

  api.put('/admin/settings/:key', async (req) => {
    const me = await need(req);
    const { key } = parse(z.object({ key: z.enum(['strava.activityTypes']) }), req.params);
    const { value } = parse(z.object({ value: z.array(z.string().min(2)).min(1) }), req.body);
    await db.insert(s.appSettings).values({ key, value }).onConflictDoUpdate({ target: s.appSettings.key, set: { value } });
    await audit(me.email, 'UPDATE', 'setting', key, value);
    return { ok: true };
  });

  api.put('/admin/plans/:planId/entitlements/:key', async (req) => {
    const me = await need(req);
    const { planId, key } = parse(z.object({ planId: z.string(), key: z.string() }), req.params);
    const { value } = parse(z.object({ value: z.union([z.boolean(), z.number(), z.string()]) }), req.body);
    await db.insert(s.entitlements).values({ planId, key, value }).onConflictDoUpdate({ target: [s.entitlements.planId, s.entitlements.key], set: { value } });
    await audit(me.email, 'UPDATE', 'entitlement', `${planId}:${key}`, { value });
    return { ok: true };
  });

  /** Direito para um usuário específico (ex.: testadores). */
  api.put('/admin/users/:id/entitlements/:key', async (req) => {
    const me = await need(req);
    const { id, key } = parse(z.object({ id: z.string(), key: z.string() }), req.params);
    const { value } = parse(z.object({ value: z.union([z.boolean(), z.number(), z.string()]) }), req.body);
    await db.insert(s.userEntitlements).values({ userId: id, key, value }).onConflictDoUpdate({ target: [s.userEntitlements.userId, s.userEntitlements.key], set: { value } });
    await audit(me.email, 'UPDATE', 'user-entitlement', `${id}:${key}`, { value });
    return { ok: true };
  });

  // ───────── Usuários (sem atividades individuais: os termos do Strava só permitem exibir ao próprio usuário) ─────────

  api.get('/admin/users', async (req) => {
    await need(req, 'SUPPORT');
    const { q } = parse(z.object({ q: z.string().min(2) }), req.query);
    const users = await db.select().from(s.users).where(or(ilike(s.users.email, `%${q}%`), ilike(s.users.name, `%${q}%`))).limit(30);
    return users.map((u) => ({ id: u.id, name: u.name, email: u.email, plan: u.planId, createdAt: u.createdAt }));
  });

  api.get('/admin/users/:id', async (req) => {
    await need(req, 'SUPPORT');
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const [u] = await db.select().from(s.users).where(eq(s.users.id, id));
    if (!u) throw notFound('Usuário');
    const bikes = await db.select().from(s.bikes).where(eq(s.bikes.userId, id));
    const parts = await db.select().from(s.parts).where(eq(s.parts.userId, id));
    const [strava] = await db.select().from(s.stravaConnections).where(eq(s.stravaConnections.userId, id));
    return {
      user: { id: u.id, name: u.name, email: u.email, plan: u.planId, createdAt: u.createdAt, termsVersion: u.termsVersion },
      bikes: bikes.map((b) => ({ id: b.id, name: b.name, type: b.type, status: b.status, stravaLinked: !!b.stravaGearId })),
      parts: parts.map((p) => ({ id: p.id, categoryId: p.categoryId, modelId: p.modelId, status: p.status })),
      strava: strava ? { status: strava.status, lastSyncAt: strava.lastSyncAt } : null,
    };
  });

  /** Saúde da integração Strava: fila pendente e falhas. */
  api.get('/admin/strava/health', async (req) => {
    await need(req, 'SUPPORT');
    const jobs = await db.select().from(s.stravaJobs);
    const conns = await db.select().from(s.stravaConnections);
    return {
      connections: { total: conns.length, ok: conns.filter((c) => c.status === 'OK').length, error: conns.filter((c) => c.status === 'ERROR').length },
      jobs: { pending: jobs.filter((j) => j.status === 'PENDING').length, failed: jobs.filter((j) => j.status === 'FAILED').length, done: jobs.filter((j) => j.status === 'DONE').length },
      lastErrors: jobs.filter((j) => j.lastError).slice(-5).map((j) => ({ kind: j.kind, error: j.lastError, attempts: j.attempts })),
    };
  });

  // ───────── Equipe e auditoria ─────────

  api.get('/admin/staff', async (req) => { await need(req); return db.select().from(s.staffMembers); });

  api.put('/admin/staff', async (req) => {
    const me = await need(req);
    const b = parse(z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'CURATOR', 'REVIEWER', 'SUPPORT']) }), req.body);
    const email = b.email.toLowerCase();
    await db.insert(s.staffMembers).values({ email, role: b.role }).onConflictDoUpdate({ target: s.staffMembers.email, set: { role: b.role } });
    await audit(me.email, 'UPDATE', 'staff', email, { role: b.role });
    return { ok: true };
  });

  api.delete('/admin/staff/:email', async (req, reply) => {
    const me = await need(req);
    const { email } = parse(z.object({ email: z.string() }), req.params);
    await db.delete(s.staffMembers).where(eq(s.staffMembers.email, email.toLowerCase()));
    await audit(me.email, 'DELETE', 'staff', email);
    return reply.status(204).send();
  });

  api.get('/admin/audit', async (req) => {
    await need(req, 'REVIEWER');
    const q = parse(z.object({ entity: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return db.select().from(s.auditLog).where(and(q.entity ? eq(s.auditLog.entity, q.entity) : undefined, q.entityId ? eq(s.auditLog.entityId, q.entityId) : undefined)).orderBy(desc(s.auditLog.createdAt)).limit(q.limit);
  });
}
