import type { BookLine } from './boardq.js';
import type { BookCode } from '../books.js';

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
export function bestEdge(books: BookLine[]): BookEdge | null {
  return bookEdges(books).find((e) => e.offered) ?? null;
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
