import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { resampleTotals, resampleFromRates, MIN_MAPS, MIN_KPR_MAPS } from '../web/projection.js';

/**
 * Does the kills-per-round rate path actually beat the old per-map path on
 * data neither one has seen?
 *
 * Task 8 changed how a CS2 kills projection is built when there is enough
 * history: instead of resampling whole per-map kill totals (which bakes in
 * whatever mix of blowouts and grinders the player's own sample happened to
 * contain), it resamples a kills-per-round rate against a round-length pool
 * drawn from the league. Task 6 showed rate and round length are close to
 * independent, which justifies drawing them apart — but independence being
 * a safe assumption is not the same claim as the result being more accurate.
 * That second claim is only checked by holding out real series and scoring
 * both methods against what actually happened.
 *
 * Split time-based, never random: rosters churn constantly in esports, so a
 * random split would let a player's own future maps leak into their training
 * data and report a flattering lie (this is also the reason `roundLengthPool`
 * is not reused here as-is — it orders by played_at DESC with no date bound,
 * which would pull mostly from the test window; the training-only pool below
 * is a separate, deliberately bounded query).
 *
 * Everything a held-out series is projected from — a player's per-map kill
 * values, a player's kills-per-round rate, and the league's round-length pool
 * — is built only from rows strictly before CUTOFF. The test set is only rows
 * at or after CUTOFF. This is the "at minimum" leak-free split the brief
 * allows: a fixed cutoff rather than a walk-forward one, with training built
 * once from everything before it rather than re-built per held-out series.
 * It is still leak-free because no training row's played_at is ever >= any
 * test row's played_at.
 *
 * Read-only. No database writes.
 */

const CUTOFF = '2026-06-01T00:00:00Z';

interface StatRow {
  series_key: string;
  canon_handle: string;
  map_number: number;
  kills: number | null;
  rounds: number | null;
  played_at: string;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main(): Promise<void> {
  // --- Training side: everything strictly before the cutoff. ---------------
  const trainRows = await q<{ canon_handle: string; kills: number; rounds: number | null }>(
    `SELECT canon_handle, kills, rounds
     FROM map_stat_dedup
     WHERE league = 'CS2' AND played_at < $1 AND kills IS NOT NULL`,
    [CUTOFF],
  );

  const mapValuesByPlayer = new Map<string, number[]>();
  const kprByPlayer = new Map<string, number[]>();
  for (const r of trainRows) {
    const mv = mapValuesByPlayer.get(r.canon_handle);
    if (mv) mv.push(r.kills); else mapValuesByPlayer.set(r.canon_handle, [r.kills]);
    if (r.rounds !== null && r.rounds >= 13) {
      const rate = r.kills / r.rounds;
      const kv = kprByPlayer.get(r.canon_handle);
      if (kv) kv.push(rate); else kprByPlayer.set(r.canon_handle, [rate]);
    }
  }

  const trainRoundPool = (
    await q<{ rounds: number }>(
      `SELECT rounds FROM map_stat_dedup
       WHERE league = 'CS2' AND played_at < $1 AND rounds IS NOT NULL AND rounds >= 13`,
      [CUTOFF],
    )
  ).map((r) => r.rounds);

  const trainSeriesCount = (
    await q<{ n: number }>(
      `SELECT count(DISTINCT series_key)::int AS n FROM map_stat_dedup
       WHERE league = 'CS2' AND played_at < $1`,
      [CUTOFF],
    )
  )[0]!.n;

  // --- Test side: everything at or after the cutoff. ------------------------
  const testRows = await q<StatRow>(
    `SELECT series_key, canon_handle, map_number, kills, rounds, played_at
     FROM map_stat_dedup
     WHERE league = 'CS2' AND played_at >= $1 AND kills IS NOT NULL
     ORDER BY series_key, canon_handle, map_number`,
    [CUTOFF],
  );

  const testSeriesCount = (
    await q<{ n: number }>(
      `SELECT count(DISTINCT series_key)::int AS n FROM map_stat_dedup
       WHERE league = 'CS2' AND played_at >= $1`,
      [CUTOFF],
    )
  )[0]!.n;

  // Group held-out rows into one observation per (series_key, canon_handle):
  // a player's whole run through that series. Only a complete range counts —
  // a set of map numbers running 1..N with no gaps and no repeats — the same
  // refusal `projectFor` makes when a series didn't play the whole range
  // being priced.
  type Group = { maps: Set<number>; total: number };
  const groups = new Map<string, Group>();
  for (const r of testRows) {
    const key = `${r.series_key}|${r.canon_handle}`;
    let g = groups.get(key);
    if (!g) { g = { maps: new Set(), total: 0 }; groups.set(key, g); }
    g.maps.add(r.map_number);
    g.total += r.kills!;
  }

  let heldOut = 0;
  let skippedIncomplete = 0;
  let skippedThinTraining = 0;
  const errOld: number[] = [];
  const errNew: number[] = [];

  for (const [key, g] of groups) {
    const [, canonHandle] = key.split('|') as [string, string];
    const n = g.maps.size;
    const maxMap = Math.max(...g.maps);
    const complete = n >= 1 && maxMap === n && g.maps.has(1);
    if (!complete) { skippedIncomplete++; continue; }

    const trainMaps = mapValuesByPlayer.get(canonHandle) ?? [];
    const trainKpr = kprByPlayer.get(canonHandle) ?? [];
    // Apples to apples: only score an observation where BOTH methods could
    // actually have fired in production (`evaluate`'s own thresholds), so a
    // player thin enough to sink one method doesn't get counted for the other.
    if (trainMaps.length < MIN_MAPS || trainKpr.length < MIN_KPR_MAPS || trainRoundPool.length === 0) {
      skippedThinTraining++;
      continue;
    }

    heldOut++;
    const seed = `${key}|validate`;
    const oldSample = resampleTotals(trainMaps, n, `${seed}|old`);
    const newSample = resampleFromRates(trainKpr, trainRoundPool, n, `${seed}|new`);
    const oldProj = mean(oldSample);
    const newProj = mean(newSample);
    errOld.push(Math.abs(oldProj - g.total));
    errNew.push(Math.abs(newProj - g.total));
  }

  console.log(`cutoff: ${CUTOFF}`);
  console.log(`train series (distinct series_key, CS2, played_at < cutoff): ${trainSeriesCount}`);
  console.log(`test series  (distinct series_key, CS2, played_at >= cutoff): ${testSeriesCount}`);
  console.log(`train maps: ${trainRows.length}    train round-pool (rounds >= 13): ${trainRoundPool.length}`);
  console.log();
  console.log(`held-out player-series groups (test side): ${groups.size}`);
  console.log(`  skipped, incomplete map range:            ${skippedIncomplete}`);
  console.log(`  skipped, training below MIN_MAPS/MIN_KPR: ${skippedThinTraining}`);
  console.log(`  scored (both methods applicable):         ${heldOut}`);
  console.log();

  if (heldOut === 0) {
    console.log('Nothing scored — cannot compare.');
    return;
  }

  const maeOld = mean(errOld);
  const maeNew = mean(errNew);
  const medOld = median(errOld);
  const medNew = median(errNew);

  console.log('method       MAE      median AE');
  console.log(`per-map      ${maeOld.toFixed(4).padStart(7)}   ${medOld.toFixed(4).padStart(7)}`);
  console.log(`rate (kpr)   ${maeNew.toFixed(4).padStart(7)}   ${medNew.toFixed(4).padStart(7)}`);
  console.log();
  console.log(
    maeNew < maeOld
      ? `VERDICT: rate method beats per-map on MAE (${maeNew.toFixed(4)} < ${maeOld.toFixed(4)}).`
      : `VERDICT: rate method does NOT beat per-map on MAE (${maeNew.toFixed(4)} >= ${maeOld.toFixed(4)}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}
