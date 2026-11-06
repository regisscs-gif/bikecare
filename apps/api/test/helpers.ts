import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { DB } from '../src/db/client';
import * as schema from '../src/db/schema';
import { loadLibrary, seedLibrary } from '../src/db/seed-lib';

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Postgres real em memória (PGlite) com migrações e biblioteca carregadas. */
export async function makeTestDb(opts: { seed?: boolean } = { seed: true }) {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as any, { migrationsFolder: root('../drizzle') });
  const report = opts.seed === false ? null : await seedLibrary(db, loadLibrary(root('../seed/biblioteca_v1.json')), { publishRules: true });
  return { db, client, report };
}
