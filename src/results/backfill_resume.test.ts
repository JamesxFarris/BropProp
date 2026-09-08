import test from 'node:test';
import assert from 'node:assert/strict';
import { chunksFor } from './backfill_resume.js';

/**
 * The windows have to tile the range exactly.
 *
 * A gap at a seam loses a day of matches silently — nothing errors, the
 * backfill reports success, and the hole only shows up much later as a player
 * whose history is inexplicably thin. An overlap is cheaper (the second pass
 * skips stored maps) but means every seam is walked twice for nothing.
 *
 * These are pure date arithmetic against a fixed clock, so no database.
 */

const NOW = Date.parse('2026-09-08T12:00:00Z');
const DAY = 864e5;

test('windows tile the range with no gap and no overlap', () => {
  const chunks = chunksFor(90, 30, NOW);
  assert.equal(chunks.length, 3);
  for (let i = 1; i < chunks.length; i++) {
    // Newest first, so each window's upper bound is the previous one's lower.
    assert.equal(chunks[i]!.until, chunks[i - 1]!.since,
      `seam between chunk ${i - 1} and ${i} does not meet`);
  }
});

test('the newest window ends today and the oldest starts at the full depth', () => {
  const chunks = chunksFor(90, 30, NOW);
  assert.equal(chunks[0]!.until, '2026-09-08');
  assert.equal(chunks[chunks.length - 1]!.since,
    new Date(NOW - 90 * DAY).toISOString().slice(0, 10));
});

test('a range that does not divide evenly still stops exactly at the depth', () => {
  // 70 days in 30s is two full windows and a 10-day remainder. The remainder
  // must be short, not a third full window reaching 20 days too far back.
  const chunks = chunksFor(70, 30, NOW);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2]!.since, new Date(NOW - 70 * DAY).toISOString().slice(0, 10));
  assert.equal(chunks[2]!.until, new Date(NOW - 60 * DAY).toISOString().slice(0, 10));
});

test('every window is non-empty and ordered newest first', () => {
  for (const [days, size] of [[730, 30], [365, 14], [45, 7], [5, 30]] as const) {
    const chunks = chunksFor(days, size, NOW);
    assert.ok(chunks.length > 0, `${days}/${size} produced nothing`);
    for (const c of chunks) {
      assert.ok(c.since < c.until, `empty or inverted window ${c.since}..${c.until}`);
    }
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i]!.since < chunks[i - 1]!.since, 'not ordered newest first');
    }
  }
});

test('a chunk larger than the range yields one window covering exactly the range', () => {
  const chunks = chunksFor(5, 30, NOW);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.until, '2026-09-08');
  assert.equal(chunks[0]!.since, new Date(NOW - 5 * DAY).toISOString().slice(0, 10));
});

test('the boundaries are stable for a given clock, so the ledger keeps matching', () => {
  // Chunk identity is (since, until). If these drifted between runs, every
  // restart would treat completed windows as new and walk them all again —
  // exactly the failure this whole mechanism exists to remove.
  assert.deepEqual(chunksFor(60, 30, NOW), chunksFor(60, 30, NOW));
});
