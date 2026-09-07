import type { MarketRow } from './boardq.js';
import type { FormStats, Play } from './projection.js';
import { recommend, type LineOption } from './projection.js';

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

const BASE: Record<string, Record<number, number>> = {
  prizepicks: { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 },
  underdog: { 2: 3, 3: 6, 4: 10, 5: 20 },
};

export type Candidate = {
  row: MarketRow;
  play: Play;
  propId: number;
  /** Win probability, shrunk toward a coin flip by how thin the evidence is. */
  p: number;
  /** What this leg pays relative to a standard one (Underdog discounts some). */
  mult: number;
  /** p x mult — the whole objective, per leg. */
  value: number;
  matchKey: string;
};

export type Entry = {
  size: number;
  book: 'prizepicks' | 'underdog';
  legs: Candidate[];
  payout: number;        // base x product of leg multipliers
  winProb: number;       // product of leg probabilities
  evMultiple: number;    // payout x winProb; above 1.0 is profitable
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
  book: 'prizepicks' | 'underdog',
): Candidate[] {
  const out: Candidate[] = [];
  const now = Date.now();

  for (const r of rows) {
    // A market already under way cannot be entered.
    if (r.scheduled_at && new Date(r.scheduled_at).getTime() < now) continue;
    // Combos have no per-player projection to reason about.
    if (r.is_combo) continue;

    const line = book === 'prizepicks' ? r.pp_line : r.ud_line;
    const propId = book === 'prizepicks' ? r.pp_prop_id : r.ud_prop_id;
    if (line === null || propId === null) continue;

    const options: LineOption[] = [{
      book,
      line: Number(line),
      overOk: book === 'prizepicks' ? r.pp_over_ok : r.ud_over_ok,
      underOk: book === 'prizepicks' ? r.pp_under_ok : r.ud_under_ok,
    }];

    const maps = r.map_end - r.map_start + 1;
    const f = form.get(`${r.canon_handle}|${r.stat}|${r.map_start}|${r.map_end}`);
    const play = recommend(f, options, maps, `${r.canon_handle}|${r.stat}|${r.map_start}|${r.map_end}`);
    if (!play) continue;

    const p = shrink(play.hitRate, evidenceCount(play, maps));
    const rawMult =
      book === 'underdog'
        ? play.side === 'over' ? r.ud_over_mult : r.ud_under_mult
        : null;
    const mult = rawMult === null ? 1 : Number(rawMult);

    out.push({
      row: r, play, propId, p, mult,
      value: p * mult,
      matchKey: r.match_title ?? `?${r.canon_handle}`,
    });
  }

  return out.sort((a, b) => b.value - a.value);
}

/**
 * Take the N best legs, subject to the rules that stop an "optimal" entry
 * being an obviously bad one.
 *
 * - **One leg per player.** Two markets on the same player are close to the
 *   same bet twice; the entry looks diversified and isn't.
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
  book: 'prizepicks' | 'underdog',
  maxPerMatch = 2,
): Entry | null {
  const base = BASE[book]?.[size];
  if (base === undefined) return null;

  const legs: Candidate[] = [];
  const players = new Set<string>();
  const perMatch = new Map<string, number>();

  for (const c of candidates) {
    if (legs.length === size) break;
    if (players.has(c.row.canon_handle)) continue;
    if ((perMatch.get(c.matchKey) ?? 0) >= maxPerMatch) continue;
    legs.push(c);
    players.add(c.row.canon_handle);
    perMatch.set(c.matchKey, (perMatch.get(c.matchKey) ?? 0) + 1);
  }

  if (legs.length < size) return null;

  const payout = legs.reduce((acc, l) => acc * l.mult, base);
  const winProb = legs.reduce((acc, l) => acc * l.p, 1);

  return {
    size,
    book,
    legs,
    payout,
    winProb,
    evMultiple: payout * winProb,
    discounted: legs.filter((l) => Math.abs(l.mult - 1) > 0.005).length,
  };
}

export function buildEntries(
  rows: MarketRow[],
  form: Map<string, FormStats>,
  book: 'prizepicks' | 'underdog',
  sizes = [3, 4, 5, 6],
): Entry[] {
  const cands = candidatesFor(rows, form, book);
  return sizes
    .map((n) => bestEntry(cands, n, book))
    .filter((e): e is Entry => e !== null);
}
