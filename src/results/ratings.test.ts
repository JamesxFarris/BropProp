import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Elo, ELO_DEFAULTS, expected, pSeries, winsDistribution, runElo, movMultiplier,
  fitTemperature, fitOffsetLogistic, logistic, logit, type RatedSeries,
} from './ratings.js';
import { mulberry32 } from './referee.js';

const near = (got: number, want: number, tol: number, what = '') =>
  assert.ok(Math.abs(got - want) < tol, `${what} expected ~${want}, got ${got}`);

test('pSeries: Bo1 is the map, Bo3/Bo5 textbook values, even n is undefined', () => {
  near(pSeries(0.6, 1), 0.6, 1e-12);
  near(pSeries(0.6, 3), 0.36 * (3 - 1.2), 1e-12, 'p²(3−2p)');
  near(pSeries(0.6, 5), 0.6 ** 3 * (10 - 15 * 0.6 + 6 * 0.36), 1e-12, 'p³(10−15p+6p²)');
  near(pSeries(0.5, 5), 0.5, 1e-12);
  assert.ok(Number.isNaN(pSeries(0.6, 2)));
  assert.ok(pSeries(0.7, 5) > pSeries(0.7, 3) && pSeries(0.7, 3) > 0.7, 'longer series favour the favourite');
});

test('winsDistribution sums to 1 and matches p², 2pq, q²', () => {
  const d = winsDistribution(0.7, 2);
  near(d[0]!, 0.09, 1e-12); near(d[1]!, 0.42, 1e-12); near(d[2]!, 0.49, 1e-12);
  near(winsDistribution(0.33, 5).reduce((a, x) => a + x, 0), 1, 1e-12);
});

test('Elo: equal teams are 50/50 and a win moves both by K/2 (after provisional period)', () => {
  const e = new Elo({ ...ELO_DEFAULTS, provisionalBoost: 1 });
  near(e.pMap('A', 'B', 0), 0.5, 1e-12);
  e.update('A', 'B', 0);
  near(e.rating('A', 0), 16, 1e-9);
  near(e.rating('B', 0), -16, 1e-9);
  near(e.pMap('A', 'B', 0), expected(32), 1e-12);
});

test('Elo: provisional boost doubles K on a first map and fades to 1', () => {
  const e = new Elo({ ...ELO_DEFAULTS, provisionalBoost: 2, provisionalMaps: 10 });
  e.update('A', 'B', 0);
  near(e.rating('A', 0), 32, 1e-9, 'first map at 2K');
  const f = new Elo({ ...ELO_DEFAULTS, provisionalBoost: 2, provisionalMaps: 10 });
  for (let i = 0; i < 10; i++) { f.update('X', `opp${i}`, 0); }
  const before = f.rating('X', 0);
  f.update('X', 'fresh', 0);
  // X is past its provisional maps: its gain uses plain K.
  near(f.rating('X', 0) - before, 32 * (1 - expected(before - 0)), 1e-9);
});

test('Elo: decay halves an idle rating per half-life, and never touches the stored value', () => {
  const e = new Elo({ ...ELO_DEFAULTS, halfLifeDays: 100, provisionalBoost: 1 });
  e.update('A', 'B', 0);
  near(e.rating('A', 100 * 86_400_000), 8, 1e-9);
  near(e.rating('A', 0), 16, 1e-9);
});

test('movMultiplier: off is 1, the typical margin is ~1 at an even gap', () => {
  assert.equal(movMultiplier(12, 6, 0, 0), 1);
  near(movMultiplier(6, 6, 0, 1), 1, 1e-12);
  assert.ok(movMultiplier(13, 6, 0, 1) > movMultiplier(2, 6, 0, 1));
  assert.ok(movMultiplier(13, 6, 300, 1) < movMultiplier(13, 6, 0, 1), 'favourite blowouts are damped');
});

test('runElo: a series never sees its own result, but the next one does', () => {
  const s = (key: string, at: number, winner: string): RatedSeries =>
    ({ key, at, a: 'A', b: 'B', maps: [{ winner, diff: 5 }, { winner, diff: 5 }] });
  const r1 = runElo([s('s1', 1, 'A'), s('s2', 2, 'A')], ELO_DEFAULTS, 6);
  const r2 = runElo([s('s1', 1, 'B'), s('s2', 2, 'A')], ELO_DEFAULTS, 6);
  near(r1.pre.get('s1')!.pMapA, 0.5, 1e-12);
  near(r2.pre.get('s1')!.pMapA, 0.5, 1e-12, 'flipping s1 must not change s1 pre-match');
  assert.ok(r1.pre.get('s2')!.pMapA > 0.5 && r2.pre.get('s2')!.pMapA < 0.5);
});

test('runElo: probes read ratings as of their time, before a simultaneous series', () => {
  const series: RatedSeries[] = [
    { key: 'x', at: 10, a: 'A', b: 'B', maps: [{ winner: 'A', diff: 5 }] },
    { key: 'y', at: 20, a: 'A', b: 'B', maps: [{ winner: 'A', diff: 5 }] },
  ];
  const r = runElo(series, ELO_DEFAULTS, 6, [{ at: 5, a: 'A', b: 'B' }, { at: 20, a: 'A', b: 'B' }, { at: 99, a: 'A', b: 'B' }]);
  near(r.probes[0]!.pMapA, 0.5, 1e-12);
  near(r.probes[1]!.pMapA, r.pre.get('y')!.pMapA, 1e-12, 'probe at 20 = pre-match of series at 20');
  assert.ok(r.probes[2]!.pMapA > r.probes[1]!.pMapA);
});

test('runElo: ratings learn a planted strength order', () => {
  const rnd = mulberry32(7);
  const truth: Record<string, number> = { T0: 300, T1: 150, T2: 0, T3: -150, T4: -300 };
  const names = Object.keys(truth);
  const series: RatedSeries[] = [];
  for (let i = 0; i < 3000; i++) {
    const a = names[Math.floor(rnd() * 5)]!;
    let b = a; while (b === a) b = names[Math.floor(rnd() * 5)]!;
    const winner = rnd() < expected(truth[a]! - truth[b]!) ? a : b;
    series.push({ key: `s${i}`, at: i, a, b, maps: [{ winner, diff: 5 }] });
  }
  const { elo } = runElo(series, { ...ELO_DEFAULTS, k: 16 }, 6);
  const order = [...names].sort((x, y) => elo.rating(y, 1e9) - elo.rating(x, 1e9));
  assert.deepEqual(order, names);
});

test('fitTemperature recovers a planted over-confidence', () => {
  const rnd = mulberry32(11);
  const xs = Array.from({ length: 20000 }, () => {
    const trueLogit = (rnd() - 0.5) * 4;
    const y = rnd() < logistic(trueLogit);
    return { p: logistic(trueLogit * 2), y }; // claims twice the true logit
  });
  near(fitTemperature(xs), 0.5, 0.05);
});

test('fitOffsetLogistic recovers a planted coefficient on top of an offset', () => {
  const rnd = mulberry32(3);
  const rows = Array.from({ length: 30000 }, () => {
    const offset = logit(0.3 + 0.4 * rnd());
    const x = [rnd() - 0.5, rnd() - 0.5];
    const y = rnd() < logistic(offset + 1.5 * x[0]! - 0.8 * x[1]!);
    return { offset, x, y };
  });
  const b = fitOffsetLogistic(rows);
  near(b[0]!, 1.5, 0.12); near(b[1]!, -0.8, 0.12);
});
