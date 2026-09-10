import test from 'node:test';
import assert from 'node:assert/strict';
import { staleLine, FRESH_MS } from './stale.js';
import type { BookLine } from './boardq.js';

/**
 * The stale-line signal claims one thing: that a book moved and the others have
 * not followed. Every case here is a way of being wrong about that.
 */

const NOW = Date.parse('2026-09-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function bl(
  book: string,
  line: number,
  move: number | null = null,
  moveAt: string | null = null,
  sides: { over?: boolean; under?: boolean } = {},
): BookLine {
  return {
    book, line, prop_id: 1,
    over_price: null, under_price: null,
    over_ok: sides.over ?? true, under_ok: sides.under ?? true,
    over_mult: null, under_mult: null,
    moved: null, last_move: move, last_move_at: moveAt, side: null,
  };
}

test('a recent move on one book, with the other still where it was', () => {
  const s = staleLine([
    bl('prizepicks', 30.5, 2, ago(30 * 60e3)),
    bl('underdog', 28.5),
  ], NOW);
  assert.ok(s);
  assert.equal(s!.mover, 'prizepicks');
  assert.equal(s!.book, 'underdog', 'the one holding the stale number');
  assert.equal(s!.side, 'over', 'the mover raised its line, so the low one is the cheap over');
  assert.equal(s!.gap, 2);
});

test('a downward move points at the under', () => {
  const s = staleLine([
    bl('prizepicks', 26.5, -2, ago(30 * 60e3)),
    bl('underdog', 28.5),
  ], NOW);
  assert.equal(s?.side, 'under');
  assert.equal(s?.book, 'underdog');
});

test('a market only one book prices cannot be stale against anything', () => {
  assert.equal(staleLine([bl('prizepicks', 28.5, 2, ago(60e3))], NOW), null);
});

test('an old move is books disagreeing, not one lagging', () => {
  // Moved yesterday and never followed: that is a settled difference of
  // opinion. Calling it a lag would keep a dead row lit up forever.
  assert.equal(staleLine([
    bl('prizepicks', 30.5, 2, ago(FRESH_MS + 60e3)),
    bl('underdog', 28.5),
  ], NOW), null);
});

test('books moving together is not a lag', () => {
  // They are both reacting to the same news. Neither number is stale.
  assert.equal(staleLine([
    bl('prizepicks', 30.5, 2, ago(40 * 60e3)),
    bl('underdog', 30.5, 2, ago(20 * 60e3)),
  ], NOW), null);
});

test('the lagging book having moved EARLIER still counts as lagging', () => {
  // Underdog moved two hours ago, PrizePicks ten minutes ago. Underdog is the
  // one that has not responded to the newer move.
  const s = staleLine([
    bl('prizepicks', 30.5, 2, ago(10 * 60e3)),
    bl('underdog', 28.5, 1, ago(2 * 3600e3)),
  ], NOW);
  assert.equal(s?.mover, 'prizepicks');
  assert.equal(s?.book, 'underdog');
});

test('a zero move is not a move', () => {
  assert.equal(staleLine([
    bl('prizepicks', 30.5, 0, ago(60e3)),
    bl('underdog', 28.5),
  ], NOW), null);
});

test('when two qualify, the more recent move is the live one', () => {
  const s = staleLine([
    bl('prizepicks', 30.5, 2, ago(3 * 3600e3)),
    bl('underdog', 27.5, -1, ago(3 * 3600e3 + 60e3)),
  ], NOW);
  assert.equal(s?.mover, 'prizepicks', 'PrizePicks moved later, so its move is the live one');
});

test('a malformed timestamp is refused rather than thrown', () => {
  assert.equal(staleLine([
    bl('prizepicks', 30.5, 2, 'not a date'),
    bl('underdog', 28.5),
  ], NOW), null);
});

test('converged books are not stale, however the timestamps read', () => {
  // Both on 28.5. There is no cheaper side to take, so there is no signal.
  assert.equal(staleLine([
    bl('prizepicks', 28.5, 2, ago(30 * 60e3)),
    bl('underdog', 28.5),
  ], NOW), null);
});

test('with three books, the cheapest lagging number is the one named', () => {
  const s = staleLine([
    bl('prizepicks', 30.5, 2, ago(30 * 60e3)),
    bl('underdog', 29.5),
    bl('sleeper', 28.5),
  ], NOW);
  assert.equal(s?.mover, 'prizepicks');
  assert.equal(s?.book, 'sleeper', 'lowest line standing is the cheapest over');
  assert.equal(s?.gap, 2);
});

test('a lagging book that does not offer the side is not the answer', () => {
  const s = staleLine([
    bl('prizepicks', 30.5, 2, ago(30 * 60e3)),
    bl('underdog', 29.5),
    bl('sleeper', 28.5, null, null, { over: false }),
  ], NOW);
  assert.equal(s?.book, 'underdog', 'sleeper is cheaper but will not take the bet');
});

test('a book that followed becomes the mover, and the one left behind is named', () => {
  // PrizePicks moved to 30.5 half an hour ago and Sleeper matched it ten
  // minutes ago. Two books now say 30.5 and Underdog is still on 28.5, so
  // Underdog is the one lagging — behind the most recent move, not the first.
  const s = staleLine([
    bl('prizepicks', 30.5, 2, ago(30 * 60e3)),
    bl('underdog', 28.5),
    bl('sleeper', 30.5, 2, ago(10 * 60e3)),
  ], NOW);
  assert.equal(s?.mover, 'sleeper', 'the most recent move is the live one');
  assert.equal(s?.book, 'underdog');
  assert.equal(s?.gap, 2);
});

test('the mover being matched by everyone leaves nothing stale', () => {
  // All three on 30.5. Whoever moved last, there is no cheaper number left.
  assert.equal(staleLine([
    bl('prizepicks', 30.5, 2, ago(30 * 60e3)),
    bl('underdog', 30.5),
    bl('sleeper', 30.5, 2, ago(10 * 60e3)),
  ], NOW), null);
});
