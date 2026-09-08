import test from 'node:test';
import assert from 'node:assert/strict';
import { americanToProb, devig } from './devig.js';

/**
 * Turning Underdog's two-sided prices into a probability.
 *
 * Underdog is the only book on the board that publishes real odds —
 * PrizePicks expresses price by moving the line instead — so this is the only
 * market probability available to us. It is shown beside our own hit rate and
 * deliberately kept out of the score.
 *
 * No database: every input is a literal.
 */

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('american odds convert to implied probability', () => {
  close(americanToProb(-110), 110 / 210);
  close(americanToProb(110), 100 / 210);
  // The boundary: +100 and -100 are both an even-money bet.
  close(americanToProb(100), 0.5);
  close(americanToProb(-100), 0.5);
});

test('a symmetric market devigs to an even split', () => {
  const f = devig(-110, -110);
  assert.ok(f);
  close(f.over, 0.5);
  close(f.under, 0.5);
});

test('the two sides always sum to one', () => {
  for (const [o, u] of [[-110, -110], [-139, 113], [-250, 200], [150, -175]] as const) {
    const f = devig(o, u);
    assert.ok(f, `${o}/${u} should devig`);
    close(f.over + f.under, 1);
  }
});

test('the overround reported is the overround removed', () => {
  const f = devig(-139, 113);
  assert.ok(f);
  // -139 -> 139/239, +113 -> 100/213. They sum to more than 1; the excess is
  // the book's margin, and it is reported rather than silently discarded.
  const raw = 139 / 239 + 100 / 213;
  close(f.overround, raw - 1);
  assert.ok(f.overround > 0, 'a real market has a positive overround');
});

test('devigging preserves which side is favoured', () => {
  const f = devig(-139, 113);
  assert.ok(f);
  assert.ok(f.over > f.under, 'the -139 side is the favourite and must stay so');
});

test('a one-sided market yields no probability, not a guess', () => {
  // Every Underdog LoL assists market is higher-only. A single price cannot be
  // devigged, and inventing the other side would be the same error as grading
  // a stat the source cannot produce.
  assert.equal(devig(-110, null), null);
  assert.equal(devig(null, -110), null);
  assert.equal(devig(null, null), null);
});

test('the method is named in the result so it can be changed and compared', () => {
  const f = devig(-110, -110);
  assert.ok(f);
  assert.equal(f.method, 'multiplicative');
});
