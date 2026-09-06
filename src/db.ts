import pg from 'pg';
import { config } from './config.js';

// PrizePicks line values are decimals; pg returns NUMERIC as string by default.
// Parse them as floats so downstream maths doesn't silently concatenate.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/**
 * Managed Postgres (Railway, Render, Neon) terminates TLS with a certificate
 * chain node doesn't trust by default, so a plain connection string fails with
 * "self-signed certificate". Railway's *private* network (.railway.internal)
 * doesn't use TLS at all. Detect rather than make the operator debug it.
 */
function sslConfig() {
  if (process.env.DATABASE_SSL === 'false') return false;
  const url = config.databaseUrl;
  const isLocal = /@(localhost|127\.0\.0\.1|db|postgres)[:/]/.test(url);
  const isPrivate = /\.railway\.internal/.test(url) || /\.internal[:/]/.test(url);
  if (isLocal || isPrivate) return false;
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  ssl: sslConfig(),
});

pool.on('error', (err) => {
  // A managed provider will drop idle connections; don't let that kill the worker.
  console.error('pg pool error:', err.message);
});

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
