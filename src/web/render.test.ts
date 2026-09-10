import test from 'node:test';
import assert from 'node:assert/strict';
import { offeredSides, marketDisagreement } from './render.js';
import type { BookLine } from './boardq.js';

/**
 * Which sides a market offers, once an app has been chosen.
 *
 * This is the rule DESIGN.md states as "'better on an app' is a property of a
 * side, not of a prop": a lower line is the better over and a higher line the
 * better under, so on a market where apps differ the selected app wins exactly
 * one side, and only that side should be takeable.
 *
 * It is tested here because the two pages that render take buttons had already
 * drifted apart on it. The board computed the restriction; the disagreements
 * page hardcoded "both" and used the better side only to paint a marker — so
 * with a slip open on Underdog it still offered the Underdog over while
 * PrizePicks priced that same over lower. One shared function and this test
 * are what stop them drifting again.
 *
 * The input is now the row's whole book list rather than a signed
 * `pp_line - ud_line` delta, which only had a meaning while there were exactly
 * two books to subtract.
 *
 * No database: every input is a literal.
 */

function bl(book: string, line: number): BookLine {
  return {
    book, line, prop_id: 1,
    over_price: null, under_price: null, over_ok: true, under_ok: true,
    over_mult: null, under_mult: null,
    moved: null, last_move: null, last_move_at: null, side: null,
  };
}

/** PP 18.5, UD 19.5 — PrizePicks holds the cheaper over. */
const ppLower = [bl('prizepicks', 18.5), bl('underdog', 19.5)];
/** The mirror: Underdog now holds the lower line. */
const udLower = [bl('prizepicks', 19.5), bl('underdog', 18.5)];
const agreed = [bl('prizepicks', 19.5), bl('underdog', 19.5)];

test('with no app chosen, both sides stay takeable', () => {
  // The comparison view. Nothing has been narrowed, so nothing is withheld.
  assert.equal(offeredSides(ppLower, 'prizepicks', false), 'both');
  assert.equal(offeredSides(ppLower, 'underdog', false), 'both');
});

test('the app with the lower line offers the over, not the under', () => {
  assert.equal(offeredSides(ppLower, 'prizepicks', true), 'over');
});

test('the app with the higher line offers the under, not the over', () => {
  // Same market from Underdog's side: its line is higher, so it wins the under.
  assert.equal(offeredSides(ppLower, 'underdog', true), 'under');
});

test('the over is withheld on the app that prices it worse', () => {
  // The reported bug, stated directly: a slip open on Underdog, PrizePicks
  // holding the cheaper over, and the Underdog over still takeable.
  const ud = offeredSides(ppLower, 'underdog', true);
  assert.notEqual(ud, 'both', 'a narrowed app must not offer both sides');
  assert.notEqual(ud, 'over', 'the worse over must not be takeable');
});

test('the direction of the gap decides which side each app wins', () => {
  assert.equal(offeredSides(udLower, 'underdog', true), 'over');
  assert.equal(offeredSides(udLower, 'prizepicks', true), 'under');
});

test('apps that agree withhold nothing', () => {
  // No gap means neither app prices a side better, so there is nothing to
  // steer the user away from and both sides remain available.
  assert.equal(offeredSides(agreed, 'prizepicks', true), 'both');
  assert.equal(offeredSides(agreed, 'underdog', true), 'both');
});

test('a market only one app lists withholds nothing', () => {
  // One book, so no comparison exists and neither side can be called worse.
  assert.equal(offeredSides([bl('prizepicks', 18.5)], 'prizepicks', true), 'both');
});

test('with three books, only the extremes win a side', () => {
  // The middle book is beaten on the over by the low one and on the under by
  // the high one, so it wins neither and offers both. Two books could never
  // produce this case, which is why the delta version never had to handle it.
  const three = [bl('prizepicks', 18.5), bl('underdog', 19.5), bl('sleeper', 20.5)];
  assert.equal(offeredSides(three, 'prizepicks', true), 'over');
  assert.equal(offeredSides(three, 'sleeper', true), 'under');
  assert.equal(offeredSides(three, 'underdog', true), 'both');
});
/**
 * How far our own hit rate sits from what Underdog's price implies.
 *
 * Shown, never scored. Our hit rate is an empirical frequency over a dozen-odd
 * series and Underdog is a DFS operator rather than a sharp book, so the gap
 * between them is a prompt to look, not an edge to rank on.
 */

test('no market price means no disagreement to report', () => {
  assert.equal(marketDisagreement(0.7, null), null);
});

test('no hit rate of our own means no disagreement to report', () => {
  assert.equal(marketDisagreement(null, 0.5), null);
});

test('disagreement is our number minus the market, signed', () => {
  // We think it hits 70% of the time; the market prices it at 50%.
  assert.ok(Math.abs(marketDisagreement(0.7, 0.5)! - 0.2) < 1e-9);
  // And the other way round, so the sign says who is higher.
  assert.ok(Math.abs(marketDisagreement(0.4, 0.6)! - -0.2) < 1e-9);
});

test('agreement is zero, not absent', () => {
  // A market we agree with is a real answer and must be distinguishable from
  // one we could not price at all.
  assert.equal(marketDisagreement(0.55, 0.55), 0);
});
