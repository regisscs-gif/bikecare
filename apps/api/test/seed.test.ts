import { describe, expect, it } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { matchRuleTargets } from '../src/db/seed-lib';
import * as s from '../src/db/schema';
import { makeTestDb } from './helpers';

describe('seed da biblioteca', () => {
  it('carrega categorias, modelos, genéricos, fontes e regras da planilha', async () => {
    const { db, report } = await makeTestDb();
    expect(report!.categories).toBe(23);
    expect(report!.manufacturers).toBe(38);
    expect(report!.models).toBe(249 + 23);
    const generics = await db.select().from(s.models).where(eq(s.models.isGeneric, true));
    expect(generics).toHaveLength(23);
    const platform = await db.select().from(s.rules).where(eq(s.rules.origin, 'PLATFORM'));
    expect(platform).toHaveLength(30);
    expect(report!.unmatchedManufacturerRules).toEqual([]);
  });

  it('toda regra do fabricante tem fonte (seção 13)', async () => {
    const { db } = await makeTestDb();
    const maker = await db.select({ id: s.rules.id }).from(s.rules).where(eq(s.rules.origin, 'MANUFACTURER'));
    expect(maker.length).toBeGreaterThan(0);
    const withSource = await db.select({ id: s.ruleSources.ruleId }).from(s.ruleSources);
    const ids = new Set(withSource.map((r) => r.id));
    expect(maker.every((r) => ids.has(r.id))).toBe(true);
  });

  it('regras do fabricante apontam para modelo; da plataforma, para categoria', async () => {
    const { db } = await makeTestDb();
    const bad = await db.select().from(s.rules).where(and(eq(s.rules.origin, 'MANUFACTURER'), isNotNull(s.rules.categoryId)));
    expect(bad.every((r) => r.modelId)).toBe(true);
    const plat = await db.select().from(s.rules).where(eq(s.rules.origin, 'PLATFORM'));
    expect(plat.every((r) => r.categoryId && !r.modelId)).toBe(true);
  });

  it('casa texto de alvo com modelos', () => {
    const models = [
      { id: 'a', name: 'RockShox Pike / Lyrik / ZEB', manufacturerName: 'RockShox', categoryId: 'C16' },
      { id: 'b', name: 'RockShox Judy (Silver TK / Gold RL)', manufacturerName: 'RockShox', categoryId: 'C16' },
      { id: 'c', name: 'SR Suntour XCT / XCM', manufacturerName: 'SR Suntour', categoryId: 'C16' },
    ];
    expect(matchRuleTargets('RockShox — Pike (2014+), Lyrik (2016+), ZEB (2022+), Yari', 'C16', models)).toEqual(['a']);
    expect(matchRuleTargets('RockShox — Judy (2018+), Recon (2016+)', 'C16', models)).toEqual(['b']);
    expect(matchRuleTargets('SR Suntour — garfos (XCT, XCM, XCR)', 'C16', models)).toEqual(['c']);
  });
});
