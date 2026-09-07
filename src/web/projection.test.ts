import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, recommend, edgeProgress, type FormStats, type LineOption } from './projection.js';
import { foldCombo, type ComboStatRow } from '../combo.js';

/**
 * The verdict, and the reasons behind it.
 *
 * `evaluate` decides two things that matter: which side to take, and — when it
 * takes none — which KIND of "no" that is. The second is not cosmetic. It is
 * what the board sorts on and what the Show filter hides on, so getting it
 * wrong hides live markets or keeps inert ones at the top. A market the model
 * priced as fair is one line move from a call; a market with no stat history
 * cannot become one however far the line moves, and calling both "no edge"
 * made 386 of 465 rows look like a judgement when they were a data gap.
 *
 * No database: every input is a literal.
 */

const form = (o: Partial<FormStats> = {}): FormStats => ({
  series: 0, mean: 0, sd: null, totals: [], mapValues: [], perMap: null, ...o,
});

/** A form built from twelve identical whole-range series, so the mean is exact. */
const flat = (value: number, n = 12): FormStats => {
  const totals = Array.from({ length: n }, () => value);
  return form({ series: n, mean: value, sd: 0, totals, mapValues: totals, perMap: value });
};

const both = (book: 'prizepicks' | 'underdog', line: number): LineOption =>
  ({ book, line, overOk: true, underOk: true });

// ------------------------------------------------------------- refusals ---

test('a stat with no stored column is named as such, not as missing history', () => {
  // Fantasy points use a formula the books do not publish. Reporting it as "no
  // history" invites someone to go looking for data that would not help.
  const s = evaluate({ form: flat(20), options: [both('prizepicks', 10)], stat: 'fantasy_points' });
  assert.equal(s.play, null);
  assert.deepEqual(s.why, { kind: 'unsupported' });
});

test('a combo whose handle cannot be split is unreadable, not empty', () => {
  const s = evaluate({ form: flat(20), options: [both('prizepicks', 10)], handle: 'A + A' });
  assert.deepEqual(s.why, { kind: 'unreadable' });
});

test('a splittable combo handle is not itself a refusal', () => {
  const s = evaluate({ form: flat(20), options: [both('prizepicks', 10)], handle: 'A + B' });
  assert.ok(s.play, 'a combo with form and an edge must be able to produce a call');
});

test('no form at all is "none"; some form below the floor is "thin"', () => {
  assert.deepEqual(evaluate({ form: undefined, options: [both('prizepicks', 10)] }).why, { kind: 'none' });
  // Five whole-range series is under MIN_SERIES and eleven maps under MIN_MAPS,
  // so neither path opens — but this is a player we have data on, and saying
  // "no history" about them would be false.
  const thin = form({ series: 5, totals: [1, 2, 3, 4, 5], mapValues: Array(11).fill(3) });
  assert.deepEqual(evaluate({ form: thin, options: [both('prizepicks', 10)] }).why, {
    kind: 'thin', series: 5, maps: 11,
  });
});

test('a market with neither side offered is unavailable, whatever the edge', () => {
  // Underdog lists every LoL assists market higher-only and PrizePicks promos
  // are over-only. A huge edge on a side no book accepts is not a call.
  const s = evaluate({
    form: flat(30),
    options: [{ book: 'prizepicks', line: 10, overOk: false, underOk: false }],
  });
  assert.deepEqual(s.why, { kind: 'unavailable' });
});

test('an evaluated market under MIN_EDGE reports the edge it actually found', () => {
  // The number is the whole point of separating this from "no history": 0.4
  // off is one line move from a call and 2.0 off is not, and the board sorts
  // on the difference.
  const s = evaluate({ form: flat(10.1), options: [both('prizepicks', 10)] });
  assert.equal(s.play, null);
  assert.equal(s.why?.kind, 'fair');
  assert.ok(s.why!.kind === 'fair' && Math.abs(s.why.edge - 0.1) < 1e-9);
});

test('MIN_EDGE is a floor, not a suggestion', () => {
  // Half a unit is inside the rounding of a line, so 0.49 must not call and
  // 0.51 must. This threshold is the difference between a board with edges on
  // it and a board with an opinion about every row.
  assert.equal(evaluate({ form: flat(10.49), options: [both('prizepicks', 10)] }).play, null);
  assert.ok(evaluate({ form: flat(10.51), options: [both('prizepicks', 10)] }).play);
});

test('edgeProgress says how close a fair market is to being a call', () => {
  // 1.0 is exactly at the threshold, so the board can sort near-misses first.
  assert.equal(edgeProgress(0.5), 1);
  assert.equal(edgeProgress(0.25), 0.5);
  assert.equal(edgeProgress(-3), 0);
});

// ------------------------------------------------------ side and book -----

test('an over takes the lowest line and an under the highest, across books', () => {
  const over = evaluate({ form: flat(40), options: [both('prizepicks', 30), both('underdog', 28)] });
  assert.equal(over.play?.side, 'over');
  assert.equal(over.play?.book, 'underdog');   // the cheaper over

  const under = evaluate({ form: flat(10), options: [both('prizepicks', 30), both('underdog', 28)] });
  assert.equal(under.play?.side, 'under');
  assert.equal(under.play?.book, 'prizepicks'); // the roomier under
});

test('recommend is evaluate without the reason, so both cannot drift apart', () => {
  const args = { form: flat(40), options: [both('prizepicks', 30)] };
  assert.deepEqual(recommend(args.form, args.options), evaluate(args).play);
});

// ------------------------------------------------------------- combos -----

/**
 * A combo reaches the same engine as a single player, by way of a FormStats
 * built from joint history. These pin the join between the two halves.
 */
function rows(series: string, at: string, perMap: [number, number][]): ComboStatRow[] {
  const out: ComboStatRow[] = [];
  perMap.forEach(([a, b], i) => {
    out.push({ series_key: series, map_number: i + 1, canon_handle: 'a', value: a, played_at: at });
    out.push({ series_key: series, map_number: i + 1, canon_handle: 'b', value: b, played_at: at });
  });
  return out;
}

function comboForm(all: ComboStatRow[], mapStart: number, mapEnd: number): FormStats {
  const { totals, mapValues } = foldCombo(['a', 'b'], all, mapStart, mapEnd);
  const n = totals.length;
  const mean = n ? totals.reduce((x, y) => x + y, 0) / n : 0;
  const sd = n > 1
    ? Math.sqrt(totals.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1))
    : null;
  const perMap = mapValues.length ? mapValues.reduce((x, y) => x + y, 0) / mapValues.length : null;
  return { series: n, mean, sd, totals, mapValues, perMap };
}

test('a combo projects from joint totals and calls the side its members support', () => {
  const all: ComboStatRow[] = [];
  for (let i = 0; i < 8; i++) {
    // 10 + 10 = 20 per map, two maps, so 40 over maps 1-2 every time.
    all.push(...rows(`s${i}`, `2026-0${(i % 9) + 1}-01T00:00:00Z`, [[10, 10], [10, 10]]));
  }
  const f = comboForm(all, 1, 2);
  assert.equal(f.series, 8);
  assert.equal(f.mean, 40);

  const s = evaluate({ form: f, options: [both('prizepicks', 35)], maps: 2, handle: 'A + B' });
  assert.equal(s.play?.side, 'over');
  assert.equal(s.play?.edge, 5);
  assert.equal(s.play?.method, 'series');
});

test('the combo mean is the sum of the members means — that part IS independent of correlation', () => {
  // E[X+Y] = E[X] + E[Y] under any dependence, so the projected total and the
  // edge are unaffected by the thing joint history is here to capture. What
  // the joint history fixes is the SPREAD, and therefore the ranking. This is
  // pinned because it is the claim the whole approach rests on.
  const at = (i: number) => `2026-0${i + 1}-01T00:00:00Z`;
  const pairs: [number, number][][] = [
    [[2, 12]], [[12, 2]], [[2, 12]], [[12, 2]], [[7, 7]], [[7, 7]], [[7, 7]], [[7, 7]],
  ];
  const all = pairs.flatMap((p, i) => rows(`s${i}`, at(i), p));
  const f = comboForm(all, 1, 1);
  const meanA = pairs.reduce((x, p) => x + p[0]![0], 0) / pairs.length;
  const meanB = pairs.reduce((x, p) => x + p[0]![1], 0) / pairs.length;
  assert.equal(f.mean, meanA + meanB);
  // ...and here the members are strongly NEGATIVELY correlated, so the joint
  // spread is far tighter than independence would imply. An independent sum
  // would have inflated the spread and understated every edgeSd on this row.
  assert.equal(f.sd, 0);
});

test('a combo with too few whole-range series falls back to modelling from joint maps', () => {
  // Five whole-range series is under MIN_SERIES; the same games supply 15
  // joint maps, which is over MIN_MAPS. The fallback resamples MAP totals that
  // already contain the cross-player correlation, so it drops the
  // maps-are-interchangeable assumption's cost only, not the correlation.
  const all: ComboStatRow[] = [];
  for (let i = 0; i < 5; i++) all.push(...rows(`s${i}`, `2026-0${i + 1}-01T00:00:00Z`, [[5, 5], [5, 5], [5, 5]]));
  const f = comboForm(all, 1, 3);
  assert.equal(f.series, 5);
  assert.equal(f.mapValues.length, 15);

  const s = evaluate({ form: f, options: [both('prizepicks', 25)], maps: 3, handle: 'A + B' });
  assert.equal(s.play?.method, 'maps');
  assert.equal(s.play?.side, 'over');   // 30 modelled against a 25 line
});

test('a combo whose members never played together makes no call', () => {
  // The weakest-link rule, stated as an outcome: no joint observation means no
  // sample, and no sample means no call. Nothing here falls back to summing
  // the two players independently, which is exactly the point.
  const apart: ComboStatRow[] = [
    { series_key: 's1', map_number: 1, canon_handle: 'a', value: 10, played_at: '2026-01-01T00:00:00Z' },
    { series_key: 's2', map_number: 1, canon_handle: 'b', value: 10, played_at: '2026-02-01T00:00:00Z' },
  ];
  const f = comboForm(apart, 1, 1);
  assert.equal(f.series, 0);
  assert.equal(f.mapValues.length, 0);
  assert.equal(evaluate({ form: f, options: [both('prizepicks', 5)], handle: 'A + B' }).play, null);
});
