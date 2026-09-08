import cron from 'node-cron';
import { config } from './config.js';
import { pollOnce } from './poll.js';
import { runResults } from './results/run.js';
import { fetchBo3 } from './results/bo3.js';
import { storeStats } from './results/store_stats.js';
import { scoreCalls, storeScore, LEAGUES } from './results/validate_calls.js';
import { resumeBackfill } from './results/backfill_resume.js';

console.log(`BropProp logger up — schedule "${config.pollCron}", leagues ${config.leagues.join(',')}`);

let running = false;

async function tick() {
  // A slow Underdog fetch must never let two polls overlap and double-write.
  if (running) {
    console.warn('previous poll still running — skipping this tick');
    return;
  }
  running = true;
  try {
    await pollOnce();
  } catch (err) {
    console.error('poll threw:', (err as Error).message);
  } finally {
    running = false;
  }
}

let grading = false;

/**
 * Results run on their own, slower schedule. Matches finish long after a line
 * stops moving, and the sources rate-limit far harder than the books do, so
 * grading every poll would earn nothing but 429s.
 */
async function gradeTick() {
  if (grading) {
    console.warn('previous results run still going — skipping this tick');
    return;
  }
  grading = true;
  try {
    await runResults();
  } catch (err) {
    console.error('results threw:', (err as Error).message);
  } finally {
    grading = false;
  }
}

let accumulating = false;

/**
 * A wider daily sweep of CS2 stats than the results run makes.
 *
 * The results run covers three days, which catches a match parsed within about
 * a day and a half of finishing. A minority are parsed much later than that,
 * and once the three-day window slides past them nothing would ever look
 * again. Two weeks daily closes that gap; the upsert makes the overlap free.
 *
 * Unlike the HLTV crawler this replaced, it needs no browser, so it runs in
 * the container as happily as it does locally.
 */
async function accumulateTick() {
  if (accumulating) return;
  accumulating = true;
  try {
    const { stats } = await fetchBo3({ days: 14, maxMatches: 1500 });
    const written = await storeStats(stats);
    console.log(`cs2 sweep: ${stats.length} stat lines, ${written} stored`);
  } catch (err) {
    // A reshaped payload or a bad gateway must never touch the poller.
    console.warn('cs2 sweep skipped:', (err as Error).message.slice(0, 120));
  } finally {
    accumulating = false;
  }
}

let scoring = false;

/**
 * Score the model against everything that has settled, and store the result.
 *
 * This is the one job whose output nobody bets on — it exists so the board's
 * claims stay checkable. The replay is slow (every settled market, through
 * the real `evaluate()`, with every stat row for every player in them), which
 * is exactly why it belongs on a schedule rather than on a page load.
 */
async function scoreTick() {
  if (scoring) return;
  scoring = true;
  try {
    const pc = (v: number | null) => (v === null ? '—' : `${(100 * v).toFixed(1)}%`);
    for (const league of LEAGUES) {
      const s = await scoreCalls(league);
      if (s.settled === 0) {
        console.log(`model score ${league}: nothing settled yet`);
        continue;
      }
      await storeScore(s, league);
      console.log(
        `model score ${league}: ${s.calls} calls / ${s.series} series — ` +
        `realised ${pc(s.realised)}, claimed ${pc(s.claimed)}, ` +
        `AUC ${s.auc === null ? '—' : s.auc.toFixed(3)}, ` +
        `always-under ${pc(s.alwaysUnder)}`);
    }
  } catch (err) {
    // Scoring is reporting, not collection. It must never take the logger down.
    console.warn('model score skipped:', (err as Error).message.slice(0, 120));
  } finally {
    scoring = false;
  }
}

cron.schedule(config.pollCron, tick);
cron.schedule(config.resultsCron, gradeTick);
cron.schedule(config.accumulateCron, accumulateTick);
cron.schedule(config.scoreCron, scoreTick);
console.log(`results schedule "${config.resultsCron}", cs2 accumulate "${config.accumulateCron}", ` +
            `model score "${config.scoreCron}"`);

await tick();       // don't wait a full interval for the first datapoint
await gradeTick();  // and grade anything already waiting

/**
 * Resume the deep backfill, if one is configured.
 *
 * Deliberately not awaited: it runs for hours and the poller must not wait on
 * it. Deliberately last, so a backfill can never delay the first poll or the
 * first grading pass — collection is the job, and this is catch-up.
 *
 * `SIGTERM` sets the stop flag rather than killing the walk, so a deploy ends
 * the run at the next chunk boundary and the chunk in flight is not thrown
 * away half-finished. Railway will replace the container regardless; this just
 * means the ledger stays honest about what actually completed.
 */
if (config.backfillDays > 0) {
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  void resumeBackfill({
    days: config.backfillDays,
    chunkDays: config.backfillChunkDays,
    shouldStop: () => stopping,
  }).catch((err) => {
    console.warn('backfill stopped:', (err as Error).message.slice(0, 160));
  });
}
