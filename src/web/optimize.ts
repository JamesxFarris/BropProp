import { config } from '../config.js';
import type { MarketRow } from './boardq.js';
import type { FormStats, Play } from './projection.js';
import { recommend, type LineOption } from './projection.js';
import { comboParts } from '../normalize.js';
import type { BookCode } from '../books.js';
import { devig } from '../devig.js';
import { bookEdges, edgeProbability } from './consensus.js';

/**
 * Building the best entry of a given size.
 *
 * For an all-must-win entry the expected return is
 *
 *     payout x product of each leg's win probability
 *
 * and on Underdog the payout is itself base(N) x product of each leg's payout
 * multiplier. So the objective factorises into one number per leg — p x mult —
 * and maximising a product of per-leg terms is just taking the N largest. No
 * combinatorial search is needed for the arithmetic.
 *
 * The difficulty is entirely in the constraints and in not believing our own
 * probabilities too much.
 */

/**
 * Base payout by entry size, from config — empty until the real numbers are
 * entered.
 *
 * The tables that used to sit here assumed a flat rate by leg count, which
 * neither book pays any more: PrizePicks prices per prop and its live board is
 * mostly demon and goblin, whose multipliers appear nowhere in the API, and
 * Underdog attaches a multiplier to each side. A stale table makes every EV
 * confidently wrong rather than visibly absent, so unknown is the default.
 */
const BASE = config.payoutTable;

export type Candidate = {
  row: MarketRow;
  play: Play;
  propId: number;
  /** Win probability, shrunk toward a coin flip by how thin the evidence is. */
  p: number;
  /**
   * Where the direction came from.
   *
   * `consensus` means the side was read off where this book sits relative to
   * every other book pricing the market — no projection involved. `model`
   * means it came from `recommend()`, which has been measured at AUC 0.495 and
   * carries no demonstrated information about who wins.
   *
   * Recorded per leg rather than assumed for the entry, because a board will
   * hold both kinds at once: a market three books price gets a consensus, and
   * one only PrizePicks lists cannot.
   */
  source: 'consensus' | 'model';
  /** How far off the crowd this book is, in stat units. Null on the model path. */
  gap: number | null;
  /** What this leg pays relative to a standard one (Underdog discounts some). */
  mult: number;
  /** p x mult — the whole objective, per leg. */
  value: number;
  matchKey: string;
  /** Every player this leg's outcome depends on — a combo depends on all of its members. */
  players: string[];
};

export type Entry = {
  size: number;
  book: BookCode;
  legs: Candidate[];
  /** base x product of leg multipliers. Null when the book's table is unknown. */
  payout: number | null;
  winProb: number;       // product of leg probabilities
  /** payout x winProb; above 1.0 is profitable. Null without a payout. */
  evMultiple: number | null;
  discounted: number;    // legs paying below standard
};

/**
 * Shrink an observed hit rate toward 0.5 in proportion to how little is behind
 * it.
 *
 * An optimiser searches for the highest numbers, which means it searches for
 * the luckiest small samples. "9 of 10" is not a 90% edge, and left raw it
 * would outrank a genuine 65% built on eighty games every time. A Beta(2,2)
 * prior costs a well-evidenced leg almost nothing and guts a thin one.
 */
function shrink(hitRate: number, effectiveN: number): number {
  // Deliberately heavier than a plain Beta(2,2). This estimate is not being
  // read once — it is being maximised over roughly a hundred markets, and the
  // maximum of many noisy estimates is biased upward whatever each one's own
  // error looks like. The books also price these to be close to a coin flip,
  // so a prior centred there is the honest starting point rather than a
  // conservative one.
  const prior = 8;
  return (hitRate * effectiveN + 0.5 * prior) / (effectiveN + prior);
}

/**
 * How many independent observations really sit behind a play.
 *
 * A modelled play resamples single maps thousands of times, but the evidence is
 * the maps themselves, not the draws — and it takes `maps` of them to speak to
 * one range. Counting 4000 draws as 4000 observations would defeat the
 * shrinkage entirely.
 */
function evidenceCount(play: Play, maps: number): number {
  if (play.method === 'series') return play.series;
  return Math.floor(play.sample / Math.max(1, maps));
}

export function candidatesFor(
  rows: MarketRow[],
  form: Map<string, FormStats>,
  book: BookCode,
): Candidate[] {
  const out: Candidate[] = [];
  const now = Date.now();

  for (const r of rows) {
    // A market already under way cannot be entered.
    if (r.scheduled_at && new Date(r.scheduled_at).getTime() < now) continue;
    // Combos used to be skipped for want of a projection. They have one now,
    // built from the members' joint history, so they compete on the same terms
    // as everything else — but see `players` below: a combo leg occupies every
    // player in it, or the one-leg-per-player rule stops seeing through them.
    const parts = comboParts(r.handle);
    if (r.is_combo && parts.length < 2) continue;

    const mine = r.books.find((b) => b.book === book);
    if (!mine) continue;

    /**
     * A market probability for this line from whoever publishes one.
     *
     * PrizePicks quotes no odds — it prices by moving the line — but another
     * book often lists the same market at the same number, and that devigged
     * probability is a read on this line too. It only transfers when the
     * numbers match exactly: at a different line it is a different bet.
     *
     * Any priced book will do, not just Underdog. The old version hardcoded
     * one, which meant a third book publishing prices would have been ignored
     * while the anchor sat empty.
     */
    const twin = r.books.find(
      (b) => b.book !== book && b.line === mine.line
        && b.over_price !== null && b.under_price !== null,
    );
    const fair = twin ? devig(twin.over_price, twin.under_price) : null;

    const options: LineOption[] = [{
      book,
      line: Number(mine.line),
      overOk: mine.over_ok,
      underOk: mine.under_ok,
      overPrice: mine.over_price === null ? null : Number(mine.over_price),
      underPrice: mine.under_price === null ? null : Number(mine.under_price),
      anchorOver: fair?.over ?? null,
      anchorUnder: fair?.under ?? null,
    }];

    const maps = r.map_end - r.map_start + 1;
    const seed = `${r.canon_handle}|${r.stat}|${r.map_start}|${r.map_end}`;
    const f = form.get(seed);
    const play = recommend(f, options, maps, seed);

    /**
     * Prefer the crowd's answer to our own.
     *
     * The projection decides direction only where no consensus exists. Where
     * three or more books price the market, the side comes from which of them
     * is out of step and the probability comes from that gap measured against
     * this player's spread — a chain with our own mean nowhere in it.
     *
     * The two are NOT blended. Averaging a measured-useless estimate into a
     * measured-useful one only adds noise, and it would make the resulting
     * number impossible to attribute when the record is finally scored. One
     * leg, one source, recorded.
     *
     * The consensus side can disagree with the model's, and when it does the
     * consensus wins outright. That is the intended behaviour: AUC 0.495 means
     * the model's opinion is worth nothing as a tiebreak either.
     */
    const edge = bookEdges(r.books).find((e) => e.book === book && e.offered);
    const ep = edge ? edgeProbability(edge, f, maps, seed) : null;
    const useConsensus = edge !== undefined && ep !== null;

    /**
     * A consensus leg does not need the model's permission to exist.
     *
     * `recommend()` returns null below MIN_SERIES or MIN_EDGE — it declines to
     * have an opinion. Skipping the market on that basis would let a signal
     * measured at AUC 0.495 veto one that does not depend on it at all, and
     * quietly: the leg would just never appear. The two paths are independent
     * and the gate has to be too.
     */
    if (!play && !useConsensus) continue;

    const side = useConsensus ? edge.side : play!.side;
    const p = useConsensus
      ? shrink(ep.p, ep.n)
      : shrink(play!.hitRate, evidenceCount(play!, maps));

    const rawMult = side === 'over' ? mine.over_mult : mine.under_mult;
    const mult = rawMult === null ? 1 : Number(rawMult);

    // The displayed play must describe the side actually being staked, or the
    // slip panel and the take button disagree about what was picked. Where the
    // model declined entirely there is no play to amend, so one is built from
    // what the consensus actually knows — and the fields it cannot know are
    // null or zero rather than invented.
    const shown: Play = useConsensus
      ? {
          ...(play ?? {
            edgeSd: null, rawWins: null, rawOf: null,
            anchored: edge.fair, rawMean: f?.mean ?? edge.fair,
            series: f?.series ?? 0, method: 'series' as const, sample: ep.n,
            breakEven: null, ev: null,
          }),
          side, line: edge.line, book,
          // The gap IS the edge on this path, in the same stat units the model
          // reports its own in.
          edge: edge.gap,
          hitRate: ep.p,
          strength: edge.gap,
          score: Math.min(99, Math.round(ep.p * 100)),
        }
      : play!;

    out.push({
      row: r,
      play: shown,
      propId: mine.prop_id,
      p, mult,
      source: useConsensus ? 'consensus' : 'model',
      gap: useConsensus ? edge.gap : null,
      value: p * mult,
      matchKey: r.match_title ?? `?${r.canon_handle}`,
      players: parts.length >= 2 ? parts : [r.canon_handle],
    });
  }

  return out.sort((a, b) => b.value - a.value);
}

/**
 * Take the N best legs, subject to the rules that stop an "optimal" entry
 * being an obviously bad one.
 *
 * - **One leg per player.** Two markets on the same player are close to the
 *   same bet twice; the entry looks diversified and isn't. A combo counts as a
 *   leg on every player in it: `knight + Viper` alongside `knight` is the same
 *   bet twice with a different name on it, and comparing canon handles alone
 *   would not notice — a combo's handle is the members run together.
 * - **At most two legs per match.** Legs from one match move together — a long
 *   game lifts everyone's kills. Both books also reprice correlated legs, so
 *   the payout we are calculating from would no longer be the payout offered.
 *
 * Greedy by value is exact for an unconstrained product and near-optimal under
 * these two, since both only ever forbid a leg outright.
 */
export function bestEntry(
  candidates: Candidate[],
  size: number,
  book: BookCode,
  maxPerMatch = 4,
  /**
   * Payout table to price the entry with. Injected so a test can pin the
   * arithmetic without depending on what happens to be in the environment,
   * and so the default can be empty without making the behaviour untestable.
   */
  payouts: Record<string, Record<number, number>> = BASE,
): Entry | null {
  // An unknown payout is not a reason to refuse to pick legs. The entry is
  // still the best N markets; it just cannot be told what it pays, so the
  // payout and EV come back null and the page says so rather than inventing
  // a multiplier.
  const base = payouts[book]?.[size] ?? null;

  const legs: Candidate[] = [];
  const players = new Set<string>();
  const perMatch = new Map<string, number>();
  /** Which direction this entry has already committed to, per match. */
  const matchSide = new Map<string, 'over' | 'under'>();

  for (const c of candidates) {
    if (legs.length === size) break;
    if (c.players.some((h) => players.has(h))) continue;
    if ((perMatch.get(c.matchKey) ?? 0) >= maxPerMatch) continue;

    /**
     * Same match, opposite sides, is the one stack to refuse.
     *
     * The old rule capped legs per match at two to spread risk, which is
     * right for independent bets and backwards for an entry that pays only
     * if every leg wins. What matters there is P(all win), and correlated
     * legs win together — measured over 35,702 same-match pairs of real CS2
     * series:
     *
     *   both overs          observed 24.69%  vs 21.30% under independence  (1.159)
     *   one over, one under observed 20.56%  vs 24.85% under independence  (0.828)
     *
     * Stacking the same direction beats independence by 16%. Mixing
     * directions is 17% worse than independence, because the two legs are
     * betting against each other: a long bloody series cashes every over on
     * it and busts every under. The cap was blocking both cases equally.
     *
     * So the constraint is on direction rather than on count. The count cap
     * stays, loosened, purely as a ceiling on concentration — an entry that
     * is five legs of one match lives or dies on one server crash.
     *
     * Underdog's per-leg multiplier and PrizePicks' demotion of correlated
     * legs both already ride in `mult`, so whatever the books claw back for
     * this shows up in the objective on its own.
     */
    const committed = matchSide.get(c.matchKey);
    if (committed !== undefined && committed !== c.play.side) continue;

    legs.push(c);
    for (const h of c.players) players.add(h);
    perMatch.set(c.matchKey, (perMatch.get(c.matchKey) ?? 0) + 1);
    matchSide.set(c.matchKey, c.play.side);
  }

  if (legs.length < size) return null;

  const payout = base === null ? null : legs.reduce((acc, l) => acc * l.mult, base);
  const winProb = legs.reduce((acc, l) => acc * l.p, 1);

  return {
    size,
    book,
    legs,
    payout,
    winProb,
    evMultiple: payout === null ? null : payout * winProb,
    discounted: legs.filter((l) => Math.abs(l.mult - 1) > 0.005).length,
  };
}

export function buildEntries(
  rows: MarketRow[],
  form: Map<string, FormStats>,
  book: BookCode,
  sizes = [3, 4, 5, 6],
): Entry[] {
  const cands = candidatesFor(rows, form, book);
  return sizes
    .map((n) => bestEntry(cands, n, book))
    .filter((e): e is Entry => e !== null);
}
