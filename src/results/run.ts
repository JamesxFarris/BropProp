import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { fetchLeaguepedia } from './leaguepedia.js';
import { fetchBo3 } from './bo3.js';
import { pendingPicks, gradePick, applyGrade, settleSlips } from './grade.js';
import { storeStats } from './store_stats.js';
import type { MapStat } from './types.js';

/** Fetch results, then grade whatever became gradeable. */
export async function runResults(): Promise<void> {
  console.log(`[${new Date().toISOString()}] results start`);

  // CS2 comes from bo3.gg: a plain JSON API with no auth, no rate limit and
  // no browser, which HLTV required for a fraction of the coverage. Because it
  // is cheap it runs unconditionally rather than only when a pick is pending —
  // every stat line collected now is history the projections use later.
  //
  // Three days rather than one: stats appear 7.5 to 33 hours after a match
  // ends, so a one-day window would miss the slower half and never revisit it.
  const sources: [string, () => Promise<{ stats: MapStat[] }>][] = [
    ['leaguepedia', () => fetchLeaguepedia()],
    ['bo3', () => fetchBo3({ days: 3 })],
  ];

  for (const [source, fetcher] of sources) {
    const run = await q<{ id: number }>(
      'INSERT INTO result_run (source) VALUES ($1) RETURNING id',
      [source],
    );
    const runId = run[0]!.id;
    try {
      const { stats } = await fetcher();
      const written = await storeStats(stats);
      await q(
        `UPDATE result_run SET finished_at = now(), rows_seen = $2,
                               rows_written = $3, ok = true WHERE id = $1`,
        [runId, stats.length, written],
      );
      console.log(`  ${source}: ${stats.length} stat lines, ${written} stored`);
    } catch (err) {
      const msg = (err as Error).message;
      await q(
        `UPDATE result_run SET finished_at = now(), ok = false, error = $2 WHERE id = $1`,
        [runId, msg],
      );
      console.error(`  ${source}: FAILED — ${msg}`);
    }
  }

  const picks = await pendingPicks();
  let graded = 0;
  const tally: Record<string, number> = {};
  for (const p of picks) {
    const outcome = await gradePick(p);
    // Leave a pick pending when no stat line has arrived yet: the match may
    // simply not be in the source. Recording it as ungradeable now would stop
    // it ever being retried.
    if (outcome.status === 'ungradeable' && outcome.note.startsWith('No stat line')) continue;
    await applyGrade(outcome);
    tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
    graded++;
  }

  const settled = await settleSlips();
  console.log(
    `  graded ${graded} of ${picks.length} pending picks${
      graded ? ` (${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''
    }, settled ${settled} slips`,
  );
  console.log(`[${new Date().toISOString()}] results done`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runResults();
  await pool.end();
}
