import test from 'node:test';
import assert from 'node:assert/strict';
import { staleLine, FRESH_MS } from './stale.js';

/**
 * The stale-line signal is the only thing on the board that does not rest on a
 * projection, so it has to be right about the one thing it claims: that a book
 * moved, and the other one has not followed. Every case here is a way of being
 * wrong about that.
 */

const NOW = Date.parse('2026-09-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const row = (o: Partial<Parameters<typeof staleLine>[0]> = {}) => ({
  pp_line: 28.5, ud_line: 28.5,
  pp_last_move: null, pp_last_move_at: null,
  ud_last_move: null, ud_last_move_at: null,
  ...o,
});

test('a recent move on one book, with the other still where it was', () => {
  const s = staleLine(row({
    pp_line: 30.5, ud_line: 28.5,
    pp_last_move: 2, pp_last_move_at: ago(30 * 60e3),
  }), NOW);
  assert.ok(s);
  assert.equal(s!.mover, 'prizepicks');
  assert.equal(s!.book, 'underdog', 'the one holding the stale number');
  assert.equal(s!.side, 'over', 'the mover raised its line, so the low one is the cheap over');
  assert.equal(s!.gap, 2);
});

test('a downward move points at the under', () => {
  const s = staleLine(row({
    pp_line: 26.5, ud_line: 28.5,
    pp_last_move: -2, pp_last_move_at: ago(30 * 60e3),
  }), NOW);
  assert.equal(s?.side, 'under');
});

test('a market only one book prices cannot be stale against anything', () => {
  assert.equal(staleLine(row({
    ud_line: null, pp_last_move: 2, pp_last_move_at: ago(60e3),
  }), NOW), null);
});

test('an old move is two books disagreeing, not one lagging', () => {
  // Moved yesterday and never followed: that is a settled difference of
  // opinion. Calling it a lag would keep a dead row lit up forever.
  assert.equal(staleLine(row({
    pp_line: 30.5, ud_line: 28.5,
    pp_last_move: 2, pp_last_move_at: ago(FRESH_MS + 60e3),
  }), NOW), null);
});

test('both books moving together is not a lag', () => {
  // They are both reacting to the same news. Neither number is stale.
  assert.equal(staleLine(row({
    pp_line: 30.5, ud_line: 30.5,
    pp_last_move: 2, pp_last_move_at: ago(40 * 60e3),
    ud_last_move: 2, ud_last_move_at: ago(20 * 60e3),
  }), NOW), null);
});

test('the lagging book having moved EARLIER still counts as lagging', () => {
  // Underdog moved two hours ago, PrizePicks moved ten minutes ago. Underdog
  // is the one that has not responded to the newer move.
  const s = staleLine(row({
    pp_line: 30.5, ud_line: 28.5,
    pp_last_move: 2, pp_last_move_at: ago(10 * 60e3),
    ud_last_move: 1, ud_last_move_at: ago(2 * 3600e3),
  }), NOW);
  assert.equal(s?.mover, 'prizepicks');
  assert.equal(s?.book, 'underdog');
});

test('a zero move is not a move', () => {
  assert.equal(staleLine(row({
    pp_line: 30.5, ud_line: 28.5, pp_last_move: 0, pp_last_move_at: ago(60e3),
  }), NOW), null);
});

test('when both qualify, the more recent move is the live one', () => {
  const s = staleLine(row({
    pp_line: 30.5, ud_line: 27.5,
    pp_last_move: 2, pp_last_move_at: ago(3 * 3600e3),
    ud_last_move: -1, ud_last_move_at: ago(3 * 3600e3 + 60e3),
  }), NOW);
  assert.equal(s?.mover, 'prizepicks', 'PrizePicks moved later, so its move is the live one');
});

test('a malformed timestamp is refused rather than thrown', () => {
  assert.equal(staleLine(row({
    pp_line: 30.5, ud_line: 28.5, pp_last_move: 2, pp_last_move_at: 'not a date',
  }), NOW), null);
});
