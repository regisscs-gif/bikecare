/**
 * Inicialização de produção: aplica migrações e, na primeira subida, carrega a biblioteca.
 * Só carrega se a tabela de regras estiver vazia (o seed de regras não é idempotente).
 * SEED_PUBLISH=true publica as regras na hora (beta sem painel admin); sem isso entram como rascunho.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { count } from 'drizzle-orm';
import * as s from './schema';
import { createDb } from './client';
import { loadLibrary, seedLibrary } from './seed-lib';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(drizzle(pool), { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
await pool.end();
console.log('Migrações aplicadas.');

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
