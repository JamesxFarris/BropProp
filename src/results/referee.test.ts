import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brier, logLoss, auc, reliability, clusterBootstrap, signTest, seriesVote,
  perLegBreakEven, edgeTable, roiOf, type Pred,
} from './referee.js';

const near = (got: number, want: number, tol: number, what = '') =>
  assert.ok(Math.abs(got - want) < tol, `${what} expected ~${want}, got ${got}`);

const leg = (series: string, p: number, won: boolean): Pred => ({ series, p, won });

test('a coin-flip forecaster scores the textbook values', () => {
  const ps = [leg('a', 0.5, true), leg('b', 0.5, false), leg('c', 0.5, true), leg('d', 0.5, false)];
  near(brier(ps), 0.25, 1e-12);
  near(logLoss(ps), Math.LN2, 1e-9);
  near(auc(ps), 0.5, 1e-12, 'all ties is no ordering');
});

test('AUC: perfect, reversed, and one inversion', () => {
  const perfect = [leg('a', 0.9, true), leg('b', 0.8, true), leg('c', 0.2, false), leg('d', 0.1, false)];
  near(auc(perfect), 1, 1e-12);
  near(auc(perfect.map((x) => ({ ...x, won: !x.won }))), 0, 1e-12);
  const one = [leg('a', 0.9, true), leg('b', 0.3, true), leg('c', 0.5, false), leg('d', 0.1, false)];
  near(auc(one), 0.75, 1e-12, '3 of 4 pos/neg pairs ordered');
});

test('reliability bins cover every leg once', () => {
  const ps = Array.from({ length: 100 }, (_, i) => leg(`s${i}`, i / 100, i % 2 === 0));
  const bins = reliability(ps, 10);
  assert.equal(bins.reduce((a, b) => a + b.n, 0), 100);
  assert.ok(bins.every((b, i) => i === 0 || b.lo >= bins[i - 1]!.hi));
});

test('the bootstrap resamples series, not legs', () => {
  // One series of 50 wins and 50 series of one loss each: at the leg level the
  // win rate looks like 50%, but it is one lucky match. The interval must be
  // wide, because only 51 independent units exist.
  const ps: Pred[] = [];
  for (let i = 0; i < 50; i++) ps.push(leg('lucky', 0.6, true));
  for (let i = 0; i < 50; i++) ps.push(leg(`s${i}`, 0.6, false));
  const hit = (s: Pred[]) => s.filter((x) => x.won).length / s.length;
  const b = clusterBootstrap(ps, hit, 1000);
  assert.equal(b.series, 51);
  near(b.point, 0.5, 1e-12);
  assert.ok(b.hi - b.lo > 0.4, `interval ${b.lo}–${b.hi} should be very wide`);
});

test('sign test and series vote', () => {
  near(signTest(5, 10), 1, 1e-9);
  near(signTest(10, 10), 2 * 0.5 ** 10, 1e-12);
  const v = seriesVote([leg('a', 0.6, true), leg('a', 0.6, true), leg('a', 0.6, false), leg('b', 0.6, false), leg('c', 0.6, true), leg('c', 0.6, false)]);
  assert.deepEqual([v.up, v.down], [1, 1], 'c splits evenly and casts no vote');
});

test('break-even follows the Power ladder', () => {
  near(perLegBreakEven(3), 6 ** (-1 / 3), 1e-12);
  near(perLegBreakEven(5), 20 ** (-1 / 5), 1e-12);
  assert.throws(() => perLegBreakEven(9));
});

test('ROI is zero at the break-even and the edge table filters by margin', () => {
  const be = 0.55;
  const ps = Array.from({ length: 100 }, (_, i) => leg(`s${i}`, 0.6, i < 55));
  near(roiOf(be)(ps), 0, 1e-12);
  const rows = edgeTable(ps, be, [0, 0.1]);
  assert.equal(rows[0]!.legs, 100);
  assert.equal(rows[1]!.legs, 0, 'nothing clears a 10-point edge at p = 0.6');
});
