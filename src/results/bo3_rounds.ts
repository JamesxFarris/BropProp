import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';

/**
 * Backfill `map_stat.rounds` for CS2 history stored before Task 4 taught the
 * bo3 collector to read `rounds_count` off the game object.
 *
 * Verified rather than trusted: bo3.gg ignores unknown filters and returns
 * the unfiltered list with HTTP 200 (see `bo3.ts`'s header note), so before
 * writing this file the bulk-filter shape was checked by hand against the
 * live API:
 *
 *   GET /games?filter[games.id][in]=182458,182459&page[limit]=100
 *     -> total.count: 2, returned 2, ids exactly [182458, 182459]
 *   Control, no filter:
 *     -> total.count: 144532, returned 100
 *
 * `filter[games.id][in]=<comma-separated ids>` is genuinely honoured, so
 * this script batches game ids 100 per request under that filter. Even so,
 * every response is re-checked: any game id that comes back which was not
 * requested is skipped rather than written, matching the discipline `bo3.ts`
 * already applies to every filter it sends.
 */

const API = 'https://api.bo3.gg/api/v1';

/** Same politeness delay bo3.ts uses. No rate limiting observed; not a measured floor. */
const GAP_MS = 90;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BropProp/0.1 (prop research)' },
  });
  if (!res.ok) throw new Error(`bo3 ${res.status} ${url.slice(API.length)}`);
  return (await res.json()) as T;
}

type Bo3GameRow = {
  id: number;
  match_id: number;
  number: number | null;
  rounds_count: number | null;
  winner_clan_score: number | null;
  loser_clan_score: number | null;
  map_name: string | null;
};

/** Game ids whose `map_stat.rounds` is still null, oldest work-queue semantics not required. */
async function pendingGameIds(limit?: number): Promise<string[]> {
  const rows = await q<{ game_id: string }>(
    `SELECT DISTINCT raw->>'game_id' AS game_id
       FROM map_stat
      WHERE source = 'bo3' AND rounds IS NULL AND raw->>'game_id' IS NOT NULL`,
  );
  const ids = rows.map((r) => r.game_id);
  return typeof limit === 'number' ? ids.slice(0, limit) : ids;
}

/** Writes one game's round count. Guarded the same way the query that selected it was. */
async function writeRounds(gameId: string, rounds: number): Promise<number> {
  const res = await pool.query(
    `UPDATE map_stat SET rounds = $1
      WHERE source = 'bo3' AND raw->>'game_id' = $2 AND rounds IS NULL`,
    [rounds, gameId],
  );
  return res.rowCount ?? 0;
}

export async function backfillRounds(limit?: number): Promise<{ games: number; rowsUpdated: number }> {
  const ids = await pendingGameIds(limit);
  console.log(`bo3_rounds: ${ids.length} games missing rounds${limit ? ` (capped at ${limit})` : ''}`);

  let gamesUpdated = 0;
  let rowsUpdated = 0;
  let batches = 0;
  const started = Date.now();

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const requested = new Set(batch);

    const params = new URLSearchParams();
    params.set('filter[games.id][in]', batch.join(','));
    params.set('page[limit]', '100');

    let page: { results?: Bo3GameRow[]; total?: { count?: number } };
    try {
      page = await getJson<{ results?: Bo3GameRow[]; total?: { count?: number } }>(
        `${API}/games?${params}`,
      );
    } catch (err) {
      console.warn(`  batch ${batches}: ${(err as Error).message}`);
      await sleep(GAP_MS);
      continue;
    }

    const rows = page.results ?? [];
    for (const g of rows) {
      // Re-check the filter on every response: bo3.gg has been seen returning
      // the unfiltered list with HTTP 200 when a filter goes unrecognised.
      // Anything we did not ask for is skipped, never written.
      if (!requested.has(String(g.id))) continue;
      if (typeof g.rounds_count !== 'number' || g.rounds_count <= 0) continue;

      const rowsChanged = await writeRounds(String(g.id), g.rounds_count);
      if (rowsChanged > 0) {
        gamesUpdated++;
        rowsUpdated += rowsChanged;
      }
    }

    batches++;
    const mins = (Date.now() - started) / 60000;
    const done = Math.min(i + 100, ids.length);
    const pct = Math.round((100 * done) / ids.length);
    const eta = done ? (mins / done) * (ids.length - done) : 0;
    console.log(
      `  ${String(pct).padStart(3)}%  ${done}/${ids.length} games  ` +
        `${gamesUpdated} games updated  ${rowsUpdated} rows written  ` +
        `${mins.toFixed(1)}m elapsed  ~${eta.toFixed(1)}m left`,
    );

    await sleep(GAP_MS);
  }

  console.log(`bo3_rounds: done — ${gamesUpdated} games updated, ${rowsUpdated} map_stat rows written`);
  return { games: gamesUpdated, rowsUpdated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const capArg = process.argv[2];
  const cap = capArg ? Number(capArg) : undefined;
  await backfillRounds(cap);
  await pool.end();
}
