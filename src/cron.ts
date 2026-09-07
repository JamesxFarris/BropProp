import cron from 'node-cron';
import { config } from './config.js';
import { pollOnce } from './poll.js';
import { runResults } from './results/run.js';
import { backfillCs2 } from './results/hltv_backfill.js';

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
 * Collect CS2 stat lines that appeared since yesterday.
 *
 * Deliberately daily and unattended. It cannot build history — HLTV publishes
 * stats for maybe one match in thirty and its archive can't be paged — but run
 * every day it accumulates the matches that do get parsed, for the players we
 * price. That is the only free path to CS2 form.
 */
async function accumulateTick() {
  if (accumulating) return;
  accumulating = true;
  try {
    await backfillCs2(1);
  } catch (err) {
    // No browser in the image, HLTV reshaped, Cloudflare in a mood — none of
    // it should touch the poller.
    console.warn('cs2 accumulate skipped:', (err as Error).message.slice(0, 120));
  } finally {
    accumulating = false;
  }
}

cron.schedule(config.pollCron, tick);
cron.schedule(config.resultsCron, gradeTick);
cron.schedule(config.accumulateCron, accumulateTick);
console.log(`results schedule "${config.resultsCron}", cs2 accumulate "${config.accumulateCron}"`);

await tick();       // don't wait a full interval for the first datapoint
await gradeTick();  // and grade anything already waiting
