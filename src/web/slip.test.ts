import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normCdf, normInv, winCountDistribution, probAllWin, requiredMultiplier,
  slipEV, marginalLegWorthIt, RHO, RHO_TEAMMATE, RHO_OPPONENT, type SlipLeg,
  partnerGivenCore, PARTNER_SHIFT,
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

test('it reproduces the measured TEAMMATE pair rate', () => {
  // The anchor for the whole module. Measured 2026-09-10 with walk-forward
  // lines over 41,852 player-series: at a 47.73% over rate, two teammates both
  // going over hit 27.59% where independence predicts 22.78%.
  const p = 0.4773;
  const both = probAllWin([leg(p, 'm'), leg(p, 'm')], RHO_TEAMMATE);
  near(p * p, 0.2278, 1e-3, 'independence baseline');
  near(both, 0.2759, 8e-3, 'observed teammate pair rate');
  assert.ok(both > p * p, 'teammates must beat independence');
});

test('it reproduces the much weaker OPPONENT pair rate', () => {
  // 24.16% observed against the same 22.78% independence. Opponents share only
  // the length of the game; teammates share the win as well, and the gap
  // between these two numbers is where the whole edge lives.
  const p = 0.4773;
  const both = probAllWin([leg(p, 'm'), leg(p, 'm')], RHO_OPPONENT);
  near(both, 0.2416, 8e-3, 'observed opponent pair rate');
  assert.ok(both < probAllWin([leg(p, 'm'), leg(p, 'm')], RHO_TEAMMATE),
    'opponents must be weaker than teammates');
});

test('mixing directions in one match is worse than independence', () => {
  // The measured other half: an over paired with an under hit 20.56% against
  // 24.85% independence — about a sixth worse, where same-side is a sixth
  // better. A model that only knew about positive correlation would miss this.
  const p = 0.4773;
  const opposed = probAllWin([leg(p, 'm', 'over'), leg(p, 'm', 'under')]);
  assert.ok(opposed < p * p, `opposed ${opposed} should trail independence ${p * p}`);
  const aligned = probAllWin([leg(p, 'm', 'over'), leg(p, 'm', 'over')]);
  assert.ok(aligned > opposed, 'aligned must beat opposed');
});

test('stacking one match beats spreading across matches, for all-must-win', () => {
  // The whole reason correlation matters to a Power play: correlated legs win
  // together, so concentration raises P(all win).
  const stacked = probAllWin([leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm')], RHO_TEAMMATE);
  const spread = probAllWin([leg(0.5, 'a'), leg(0.5, 'b'), leg(0.5, 'c'), leg(0.5, 'd')]);
  assert.ok(stacked > spread, `stacked ${stacked} vs spread ${spread}`);
  near(spread, 0.0625, 1e-3, 'four independent coin flips');
  // Four teammates at the measured teammate correlation.
  assert.ok(stacked > 0.13, `expected well above independence, got ${stacked}`);
});

test('the required multiplier is the reciprocal of P(all win)', () => {
  const legs = [leg(0.5, 'a'), leg(0.5, 'b'), leg(0.5, 'c')];
  const p = probAllWin(legs);
  near(requiredMultiplier(legs)!, 1 / p, 1e-9);
  // Three independent coin flips need 8x; PrizePicks pays 6x.
  near(requiredMultiplier(legs)!, 8, 0.05);
});

test('a four-teammate stack clears the 10x PrizePicks pays a four-pick', () => {
  // With the properly measured teammate correlation this crosses over, which
  // it did not under the old understated figure. The catch is unchanged and
  // decisive: PrizePicks reprices same-game combinations by an amount it does
  // not publish, so what matters is whether the haircut leaves more than this.
  const stacked = [leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm'), leg(0.5, 'm')];
  const need = requiredMultiplier(stacked, RHO_TEAMMATE)!;
  assert.ok(need < 10, `a four-teammate stack should need under 10x, needs ${need}`);
  assert.ok(need > 5, `...but not absurdly little; got ${need}`);
});

test('spreading four legs across four matches does not clear 10x', () => {
  // The control. Independence needs 16x against the 10x on offer, which is the
  // 37.5% hold the break-even table reports.
  const spread = [leg(0.5, 'a'), leg(0.5, 'b'), leg(0.5, 'c'), leg(0.5, 'd')];
  near(requiredMultiplier(spread)!, 16, 0.2);
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

test('the correlation constants are the measured ones, converted properly', () => {
  // phi is the correlation of two binary outcomes; the copula parameter is
  // sin(pi*phi/2) and is larger. Using phi directly as rho — which the first
  // version of this file did — understates the effect by about a third.
  near(RHO_TEAMMATE, Math.sin(Math.PI * 0.210 / 2), 1e-9);
  near(RHO_OPPONENT, Math.sin(Math.PI * 0.055 / 2), 1e-9);
  assert.ok(RHO_TEAMMATE > 0.32 && RHO_TEAMMATE < 0.33, String(RHO_TEAMMATE));
  assert.ok(RHO_OPPONENT > 0.08 && RHO_OPPONENT < 0.09, String(RHO_OPPONENT));
  // The default sits between them and nearer the opponent value, because
  // over-crediting correlation makes a slip look better than it is.
  assert.ok(RHO > RHO_OPPONENT && RHO < RHO_TEAMMATE);
  assert.ok(RHO - RHO_OPPONENT < RHO_TEAMMATE - RHO, 'default must lean conservative');
});

test('an empty slip is a certainty, not a crash', () => {
  assert.deepEqual(winCountDistribution([]), [1]);
  assert.equal(probAllWin([]), 1);
});

test('the partner table reproduces what validate:tail measured', () => {
  // At the validator's own opponent base rate (43.0% over at a five-core), the
  // shifts must give back the conditional rates it printed.
  near(partnerGivenCore(0.430, 5, 'over'), 0.873, 0.005, 'opp over after 5 over');
  near(partnerGivenCore(0.570, 5, 'under'), 0.717, 0.005, 'opp under after 5 under');
  near(partnerGivenCore(0.5, 0, 'over'), 0.5, 1e-9, 'no core, no shift');
});

test('the opponent follows a bigger core more, and follows overs more than unders', () => {
  for (let k = 1; k <= 5; k++) {
    assert.ok(partnerGivenCore(0.5, k, 'over') > partnerGivenCore(0.5, k - 1, 'over'), `over k=${k}`);
    assert.ok(partnerGivenCore(0.5, k, 'under') > partnerGivenCore(0.5, k - 1, 'under'), `under k=${k}`);
  }
  for (let k = 2; k <= 5; k++) {
    assert.ok(PARTNER_SHIFT.over[k]! > PARTNER_SHIFT.under[k]!, `k=${k}: over tail must be the stronger`);
  }
  // Cores bigger than anything measured use the largest measured shift.
  near(partnerGivenCore(0.5, 9, 'over'), partnerGivenCore(0.5, 5, 'over'), 1e-12);
});

test('the measured tail is far stronger than the copula says', () => {
  // The reason the table exists: at a coin flip, the two-factor model has the
  // opponent following a five-over core ~58% of the time. Measured, it is ~90%.
  const core = Array.from({ length: 5 }, () => ({ p: 0.5, matchKey: 'M', side: 'over' as const, team: 'A' }));
  const model = probAllWin([...core, { p: 0.5, matchKey: 'M', side: 'over', team: 'B' }]) / probAllWin(core);
  assert.ok(model < 0.6, `model ${model}`);
  assert.ok(partnerGivenCore(0.5, 5, 'over') > 0.85);
});
