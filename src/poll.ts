import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool, q } from './db.js';
import { config } from './config.js';
import { fetchPrizePicks } from './adapters/prizepicks.js';
import { fetchUnderdog } from './adapters/underdog.js';
import { fetchSleeper } from './adapters/sleeper.js';
import { persistProps, getLeagueRefs, saveLeagueRefs } from './store.js';
import type { FetchResult } from './adapters/types.js';

function archive(bookCode: string, raw: unknown) {
  if (!config.archiveRaw || raw === undefined) return;
  try {
    mkdirSync(config.rawDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(config.rawDir, `${bookCode}-${stamp}.json`), JSON.stringify(raw));
  } catch (err) {
    console.warn(`  ! raw archive failed: ${(err as Error).message}`);
  }
}

async function runBook(bookCode: string, fetcher: () => Promise<FetchResult>) {
  const client = await pool.connect();
  const run = await client.query(
    'INSERT INTO poll_run (book_code) VALUES ($1) RETURNING id',
    [bookCode],
  );
  const runId = run.rows[0].id as number;

  try {
    const result = await fetcher();
    archive(bookCode, result.raw);

    if (result.discoveredLeagueIds) {
      await saveLeagueRefs(client, bookCode, result.discoveredLeagueIds);
    }

    const { propsSeen, snapsWritten } = await persistProps(
      client, bookCode, result.props, runId,
    );

    await client.query(
      `UPDATE poll_run SET finished_at = now(), http_status = $2, props_seen = $3,
                           snaps_written = $4, ok = $5
        WHERE id = $1`,
      [runId, result.httpStatus, propsSeen, snapsWritten, propsSeen > 0],
    );
    console.log(
      `  ${bookCode}: HTTP ${result.httpStatus}, ${propsSeen} props, ${snapsWritten} snapshots written`,
    );
    return { propsSeen, snapsWritten };
  } catch (err) {
    const msg = (err as Error).message;
    // A book failing is normal operations, not a crash: record it and let the
    // other book's poll stand on its own.
    await client.query(
      `UPDATE poll_run SET finished_at = now(), ok = false, error = $2 WHERE id = $1`,
      [runId, msg],
    );
    console.error(`  ${bookCode}: FAILED — ${msg}`);
    return { propsSeen: 0, snapsWritten: 0 };
  } finally {
    client.release();
  }
}

/**
 * Close out runs a previous container left open.
 *
 * A redeploy kills the worker mid-poll, and the row it was writing stays
 * unfinished forever. Left alone those look identical to a live failure.
 */
async function closeOrphanedRuns(): Promise<void> {
  const orphans = await q(
    `UPDATE poll_run SET finished_at = now(), ok = false,
            error = 'interrupted — worker restarted mid-poll'
      WHERE finished_at IS NULL AND started_at < now() - interval '10 minutes'
      RETURNING id`,
  );
  if (orphans.length > 0) {
    console.log(`  closed ${orphans.length} poll run(s) orphaned by a restart`);
  }
}

export async function pollOnce() {
  console.log(`[${new Date().toISOString()}] poll start — leagues: ${config.leagues.join(',')}`);
  await closeOrphanedRuns();

  const client = await pool.connect();
  let ppLeagues;
  try {
    ppLeagues = await getLeagueRefs(client, 'prizepicks', config.leagues);
  } finally {
    client.release();
  }

  if (ppLeagues.length === 0) {
    console.warn('  ! no known PrizePicks league ids for the configured leagues');
  }

  await runBook('prizepicks', () => fetchPrizePicks(ppLeagues));
  await runBook('underdog', () => fetchUnderdog(config.leagues));
  await runBook('sleeper', () => fetchSleeper(config.leagues));

  console.log(`[${new Date().toISOString()}] poll done`);
}

// Only self-execute when run directly (`npm run poll`); the cron scheduler
// imports pollOnce instead. pathToFileURL avoids hand-rolling Windows path
// escaping, which is what broke the naive string comparison here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await pollOnce();
  await pool.end();
}
