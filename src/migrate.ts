import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './db.js';

const dir = 'db';
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = await pool.connect();
try {
  for (const f of files) {
    process.stdout.write(`applying ${f} ... `);
    await client.query(readFileSync(join(dir, f), 'utf8'));
    console.log('ok');
  }
} finally {
  client.release();
  await pool.end();
}
