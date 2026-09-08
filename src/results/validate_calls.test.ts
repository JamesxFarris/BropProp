import test from 'node:test';
import assert from 'node:assert/strict';
import { auc, signTest } from './validate_calls.js';

/**
 * These two functions decide what the scorecard claims.
 *
 * `auc` is the number the Stats page leads with, and the one that says the
 * model cannot tell a winner from a loser. `signTest` is what replaced the
 * leg-level z-scores that made 462 correlated legs read as 5.11 standard
 * errors. Both are pure, so there is no excuse for either being wrong, and a
 * quiet error in either would be invisible — the output would still look like
 * a plausible statistic.
 */

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('auc: perfect separation scores 1, and reversed scores 0', () => {
  const good = [{ p: 0.9, won: true }, { p: 0.8, won: true },
                { p: 0.3, won: false }, { p: 0.2, won: false }];
  close(auc(good), 1);
  close(auc(good.map((r) => ({ ...r, won: !r.won }))), 0);
});

test('auc: a worked example by hand', () => {
  // wins at 0.9 and 0.5, losses at 0.6 and 0.4. Of the four win/loss pairs,
  // only (0.5 vs 0.6) is ordered wrongly, so three of four → 0.75.
  close(auc([
    { p: 0.9, won: true }, { p: 0.5, won: true },
    { p: 0.6, won: false }, { p: 0.4, won: false },
  ]), 0.75);
});

test('auc: identical predictions are exactly a coin flip, not an accident of order', () => {
  // The naive implementation returns 1 or 0 here depending on sort stability,
  // which is precisely the bug the average-rank handling exists to prevent.
  close(auc([{ p: 0.6, won: true }, { p: 0.6, won: false }]), 0.5);
  close(auc([{ p: 0.6, won: false }, { p: 0.6, won: true }]), 0.5);
  close(auc(Array.from({ length: 20 }, (_, i) => ({ p: 0.55, won: i % 2 === 0 }))), 0.5);
});

test('auc: a tied block between separated ones is scored as half credit', () => {
  // One win and one loss both at 0.5, a clear win above and a clear loss
  // below. The tied pair contributes 0.5 of its one pair; the rest are clean.
  // Pairs: (0.9,0.5L)=1 (0.9,0.1L)=1 (0.5W,0.5L)=0.5 (0.5W,0.1L)=1 → 3.5/4.
  close(auc([
    { p: 0.9, won: true }, { p: 0.5, won: true },
    { p: 0.5, won: false }, { p: 0.1, won: false },
  ]), 0.875);
});

test('auc: no wins or no losses is undefined, and reports no skill rather than throwing', () => {
  close(auc([{ p: 0.7, won: true }, { p: 0.6, won: true }]), 0.5);
  close(auc([{ p: 0.7, won: false }]), 0.5);
  close(auc([]), 0.5);
});

test('signTest: an even split is the least surprising thing possible', () => {
  close(signTest(5, 10), 1);
  close(signTest(8, 16), 1);
});

test('signTest: a clean sweep is 2 / 2^n', () => {
  close(signTest(10, 10), 2 / 1024);
  close(signTest(0, 10), 2 / 1024);
});

test('signTest: symmetric in k', () => {
  for (const [k, n] of [[3, 17], [12, 16], [1, 5], [7, 20]] as const) {
    close(signTest(k, n), signTest(n - k, n));
  }
});

test('signTest: the real case from the board, computed by hand', () => {
  // 12 of 16 series leaned under. Two-sided means every outcome no more likely
  // than C(16,12) = 1820, which is i in {0..4} and {12..16}:
  //   (1 + 16 + 120 + 560 + 1820) * 2 = 5034, over 2^16 = 65536.
  close(signTest(12, 16), 5034 / 65536, 1e-12);
  // And the value the RUNBOOK quotes.
  assert.equal(signTest(12, 16).toFixed(3), '0.077');
});

test('signTest: more extreme is never less significant', () => {
  const n = 21;
  let prev = signTest(11, n);
  for (let k = 12; k <= n; k++) {
    const p = signTest(k, n);
    assert.ok(p <= prev + 1e-12, `p rose from ${prev} to ${p} at k=${k}`);
    prev = p;
  }
});

test('signTest: stays a probability at sizes that would overflow a factorial', () => {
  // Computed in log space precisely so 170! does not become Infinity. A naive
  // implementation returns NaN here.
  for (const n of [200, 400, 1000]) {
    const p = signTest(Math.floor(n / 2), n);
    assert.ok(Number.isFinite(p), `n=${n} gave ${p}`);
    assert.ok(p > 0 && p <= 1, `n=${n} gave ${p}`);
  }
  assert.ok(signTest(700, 1000) < 1e-30);
});

test('signTest: n = 0 has nothing to test and is not significant', () => {
  close(signTest(0, 0), 1);
});
