import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { DB } from './client';
import { BIKE_TEMPLATES, BIKE_TYPES } from './bike-templates';
import * as s from './schema';

type Row = Record<string, any>;
export interface Library {
  Categorias: Row[]; Fabricantes: Row[]; Modelos: Row[]; Genericos: Row[];
  Regras_Fabricante: Row[]; Regras_Plataforma: Row[]; Fontes: Row[];
}

export const loadLibrary = (path: string): Library => JSON.parse(readFileSync(path, 'utf8'));

const norm = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);
const wearsIndoor = (v: string) => (v.startsWith('Sim') ? 'YES' : v.startsWith('Não se aplica') ? 'NA' : 'NO');

function parseDate(v: string): Date {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  return m ? new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!, 12)) : new Date(v);
}

/** "Stan's" casa com "Stan's NoTubes": um nome começa com o outro. */
const sameMaker = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ');
};

/** Separa por vírgula só no nível de fora dos parênteses. */
function topLevelSplit(text: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * "RockShox — Pike (2014+), Lyrik (2016+), ZEB (2022+)" -> modelos da biblioteca do mesmo fabricante e categoria
 * cujo nome contém algum dos termos. Sem nenhum termo reconhecido, vale para todos os modelos do fabricante na categoria.
 */
export function matchRuleTargets(target: string, categoryId: string, models: Array<{ id: string; name: string; manufacturerName: string | null; categoryId: string }>): string[] {
  const [maker = '', rest = ''] = target.split(' — ');
  const pool = models.filter((m) => m.categoryId === categoryId && m.manufacturerName && sameMaker(m.manufacturerName, maker.trim()));
  const terms = topLevelSplit(rest).map((t) => norm(t.replace(/\(.*?\)/g, '').trim())).filter((t) => t.length >= 2);
  const hits = pool.filter((m) => terms.some((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(norm(m.name))));
  return (hits.length ? hits : pool).map((m) => m.id);
}

export interface SeedOptions {
  /** Regras entram como PUBLISHED (dev/testes). Em produção entram como DRAFT para revisão (seção 13). */
  publishRules?: boolean;
}

export interface SeedReport {
  categories: number; manufacturers: number; models: number; rules: number; unmatchedManufacturerRules: string[];
}

export async function seedLibrary(db: DB, lib: Library, opts: SeedOptions = {}): Promise<SeedReport> {
  const status = opts.publishRules ? 'PUBLISHED' : 'DRAFT';
  const publishedAt = opts.publishRules ? new Date() : null;

  // Planos e direitos (seção 15): tudo vem de configuração
  await db.insert(s.plans).values([{ id: 'free', name: 'Gratuito' }, { id: 'premium', name: 'Premium' }]).onConflictDoNothing();
  await db.insert(s.entitlements).values([
    { planId: 'free', key: 'maxActiveBikes', value: 'unlimited' },
    { planId: 'free', key: 'advancedHistory', value: false },
    { planId: 'free', key: 'reports', value: false },
    { planId: 'free', key: 'aiAssistant', value: false },
  ]).onConflictDoNothing();

  // Categorias
  await db.insert(s.categories).values(lib.Categorias.map((c, i) => ({
    id: c.ID, name: c.Categoria, wearsIndoorDefault: wearsIndoor(String(c['Desgasta no rolo (padrão)'] ?? '')),
    typicalCriterion: c['Critério típico'] ?? null, bikeTypesNote: c['Tipos de bike'] ?? null, sortOrder: i,
  }))).onConflictDoNothing();

  // Serviços: união dos aplicáveis por categoria e dos usados em regras
  const svcNames = new Set<string>();
  const catSvc: Array<[string, string]> = [];
  for (const c of lib.Categorias) {
    for (const name of String(c['Serviços aplicáveis'] ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
      svcNames.add(name); catSvc.push([c.ID, name]);
    }
  }
  for (const r of [...lib.Regras_Fabricante, ...lib.Regras_Plataforma]) {
    svcNames.add(r['Serviço']); catSvc.push([r['ID categoria'], r['Serviço']]);
  }
  await db.insert(s.services).values([...svcNames].map((name) => ({ name, lifetime: /^substituir/i.test(name) }))).onConflictDoNothing();
  const svcRows = await db.select().from(s.services);
  const svcId = new Map(svcRows.map((r) => [r.name, r.id]));
  const uniqCatSvc = [...new Map(catSvc.map(([c, n]) => [`${c}|${n}`, { categoryId: c, serviceId: svcId.get(n)! }])).values()];
  await db.insert(s.categoryServices).values(uniqCatSvc).onConflictDoNothing();

  // Fabricantes e modelos
  await db.insert(s.manufacturers).values(lib.Fabricantes.map((f) => ({ id: f.ID, name: f.Fabricante }))).onConflictDoNothing();
  const makerName = new Map(lib.Fabricantes.map((f) => [f.ID, f.Fabricante as string]));
  await db.insert(s.models).values(lib.Modelos.map((m) => ({
    id: m.ID, manufacturerId: m['ID fabricante'] ?? null, categoryId: m['ID categoria'], name: m['Modelo / linha'],
    code: m['Código / medida'] ?? null, speeds: m.Velocidades ?? null, segment: m.Segmento ?? null,
    bikeTypes: m['Tipo de bike'] ?? null, priorityBR: m['Prioridade BR'] ?? null, evidence: m['Evidência'] ?? null,
  }))).onConflictDoNothing();
  // Genérico por categoria é obrigatório na biblioteca
  await db.insert(s.models).values(lib.Genericos.map((g) => ({
    id: g.ID, manufacturerId: null, categoryId: g['ID categoria'], name: g['Nome exibido'], isGeneric: true,
  }))).onConflictDoNothing();

  // Fontes
  await db.insert(s.sources).values(lib.Fontes.map((f) => ({
    id: f.ID, type: f.Tipo, title: f['Título'], url: f.Link ?? null, consultedAt: parseDate(String(f['Data de consulta'])),
  }))).onConflictDoNothing();

  // Regras da plataforma (alvo: categoria)
  let ruleCount = 0;
  for (const r of lib.Regras_Plataforma) {
    const groupId = crypto.randomUUID();
    await db.insert(s.rules).values({
      groupId, status, origin: 'PLATFORM', categoryId: r['ID categoria'], serviceId: svcId.get(r['Serviço'])!,
      kmLimit: num(r['Limite km']), hoursLimit: num(r['Limite horas']), daysLimit: num(r['Limite dias']),
      note: r['Observação'] ?? null, confidence: r['Situação'] ?? null, importId: r.ID, publishedAt,
    });
    ruleCount++;
  }

  // Regras do fabricante (alvo: modelos que casam com o texto)
  const modelRows = lib.Modelos.map((m) => ({
    id: m.ID as string, name: m['Modelo / linha'] as string, categoryId: m['ID categoria'] as string,
    manufacturerName: makerName.get(m['ID fabricante']) ?? null,
  }));
  const unmatched: string[] = [];
  for (const r of lib.Regras_Fabricante) {
    const targets = matchRuleTargets(r['Alvo (fabricante e modelos)'], r['ID categoria'], modelRows);
    if (!targets.length) { unmatched.push(`${r.ID}: ${r['Alvo (fabricante e modelos)']}`); continue; }
    const groupBase = crypto.randomUUID();
    const sourceIds = String(r['Fonte(s)'] ?? '').split(';').map((x) => x.trim()).filter(Boolean);
    for (const modelId of targets) {
      const [row] = await db.insert(s.rules).values({
        groupId: `${groupBase}:${modelId}`, status, origin: 'MANUFACTURER', modelId, categoryId: r['ID categoria'],
        serviceId: svcId.get(r['Serviço'])!, kmLimit: num(r['Limite km']), hoursLimit: num(r['Limite horas']),
        daysLimit: num(r['Limite dias']), note: r['Observação'] ?? null, confidence: r['Confiança'] ?? null,
        importId: r.ID, publishedAt,
      }).returning({ id: s.rules.id });
      if (sourceIds.length) {
        await db.insert(s.ruleSources).values(sourceIds.map((sourceId) => ({ ruleId: row!.id, sourceId }))).onConflictDoNothing();
      }
      ruleCount++;
    }
  }

  // Posições sugeridas por tipo de bike
  const have = await db.select({ n: sql<number>`count(*)::int` }).from(s.bikeTypeTemplates);
  if (!have[0]?.n) {
    const rows = BIKE_TYPES.flatMap((bikeType) => BIKE_TEMPLATES[bikeType].map(([categoryId, name], sortOrder) => ({ bikeType, categoryId, name, sortOrder })));
    await db.insert(s.bikeTypeTemplates).values(rows);
  }

  return {
    categories: lib.Categorias.length, manufacturers: lib.Fabricantes.length, models: lib.Modelos.length + lib.Genericos.length,
    rules: ruleCount, unmatchedManufacturerRules: unmatched,
  };
}
