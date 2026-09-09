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
  // The count is not fixed: the grid is absolute, so covering N days from an
  // arbitrary moment can need one extra cell at each end. What must hold is
  // that the seams meet exactly — a gap loses a day of matches silently.
  for (const [days, size] of [[90, 30], [365, 30], [70, 14]] as const) {
    const chunks = chunksFor(days, size, NOW);
    assert.ok(chunks.length >= Math.ceil(days / size), `${days}/${size} produced too few`);
    for (let i = 1; i < chunks.length; i++) {
      // Newest first, so each window's upper bound is the previous one's lower.
      assert.equal(chunks[i]!.until, chunks[i - 1]!.since,
        `${days}/${size}: seam between chunk ${i - 1} and ${i} does not meet`);
    }
  }
});

test('the newest window runs to the end of the current grid cell, and covers today', () => {
  // Not "ends today" any more. The grid is absolute so that a window keeps its
  // name across a date change, which means the newest one runs to the end of
  // the cell today falls in — a date that can be in the future. Harmless: no
  // finished match has a future start date, and anything landing inside the
  // current window afterwards is picked up by the daily 14-day sweep rather
  // than by this job.
  const chunks = chunksFor(90, 30, NOW);
  assert.ok(chunks[0]!.until > '2026-09-08', `newest window ends ${chunks[0]!.until}`);
  assert.ok(chunks[0]!.since <= '2026-09-08', 'the newest window must still contain today');
});

test('a range that does not divide evenly still reaches past the requested depth', () => {
  // On a fixed grid the far end lands on a boundary rather than exactly on the
  // requested day, so it must reach AT LEAST that far back — never short.
  const chunks = chunksFor(70, 30, NOW);
  const need = new Date(NOW - 70 * DAY).toISOString().slice(0, 10);
  assert.ok(chunks[chunks.length - 1]!.since <= need,
    `oldest window starts ${chunks[chunks.length - 1]!.since}, needs ${need}`);
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

test('a chunk larger than the range yields one window that still contains the range', () => {
  const chunks = chunksFor(5, 30, NOW);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.since <= new Date(NOW - 5 * DAY).toISOString().slice(0, 10));
  assert.ok(chunks[0]!.until > '2026-09-08');
});

test('the boundaries do not move when the clock does', () => {
  // The bug this exists for. Chunk identity is (since, until), so a boundary
  // that shifts with "today" makes every completed window look undone the
  // moment the date changes. In production on 2026-09-08 that re-walked five
  // windows and left ten overlapping seams in the ledger, each pair a day
  // apart, because the grid was measured from Date.now().
  const base = chunksFor(365, 30, NOW);
  for (const shift of [1, 2, 6, 13, 29]) {
    const later = chunksFor(365, 30, NOW + shift * 864e5);
    const shared = later.filter((c) => base.some((b) => b.since === c.since && b.until === c.until));
    // Every window they have in common must be identical, and moving the clock
    // by less than a chunk must not invent a whole new set.
    assert.ok(
      shared.length >= base.length - 1,
      `moving the clock ${shift}d changed ${base.length - shared.length} of ${base.length} windows`,
    );
  }
});

test('a window keeps its identity across a month boundary', () => {
  // Same grid either side of the chunk-size rollover: the newest window may be
  // new, but nothing older is allowed to be renamed.
  const before = chunksFor(365, 30, Date.parse('2026-09-08T23:59:00Z'));
  const after = chunksFor(365, 30, Date.parse('2026-09-09T00:01:00Z'));
  assert.deepEqual(before, after, 'crossing midnight must not renumber the grid');
});

test('windows still cover the whole requested depth', () => {
  // Snapping to a fixed grid must not leave the far end short.
  for (const [days, size] of [[365, 30], [730, 30], [90, 14]] as const) {
    const cs = chunksFor(days, size, NOW);
    const oldest = cs[cs.length - 1]!.since;
    const need = new Date(NOW - days * DAY).toISOString().slice(0, 10);
    assert.ok(oldest <= need, `${days}/${size} reaches only ${oldest}, needs ${need}`);
  }
});
