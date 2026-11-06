import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

/** Compatível com node-postgres (produção) e PGlite (testes). */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

export function createDb(url = process.env.DATABASE_URL): DB {
  if (!url) throw new Error('DATABASE_URL não definido');
  const pool = new pg.Pool({ connectionString: url });
  return drizzlePg(pool, { schema }) as unknown as DB;
}
