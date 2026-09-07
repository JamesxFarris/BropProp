import cron from 'node-cron';
import { config } from './config.js';
import { pollOnce } from './poll.js';
import { runResults } from './results/run.js';

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

cron.schedule(config.pollCron, tick);
cron.schedule(config.resultsCron, gradeTick);
console.log(`results schedule "${config.resultsCron}"`);

await tick();       // don't wait a full interval for the first datapoint
await gradeTick();  // and grade anything already waiting
