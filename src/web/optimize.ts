import { config } from '../config.js';
import type { MarketRow } from './boardq.js';
import type { FormStats, Play } from './projection.js';
import { recommend, type LineOption } from './projection.js';
import { comboParts } from '../normalize.js';
import type { BookCode } from '../books.js';
import { devig } from '../devig.js';
import { pricedEdges, edgeProbability } from './consensus.js';
import { probAllWin, requiredMultiplier, marginalLegWorthIt, partnerGivenCore, type SlipLeg } from './slip.js';
import { underProbForTeam, MEASURED_UNDER_BASELINE, type TeamOdds } from './matchodds.js';

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
  source: 'consensus' | 'model' | 'market';
  /** How far off the crowd this book is, in stat units. Null on the model path. */
  gap: number | null;
  /** What this leg pays relative to a standard one (Underdog discounts some). */
  mult: number;
  /**
   * What this pick pays outright, where the book publishes it (Sleeper).
   * Null elsewhere. An entry of such picks pays the product, so a stack made
   * of them can be priced with no quote typed in.
   */
  payout?: number | null;
  /** p x mult — the whole objective, per leg. */
  value: number;
  matchKey: string;
  /** The player's team, for the teammate-vs-opponent correlation split. */
  team: string | null;
  /** Every player this leg's outcome depends on — a combo depends on all of its members. */
  players: string[];
};

export type Entry = {
  size: number;
  book: BookCode;
  legs: Candidate[];
  /** base x product of leg multipliers. Null when the book's table is unknown. */
  payout: number | null;
  /**
   * P(every leg wins), with same-match correlation applied.
   *
   * Was a plain product, which is the arithmetic for independent legs and
   * understates a stacked slip by up to 1.87x. See `slip.ts`.
   */
  winProb: number;
  /** What the same slip would have been worth under the old independence assumption. */
  winProbIndependent: number;
  /**
   * The multiplier at which this entry breaks even: 1 / winProb.
   *
   * The number to compare against what the app is showing. PrizePicks' own
   * rules say a lineup's multiplier moves with pick combinations, special
   * projections and promotions — a 6-pick is not always 37.5x, it can be 23x or
   * 28x — so this is the only side of the comparison we can compute.
   */
  requiredMultiplier: number | null;
  /** payout x winProb; above 1.0 is profitable. Null without a payout. */
  evMultiple: number | null;
  discounted: number;    // legs paying below standard
  /**
   * Legs that fail the marginal test: their own win probability is below the
   * payout step they have to buy. Null where the book's ladder is unknown.
   */
  legsBelowMarginalBar: number | null;
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
     * Prefer the market's answer to our own.
     *
     * The projection decides direction only where the market cannot. With
     * three books that means a crowd consensus; with two it means the book
     * that publishes odds anchoring the one that does not — see
     * `consensus.fairLine`. Either way the side comes from where a book sits
     * against that anchor, and the probability comes from the gap measured
     * against this player's spread: a chain with our own mean nowhere in it.
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
    const edge = pricedEdges(r.books, f, maps, seed).find((e) => e.book === book && e.offered);
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
      // Underdog publishes no team at all — every one of its lines came back
      // teamless when the board was run against production — so an Underdog
      // leg could never join a stack. The same player on the same market at
      // another book usually does carry one, and a player's team does not
      // depend on who is quoting him.
      team: mine.team ?? r.books.find((b) => b.team)?.team ?? null,
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

  /**
   * P(all win), correlated.
   *
   * Legs from one match move together — a long, bloody series lifts everyone's
   * kills — so the product this used to compute was the wrong arithmetic for
   * exactly the entries the constraints below encourage. Both numbers are kept
   * so the page can show what the assumption was worth.
   */
  const slipLegs: SlipLeg[] = legs.map((l) => ({
    p: l.p, matchKey: l.matchKey, side: l.play.side, team: l.team,
  }));
  const winProb = probAllWin(slipLegs);
  const winProbIndependent = legs.reduce((acc, l) => acc * l.p, 1);

  /**
   * How many legs are not worth their own payout step.
   *
   * Adding an nth leg to an all-must-win entry only helps when that leg wins
   * more often than `M_{n-1} / M_n`. On PrizePicks that is 50%, **60%**, 50%,
   * 53.3% — the fourth leg is the expensive one. Counting the failures is more
   * useful than silently dropping them: the entry is still the best N markets
   * available, and the reader deserves to know N was the wrong N.
   */
  let belowBar: number | null = null;
  if (base !== null) {
    belowBar = 0;
    for (let i = 1; i < legs.length; i++) {
      const prev = payouts[book]?.[i] ?? null;
      const next = payouts[book]?.[i + 1] ?? null;
      const ok = marginalLegWorthIt(legs[i]!.p, prev, next);
      if (ok === false) belowBar++;
      if (ok === null) { belowBar = null; break; }
    }
  }

  return {
    size,
    book,
    legs,
    payout,
    winProb,
    winProbIndependent,
    requiredMultiplier: requiredMultiplier(slipLegs),
    evMultiple: payout === null ? null : payout * winProb,
    discounted: legs.filter((l) => Math.abs(l.mult - 1) > 0.005).length,
    legsBelowMarginalBar: belowBar,
  };
}

/**
 * Default sizes: the ones actually played, and 4 is not among them.
 *
 * A four-pick is the worst product on the PrizePicks board — 37.5% hold, and a
 * fourth leg has to win 60% of the time to be worth adding to a three-pick.
 * Nothing here has ever produced an honest 60% leg; `shrink()`'s Beta(8) prior
 * makes it nearly unreachable by construction. Offering a 4-pick by default was
 * the app recommending the shape its own maths says to avoid.
 *
 * See docs/STRATEGY.md for the full break-even table.
 */
export const DEFAULT_SIZES = [3, 5, 6];

export function buildEntries(
  rows: MarketRow[],
  form: Map<string, FormStats>,
  book: BookCode,
  sizes = DEFAULT_SIZES,
): Entry[] {
  const cands = candidatesFor(rows, form, book);
  return sizes
    .map((n) => bestEntry(cands, n, book))
    .filter((e): e is Entry => e !== null);
}

/**
 * Search for the strongest slip, instead of taking the N best legs.
 *
 * `bestEntry` is greedy: it sorts legs by their own value and fills. That is
 * exact when legs are independent, and they are not. Once teammates correlate
 * at rho 0.324, the best six-leg entry is usually NOT the six best legs — it is
 * six legs that win TOGETHER, which means a stack on one team.
 *
 * The measured numbers say how much this matters. Six legs spread over six
 * matches need 64x to break even at coin-flip legs; five on one team plus an
 * opponent need 15.56x. PrizePicks was quoted at 22x for exactly that shape.
 * Same six legs' worth of risk, a four-fold difference in what it has to pay.
 *
 * ## Why this is a search and not a formula
 *
 * The objective no longer factorises. `payout x P(all win)` with correlated
 * legs cannot be maximised leg by leg, because a leg's contribution depends on
 * who else is in the slip. So this enumerates candidate SHAPES — one team's
 * players plus a partner — rather than candidate legs, which keeps the search
 * small: there are only so many teams on a board, and a stack is defined by its
 * team.
 *
 * ## What it does NOT do
 *
 * It does not decide the side. That comes from each candidate's own play, which
 * traces back either to the book consensus or to the projection — and both have
 * been graded at a coin flip. What this optimises is the SHAPE, which is the
 * part with a measured edge behind it.
 */
export type Stack = {
  book: BookCode;
  /** The team the stack is built on. */
  team: string;
  matchKey: string;
  legs: Candidate[];
  /** Every leg pointed the same way — the shape the correlation rewards. */
  aligned: boolean;
  side: 'over' | 'under' | 'mixed';
  winProb: number;
  winProbIndependent: number;
  /** The multiplier this has to be paid to break even. Compare with the app. */
  requiredMultiplier: number;
  /** How much the correlation is worth here, as a ratio of win probabilities. */
  lift: number;
};

/**
 * Every stack worth looking at, best first.
 *
 * "Best" is the LOWEST required multiplier, because that is the number the
 * reader compares against what the app quotes them. A slip needing 10.85x is
 * strictly easier to beat than one needing 23.09x, whatever either one's legs
 * look like individually.
 */
export function findStacks(
  candidates: Candidate[],
  size: number,
  book: BookCode,
  opts: { minTeamLegs?: number } = {},
): Stack[] {
  const minTeam = opts.minTeamLegs ?? Math.max(2, size - 1);
  if (size < 2) return [];

  // Group by match, then by team within it.
  const byMatch = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.team === null) continue;          // cannot stack what we cannot group
    const arr = byMatch.get(c.matchKey) ?? [];
    arr.push(c);
    byMatch.set(c.matchKey, arr);
  }

  const out: Stack[] = [];
  for (const [matchKey, inMatch] of byMatch) {
    const byTeam = new Map<string, Candidate[]>();
    for (const c of inMatch) {
      const arr = byTeam.get(c.team!) ?? [];
      arr.push(c);
      byTeam.set(c.team!, arr);
    }

    /** One leg per player, strongest first. */
    const onePerPlayer = (cs: Candidate[], taken = new Set<string>()): Candidate[] => {
      const seen = new Set(taken);
      return [...cs].sort((a, b) => b.p - a.p).filter((c) => {
        if (c.players.some((h) => seen.has(h))) return false;
        for (const h of c.players) seen.add(h);
        return true;
      });
    };
    const toSlip = (l: Candidate): SlipLeg => ({ p: l.p, matchKey: l.matchKey, side: l.play.side, team: l.team });

    for (const [team, teamLegs] of byTeam) {
      /**
       * Each side is searched separately, and the partner is always on the
       * core's side.
       *
       * The partner used to be whichever opponent leg was strongest on its
       * own. Measured in the tail, that is the wrong question: after five
       * teammates all go over, an opponent's over hits 87% and his under 13%.
       * A sub-50% leg on the core's side beats a 55% leg against it by a mile.
       */
      for (const side of ['under', 'over'] as const) {
        const pool = onePerPlayer(teamLegs.filter((c) => c.play.side === side));

        for (let take = Math.min(pool.length, size); take >= minTeam; take--) {
          const core = pool.slice(0, take);
          const need = size - take;

          // Partners come from the other team in the same match — that keeps
          // the tail working for us — and PrizePicks requires two different
          // teams in a lineup anyway, so a pure stack is unbuildable.
          const inCore = new Set(core.flatMap((c) => c.players));
          const partners = onePerPlayer(
            inMatch.filter((c) => c.team !== team && c.play.side === side),
            inCore,
          ).slice(0, need);
          if (partners.length < need) continue;

          const legs = [...core, ...partners];
          if (legs.length !== size) continue;

          /**
           * Two different teams, always.
           *
           * PrizePicks refuses a lineup drawn from a single team, so a pure
           * stack is not a slip — it is a screenshot of one. Without this the
           * search happily returns the highest-correlation shape on the board
           * and the best number on the page is one the app will not accept.
           */
          if (new Set(legs.map((l) => l.team)).size < 2) continue;

          // One partner — every shape the Build page asks for — is priced from
          // the measured tail. More than one falls back to the copula, which
          // understates them; nothing on the page builds that shape today.
          const winProb = need === 1
            ? probAllWin(core.map(toSlip)) * partnerGivenCore(partners[0]!.p, core.length, side)
            : probAllWin(legs.map(toSlip));
          const indep = legs.reduce((acc, l) => acc * l.p, 1);
          if (!(winProb > 0)) continue;

          out.push({
            book, team, matchKey, legs,
            aligned: true,
            side,
            winProb,
            winProbIndependent: indep,
            requiredMultiplier: 1 / winProb,
            lift: indep > 0 ? winProb / indep : 1,
          });
        }
      }
    }
  }

  // Lowest bar first.
  return out.sort((a, b) => a.requiredMultiplier - b.requiredMultiplier);
}

/**
 * Legs sided and priced by the two things that have actually been measured.
 *
 * `candidatesFor` takes its side from the book consensus or the projection, and
 * both have now been graded at a coin flip — 74-73 over 147 series, and AUC
 * 0.495. What survived measurement is different in kind: it is not about the
 * player at all.
 *
 *   1. Losing teams' players go under more than winning teams' do — 57.2%
 *      against 45.7% on the books' own closing lines, and 39-22 (p = 0.040)
 *      within series that had legs on both sides. A moneyline says in advance
 *      who is likelier to lose. (First measured as 62.0/48.2, inflated by
 *      counting each player's own kills in deciding who lost; see matchodds.ts.)
 *   2. The books' blind shade against the over. It was 55.3% under on 09-10
 *      and has faded to 51.6% (p = 0.14), so it is priced as nearly nothing.
 *
 * So every leg here is priced from its TEAM: Pinnacle's win probability, mixed
 * through the measured loser/winner rates, or the measured baseline when no
 * moneyline is available. Every player on a team gets the same number, which is
 * the honest consequence of having no player-level signal that works — and it
 * is exactly why the payoff comes from stacking a team rather than picking
 * players.
 *
 * The side is the under unless the team is a heavy enough favourite that its
 * players' under drops below 50% — about a 63% favourite — in which case it is
 * the over, and a stack of that team's overs is the play instead.
 */
/**
 * The stats the team-level pricing is valid for: kills, and headshots.
 *
 * Every number behind `marketCandidates` was measured on these: the
 * loser/winner split, the teammate correlation and the opponent tail were all
 * measured on kills, and a headshot is a kill. (The first line-shade figures —
 * 44.1% over on kills, 45.7% on headshots — have since faded; see matchodds.ts.)
 *
 * DEATHS are the reason this list exists. The first render of the Stacks card
 * put "sh1ro under deaths" in a stack built on the team Pinnacle had losing —
 * but a team that gets beaten dies MORE, so on exactly the teams this favours,
 * deaths run the other way. Assists were never measured for CS2 at all (the
 * only figure is 20 LoL legs). A stat stays off this list until it has its own
 * measurement, not until it seems plausible.
 */
const MARKET_STATS = new Set(['kills', 'headshots']);

/**
 * And which LEAGUE, because correlation is a property of the game, not the
 * stat. Measured on the archive with `npm run validate:market`, walk-forward:
 *
 *   CS2 kills      teammate phi 0.168, and the tail runs with it — after four
 *                  teammates land, the next follows 79% and an opponent 71%.
 *                  A 5+1 all-over hits 7.8% against a 4.5% bar.
 *   LOL kills      teammate phi **0.005**. No correlation at all: after three
 *                  teammates land, the next is 45.6% — a coin flip. The same
 *                  4+1 shape hits 1.6% against a 5.0% bar, so stacking LoL
 *                  kills is a losing shape however the legs are chosen.
 *   LOL assists    teammate phi 0.178, but opponents move AGAINST each other
 *                  (phi -0.146): assists are shared credit on kills, and kills
 *                  are traded between the teams. A same-side opponent leg is
 *                  the worst leg available; the shape wants the opposite side,
 *                  which the builder cannot express yet.
 *
 * So only CS2 is stackable today. LoL assists stay out until the
 * opposite-side partner is measured and the builder can price it; LoL kills
 * stay out because there is nothing there to price.
 */
const STACKABLE_LEAGUES = new Set(['CS2']);

export function marketCandidates(
  rows: MarketRow[],
  teamOdds: Map<string, TeamOdds>,
  book: BookCode,
  /**
   * Emit both sides of every leg rather than only its better one. The stack
   * search wants this: a stack's partner must be on the core's side, and the
   * measured tail makes a sub-50% partner on that side far better than a
   * 55% partner against it.
   */
  opts: { bothSides?: boolean } = {},
): Candidate[] {
  const out: Candidate[] = [];
  const now = Date.now();
  for (const r of rows) {
    if (r.scheduled_at && new Date(r.scheduled_at).getTime() < now) continue;
    // A combo depends on several players, possibly on both teams. The team
    // mixture below prices ONE team, so a combo does not fit it.
    if (r.is_combo) continue;
    if (!MARKET_STATS.has(r.stat)) continue;
    // …and the league, because correlation belongs to the game. LoL kills
    // measured phi 0.005 — stacking them is the flat ladder applied to
    // independent legs, which is the bet the ladder is priced to win.
    if (!STACKABLE_LEAGUES.has(r.league)) continue;
    const mine = r.books.find((b) => b.book === book);
    if (!mine) continue;
    const team = mine.team ?? r.books.find((b) => b.team)?.team ?? null;
    if (!team) continue;

    const odds = teamOdds.get(team);
    const pUnder = odds ? underProbForTeam(odds.pWin) : MEASURED_UNDER_BASELINE;
    const better: 'over' | 'under' = pUnder >= 0.5 ? 'under' : 'over';
    const sides: ('over' | 'under')[] = opts.bothSides ? ['under', 'over'] : [better];
    for (const side of sides) {
      if (side === 'under' ? !mine.under_ok : !mine.over_ok) continue;
      const p = side === 'under' ? pUnder : 1 - pUnder;

      const rawMult = side === 'over' ? mine.over_mult : mine.under_mult;
      const mult = rawMult === null ? 1 : Number(rawMult);
      const rawPayout = side === 'over' ? mine.payout_over : mine.payout_under;
      const payout = rawPayout === null || rawPayout === undefined ? null : Number(rawPayout);
      const line = Number(mine.line);

      out.push({
        row: r,
        play: {
          side, book, line,
          edge: 0, edgeSd: null,
          hitRate: p, rawWins: null, rawOf: null,
          anchored: line, rawMean: line,
          series: 0, strength: p, score: Math.round(p * 100),
          method: 'series', sample: 0,
          breakEven: null, ev: null,
        },
        propId: mine.prop_id,
        p, mult, payout,
        source: 'market',
        gap: null,
        value: p * mult,
        matchKey: r.match_title ?? `?${r.canon_handle}`,
        team,
        players: [r.canon_handle],
      });
    }
  }
  return out.sort((a, b) => b.value - a.value);
}

