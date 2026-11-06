/**
 * Inicialização de produção: aplica migrações e, na primeira subida, carrega a biblioteca.
 * Só carrega se a tabela de regras estiver vazia (o seed de regras não é idempotente).
 * SEED_PUBLISH=true publica as regras na hora (beta sem painel admin); sem isso entram como rascunho.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPool } from './pool';
import { count } from 'drizzle-orm';
import * as s from './schema';
import { createDb } from './client';
import { loadLibrary, seedLibrary } from './seed-lib';

const pool = createPool(process.env.DATABASE_URL!);
await migrate(drizzle(pool), { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
console.log('Migrações aplicadas.');

// Supabase expõe as tabelas do schema public por uma API REST pública (chave anon).
// Com RLS ligado e sem políticas, essa API não enxerga nada; a nossa API conecta como dono do banco e não é afetada.
if (process.env.ENABLE_RLS === 'true') {
  const { rows } = await pool.query("select tablename from pg_tables where schemaname = 'public'");
  for (const r of rows) await pool.query(`alter table "public"."${r.tablename}" enable row level security`);
  console.log(`RLS ativado em ${rows.length} tabelas.`);
}
await pool.end();

if (process.env.SEED_ON_START === 'true') {
  const db = createDb();
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(s.rules);
  if (n === 0) {
    const file = new URL('../../seed/biblioteca_v1.json', import.meta.url).pathname;
    const report = await seedLibrary(db, loadLibrary(file), { publishRules: process.env.SEED_PUBLISH === 'true' });
    console.log('Biblioteca carregada.', report);
  } else {
    console.log('Biblioteca já carregada; seed ignorado.');
  }
}
process.exit(0);
