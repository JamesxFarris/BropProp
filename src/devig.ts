/**
 * Underdog's price, with the book's margin taken back out.
 *
 * Underdog publishes genuine two-sided American odds; PrizePicks cannot,
 * because it prices with a flat multiplier and expresses price by moving the
 * line. So this is the only real market probability available on the board.
 *
 * Multiplicative, deliberately. At the -112/-112 that most of these markets
 * carry, the margin is small and near-symmetric, which is exactly where
 * multiplicative and Shin agree; the extra machinery would buy nothing we
 * could measure. The method is named in the result so it can be swapped for
 * Shin or power later and the two compared on real graded picks, rather than
 * being silently baked in here.
 */

export type FairOdds = {
  /** Probability the over hits, margin removed. 0..1. */
  over: number;
  under: number;
  /** The margin that was removed: 0.05 is a 5% overround. */
  overround: number;
  method: 'multiplicative';
};

/**
 * American odds to the probability they imply, margin still in.
 *
 * Negative odds are a favourite (-110 risks 110 to win 100); positive odds an
 * underdog (+110 risks 100 to win 110). At ±100 the two formulas meet at 0.5.
 */
export function americanToProb(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

/**
 * Both sides' fair probabilities, or null when there is no two-sided market.
 *
 * A market the book lists one way only cannot be devigged: there is no second
 * price to measure the margin against. It returns null rather than assuming
 * the missing side is the complement, which would be reporting the book's
 * margin as though it were the player's chance.
 */
export function devig(
  overPrice: number | null | undefined,
  underPrice: number | null | undefined,
): FairOdds | null {
  if (overPrice === null || overPrice === undefined) return null;
  if (underPrice === null || underPrice === undefined) return null;
  if (!Number.isFinite(overPrice) || !Number.isFinite(underPrice)) return null;

  const o = americanToProb(overPrice);
  const u = americanToProb(underPrice);
  const total = o + u;
  if (!(total > 0)) return null;

  return { over: o / total, under: u / total, overround: total - 1, method: 'multiplicative' };
}
