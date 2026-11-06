import pg from 'pg';

/**
 * Pool único para API e bootstrap. Bancos hospedados (Neon, Supabase) exigem TLS;
 * o certificado vem de uma cadeia que o Node não conhece, então aceitamos o certificado do servidor.
 * Local (localhost/127.0.0.1) fica sem TLS. DATABASE_SSL=false/true força o comportamento.
 */
export function createPool(url: string): pg.Pool {
  const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url);
  const forced = process.env.DATABASE_SSL;
  const useSsl = forced ? forced === 'true' : !local;
  // sslmode=... na URL sobrescreve o objeto ssl no pg: removemos e controlamos por aqui.
  const clean = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const pool = new pg.Pool({ connectionString: clean, ssl: useSsl ? { rejectUnauthorized: false } : undefined, max: 10, idleTimeoutMillis: 30_000 });
  // Bancos serverless (Neon) derrubam conexões ociosas; sem este handler o erro derrubaria o processo.
  pool.on('error', (err) => console.warn('Conexão ociosa encerrada pelo banco:', err.message));
  return pool;
}
