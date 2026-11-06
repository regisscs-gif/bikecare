import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPool } from './pool';

const pool = createPool(process.env.DATABASE_URL!);
await migrate(drizzle(pool), { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
await pool.end();
console.log('Migrações aplicadas.');
