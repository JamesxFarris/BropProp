import cron from 'node-cron';
import { config } from './config.js';
import { pollOnce } from './poll.js';

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

cron.schedule(config.pollCron, tick);
await tick(); // don't wait a full interval for the first datapoint
