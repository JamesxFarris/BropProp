import type { BookLine } from './boardq.js';
import type { BookCode } from '../books.js';
import { resampleTotals, type FormStats } from './projection.js';
import { devig } from '../devig.js';

/**
 * What the books, together, think a market is worth — and which one is off it.
 *
 * This is the only signal in the app whose direction does not come from our own
 * projection, and that matters because the projection has been measured and has
 * no direction to give: `npm run validate:calls` scored it at **AUC 0.495** over
 * 323 calls, meaning a call it rates 75% wins no more often than one it rates
 * 56%. Ranking legs by that number is ranking them by noise. So the edge has to
 * come from somewhere else, and the only other thing on the board is the books.
 *
 * The method is the one every DFS comparison tool uses, and it is not the
 * stale-line signal in `stale.ts`. That one asks "who moved first" and was
 * measured at 41-41 — dead level — because a move predicts what the OTHER BOOK
 * will print, not what the player will do. This asks a different question:
 * where does this book sit relative to everyone else pricing the same market,
 * right now, movement or no movement.
 *
 * ## Why this needs three books and cannot be faked with two
 *
 * With two books there is no consensus to be off. The median of two numbers is
 * their midpoint, and "which of the two is the outlier" is symmetric — if
 * PrizePicks says 28.5 and Underdog says 30.5, nothing in those two numbers
 * says which is wrong. A third book breaks the tie: at 28.5 / 30.5 / 30.5 the
 * crowd is at 30.5 and PrizePicks is the outlier, and taking its over is taking
 * a number two full kills cheaper than the market's.
 *
 * That is the entire reason for adding books, and it is why this module returns
 * `null` below `MIN_BOOKS` instead of returning something weaker. A midpoint
 * dressed up as a consensus would produce a confident direction out of a market
 * that contains none — which is the failure mode the whole app is trying to
 * stop making. Two books can still say which one is the better PRICE for a side
 * you had already decided to take; see `betterSide` below. They cannot say
 * which side to take.
 */

/**
 * How many books must price a market before a consensus means anything.
 *
 * Three is the arithmetic minimum for a median to have a majority behind it,
 * not a comfortable number. At three, one book dropping its listing collapses
 * the signal entirely, and a single miscoded line moves the crowd. Four or more
 * is where this starts being robust.
 */
export const MIN_BOOKS = 3;

/** Books are weighted equally on purpose — see `consensusLine`. */
export type Consensus = {
  /** The crowd's line: the median across every book pricing the market. */
  fair: number;
  /** How many books stood behind it. */
  n: number;
  /** Widest disagreement among them, in stat units. */
  spread: number;
};

/** Why there is no consensus, when there is none. */
export type NoConsensus = 'one-book' | 'need-three-books';

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The crowd's line, or why there isn't one.
 *
 * Median rather than mean, because one book listing a stale or fat-fingered
 * number should not drag the crowd toward it — which is the exact situation
 * this is built to detect, and a mean would launder the outlier into the
 * baseline it is being measured against.
 *
 * Every book counts the same. Weighting by "sharpness" is what a sportsbook
 * comparison would do, but these are all soft DFS apps pricing the same
 * recreational flow; there is no measurement here that says one of them is
 * closer to true, and inventing weights would be inventing the answer.
 */
export function consensusLine(books: BookLine[]): Consensus | NoConsensus {
  if (books.length < 2) return 'one-book';
  if (books.length < MIN_BOOKS) return 'need-three-books';
  const lines = books.map((b) => b.line);
  return {
    fair: median(lines),
    n: books.length,
    spread: Math.max(...lines) - Math.min(...lines),
  };
}

export type BookEdge = {
  book: BookCode;
  propId: number;
  /** The side this book prices cheaply relative to the others. */
  side: 'over' | 'under';
  /** This book's line. */
  line: number;
  /** What the other books say it should be. */
  fair: number;
  /** How far off the crowd it is, in stat units. Always positive. */
  gap: number;
  /** Whether the cheap side can actually be taken here. */
  offered: boolean;
};

/**
 * Every book that is off the crowd, worst offender first.
 *
 * **Leave-one-out, but only where it leaves a crowd behind.** A book sitting
 * inside its own consensus pulls the baseline toward itself and understates its
 * own gap, so the better measurement removes it first: at 28.5 / 29 / 30 / 30.5
 * the low book is 1.0 off the all-books median but 1.5 off what the rest of the
 * market says, and 1.5 is the number that describes the bet on offer.
 *
 * That only works while enough books remain. Dropping one of three leaves two,
 * and the midpoint of two is precisely what this module refuses to treat as a
 * consensus everywhere else — worse, it is a midpoint contaminated by the
 * outlier being measured. At 28.5 / 30.5 / 30.5 it would report the two books
 * that agree with each other as each being 1.0 off the market, when between
 * them they ARE the market.
 *
 * So leave-one-out applies from four books up, and at exactly three every book
 * is measured against the median of all three, itself included. That direction
 * of error is the safe one: including yourself drags the baseline toward you
 * and shrinks the gap, so a real edge reads smaller than it is. An edge that
 * reads too small costs a bet that was there; one that reads too large invents
 * a bet that was not.
 *
 * Direction is mechanical and involves no view about the player. A book below
 * the crowd is posting a line that is easier to clear, so its OVER is the cheap
 * side; a book above the crowd has left room underneath, so its UNDER is. This
 * is the sense in which the signal "points the correct way" — the direction is
 * read off the other books rather than predicted.
 *
 * Returns `[]` below `MIN_BOOKS`, because two books are a disagreement rather
 * than a crowd to be out of step with.
 */
export function bookEdges(books: BookLine[]): BookEdge[] {
  if (books.length < MIN_BOOKS) return [];
  const all = books.map((b) => b.line);

  const out: BookEdge[] = [];
  for (const b of books) {
    const others = books.filter((o) => o.book !== b.book).map((o) => o.line);
    // Leave-one-out only while what remains is still a crowd; see above.
    const fair = others.length >= MIN_BOOKS ? median(others) : median(all);
    const gap = fair - b.line;
    if (gap === 0) continue;
    const side = gap > 0 ? 'over' : 'under';
    out.push({
      book: b.book,
      propId: b.prop_id,
      side,
      line: b.line,
      fair,
      gap: Math.abs(gap),
      offered: side === 'over' ? b.over_ok : b.under_ok,
    });
  }
  return out.sort((a, b) => b.gap - a.gap);
}

/**
 * The single best thing on a market: the biggest takeable gap.
 *
 * Unoffered sides are dropped rather than ranked lower. A book that is two
 * kills below the crowd but does not list an over is not a smaller edge, it is
 * not a bet — and the board has previously shown buttons for sides that could
 * not be placed, which is worse than showing nothing.
 */
export function bestEdge(
  books: BookLine[],
  form?: FormStats,
  maps = 1,
  seed = '',
): BookEdge | null {
  // pricedEdges falls through to the crowd path when three books exist, so
  // this is the one entry point callers need. Passing no form still works —
  // an unpriced anchor needs no history — it just cannot refine a lean.
  return pricedEdges(books, form, maps, seed).find((e) => e.offered) ?? null;
}

/**
 * Which side of a market `book` is the better PRICE on, among those listing it.
 *
 * This is the two-book-safe question and it is deliberately weaker than
 * `bookEdges`. It says nothing about which side will win — only that if you
 * have already decided to take the over, the lowest line available is where to
 * take it, and the highest is where to take an under. That holds at any number
 * of books including two, needs no consensus, and cannot be wrong, because it
 * is a statement about prices rather than about players.
 *
 * `both` means this book ties for the best number on both sides — which is what
 * every book returns when they all agree.
 */
export function betterSide(books: BookLine[], book: BookCode): 'both' | 'over' | 'under' {
  const me = books.find((b) => b.book === book);
  if (!me) return 'both';
  const lines = books.map((b) => b.line);
  const lowest = Math.min(...lines);
  const highest = Math.max(...lines);
  // Same number everywhere: no side is better here than anywhere else.
  if (lowest === highest) return 'both';
  if (me.line === lowest) return 'over';
  if (me.line === highest) return 'under';
  // Priced inside the range: beaten on both sides by somebody.
  return 'both';
}

/**
 * Turning "1.5 kills off the crowd" into "wins 58% of the time".
 *
 * A gap in stat units ranks markets but cannot be bet on: 1.5 kills on a 30.5
 * line and 1.5 kills on a 5.5 assists line are wildly different propositions,
 * and `MIN_EDGE` being an absolute 0.5 across every market is a known defect
 * for exactly this reason. Turning the gap into a probability needs one more
 * thing — how widely this player's output actually swings — and that is the
 * only place history gets used.
 *
 * ## Location from the market, shape from history
 *
 * This is the whole discipline of the function, and it is what separates it
 * from the projection that has already been measured at AUC 0.495.
 *
 * The projection tries to answer "how many kills will this player get", and
 * four experiments say it cannot beat the player's own flat average, while the
 * book already knows that average. It also over-projects: 61% of markets sit
 * above the book's line, mean +0.65 units. So its estimate of WHERE the
 * distribution sits is the part that is wrong.
 *
 * Its estimate of HOW WIDE the distribution is faces no such problem. Spread is
 * a far easier statistic than location, nobody is competing it away, and
 * nothing in the validation touched it.
 *
 * So the sample is taken from history, then slid bodily along until its median
 * sits exactly on the consensus line. The market decides where the middle is;
 * history only says how far from the middle this player tends to land. Our own
 * mean is never consulted, and cannot leak its bias in.
 */
export type EdgeProb = {
  /** Chance the flagged side wins, before any shrinking. */
  p: number;
  /** Real observed totals, or single maps resampled into range totals. */
  method: 'totals' | 'resampled';
  /** Independent observations behind the shape — NOT the number of draws. */
  n: number;
};

/** The middle of a sample, used to anchor it to the market's line. */
function sampleMedian(xs: number[]): number {
  return median(xs);
}

/**
 * How likely the flagged side is to win, given the crowd's line and this
 * player's spread.
 *
 * Returns null when there is no usable history. That is a refusal, not a
 * 50%: a market we cannot size is not a market we know to be a coin flip, and
 * the two must not sort together.
 *
 * `n` is deliberately conservative on the resampled path. 4,000 draws off
 * twelve maps is twelve observations' worth of evidence, and resampling also
 * makes the distribution too NARROW — it treats maps within a series as
 * independent when a player having a good series is good across all of it, so
 * real totals swing wider than the draws do. A too-narrow distribution turns a
 * given gap into too large a probability, which is the dangerous direction, so
 * the caller is expected to shrink this toward 0.5 by `n`.
 */
export function edgeProbability(
  edge: BookEdge,
  form: FormStats | undefined,
  maps: number,
  seed: string,
): EdgeProb | null {
  const s = sampleFor(form, maps, seed);
  if (!s) return null;
  const { sample, useTotals } = s;

  // Slide the sample so its middle sits on the crowd's line. After this, a
  // draw above `edge.fair` is exactly a 50/50 proposition — which is what the
  // consensus line asserts — and everything the probability says about
  // `edge.line` comes from the shape around it.
  const shift = edge.fair - sampleMedian(sample);
  const shifted = sample.map((v) => v + shift);

  // Pushes leave the denominator rather than counting as half a win. A total
  // landing exactly on the line returns the stake; it is not a win at a
  // discount, and averaging it in would quietly inflate every whole-numbered
  // line's probability.
  let wins = 0;
  let decided = 0;
  for (const v of shifted) {
    if (v === edge.line) continue;
    decided++;
    if (edge.side === 'over' ? v > edge.line : v < edge.line) wins++;
  }
  if (decided === 0) return null;

  return {
    p: wins / decided,
    method: useTotals ? 'totals' : 'resampled',
    n: useTotals ? form!.totals.length : Math.floor(form!.mapValues.length / Math.max(1, maps)),
  };
}

/**
 * The distribution of range totals to measure a line against.
 *
 * Real totals over the exact range are the honest sample: they carry the
 * series-level swing that resampling flattens. They are also scarce — a Bo3
 * that ended 2-0 contributes nothing to a maps 1-3 market — so single maps get
 * resampled into range totals when there are too few.
 *
 * Shared by `edgeProbability` and `fairLine` so the two cannot disagree about
 * what this player's spread is.
 */
function sampleFor(
  form: FormStats | undefined,
  maps: number,
  seed: string,
): { sample: number[]; useTotals: boolean } | null {
  if (!form) return null;
  const MIN_TOTALS = 6;
  const useTotals = form.totals.length >= MIN_TOTALS;
  const sample = useTotals
    ? form.totals
    : form.mapValues.length > 0
      ? resampleTotals(form.mapValues, maps, seed)
      : [];
  if (sample.length === 0) return null;
  return { sample, useTotals };
}

// ------------------------------------------------- the fair line, two ways --

/**
 * What the market thinks the true 50/50 number is — from a crowd, or from a
 * book that publishes odds.
 *
 * The crowd path is `consensusLine` above and needs three books. There are two.
 * There is not going to be a third: settled 2026-09-10, Sleeper carries no
 * esports at all, Dabble has three CS2 fixtures, and every other pick'em app is
 * behind Cloudflare or has no web API. The only source of esports player-prop
 * prices beyond these two is PandaScore, which produces its own odds and sells
 * them B2B.
 *
 * So this is the path that actually runs, and it rests on an asymmetry already
 * in the data: **Underdog publishes genuine two-sided American odds and
 * PrizePicks cannot** — PrizePicks charges a flat multiplier on the whole entry
 * and expresses price by moving the line instead.
 *
 * Two books cannot vote, because a line difference is symmetric: nothing in
 * "28.5 versus 30.5" says which is wrong. It stops being symmetric the moment
 * one of them states a probability.
 *
 * ## The correction that makes this worth building
 *
 * I first assumed this only worked where Underdog's two prices differ, since
 * 397 of its 434 priced markets sit at a flat -112/-112 — no side taken. That
 * was wrong, and it wrongly made the idea look like a thin-slice curiosity.
 *
 * A book's LINE is its own 50/50 point. Flat vig does not mean "no
 * information", it means "the information is entirely in where they put the
 * number". So Underdog's line IS the anchor on all 434, and the price only
 * refines it on the 37 where they lean. The signal covers every market both
 * books price, not a minority of it.
 */
export type FairLine = {
  /** The line at which the market implies a coin flip. */
  fair: number;
  /** Where that came from, so a measurement can be split by provenance. */
  method: 'crowd' | 'priced-book';
  /** The book supplying it on the priced path; null on the crowd path. */
  from: BookCode | null;
  /** How many books stood behind it. */
  n: number;
};

/**
 * Slide a sample until the given share of it sits above `line`, and return the
 * median of the slid sample.
 *
 * This is how a probability becomes a line. If Underdog's devigged price says
 * the over at 30.5 wins 55% of the time, then 30.5 is not the middle — the
 * middle is higher, and how much higher depends on how widely this player
 * swings. That last part is the only thing history is asked for.
 */
function lineAtProbability(sample: number[], line: number, pOver: number): number | null {
  if (sample.length === 0) return null;
  // The shift that puts exactly pOver of the mass above `line` is the gap
  // between `line` and the sample's own (1 - pOver) quantile.
  const sorted = [...sample].sort((a, b) => a - b);
  const idx = (1 - pOver) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const quantile = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  const shift = line - quantile;
  return median(sorted) + shift;
}

/**
 * The market's fair line, preferring a crowd and falling back to a priced book.
 *
 * Returns null when neither exists — two books that both quote no odds cannot
 * say which of them is wrong, and that is the honest answer rather than a
 * midpoint dressed up as one.
 */
export function fairLine(
  books: BookLine[],
  form: FormStats | undefined,
  maps: number,
  seed: string,
): FairLine | null {
  const crowd = consensusLine(books);
  if (typeof crowd !== 'string') {
    return { fair: crowd.fair, method: 'crowd', from: null, n: crowd.n };
  }

  // Any book publishing two-sided odds will do. Underdog is the only one today,
  // but naming it here is what made the old code unable to grow a third book.
  const priced = books.find((b) => b.over_price !== null && b.under_price !== null);
  if (!priced) return null;

  const fair = devig(priced.over_price, priced.under_price);
  if (!fair) return null;

  // Flat vig is the common case and it is not a missing answer: it says the
  // book's own line is its coin flip, which is exactly what we need.
  if (Math.abs(fair.over - 0.5) < 1e-9) {
    return { fair: priced.line, method: 'priced-book', from: priced.book, n: books.length };
  }

  // A real lean needs the player's spread to convert into a distance.
  const s = sampleFor(form, maps, seed);
  if (!s) {
    return { fair: priced.line, method: 'priced-book', from: priced.book, n: books.length };
  }
  const shifted = lineAtProbability(s.sample, priced.line, fair.over);
  return {
    fair: shifted ?? priced.line,
    method: 'priced-book',
    from: priced.book,
    n: books.length,
  };
}

/**
 * Every book whose line is off the market's fair number, worst first.
 *
 * The two-book sibling of `bookEdges`. The book supplying the anchor is never
 * measured against itself — its own line is the baseline by construction, so it
 * can only ever read as zero, and including it would put a permanent no-edge
 * row next to every real one.
 */
export function pricedEdges(
  books: BookLine[],
  form: FormStats | undefined,
  maps: number,
  seed: string,
): BookEdge[] {
  const fl = fairLine(books, form, maps, seed);
  if (!fl) return [];
  if (fl.method === 'crowd') return bookEdges(books);

  const out: BookEdge[] = [];
  for (const b of books) {
    if (b.book === fl.from) continue;
    const gap = fl.fair - b.line;
    if (gap === 0) continue;
    const side = gap > 0 ? 'over' : 'under';
    out.push({
      book: b.book, propId: b.prop_id, side, line: b.line,
      fair: fl.fair, gap: Math.abs(gap),
      offered: side === 'over' ? b.over_ok : b.under_ok,
    });
  }
  return out.sort((a, b) => b.gap - a.gap);
}
