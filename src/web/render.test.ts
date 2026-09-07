import test from 'node:test';
import assert from 'node:assert/strict';
import { offeredSides } from './render.js';

/**
 * Which sides a market offers, once an app has been chosen.
 *
 * This is the rule DESIGN.md states as "'better on an app' is a property of a
 * side, not of a prop": a lower line is the better over and a higher line the
 * better under, so on a market where the two apps differ the selected app wins
 * exactly one side, and only that side should be takeable.
 *
 * It is tested here because the two pages that render take buttons had already
 * drifted apart on it. The board computed the restriction; the disagreements
 * page hardcoded "both" and used the better side only to paint a marker — so
 * with a slip open on Underdog it still offered the Underdog over while
 * PrizePicks priced that same over lower. One shared function and this test
 * are what stop them drifting again.
 *
 * `delta` is `pp_line - ud_line`, matching the board query.
 *
 * No database: every input is a literal.
 */

test('with no app chosen, both sides stay takeable', () => {
  // The comparison view. Nothing has been narrowed, so nothing is withheld.
  assert.equal(offeredSides('prizepicks', -1.0, false), 'both');
  assert.equal(offeredSides('underdog', -1.0, false), 'both');
});

test('the app with the lower line offers the over, not the under', () => {
  // PP 18.5, UD 19.5 -> delta -1.0. PP is the cheaper over.
  assert.equal(offeredSides('prizepicks', -1.0, true), 'over');
});

test('the app with the higher line offers the under, not the over', () => {
  // Same market from Underdog's side: its line is higher, so it wins the under.
  assert.equal(offeredSides('underdog', -1.0, true), 'under');
});

test('the over is withheld on the app that prices it worse', () => {
  // The reported bug, stated directly: a slip open on Underdog, PrizePicks
  // holding the cheaper over, and the Underdog over still takeable.
  const ud = offeredSides('underdog', -1.0, true);
  assert.notEqual(ud, 'both', 'a narrowed app must not offer both sides');
  assert.notEqual(ud, 'over', 'the worse over must not be takeable');
});

test('the direction of the gap decides which side each app wins', () => {
  // Mirror of the above: UD now holds the lower line, so the sides swap.
  assert.equal(offeredSides('underdog', 1.0, true), 'over');
  assert.equal(offeredSides('prizepicks', 1.0, true), 'under');
});

test('apps that agree withhold nothing', () => {
  // No gap means neither app prices a side better, so there is nothing to
  // steer the user away from and both sides remain available.
  assert.equal(offeredSides('prizepicks', 0, true), 'both');
  assert.equal(offeredSides('underdog', 0, true), 'both');
});

test('a market only one app lists withholds nothing', () => {
  // delta is null when the other book has no line at all. With no comparison
  // available neither side can be called worse, so both stand.
  assert.equal(offeredSides('prizepicks', null, true), 'both');
  assert.equal(offeredSides('underdog', null, true), 'both');
});
