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

/**
 * These three used to pin an absolute half-a-kill floor. That floor is gone:
 * it was the wrong shape (0.5 against a 30.5 line is a 1.6% claim and against
 * a 5.5 line a 9% one, and the board treated them alike — DESIGN.md had it
 * logged as an open question), and it selected sides by comparing a mean to a
 * line, which on a right-skewed distribution favours the over even when the
 * over is the losing side. They are rewritten here in the terms that replaced
 * it rather than deleted, because the intent behind each still holds.
 */

test('a market the history splits near evenly is fair, and reports how close it came', () => {
  // Seven of twelve is a 58% record, which shrinks to under the threshold.
  // The `p` is reported anyway, because a market two points short is one line
  // move from live and the board sorts those first.
  const near = form({
    series: 12, totals: [9, 9, 9, 9, 9, 9, 9, 2, 2, 2, 2, 2], mean: 6.08, sd: 3.4,
  });
  const s = evaluate({ form: near, options: [both('prizepicks', 5.5)] });
  assert.equal(s.play, null);
  assert.equal(s.why?.kind, 'fair');
  assert.ok(s.why!.kind === 'fair' && s.why.p > 0.5 && s.why.p < 0.55, `got ${(s.why as any).p}`);
});

test('the confidence threshold is a floor, not a suggestion', () => {
  // Nine of twelve clears it; seven of twelve does not. The difference between
  // a board with edges on it and a board with an opinion about every row.
  const nine = form({ series: 12, totals: [9,9,9,9,9,9,9,9,9,2,2,2], mean: 7.25, sd: 3.2 });
  const seven = form({ series: 12, totals: [9,9,9,9,9,9,9,2,2,2,2,2], mean: 6.08, sd: 3.4 });
  assert.ok(evaluate({ form: nine, options: [both('prizepicks', 5.5)] }).play);
  assert.equal(evaluate({ form: seven, options: [both('prizepicks', 5.5)] }).play, null);
});

test('edgeProgress says how close a fair market is to being a call', () => {
  // Measured in probability now, since that is what the threshold is. 1.0 is
  // exactly at it, so the board can sort near-misses first.
  assert.equal(edgeProgress(0.55), 1);
  assert.ok(Math.abs(edgeProgress(0.525) - 0.5) < 1e-9);
  assert.equal(edgeProgress(0.4), 0);
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

/**
 * A total landing exactly on the line is a push, not a loss.
 *
 * Fifteen percent of PrizePicks lines are whole numbers, and across those
 * markets' history 7.4% of series land exactly on the number. The grader has
 * always known this — `grade.ts` returns `push` and the leg is refunded — but
 * the projection was counting the same total as a loss for both sides, which
 * understated hit rate on every whole-number market and pushed it down a board
 * that ranks on hit rate. Two places, one question, two answers.
 */

test('a total exactly on the line is excluded, not counted as a loss', () => {
  // Two samples of the same size, identical except that in one the two series
  // that landed exactly on 20 are pushes, and in the other they are losses.
  // Same size means the same shrink, so any difference in the reported rate is
  // the push handling and nothing else.
  const withPushes = form({
    series: 12, totals: [30, 28, 26, 25, 24, 23, 22, 21, 20, 20, 15, 14], mean: 23.2, sd: 4.6,
  });
  const asLosses = form({
    series: 12, totals: [30, 28, 26, 25, 24, 23, 22, 21, 15, 15, 15, 14], mean: 21.5, sd: 5.4,
  });
  const opts: LineOption[] = [{ book: 'prizepicks', line: 20, overOk: true, underOk: true }];
  const a = evaluate({ form: withPushes, options: opts, maps: 1 });
  const b = evaluate({ form: asLosses, options: opts, maps: 1 });
  assert.ok(a.play && b.play, 'both should be calls');
  assert.ok(
    a.play.hitRate > b.play.hitRate,
    `a pushed series must not count against the side: ${a.play.hitRate} vs ${b.play.hitRate}`,
  );
});

test('a half-point line has no pushes, and is damped but still a call', () => {
  // Nothing can land on 20.5, so every series settles. Six of eight is a 75%
  // record; it must stay a call and must NOT be reported as 75%.
  const f = form({
    series: 8, totals: [25, 24, 23, 22, 21, 21, 13, 12], mean: 20.1, sd: 5,
  });
  const r = evaluate({
    form: f,
    options: [{ book: 'prizepicks', line: 20.5, overOk: true, underOk: true }],
    maps: 1,
  });
  assert.ok(r.play, 'six of eight should clear the threshold');
  assert.ok(r.play.hitRate > 0.55, `still a call: ${r.play.hitRate}`);
  assert.ok(r.play.hitRate < 0.75, `but damped below the raw record: ${r.play.hitRate}`);
});

test('a market that only ever pushed reports no hit rate rather than dividing by zero', () => {
  // Degenerate, but it is the one input that would produce NaN and put a
  // silently broken number on the board.
  const f = form({ series: 6, totals: [20, 20, 20, 20, 20, 20], mean: 20, sd: 0 });
  const r = evaluate({
    form: f,
    options: [{ book: 'prizepicks', line: 20, overOk: true, underOk: true }],
    maps: 1,
  });
  // Every series pushed, so there is no edge either way and no call to make.
  assert.equal(r.play, null);
});

/**
 * Picking a side by probability rather than by the mean.
 *
 * Kill counts are right-skewed: measured across 239 CS2 players and 18,712
 * series, 53.3% of a player's series land BELOW their own mean, and mean minus
 * median averages +0.55 kills. So a line set near the median sits below the
 * mean, and selecting a side by `mean - line` recommended the over on markets
 * where the over was more likely to lose. On a live board that produced 77.4%
 * over calls, and lines moved AWAY from our picks 72% of the time — 0 of 6 on
 * the highest-scoring ones.
 *
 * The side is now chosen by the share of a player's own history that would
 * actually have won it, shrunk toward a coin flip by how little history there
 * is. That also makes the threshold proportional: 54% means the same thing on
 * a 5.5 line and a 30.5 line, which half a kill never did.
 */

test('a right-skewed sample does not get called over just because the mean is high', () => {
  // Twelve series. Nine land at 8, three spike to 30 — a classic esports
  // distribution. Mean is 13.5, well above a line of 10, so the old
  // mean-minus-line rule called the over. But only 3 of 12 series actually
  // cleared 10: the over loses three times out of four.
  const totals = [30, 30, 30, 8, 8, 8, 8, 8, 8, 8, 8, 8];
  const f = form({ series: 12, totals, mean: 13.5, sd: 10 });
  const r = evaluate({
    form: f,
    options: [{ book: 'underdog', line: 10, overOk: true, underOk: true }],
    maps: 1,
  });
  assert.notEqual(r.play?.side, 'over', 'the over loses 9 times in 12 and must not be the call');
});

test('the under is called when the history actually supports it', () => {
  // Same sample, and the under is the side that wins 9 of 12.
  const totals = [30, 30, 30, 8, 8, 8, 8, 8, 8, 8, 8, 8];
  const f = form({ series: 12, totals, mean: 13.5, sd: 10 });
  const r = evaluate({
    form: f,
    options: [{ book: 'underdog', line: 10, overOk: true, underOk: true }],
    maps: 1,
  });
  assert.equal(r.play?.side, 'under');
});

test('a perfect record on a thin sample is not reported as near-certain', () => {
  // Six from six is 100% observed. It is not a 100% chance, and a board that
  // says so will be believed. Shrinking toward a coin flip by sample size is
  // what stops six games outranking sixty.
  const f = form({ series: 6, totals: [20, 20, 20, 20, 20, 20], mean: 20, sd: 0.1 });
  const r = evaluate({
    form: f,
    options: [{ book: 'underdog', line: 10, overOk: true, underOk: true }],
    maps: 1,
  });
  assert.ok(r.play, 'six clear wins should still be a call');
  assert.ok(r.play.hitRate < 0.9, `a 6-game sweep must be damped, got ${r.play.hitRate}`);
  assert.ok(r.play.hitRate > 0.5, `but it should still favour the winning side, got ${r.play.hitRate}`);
});

test('the same record on a deep sample is damped less', () => {
  const thin = form({ series: 6, totals: Array(6).fill(20), mean: 20, sd: 0.1 });
  const deep = form({ series: 40, totals: Array(40).fill(20), mean: 20, sd: 0.1 });
  const opts: LineOption[] = [{ book: 'underdog', line: 10, overOk: true, underOk: true }];
  const a = evaluate({ form: thin, options: opts, maps: 1 });
  const b = evaluate({ form: deep, options: opts, maps: 1 });
  assert.ok(a.play && b.play);
  assert.ok(
    b.play.hitRate > a.play.hitRate,
    `40 games should earn more confidence than 6: ${b.play.hitRate} vs ${a.play.hitRate}`,
  );
});

test('the threshold is proportional, so it means the same on a big line as a small one', () => {
  // Both markets win 7 of 12. One is a 5.5 line, the other a 30.5 line. Under
  // an absolute half-a-unit rule these were wildly different claims; as a
  // probability they are the same claim and must be treated alike.
  const small = form({ series: 12, totals: [9,9,9,9,9,9,9,9,9,2,2,2], mean: 7.25, sd: 3.2 });
  const big = form({ series: 12, totals: [34,34,34,34,34,34,34,34,34,27,27,27], mean: 32.25, sd: 3.2 });
  const a = evaluate({ form: small, options: [{ book: 'underdog', line: 5.5, overOk: true, underOk: true }], maps: 1 });
  const b = evaluate({ form: big, options: [{ book: 'underdog', line: 30.5, overOk: true, underOk: true }], maps: 1 });
  assert.equal(a.play?.side, b.play?.side, 'same record, same side');
  assert.ok(a.play && b.play, 'both should be calls or neither');
  assert.ok(Math.abs(a.play.hitRate - b.play.hitRate) < 1e-9, 'and the same confidence');
});

// -------------------------------------------------------------- price -----

/**
 * What the odds demand, against what we think.
 *
 * Choosing a side by probability alone was only half the job: a 58% view is a
 * losing bet at -170, which needs 63.0%. Measured on the live board before
 * this gate existed, 15 of 80 priced calls were negative expectation, and the
 * board showed every one of them as an edge. These pin the arithmetic and the
 * refusal, both of which decide money.
 */

const priced = (
  book: 'prizepicks' | 'underdog',
  line: number,
  overPrice: number | null,
  underPrice: number | null,
): LineOption => ({ book, line, overOk: true, underOk: true, overPrice, underPrice });

test('a price the view cannot clear is refused, and says so as a price', () => {
  // Twelve straight overs shrink to ~85%, comfortably past MIN_P. At -170 the
  // bar is 63.0% and it clears; at -2000 the bar is 95.2% and it does not.
  const cheap = evaluate({ form: flat(40), options: [priced('underdog', 30, -170, 140)] });
  assert.equal(cheap.play?.side, 'over');

  const dear = evaluate({ form: flat(40), options: [priced('underdog', 30, -2000, 1500)] });
  assert.equal(dear.play, null);
  assert.equal(dear.why?.kind, 'priced-out');
  if (dear.why?.kind !== 'priced-out') throw new Error('unreachable');
  // The refusal reports the bar it failed, so the row can name the price.
  assert.ok(Math.abs(dear.why.breakEven - 2000 / 2100) < 1e-9);
  assert.ok(dear.why.p > 0.55, 'still a real view — this is a price refusal, not a thin one');
});

test('priced-out is a different answer from fair, because a price can move', () => {
  // A coin-flip view fails MIN_P and is `fair` however cheap the price.
  const flatish = form({
    series: 12, mean: 20, sd: 5,
    totals: [30, 10, 30, 10, 30, 10, 30, 10, 30, 10, 30, 10],
    mapValues: [], perMap: 20,
  });
  const s = evaluate({ form: flatish, options: [priced('underdog', 20, -110, -110)] });
  assert.equal(s.play, null);
  assert.equal(s.why?.kind, 'fair');
});

test('a call carries the break-even it beat and its expected value', () => {
  const s = evaluate({ form: flat(40), options: [priced('underdog', 30, -110, -110)] });
  assert.ok(s.play);
  assert.ok(Math.abs((s.play!.breakEven ?? 0) - 110 / 210) < 1e-9);
  // EV = p * profit - (1 - p), profit at -110 being 100/110.
  const p = s.play!.hitRate;
  assert.ok(Math.abs((s.play!.ev ?? 0) - (p * (100 / 110) - (1 - p))) < 1e-9);
  assert.ok((s.play!.ev ?? 0) > 0, 'a call that clears its bar must be positive expectation');
});

test('PrizePicks has no per-side price, so it falls back to MIN_P not to free', () => {
  // No price fields at all: the bar is our own confidence floor, and EV is
  // null rather than a number invented from a multiplier we do not know.
  const s = evaluate({ form: flat(40), options: [both('prizepicks', 30)] });
  assert.ok(s.play);
  assert.equal(s.play!.breakEven, null);
  assert.equal(s.play!.ev, null);
});

test('an expensive good line loses to a cheap slightly worse one', () => {
  // Same player, same history. Underdog's 28 is the better number for an over,
  // but at -400 it needs 80%; PrizePicks' 30 has no price to clear. Ranking on
  // probability alone would have taken the -400.
  const s = evaluate({
    form: flat(40),
    options: [both('prizepicks', 30), priced('underdog', 28, -400, 300)],
  });
  assert.equal(s.play?.side, 'over');
  assert.equal(s.play?.book, 'prizepicks');
});
