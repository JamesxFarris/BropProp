import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { fetchBo3 } from './bo3.js';
import { storeStats } from './store_stats.js';

/**
 * A deep CS2 backfill that survives deploys — by resuming, not by persisting.
 *
 * Nothing running inside the container outlives a deploy; Railway replaces the
 * container outright. So the job is cut into dated windows, each recorded in
 * `backfill_chunk` once it finishes. A restart skips every window already
 * done and picks up at the first that isn't, which costs at most one chunk
 * rather than the whole walk.
 *
 * Two runs:
 *
 *   npm run bo3:resume            # 730 days, 30-day chunks
 *   npm run bo3:resume 365 14     # 365 days, 14-day chunks
 *
 * and on boot, whenever `BACKFILL_DAYS` is set — which is the point. Nobody
 * has to remember to relaunch it after shipping.
 *
 * **Chunks go newest-first.** The recent end is what the board prices, so if
 * the job is interrupted forever it will still have done the useful part. The
 * consequence is that the oldest date in `map_stat` does not move until the
 * whole window is walked, which looks like a stall and is not.
 *
 * **A completed chunk is never revisited**, even if it wrote nothing. An empty
 * window is a real answer — bo3.gg's archive thins out going back, and about
 * 18-85% of maps by month were ever parsed. Re-walking those to find nothing
 * again is how the old version spent its afternoons.
 */

const SOURCE = 'bo3';
const LEAGUE = 'CS2';

/** Default depth and granularity. 30 days is ~20 minutes of work per chunk. */
const DEFAULT_DAYS = 730;
const DEFAULT_CHUNK_DAYS = 30;

const iso = (d: Date) => d.toISOString().slice(0, 10);

export type Chunk = { since: string; until: string };

/**
 * The windows covering `days` back from today, newest first.
 *
 * Exported for the tests: boundaries have to tile exactly, with no gap and no
 * overlap, or a backfill silently skips a day at every seam.
 */
export function chunksFor(days: number, chunkDays: number, now = Date.now()): Chunk[] {
  const out: Chunk[] = [];
  for (let end = 0; end < days; end += chunkDays) {
    const start = Math.min(end + chunkDays, days);
    out.push({
      since: iso(new Date(now - start * 864e5)),
      until: iso(new Date(now - end * 864e5)),
    });
  }
  return out;
}

async function completed(): Promise<Set<string>> {
  const rows = await q<{ since: string; until: string }>(
    `SELECT to_char(since, 'YYYY-MM-DD') AS since, to_char(until, 'YYYY-MM-DD') AS until
       FROM backfill_chunk WHERE source = $1 AND league = $2`,
    [SOURCE, LEAGUE],
  );
  return new Set(rows.map((r) => `${r.since}|${r.until}`));
}

/**
 * Walk every window not yet recorded as done.
 *
 * `shouldStop` lets the caller cut a run short between chunks — the boot-time
 * job uses it so a shutdown does not have to wait out a chunk. It is checked
 * only at boundaries, because stopping mid-chunk would record nothing and
 * throw the chunk's work away.
 */
export async function resumeBackfill(opts: {
  days?: number;
  chunkDays?: number;
  shouldStop?: () => boolean;
} = {}): Promise<{ ran: number; skipped: number; written: number }> {
  const days = opts.days ?? DEFAULT_DAYS;
  const chunkDays = opts.chunkDays ?? DEFAULT_CHUNK_DAYS;
  const chunks = chunksFor(days, chunkDays);
  const done = await completed();

  let ran = 0, skipped = 0, written = 0;
  console.log(
    `backfill: ${chunks.length} windows of ${chunkDays}d over ${days}d — ` +
    `${done.size} already done`);

  for (const c of chunks) {
    if (done.has(`${c.since}|${c.until}`)) { skipped++; continue; }
    if (opts.shouldStop?.()) {
      console.log('backfill: stopping between chunks as asked');
      break;
    }

    const started = Date.now();
    // Generous per-window cap: a 30-day CS2 window is ~800 matches against the
    // ~27 a day the archive actually holds, so this never binds and never
    // silently truncates the way the flat 20,000 did over two years.
    const { stats } = await fetchBo3({
      since: c.since,
      until: c.until,
      maxMatches: Math.max(2000, chunkDays * 60),
      sink: storeStats,
    });
    const rows = stats.length;
    written += rows;
    ran++;

    await q(
      `INSERT INTO backfill_chunk (source, league, since, until, maps, written)
       VALUES ($1, $2, $3::date, $4::date, $5, $6)
       ON CONFLICT (source, league, since, until) DO UPDATE
         SET completed_at = now(), maps = EXCLUDED.maps, written = EXCLUDED.written`,
      [SOURCE, LEAGUE, c.since, c.until, rows, rows],
    );

    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(
      `backfill: ${c.since} → ${c.until} done — ${rows} stat lines, ${mins}m ` +
      `(${ran + skipped}/${chunks.length})`);
  }

  console.log(`backfill: ${ran} windows walked, ${skipped} already done, ${written} stat lines`);
  return { ran, skipped, written };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const days = Number(process.argv[2] ?? DEFAULT_DAYS);
  const chunkDays = Number(process.argv[3] ?? DEFAULT_CHUNK_DAYS);
  try {
    await resumeBackfill({ days, chunkDays });
  } finally {
    await pool.end();
  }
}
