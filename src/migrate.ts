import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from './db.js';

/**
 * Migrations run on boot, so they must be applied exactly once and never
 * re-run.
 *
 * Re-running them is not harmless: 002 appends a column to a view that 001
 * creates, so replaying 001 afterwards fails with "cannot drop columns from
 * view" and crash-loops the container on every redeploy. A ledger is the fix —
 * `IF NOT EXISTS` guards alone can't express "this file already ran".
 *
 * Each file is applied inside a transaction together with its ledger row, so a
 * migration that fails partway leaves neither schema changes nor a ledger entry
 * claiming it succeeded.
 */
export async function migrate(dir = 'db'): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );

    // One-time adoption path: a database built before this ledger existed
    // already has the schema but no record of it, and replaying 001 against it
    // fails. If the schema is present and the ledger is empty, treat what's on
    // disk now as the baseline. A genuinely fresh database has no `prop` table
    // and falls through to a normal first run.
    if (applied.size === 0) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT to_regclass('public.prop') IS NOT NULL AS exists`,
      );
      if (rows[0]?.exists) {
        for (const f of files) {
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
          applied.add(f);
        }
        console.log(`baseline: pre-existing schema adopted, marked ${files.length} migration(s) as applied`);
      }
    }

    let ran = 0;
    for (const f of files) {
      if (applied.has(f)) {
        console.log(`skip    ${f} (already applied)`);
        continue;
      }
      process.stdout.write(`apply   ${f} ... `);
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log('ok');
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('FAILED');
        throw err;
      }
    }
    console.log(`migrations: ${ran} applied, ${files.length - ran} already current`);
  } finally {
    client.release();
  }
}

// Standalone `npm run db:migrate` closes the pool; when imported by main.ts the
// process carries on using it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate();
  await pool.end();
}
