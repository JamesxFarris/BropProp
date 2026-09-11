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
 * How strongly two legs in the same match move together — MEASURED, properly,
 * on 2026-09-10.
 *
 * `npm run validate:correlation` redid the old study with the three flaws
 * fixed: lines are the median of each player's PRIOR series only (no
 * look-ahead, and no era drift laundered into the correlation), significance is
 * a cluster bootstrap over whole series rather than a test over pairs that
 * assumes its own conclusion, and teammates are separated from opponents.
 *
 * Over **41,852 player-series and 8,923 independent series** of CS2:
 *
 *   teammate pairs   48,297   phi = 0.193   both-over lift 1.211
 *   opponent pairs   32,329   phi = 0.055   both-over lift 1.061
 *
 *   cluster bootstrap on teammate phi: 0.210, 95% CI [0.198, 0.222],
 *   with 0 of 2000 resamples at or below zero.
 *
 * **The effect is real and it is overwhelmingly a TEAMMATE effect.** Opponents
 * share only the length of the game; teammates share the win as well.
 *
 * phi is the correlation of the two binary outcomes. The Gaussian copula
 * parameter is higher — for a symmetric binary, phi = (2/pi)·asin(rho) — so
 * these are `sin(pi·phi/2)`. The old single RHO of 0.213 was the phi being
 * used directly as a rho, which understated the effect.
 */
export const RHO_TEAMMATE = Math.sin(Math.PI * 0.210 / 2);   // ≈ 0.324
export const RHO_OPPONENT = Math.sin(Math.PI * 0.055 / 2);   // ≈ 0.086

/**
 * The correlation used when we do not know whether two legs are teammates.
 *
 * `MarketRow` does not yet carry a team, so the board cannot tell a teammate
 * pair from an opponent pair and this sits between the two. It is deliberately
 * nearer the opponent figure: over-crediting correlation inflates P(all win),
 * which shrinks the break-even multiplier and makes a slip look better than it
 * is. Under-crediting only costs a bet that was there.
 *
 * **Plumbing team through is the single highest-value change left**, because
 * the whole edge lives in the teammate number. See docs/STRATEGY.md.
 */
export const RHO = RHO_OPPONENT + 0.25 * (RHO_TEAMMATE - RHO_OPPONENT);

/** Opposite sides of one match move against each other; same sides together. */
export const RHO_OPPOSED = -RHO;

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

/** One leg, reduced to what the slip maths needs. */
export type SlipLeg = {
  /** Win probability on its own. */
  p: number;
  /** Which match it belongs to — legs sharing one move together. */
  matchKey: string;
  /** Which way it is pointed, so opposed legs in a match can cancel. */
  side: 'over' | 'under';
  /**
   * The player's team.
   *
   * This is the field that matters most. Teammates correlate at rho 0.324;
   * opponents at 0.086 — nearly four times weaker. Null means unknown, and an
   * unknown team is treated as its own team, so two legs of unknown provenance
   * get the weaker opponent correlation rather than the stronger teammate one.
   * Guessing high here would make every slip look better than it is.
   */
  team?: string | null;
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
export function winCountDistribution(legs: SlipLeg[], rho?: number): number[] {
  if (legs.length === 0) return [1];

  /*
   * Two nested factors, because the measurement says there are two.
   *
   *   z = sqrt(a)·M  +  sqrt(b)·T  +  sqrt(1 - a - b)·e
   *
   * M is the match: how long, how bloody, how many maps — it moves everyone
   * playing, which is the opponent-level correlation of 0.086. T is the team:
   * whether THIS side had the good game, which is the extra that lifts
   * teammates to 0.324. A single-factor model cannot express the gap, and the
   * gap is where the entire edge lives.
   *
   * Passing an explicit rho collapses this back to one factor at that value,
   * which is what the tests use to check a specific correlation in isolation.
   */
  const a = rho !== undefined ? rho : RHO_OPPONENT;
  const b = rho !== undefined ? 0 : RHO_TEAMMATE - RHO_OPPONENT;

  const byMatch = new Map<string, SlipLeg[]>();
  for (const l of legs) {
    const arr = byMatch.get(l.matchKey) ?? [];
    arr.push(l);
    byMatch.set(l.matchKey, arr);
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

  const sa = Math.sqrt(a), sb = Math.sqrt(b), se = Math.sqrt(Math.max(1e-9, 1 - a - b));

  let total: number[] = [1];
  for (const group of byMatch.values()) {
    // The direction the match as a whole is committed to: whichever side has
    // more legs. A leg opposing it loads on the factors negatively, which is
    // what reproduces the measured 0.828x for mixed directions.
    const overs = group.filter((l) => l.side === 'over').length;
    const majority: 'over' | 'under' = overs >= group.length - overs ? 'over' : 'under';

    // Teams within this match. An unknown team gets its own bucket, so two
    // unknowns are treated as opponents rather than as teammates.
    const byTeam = new Map<string, SlipLeg[]>();
    let unknown = 0;
    for (const l of group) {
      const key = l.team ?? `?unknown${unknown++}`;
      const arr = byTeam.get(key) ?? [];
      arr.push(l);
      byTeam.set(key, arr);
    }

    let dist = new Array(group.length + 1).fill(0);
    for (let n = 0; n < NODES; n++) {
      const m = nodes[n]!;
      // Teams are conditionally independent given the match factor, so each
      // team's own distribution is built separately and convolved.
      let matchDist: number[] = [1];
      for (const team of byTeam.values()) {
        const teamDist = new Array(team.length + 1).fill(0);
        for (let tn = 0; tn < NODES; tn++) {
          const t = nodes[tn]!;
          let cond: number[] = [1];
          for (const leg of team) {
            const sign = leg.side === majority ? 1 : -1;
            const shift = sign * (sa * m + sb * t);
            const thr = normInv(1 - leg.p);
            const pw = 1 - normCdf((thr - shift) / se);
            const next = new Array(cond.length + 1).fill(0);
            for (let k = 0; k < cond.length; k++) {
              next[k]! += cond[k]! * (1 - pw);
              next[k + 1]! += cond[k]! * pw;
            }
            cond = next;
          }
          for (let k = 0; k < cond.length; k++) teamDist[k]! += weights[tn]! * cond[k]!;
        }
        matchDist = convolve(matchDist, teamDist);
      }
      for (let k = 0; k < matchDist.length; k++) dist[k]! += weights[n]! * matchDist[k]!;
    }
    total = convolve(total, dist);
  }
  return total;
}

/** P(every leg wins) — the only number an all-must-win entry needs. */
export function probAllWin(legs: SlipLeg[], rho?: number): number {
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
export function requiredMultiplier(legs: SlipLeg[], rho?: number): number | null {
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
export function slipEV(legs: SlipLeg[], payouts: Record<number, number>, rho?: number): number {
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

/**
 * The opponent leg of a stack, priced from measurement instead of the copula.
 *
 * The two factors above are fitted to PAIRS, which is the body of the
 * distribution. A stack is a tail event — k teammates ALL over, then one
 * opponent — and in the tail the model is badly wrong. `npm run validate:tail`,
 * over the CS2 archive with walk-forward lines, 2026-09-11:
 *
 *   core   P(opp over | core over)   P(opp under | core under)   series
 *     1          (shift 0.194)            (shift 0.171)            4,582
 *     2      0.606  (0.393)            0.644  (0.246)              4,207
 *     3      0.688  (0.616)            0.672  (0.321)              3,248
 *     4      0.767  (0.872)            0.702  (0.388)              2,040
 *     5      0.873  (1.317)            0.717  (0.397)                823
 *
 * The model's own implied shifts are 0.06-0.22 — it captures a sixth of the
 * over effect at five. Over minus under excludes zero at every core size
 * (bootstrap over series), and every half-year since 2024 agrees on the overs
 * (1.14-1.51 at five). The UNDER tail has weakened lately: 0.90 in 2024H2,
 * 0.24-0.28 in 2026. The books' own closing lines agreed on overs: 88% over
 * 60 series.
 *
 * The overs are stronger for a physical reason: five players all over their
 * kill lines usually means long maps or overtime, and a long map feeds the
 * other five too. Five all under is a mix of short maps (everyone under) and
 * stomps (the winners go over), which partly cancel.
 *
 * The team core is NOT corrected — the model's P(k teammates all hit) matched
 * the archive to within a few percent at every k. Only the partner is.
 *
 * Stored as a probit shift so it applies to a partner at any price:
 * P = Φ(Φ⁻¹(p) + shift). It was measured with cores near 48-52% per leg;
 * a core of much stronger legs is a less extreme event and would shift less.
 */
export const PARTNER_SHIFT: Record<'over' | 'under', readonly number[]> = {
  //      core size:  0     1      2      3      4      5
  over:  [0, 0.194, 0.393, 0.616, 0.872, 1.317],
  under: [0, 0.171, 0.246, 0.321, 0.388, 0.397],
};

/**
 * P(one opponent leg hits | every leg of a same-side core of `coreSize` hit).
 *
 * The partner must be on the SAME side as the core. The opposite side is the
 * complement of this and is terrible — after a 5-over core, an opponent under
 * hits about 13% of the time — which is why stacks never mix sides.
 */
export function partnerGivenCore(pPartner: number, coreSize: number, side: 'over' | 'under'): number {
  const table = PARTNER_SHIFT[side];
  const k = Math.max(0, Math.min(table.length - 1, Math.floor(coreSize)));
  const p = Math.min(1 - 1e-9, Math.max(1e-9, pPartner));
  return normCdf(normInv(p) + table[k]!);
}
