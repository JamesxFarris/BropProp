import { config } from '../config.js';
import type { MarketRow } from './boardq.js';
import type { Play } from './projection.js';
import type { BookCode } from '../books.js';
import { devig } from '../devig.js';
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
   * Where the direction came from. Only one answer survives measurement.
   *
   * There were two others. `model` meant `recommend()`, graded at AUC 0.495 and
   * -9.5% ROI over 3,137 real closing lines. `consensus` meant where this book
   * sat against the others, graded 74-73 over 147 series at p = 1.00 — and the
   * books were later found to resell one supplier's prices, so there was never
   * a crowd to read. Both are gone; a leg is priced by the market or not at all.
   */
  source: 'market';
  /** Kept null. It held the gap from a book consensus, which never predicted. */
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
   * arithmetic without depending on what happens to be in the environment.
   *
   * The default is Sleeper's published ladder with anything in `PAYOUT_TABLE`
   * layered over it, so an environment entry always wins. Built per call rather
   * than captured in a module-level const, because `PUBLISHED_LADDER` is
   * declared further down this file: a const here would read it before it
   * exists. Default parameters are evaluated at call time, which is safe.
   */
  payouts: Record<string, Record<number, number>> = { ...PUBLISHED_LADDER, ...BASE },
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
 * Nothing here has ever produced an honest 60% leg: legs are priced at the
 * book's own devigged marginal now, and a book that believed a side landed 60%
 * of the time would move the line rather than post it. Offering a 4-pick by
 * default was the app recommending the shape its own maths says to avoid.
 *
 * See docs/STRATEGY.md for the full break-even table.
 */
export const DEFAULT_SIZES = [3, 5, 6];

/**
 * Stack sizes: 5 and 6 only. A three-leg stack does not clear its own bar.
 *
 * Two teammates plus an opponent, every leg on the same side, measured end to
 * end on the CS2 archive at walk-forward lines: it goes all-over **16.8%** of
 * the time (4,215 series, CI [15.9, 17.8]) against the **20%** a 5x three-pick
 * needs. On real closing lines it is 21.9% against the same 20%, but on 70
 * series. One estimate is tight and negative, the other loose and barely
 * positive, so the shape is not recommended.
 *
 * Correlation compounds faster than the ladder does, which is why the edge only
 * appears once enough legs sit on it. The same measurement puts 4+1 at 10.1%
 * against a 5.3% bar and 5+1 at 7.8% against 2.9%.
 *
 * `DEFAULT_SIZES` keeps its 3: a three-pick ENTRY of uncorrelated legs is a
 * different product from a three-leg STACK, and is not what this measured.
 */
export const STACK_SIZES = [5, 6];

/**
 * What an all-must-win entry pays by leg count, where the book publishes it.
 *
 * Only Sleeper does: `GET api.sleeper.app/payouts`, unauthenticated, answering
 * with `all_in` (every pick must win — the Power equivalent), `all_in_pick_8`,
 * `classic` (a flex ladder that pays something at n-1) and its own `version`,
 * 7 when this was read. Below is `all_in`, verified 2026-09-12.
 *
 * This is a hardcoded copy of a published table, which `config.ts` warns
 * against for good reason. The difference is that this one is checkable: the
 * endpoint is free, needs no auth and stamps a version, so drift is detectable
 * rather than silent. Re-read it if `version` moves off 7.
 *
 * A per-pick multiplier is NOT this. Sleeper's 1.48-2.2 per option is its
 * marginal on that leg — what `marketCandidates` devigs — and multiplying them
 * together only looked right because the ladder is set so a typical pick
 * compounds into it (1.78^6 = 31.8 against a 34x six-pick). PrizePicks and
 * Underdog publish nothing comparable and stay absent, so the page asks for a
 * quote rather than inventing one.
 */
export const PUBLISHED_LADDER: Record<string, Record<number, number>> = {
  sleeper: { 2: 2, 3: 5, 4: 9, 5: 19, 6: 34, 7: 49, 8: 99 },
};

/**
 * The entries offered on Build, priced by the market rather than by us.
 *
 * These legs used to come from `candidatesFor`, which set each one's side and
 * probability from whichever of two signals had an opinion. Both have since
 * been graded and **both are dead**: the per-prop model at AUC 0.495 and -9.5%
 * ROI over 3,137 real closing lines, and the cross-book consensus at 74-73 over
 * 147 series, p = 1.00 — the latter now with a known structural cause, namely
 * that the books resell one supplier's opinion rather than holding three.
 *
 * Ranking legs by `p x mult` where `p` carries no information is not
 * optimisation, it is sorting noise and printing the top of it. The per-leg
 * percentages shown on the card came from the same place, and so did the
 * required multiplier computed from them, so the headline number was noise too.
 *
 * So an entry is now the same honest object a stack is: each leg priced at the
 * book's own devigged marginal where it prices both sides, and the team-outcome
 * mixture where it does not. Nothing here claims to know better than the book.
 * What the card is for is the arithmetic — what this many legs must be paid to
 * break even — and that is worth showing precisely because it does not clear:
 * it is the contrast that makes the correlated stack worth taking.
 */
export function buildEntries(
  rows: MarketRow[],
  teamOdds: Map<string, TeamOdds>,
  book: BookCode,
  sizes = DEFAULT_SIZES,
): Entry[] {
  const cands = marketCandidates(rows, teamOdds, book, { stackableOnly: false, requireTeam: false });
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
 * The side used to come from the book consensus or the projection, and both
 * have now been graded at a coin flip — 74-73 over 147 series, and AUC 0.495.
 * What survived measurement is different in kind: it is not about the player at
 * all.
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
   * `bothSides` emits both sides of every leg rather than only its better one.
   * The stack search wants this: a stack's partner must be on the core's side,
   * and the measured tail makes a sub-50% partner on that side far better than
   * a 55% partner against it.
   *
   * `stackableOnly` and `requireTeam` default to the stack search's needs, and
   * an ENTRY turns both off. Neither restriction is about pricing a leg — a
   * leg's marginal is the book's devigged number whatever league it is in and
   * whoever he plays for. They exist because a STACK needs a measured
   * correlation (CS2 only) and needs to know which players are teammates. An
   * entry needs neither, and applying them there would silently drop every LoL
   * market and every leg whose team no book published.
   */
  opts: { bothSides?: boolean; stackableOnly?: boolean; requireTeam?: boolean } = {},
): Candidate[] {
  const stackableOnly = opts.stackableOnly ?? true;
  const requireTeam = opts.requireTeam ?? true;
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
    if (stackableOnly && !STACKABLE_LEAGUES.has(r.league)) continue;
    const mine = r.books.find((b) => b.book === book);
    if (!mine) continue;
    const team = mine.team ?? r.books.find((b) => b.team)?.team ?? null;
    // A stack is grouped by team, so a teamless leg cannot join one. An entry
    // can: `winCountDistribution` gives an unknown team its own bucket, which
    // earns it the weaker opponent correlation rather than a guess.
    if (requireTeam && !team) continue;

    // No team means no moneyline to mix, so such a leg falls through to the
    // book's own price, or to the measured baseline if it has none.
    const odds = team === null ? undefined : teamOdds.get(team);
    /**
     * Where the book prices both sides, ITS number is the marginal — not our
     * flat team baseline.
     *
     * This matters most exactly where a book pays best. A Sleeper pick at 2.12
     * over / 1.52 under is Sleeper saying the over lands about 40% of the time.
     * Pricing that leg at our 0.484 and then taking the 2.12 manufactures EV
     * out of the disagreement: the search would hunt for whichever legs the
     * book prices longest and call the difference an edge. Measured on the
     * first live board, that error made Sleeper six-pick stacks read as paying
     * 24-30x against a 10.9x break-even — an edge that was really just the
     * book's own opinion being thrown away.
     *
     * The stack edge is not a disagreement about legs; it is the ladder
     * underpricing correlation. So take the book's marginals and let the
     * measured teammate correlation and tail do the work on top of them.
     * PrizePicks prices no side, so there the team read stands.
     */
    const priced = mine.over_price !== null && mine.under_price !== null
      ? devig(Number(mine.over_price), Number(mine.under_price))
      : null;
    const pUnder = priced
      ? priced.under
      : odds ? underProbForTeam(odds.pWin) : MEASURED_UNDER_BASELINE;
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

