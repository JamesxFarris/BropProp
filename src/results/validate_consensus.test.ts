import test from 'node:test';
import assert from 'node:assert/strict';
import { signTest } from './validate_consensus.js';

/**
 * The significance test the consensus claim will stand or fall on.
 *
 * Worth pinning because the project has already been burned by the alternative:
 * a leg-level z-score read 5.11 on data whose honest per-series answer was
 * p = 0.077. An exact binomial tail cannot be talked into that.
 */

/** The tail sums to 1 in exact arithmetic; in floats it lands a few ulps under. */
const near = (got: number, want: number, tol = 1e-9) =>
  assert.ok(Math.abs(got - want) < tol, `${got} is not within ${tol} of ${want}`);

test('a dead-even record is as unsurprising as possible', () => {
  near(signTest(5, 10), 1);
  near(signTest(50, 100), 1);
});

test('a sweep is as surprising as the count allows', () => {
  // Ten from ten is 2 * 0.5^10.
  assert.ok(Math.abs(signTest(10, 10) - 2 * Math.pow(0.5, 10)) < 1e-12);
  // Three from three cannot clear 0.05 however lopsided — small n is small n.
  assert.ok(signTest(3, 3) > 0.05, 'three series is never significant');
});

test('the reference case from the runbook comes back where it did', () => {
  // 12 of 16 series leaning under was reported at p = 0.077.
  assert.ok(Math.abs(signTest(12, 16) - 0.077) < 0.002, String(signTest(12, 16)));
});

test('the model leading 8 of 17 is p = 1', () => {
  // Recorded in the runbook as p = 1.000, and it is: 8-9 is the least extreme
  // split available at 17, so every outcome is at least as extreme and the
  // whole distribution sums back in.
  near(signTest(8, 17), 1);
});

test('it is two-sided — losing badly is as significant as winning badly', () => {
  near(signTest(2, 20), signTest(18, 20));
  near(signTest(0, 8), signTest(8, 8));
});

test('a probability is always returned, never a number above one', () => {
  for (let n = 0; n <= 30; n++) {
    for (let k = 0; k <= n; k++) {
      const p = signTest(k, n);
      assert.ok(p >= 0 && p <= 1, `signTest(${k}, ${n}) = ${p}`);
    }
  }
});

test('no data is not evidence of anything', () => {
  assert.equal(signTest(0, 0), 1);
});

test('sixty from a hundred does NOT clear the usual bar', () => {
  // 0.057, not 0.04 — which is the useful thing to know before reading a
  // result. Sixty percent over a hundred series still is not significant, and
  // a hundred independent series is far more than this project has ever had.
  near(signTest(60, 100), 0.0569, 1e-3);
  assert.ok(signTest(60, 100) > 0.05, 'just misses');
  assert.ok(signTest(64, 100) < 0.05, 'sixty-four clears it');
  assert.ok(signTest(55, 100) > 0.05);
});
