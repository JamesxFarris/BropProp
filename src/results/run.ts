import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { canonHandle } from '../normalize.js';
import { fetchLeaguepedia } from './leaguepedia.js';
import { pendingPicks, gradePick, applyGrade, settleSlips } from './grade.js';
import type { MapStat } from './types.js';

async function storeStats(stats: MapStat[]): Promise<number> {
  let written = 0;
  for (const s of stats) {
    // Upsert, so re-running a fetch corrects a row rather than duplicating it.
    const res = await q(
      `INSERT INTO map_stat (source, league, series_key, map_number, handle_raw,
                             canon_handle, team, kills, deaths, assists, headshots,
                             played_at, raw, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (source, series_key, map_number, canon_handle) DO UPDATE
         SET kills = EXCLUDED.kills, deaths = EXCLUDED.deaths,
             assists = EXCLUDED.assists, headshots = EXCLUDED.headshots,
             team = COALESCE(EXCLUDED.team, map_stat.team),
             played_at = COALESCE(EXCLUDED.played_at, map_stat.played_at),
             fetched_at = now()
       RETURNING id`,
      [s.source, s.league, s.seriesKey, s.mapNumber, s.handleRaw,
       canonHandle(s.handleRaw), s.team, s.kills, s.deaths, s.assists, s.headshots,
       s.playedAt, s.raw ?? {}],
    );
    if (res.length) written++;
  }
  return written;
}

/** Fetch results, then grade whatever became gradeable. */
export async function runResults(): Promise<void> {
  console.log(`[${new Date().toISOString()}] results start`);

  for (const [source, fetcher] of [['leaguepedia', fetchLeaguepedia]] as const) {
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
