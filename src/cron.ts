import cron from 'node-cron';
import { config } from './config.js';
import { pollOnce } from './poll.js';
import { runResults } from './results/run.js';
import { fetchBo3 } from './results/bo3.js';
import { storeStats } from './results/store_stats.js';
import { scoreCalls, storeScore, LEAGUES } from './results/validate_calls.js';
import { resumeBackfill } from './results/backfill_resume.js';
import { pullMatchOdds, BudgetExhausted } from './adapters/oddspapi.js';
import { logStacks, gradeStacks } from './results/stack_log.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The first day that counts as forward evidence for the pre-registered pricing
 * leads (see src/results/validate_bias.ts, TRACKED). Fixed, not rolling: the
 * leads were chosen from the days before it.
 */
const LEADS_SINCE = '2026-09-12';

/**
 * Score the pricing leads on their forward window and store today's record.
 *
 * A child process, not a function call: the scan loads the whole stat archive,
 * and a job that ran this process out of memory would take the line logger
 * down with it. Its own heap cap, a timeout, and it always resolves — a failed
 * scan is a missing row on the Stats page, never a stopped poller.
 */
function runLeadScan(): Promise<void> {
  return new Promise((resolve) => {
    const cli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const script = fileURLToPath(new URL('./results/validate_bias.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=2048', cli, script, `--since=${LEADS_SINCE}`, '--store', '--quiet'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60e3);
    child.on('exit', (code) => { clearTimeout(timer); console.log(`lead scan exited ${code}`); resolve(); });
    child.on('error', (e) => { clearTimeout(timer); console.warn('lead scan failed to start:', e.message); resolve(); });
  });
}

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
    await runLeadScan();
  } catch (err) {
    // Scoring is reporting, not collection. It must never take the logger down.
    console.warn('model score skipped:', (err as Error).message.slice(0, 120));
  } finally {
    scoring = false;
  }
}

let pullingOdds = false;

/**
 * Pinnacle's moneylines for the day's matches, once.
 *
 * Metered at 250 requests a month, so this is the one job that must never run
 * twice by accident — the ledger in `api_call` enforces the cap across
 * restarts, and the flag here stops an overlap within one process.
 */
async function oddsTick() {
  if (!config.oddspapiKey || pullingOdds) return;
  pullingOdds = true;
  try {
    for (const league of config.oddsLeagues) {
      const r = await pullMatchOdds(league);
      console.log(`match odds ${league}: ${r.stored} fixtures for ${r.calls} requests`);
    }
  } catch (err) {
    // Out of budget is expected late in a month and is not an error.
    if (err instanceof BudgetExhausted) console.log(err.message);
    else console.warn('match odds skipped:', (err as Error).message.slice(0, 160));
  } finally {
    pullingOdds = false;
  }
}

let stacking = false;

/**
 * Write down the stacks Build is recommending, and grade the ones whose
 * matches have finished.
 *
 * The stack is the only shape here with a measured edge. The measurement is no
 * longer thin — the opponent tail is 831 series (`validate:tail`) and Sleeper
 * publishes its payout ladder — but it is all still OUR arithmetic about shapes
 * nobody has watched settle forward. This turns it into a record: what was
 * recommended, what it needed, what the app paid where a slip was placed, and
 * whether it came in.
 */
async function stacksTick() {
  if (stacking) return;
  stacking = true;
  try {
    const written = await logStacks();
    const { graded, pending } = await gradeStacks();
    console.log(`stacks: ${written} recommended logged, ${graded} graded, ${pending} pending`);
  } catch (err) {
    // Bookkeeping, never collection: this must not take the logger down.
    console.warn('stack log skipped:', (err as Error).message.slice(0, 160));
  } finally {
    stacking = false;
  }
}

cron.schedule(config.pollCron, tick);
cron.schedule(config.stacksCron, stacksTick);
if (config.oddspapiKey) cron.schedule(config.oddsCron, oddsTick);
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
