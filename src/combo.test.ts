import test from 'node:test';
import assert from 'node:assert/strict';
import { comboParts, isComboHandle, canonHandle } from './normalize.js';
import { foldCombo, comboRangeTotal, type ComboStatRow } from './combo.js';

/**
 * Combo props: reading the members out of a name, adding them up, and refusing
 * to when the numbers aren't all there.
 *
 * These are the rules that decide money on a combo, and each one has a way of
 * being wrong that looks right. A missing member reads as a smaller total, not
 * as an error. A dropped map reads as a lower number, not as a void. A member
 * counted twice reads as a bigger total, not as a duplicate. Every one of
 * those would settle a real slip incorrectly and none would throw, so they are
 * pinned here rather than eyeballed once.
 *
 * No database: everything is a literal row set, so a failure means the rule
 * changed, never that Postgres wasn't running.
 */

// --------------------------------------------------------------- parsing --

test('a combo handle splits into its members, canonicalised the way stats are keyed', () => {
  assert.deepEqual(comboParts('Bin + Xun + knight'), ['bin', 'xun', 'knight']);
  // The parts must fold exactly as canonHandle folds a stat source's name, or
  // the join to map_stat silently finds nothing and the combo reads as "no
  // history" forever.
  assert.deepEqual(comboParts('Rookie + JiaQi'), [canonHandle('Rookie'), canonHandle('JiaQi')]);
});

test('spacing and case around the separator do not change the members', () => {
  assert.deepEqual(comboParts('knight+Viper'), ['knight', 'viper']);
  assert.deepEqual(comboParts('  Shanks   +   Hope  '), ['shanks', 'hope']);
});

test('a single-player handle is not a combo, whatever the book flagged it as', () => {
  // PrizePicks set combo:true on `eraa`, a single CS2 player, on 2026-09-07.
  // Believing it cost that market its cross-book match and its grade. The name
  // has one player in it, so it is one player.
  assert.deepEqual(comboParts('eraa'), []);
  assert.equal(isComboHandle('eraa'), false);
  assert.equal(isComboHandle('Bin + Xun + knight'), true);
});

test('a name that only looks like a combo yields no members rather than one', () => {
  // A trailing separator would otherwise produce a one-element list, and a
  // one-member "combo" would be graded as a single player under a name that
  // is not that player's.
  assert.deepEqual(comboParts('C9+'), []);
  assert.deepEqual(comboParts('+'), []);
  assert.deepEqual(comboParts(''), []);
  assert.deepEqual(comboParts(null), []);
});

test('a repeated member is refused, not deduped and not double-counted', () => {
  // Whichever way this were resolved it would be a guess worth a whole
  // player's output, in opposite directions. No members means no call and no
  // grade, which is the only answer that cannot be wrong about money.
  assert.deepEqual(comboParts('knight + knight'), []);
});

// ----------------------------------------------------- combining history --

const PARTS = ['a', 'b'];

function row(
  series: string, map: number, handle: string, value: number | null, at = '2026-09-01T00:00:00Z',
): ComboStatRow {
  return { series_key: series, map_number: map, canon_handle: handle, value, played_at: at };
}

test('a combo map total is the members added together', () => {
  const rows = [row('s1', 1, 'a', 5), row('s1', 2, 'a', 6), row('s1', 1, 'b', 3), row('s1', 2, 'b', 4)];
  const f = foldCombo(PARTS, rows, 1, 2);
  assert.deepEqual(f.totals, [18]);         // (5+3) + (6+4)
  assert.deepEqual(f.mapValues, [8, 10]);
});

test('a map missing one member is not a partial total — it is not a total at all', () => {
  // The whole failure mode of a combo: b has no line for map 2, so the map 2
  // combo total is unknown. Summing a alone would report 5+3+6 = 14 against a
  // line built for two players and hand the under a free win on every combo
  // where a source is incomplete.
  const rows = [row('s1', 1, 'a', 5), row('s1', 2, 'a', 6), row('s1', 1, 'b', 3)];
  const f = foldCombo(PARTS, rows, 1, 2);
  assert.deepEqual(f.totals, []);
  assert.deepEqual(f.mapValues, [8]);       // map 1 is complete and still counts
});

test('a series that did not play the whole range contributes no range total', () => {
  // The same rule the single-player path uses: a 2-0 sweep can never produce a
  // three-map total, and counting it would drag every combo average down with
  // a number that could not have been bet.
  const rows = [row('s1', 1, 'a', 5), row('s1', 1, 'b', 3), row('s1', 2, 'a', 6), row('s1', 2, 'b', 4)];
  const f = foldCombo(PARTS, rows, 1, 3);
  assert.deepEqual(f.totals, []);
  assert.deepEqual(f.mapValues, [8, 10]);   // still usable for the modelled fallback
});

test('a null stat is a hole, never a zero', () => {
  // A source that knows the map happened but not this stat must not make the
  // member worth nothing.
  const rows = [row('s1', 1, 'a', 5), row('s1', 1, 'b', null)];
  const f = foldCombo(PARTS, rows, 1, 1);
  assert.deepEqual(f.totals, []);
  assert.deepEqual(f.mapValues, []);
});

test('one member reported twice for one map counts once', () => {
  // Two sources describing the same real map is the normal state of LoL data.
  // Adding both copies would inflate the combo by a whole player.
  const rows = [row('s1', 1, 'a', 5), row('s1', 1, 'a', 5), row('s1', 1, 'b', 3)];
  const f = foldCombo(PARTS, rows, 1, 1);
  assert.deepEqual(f.mapValues, [8]);
});

test('a handle that is not a member is ignored', () => {
  // The query fetches by member list, but a canon handle collision or a stray
  // row must not be able to inflate a total.
  const rows = [row('s1', 1, 'a', 5), row('s1', 1, 'b', 3), row('s1', 1, 'z', 99)];
  const f = foldCombo(PARTS, rows, 1, 1);
  assert.deepEqual(f.mapValues, [8]);
});

test('series come back most recent first, so the sample is the latest form', () => {
  const rows = [
    row('old', 1, 'a', 1, '2026-01-01T00:00:00Z'), row('old', 1, 'b', 1, '2026-01-01T00:00:00Z'),
    row('new', 1, 'a', 9, '2026-06-01T00:00:00Z'), row('new', 1, 'b', 9, '2026-06-01T00:00:00Z'),
  ];
  const f = foldCombo(PARTS, rows, 1, 1);
  assert.deepEqual(f.totals, [18, 2]);
});

test('fewer than two members produces nothing, so a mis-parsed name cannot project', () => {
  const rows = [row('s1', 1, 'a', 5)];
  assert.deepEqual(foldCombo(['a'], rows, 1, 1), { totals: [], mapValues: [] });
  assert.deepEqual(foldCombo([], rows, 1, 1), { totals: [], mapValues: [] });
});

/**
 * The reason this fold exists rather than a sum of per-player distributions.
 *
 * Means add under any dependence, so the projected total — and therefore the
 * EDGE — is the same either way. Variances only add under independence, and
 * every combo on this board is several players in one match. Measured over the
 * eight LoL combos on 2026-09-07, across each one's full joint history, the
 * real per-map combo spread was 1.06x to 1.18x what independence implies:
 * teammates' kills move together.
 *
 * That is not an academic point. `edgeSd` and hit rate are both computed from
 * the spread, and both feed the ranking, so an understated spread would float
 * every combo above the single-player markets it competes with.
 */
test('the joint total carries correlation an independent sum would lose', () => {
  // Two players who always have a good map together or a bad one together.
  // Independently, each has sd 3; summed independently that implies
  // sqrt(9+9) = 4.24. Observed together it is 6 — half again as wide.
  const at = (i: number) => `2026-0${i}-01T00:00:00Z`;
  const rows: ComboStatRow[] = [];
  [
    [2, 2], [8, 8], [2, 2], [8, 8],
  ].forEach(([av, bv], i) => {
    rows.push(row(`s${i}`, 1, 'a', av!, at(i + 1)), row(`s${i}`, 1, 'b', bv!, at(i + 1)));
  });
  const f = foldCombo(PARTS, rows, 1, 1);
  const mean = f.mapValues.reduce((x, y) => x + y, 0) / f.mapValues.length;
  const sd = Math.sqrt(
    f.mapValues.reduce((x, y) => x + (y - mean) ** 2, 0) / (f.mapValues.length - 1),
  );
  assert.equal(mean, 10);
  const perPlayerSd = Math.sqrt(((2 - 5) ** 2 * 2 + (8 - 5) ** 2 * 2) / 3);
  const independent = Math.sqrt(perPlayerSd ** 2 * 2);
  assert.ok(sd > independent, `joint sd ${sd} should exceed independent ${independent}`);
});

// ------------------------------------------------------------- grading ----

test('a combo grades to the sum of every member over every map in the range', () => {
  const rows = [row('s1', 1, 'a', 5), row('s1', 2, 'a', 6), row('s1', 1, 'b', 3), row('s1', 2, 'b', 4)];
  assert.deepEqual(comboRangeTotal(PARTS, rows, 1, 2), { kind: 'total', total: 18 });
});

test('an unplayed map in the range voids the combo, exactly as for one player', () => {
  // A Bo3 that ends 2-0 never plays map 3. The book refunds it; grading the
  // two-map total would invent a result.
  const rows = [row('s1', 1, 'a', 5), row('s1', 1, 'b', 3), row('s1', 2, 'a', 6), row('s1', 2, 'b', 4)];
  const g = comboRangeTotal(PARTS, rows, 1, 3);
  assert.equal(g.kind, 'void');
});

test('a map that was played but is missing a member is ungradeable, not short', () => {
  // b was subbed out after map 1. The map happened, so this is not a void; the
  // total is unknown, so it is not 11 either.
  const rows = [row('s1', 1, 'a', 5), row('s1', 1, 'b', 3), row('s1', 2, 'a', 6)];
  const g = comboRangeTotal(PARTS, rows, 1, 2);
  assert.equal(g.kind, 'ungradeable');
  assert.match(g.kind === 'ungradeable' ? g.note : '', /b/);
});

test('a member with a null stat is ungradeable, never counted as zero', () => {
  const rows = [row('s1', 1, 'a', 5), row('s1', 1, 'b', null)];
  const g = comboRangeTotal(PARTS, rows, 1, 1);
  assert.equal(g.kind, 'ungradeable');
});

test('void beats ungradeable when the range has both problems', () => {
  // Map 2 is missing a member AND map 3 was never played. The book refunds an
  // unplayed map whatever else is wrong, so void is the answer that matches
  // what actually happens to the money.
  const rows = [
    row('s1', 1, 'a', 5), row('s1', 1, 'b', 3),
    row('s1', 2, 'a', 6),
  ];
  assert.equal(comboRangeTotal(PARTS, rows, 1, 3).kind, 'void');
});

test('maps outside the range never reach the total', () => {
  const rows = [
    row('s1', 1, 'a', 5), row('s1', 1, 'b', 3),
    row('s1', 2, 'a', 100), row('s1', 2, 'b', 100),
  ];
  assert.deepEqual(comboRangeTotal(PARTS, rows, 1, 1), { kind: 'total', total: 8 });
});

test('a combo we could not split into players is refused rather than guessed', () => {
  assert.equal(comboRangeTotal([], [], 1, 2).kind, 'ungradeable');
  assert.equal(comboRangeTotal(['a'], [row('s1', 1, 'a', 5)], 1, 1).kind, 'ungradeable');
});
