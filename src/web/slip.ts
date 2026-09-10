/**
 * What a slip is actually worth, once you stop pretending the legs are
 * independent.
 *
 * `optimize.ts` computed `winProb` as a plain product of per-leg probabilities.
 * That is the right arithmetic for legs that do not move together, and this
 * project's own data says these do: measured over 35,702 same-match pairs of
 * real CS2 series, two overs from one match hit **24.69%** against the 21.30%
 * independence predicts, and an over paired with an under hit **20.56%**
 * against 24.85%. Same direction beats independence by about a sixth; mixing
 * directions is about a sixth worse.
 *
 * A product understates P(all win) on a stacked slip by as much as 1.87x. It is
 * not a conservative error either, because the payout it is multiplied by is
 * itself overstated whenever the book quietly reprices a same-game combination.
 * Two errors of unknown size pointing opposite ways is not caution, it is an
 * unfalsifiable number.
 *
 * ## The model
 *
 * One latent factor per match — the thing that makes everyone in a long, bloody
 * series go over together: map count, overtime, pace. Leg `i` in match `g` wins
 * when
 *
 *     sqrt(RHO) * F_g  +  sqrt(1 - RHO) * e_i   >   threshold_i
 *
 * with `F_g` and every `e_i` standard normal and independent. Legs in different
 * matches share no factor, so they stay independent of each other.
 *
 * Conditional on `F_g = f`, the legs inside a match ARE independent, which is
 * what makes this cheap to evaluate exactly: integrate each match's win-count
 * distribution over `f`, then convolve the matches together. No simulation, so
 * the same board always renders the same numbers — the property `resampleTotals`
 * is careful about for the same reason.
 */

/**
 * The same-match correlation, as a Gaussian copula parameter.
 *
 * Fitted to reproduce the measured pair rate: at the 46.15% marginal implied by
 * that study's own line convention, RHO = 0.213 gives P(both over) = 25.0%
 * against the 24.69% observed. Verified by simulation at 4M draws.
 *
 * **Treat this as an upper bound, not a measurement to bank.** Three reasons,
 * all recorded in docs/STRATEGY.md: the study set each player's line at their
 * career median over the whole sample, so anything shared by two players and
 * drifting over time (patch, meta, roster) is absorbed into it; it was never
 * tested over independent series; and it never separated teammates from
 * opponents, which almost certainly differ in sign and size.
 */
export const RHO = 0.213;

/** Opposite sides of one match move against each other; same sides together. */
export const RHO_OPPOSED = -0.213;

const SQRT2 = Math.SQRT2;

/** Normal CDF via erf, good to ~1e-7 — ample for probabilities we round to 1%. */
export function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26, in Horner form.
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592
    + t * (-0.284496736
    + t * (1.421413741
    + t * (-1.453152027
    + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + s * erf);
}

/** Inverse normal CDF (Acklam), good to ~1e-9. */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2, 1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239e+0];
  const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2, 6.680131188771972e+1, -1.328068155288572e+1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e+0, -2.549732539343734e+0, 4.374664141464968e+0, 2.938163982698783e+0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e+0, 3.754408661907416e+0];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]!*r+a[1]!)*r+a[2]!)*r+a[3]!)*r+a[4]!)*r+a[5]!)*q
       / (((((b[0]!*r+b[1]!)*r+b[2]!)*r+b[3]!)*r+b[4]!)*r+1);
}

/** One leg, reduced to the only two things the slip maths needs. */
export type SlipLeg = {
  /** Win probability on its own. */
  p: number;
  /** Which match it belongs to — legs sharing one move together. */
  matchKey: string;
  /** Which way it is pointed, so opposed legs in a match can cancel. */
  side: 'over' | 'under';
};

/** Convolve two independent win-count distributions. */
function convolve(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j]! += a[i]! * b[j]!;
  }
  return out;
}

/**
 * P(exactly k of these legs win), for k = 0..n.
 *
 * Legs are grouped by match. Within a match they share a latent factor and are
 * therefore correlated; across matches they are independent and the blocks are
 * convolved. A leg pointed against the rest of its match gets its factor
 * loading flipped, which is what reproduces the measured 0.828x for mixed
 * directions rather than assuming it.
 */
export function winCountDistribution(legs: SlipLeg[], rho = RHO): number[] {
  if (legs.length === 0) return [1];

  const byMatch = new Map<string, SlipLeg[]>();
  for (const l of legs) {
    const a = byMatch.get(l.matchKey) ?? [];
    a.push(l);
    byMatch.set(l.matchKey, a);
  }

  // A 241-point grid over [-6, 6] integrates a standard normal to better than
  // 1e-6, and unlike a random draw it gives the same answer every render.
  const NODES = 241, LO = -6, HI = 6;
  const step = (HI - LO) / (NODES - 1);
  const nodes: number[] = [];
  const weights: number[] = [];
  let wsum = 0;
  for (let i = 0; i < NODES; i++) {
    const f = LO + i * step;
    const w = Math.exp(-0.5 * f * f);
    nodes.push(f);
    weights.push(w);
    wsum += w;
  }
  for (let i = 0; i < NODES; i++) weights[i]! /= wsum;

  let total: number[] = [1];
  for (const group of byMatch.values()) {
    // The direction the match as a whole is committed to: whichever side has
    // more legs. A leg opposing it loads on the factor negatively.
    const overs = group.filter((l) => l.side === 'over').length;
    const majority: 'over' | 'under' = overs >= group.length - overs ? 'over' : 'under';

    const dist = new Array(group.length + 1).fill(0);
    for (let n = 0; n < NODES; n++) {
      const f = nodes[n]!;
      let cond: number[] = [1];
      for (const leg of group) {
        const r = leg.side === majority ? rho : -rho;
        const sr = Math.sqrt(Math.abs(r)) * Math.sign(r);
        const thr = normInv(1 - leg.p);
        // P(win | f) with loading sr on the shared factor.
        const pw = 1 - normCdf((thr - sr * f) / Math.sqrt(1 - Math.abs(r)));
        const next = new Array(cond.length + 1).fill(0);
        for (let k = 0; k < cond.length; k++) {
          next[k]! += cond[k]! * (1 - pw);
          next[k + 1]! += cond[k]! * pw;
        }
        cond = next;
      }
      for (let k = 0; k < cond.length; k++) dist[k]! += weights[n]! * cond[k]!;
    }
    total = convolve(total, dist);
  }
  return total;
}

/** P(every leg wins) — the only number an all-must-win entry needs. */
export function probAllWin(legs: SlipLeg[], rho = RHO): number {
  const d = winCountDistribution(legs, rho);
  return d[d.length - 1] ?? 0;
}

/**
 * The multiplier at which an all-must-win entry breaks even.
 *
 * This is the number to compare against what the app is showing, and it is the
 * whole decision. It needs nothing from the book, so it cannot go stale — which
 * matters more than ever now that PrizePicks' own rules say a lineup's
 * multiplier moves with "pick combinations, special projections, promotions,
 * fees" and the rest. A 6-pick is not always 37.5x; it can be 23x or 28x, and
 * only the app knows which.
 */
export function requiredMultiplier(legs: SlipLeg[], rho = RHO): number | null {
  const p = probAllWin(legs, rho);
  return p > 0 ? 1 / p : null;
}

/**
 * Expected return per unit staked, given a payout schedule by win count.
 *
 * `payouts[k]` is what the entry returns when exactly `k` legs win. An
 * all-must-win entry is just the special case where every entry but the last is
 * zero, so Power and Flex go through the same function and cannot drift apart.
 */
export function slipEV(legs: SlipLeg[], payouts: Record<number, number>, rho = RHO): number {
  const d = winCountDistribution(legs, rho);
  let ev = 0;
  for (let k = 0; k < d.length; k++) ev += (payouts[k] ?? 0) * d[k]!;
  return ev;
}

/**
 * Should an nth leg be added at all?
 *
 * For an all-must-win entry, adding a leg multiplies the win probability by
 * roughly that leg's own chance and multiplies the payout by `M_n / M_{n-1}`.
 * So it only helps when
 *
 *     p_n  >  M_{n-1} / M_n
 *
 * On PrizePicks the ladder is 3x, 6x, 10x, 20x, 37.5x, which makes the steps
 * 50%, **60%**, 50%, 53.3%. The fourth leg is the expensive one: it has to win
 * 60% of the time to be worth adding, and nothing in this codebase has ever
 * produced a leg that clears 60% honestly — `shrink()`'s Beta(8) prior makes it
 * nearly unreachable by design.
 *
 * Returns null when the payouts for either size are unknown, which is not the
 * same as "yes".
 */
export function marginalLegWorthIt(
  pNextLeg: number,
  payoutPrev: number | null,
  payoutNext: number | null,
): boolean | null {
  if (payoutPrev === null || payoutNext === null || payoutNext <= 0) return null;
  return pNextLeg > payoutPrev / payoutNext;
}
