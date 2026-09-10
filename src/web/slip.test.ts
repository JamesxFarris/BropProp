import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normCdf, normInv, winCountDistribution, probAllWin, requiredMultiplier,
  slipEV, marginalLegWorthIt, RHO, type SlipLeg,
} from './slip.js';

const leg = (p: number, matchKey: string, side: 'over' | 'under' = 'over'): SlipLeg =>
  ({ p, matchKey, side });

const near = (got: number, want: number, tol: number, what = '') =>
  assert.ok(Math.abs(got - want) < tol, `${what} expected ~${want}, got ${got} (tol ${tol})`);

test('the normal helpers round-trip', () => {
  near(normCdf(0), 0.5, 1e-9);
  near(normCdf(1.959964), 0.975, 1e-6);
  near(normInv(0.975), 1.959964, 1e-6);
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) near(normCdf(normInv(p)), p, 1e-6, `p=${p}`);
});

test('legs in different matches are independent, so the product still holds', () => {
  // The one case where the old arithmetic was right. If this drifts, the model
  // has broken the easy case while chasing the hard one.
  const legs = [leg(0.6, 'a'), leg(0.55, 'b'), leg(0.5, 'c')];
  near(probAllWin(legs), 0.6 * 0.55 * 0.5, 1e-4);
});

test('the distribution sums to one and has the right length', () => {
  const d = winCountDistribution([leg(0.5, 'a'), leg(0.5, 'a'), leg(0.6, 'b')]);
  assert.equal(d.length, 4, 'k = 0..3');
  near(d.reduce((a, b) => a + b, 0), 1, 1e-6);
});

test('it reproduces the measured same-match pair rate', () => {
  // This is the anchor for the whole module. Measured over 35,702 same-match
  // CS2 pairs: two overs from one match hit 24.69% where independence at that
  // sample's 46.15% marginal predicts 21.30%.
  const p = 0.4615;
  const both = probAllWin([leg(p, 'm'), leg(p, 'm')]);
  near(p * p, 0.2130, 5e-4, 'independence baseline');
  near(both, 0.2469, 6e-3, 'observed pair rate');
  assert.ok(both > p * p, 'same-match same-direction must beat independence');
});

test('mixing directions in one match is worse than independence', () => {
  // The measured other half: an over paired with an under hit 20.56% against
  // 24.85% independence — about a sixth worse, where same-side is a sixth
  // better. A model that only knew about positive correlation would miss this.
  const p = 0.4615;
  const opposed = probAllWin([leg(p, 'm', 'over'), leg(p, 'm', 'under')]);
  assert.ok(opposed < p * p, `opposed ${opposed} should trail independence ${p * p}`);
  const aligned = probAllWin([leg(p, 'm', 'over'), leg(p, 'm', 'over')]);
  assert.ok(aligned > opposed, 'aligned must beat opposed');
});

test('stacking one match beats spreading across matches, for all-must-win', () => {
  // The whole reason correlation matters to a Power play: correlated legs win
  // together, so concentration raises P(all win).
  const stacked = probAllWin([leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm')]);
  const spread = probAllWin([leg(0.5, 'a'), leg(0.5, 'b'), leg(0.5, 'c'), leg(0.5, 'd')]);
  assert.ok(stacked > spread, `stacked ${stacked} vs spread ${spread}`);
  near(spread, 0.0625, 1e-3, 'four independent coin flips');
  // Simulated independently at 4M draws: 11.73%.
  near(stacked, 0.1173, 6e-3, 'four correlated coin flips');
});

test('the required multiplier is the reciprocal of P(all win)', () => {
  const legs = [leg(0.5, 'a'), leg(0.5, 'b'), leg(0.5, 'c')];
  const p = probAllWin(legs);
  near(requiredMultiplier(legs)!, 1 / p, 1e-9);
  // Three independent coin flips need 8x; PrizePicks pays 6x.
  near(requiredMultiplier(legs)!, 8, 0.05);
});

test('a stacked four-pick needs more than PrizePicks pays', () => {
  // 8.52x required against the 10x headline — and PrizePicks reprices same-game
  // combinations by an amount it does not publish, so the real question is
  // whether the haircut leaves more than 8.52x.
  const stacked = [leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm')];
  near(requiredMultiplier(stacked)!, 8.52, 0.4);
});

test('at the marginal actually measured, even a stacked four-pick loses at 10x', () => {
  // 46.15%, not 50%. This is the number that closes the correlation lead:
  // EV 0.936 at a full undiscounted 10x, before any same-game haircut.
  const p = 0.4615;
  const stacked = [leg(p, 'm'), leg(p, 'm'), leg(p, 'm'), leg(p, 'm')];
  const ev = 10 * probAllWin(stacked);
  assert.ok(ev < 1, `expected a losing EV, got ${ev}`);
  near(ev, 0.936, 0.05);
});

test('slipEV handles Power and Flex through one code path', () => {
  const legs = [leg(0.5, 'a'), leg(0.5, 'b'), leg(0.5, 'c'), leg(0.5, 'd')];
  // Power: pays only on 4 of 4.
  const power = slipEV(legs, { 4: 10 });
  near(power, 0.625, 1e-3, 'four independent legs at 10x');
  // Flex: the same legs, with a consolation for 3 of 4.
  const flex = slipEV(legs, { 4: 10, 3: 0.4 });
  assert.ok(flex > power, 'a consolation payout cannot lower EV');
});

test('correlation helps Power and hurts Flex, which is the whole trade-off', () => {
  const stacked = [leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm')];
  const spread = [leg(0.5, 'a'), leg(0.5, 'b'), leg(0.5, 'c'), leg(0.5, 'd')];
  // All-or-nothing: stacking wins.
  assert.ok(slipEV(stacked, { 4: 10 }) > slipEV(spread, { 4: 10 }));
  // The consolation tier: stacking loses it, because correlated legs fail
  // together and "exactly three" gets rarer.
  const dS = winCountDistribution(stacked);
  const dI = winCountDistribution(spread);
  assert.ok(dS[3]! < dI[3]!, `P(exactly 3) stacked ${dS[3]} should trail spread ${dI[3]}`);
});

test('the marginal-leg rule reproduces the PrizePicks ladder', () => {
  // 3x, 6x, 10x, 20x, 37.5x -> steps of 50%, 60%, 50%, 53.3%. The fourth leg
  // is the expensive one.
  assert.equal(marginalLegWorthIt(0.55, 3, 6), true, '2->3 needs 50%');
  assert.equal(marginalLegWorthIt(0.55, 6, 10), false, '3->4 needs 60%');
  assert.equal(marginalLegWorthIt(0.61, 6, 10), true);
  assert.equal(marginalLegWorthIt(0.55, 10, 20), true, '4->5 needs 50%');
  assert.equal(marginalLegWorthIt(0.52, 20, 37.5), false, '5->6 needs 53.3%');
});

test('an unknown payout is not a yes', () => {
  assert.equal(marginalLegWorthIt(0.9, null, 10), null);
  assert.equal(marginalLegWorthIt(0.9, 6, null), null);
});

test('RHO is the fitted value, not a round number someone guessed', () => {
  assert.equal(RHO, 0.213);
});

test('an empty slip is a certainty, not a crash', () => {
  assert.deepEqual(winCountDistribution([]), [1]);
  assert.equal(probAllWin([]), 1);
});
