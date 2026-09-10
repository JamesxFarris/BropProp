import type { BookLine } from './boardq.js';
import type { BookCode } from '../books.js';

/**
 * One book moved. The others haven't yet.
 *
 * This asks a question about BOOKS rather than about players: did the book that
 * just moved know something the rest haven't priced yet. Measured 2026-09-08
 * across 2,101 snapshots and 147 events where exactly that happened:
 *
 *   the lagging book followed the same direction   39   (26.5%)
 *   it moved the opposite way                       6   ( 4.1%)
 *   it never moved at all                         102   (69.4%)
 *
 * When it responds it agrees about 6.5 to 1, so a move is information rather
 * than noise. And two thirds of the time it never catches up, leaving a median
 * full stat unit standing.
 *
 * **But the stale side does not win.** `npm run validate:stale` settled it at
 * 41-41, exactly 50.0%, over 49 independent player-matches. A move predicts
 * what the other book will print, not what the player will do — those are
 * different claims and only the first survived. So this stays on the board as
 * an observation about two numbers and must never be dressed up as an edge.
 *
 * For a signal that does point at outcomes, see `consensus.ts`. That one reads
 * direction off where a book sits relative to the crowd rather than off who
 * moved first, and it needs three books to say anything at all.
 *
 * No book leads: PrizePicks moved first 63 times to Underdog's 84, so the rule
 * is not "follow book X", it is "follow whichever one moved".
 */

/** How recent a move has to be to still be worth acting on. */
export const FRESH_MS = 6 * 3600e3;

export type Stale = {
  /** The book holding the stale number — where the cheap side would be taken. */
  book: BookCode;
  /** The book that moved. */
  mover: BookCode;
  /** Which side the move points at: the mover raised its line, so the over got harder. */
  side: 'over' | 'under';
  /** Size of the mover's most recent step, signed. */
  move: number;
  /** Gap between the mover and the stale book, absolute. */
  gap: number;
  /** When the mover moved. */
  at: string;
};

const at = (s: string | null): number | null => {
  if (s === null) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/**
 * Whether one book has moved recently and left the others behind.
 *
 * Every book must be considered, not just a pair. With three books the
 * question "has the other one followed" becomes "has ANY of them followed",
 * and a mover that two books have already matched is not leading anything —
 * so the mover has to be strictly the most recent to have moved.
 *
 * The side is the mover's direction, not a view about the player. If the mover
 * pushed its line UP, it thinks the over is harder than it was, so a lower line
 * elsewhere is the cheap over.
 *
 * Which lagging book gets named is a price question with one answer: for an
 * over you want the lowest line still standing, for an under the highest. That
 * is the same rule `consensus.betterSide` uses, applied to whoever has not
 * moved.
 */
export function staleLine(books: BookLine[], now = Date.now()): Stale | null {
  // With one book there is nothing to be stale against.
  if (books.length < 2) return null;

  // The most recent qualifying move. A zero step is not a move, and a move
  // older than FRESH_MS that nobody followed is a settled difference of
  // opinion rather than a lag — calling that stale keeps a dead row lit up.
  let mover: BookLine | null = null;
  let movedAt = -Infinity;
  for (const b of books) {
    if (b.last_move === null || b.last_move === 0) continue;
    const t = at(b.last_move_at);
    if (t === null || now - t > FRESH_MS) continue;
    if (t > movedAt) { mover = b; movedAt = t; }
  }
  if (!mover) return null;

  // Anyone who moved at the same moment or later is reacting too, so nothing
  // is lagging. Ties count against the mover: two books stepping together are
  // both responding to the same news.
  for (const b of books) {
    if (b.book === mover.book) continue;
    const t = at(b.last_move_at);
    if (t !== null && t >= movedAt) return null;
  }

  const side: 'over' | 'under' = mover.last_move! > 0 ? 'over' : 'under';

  // The best stale number for that side, among books that have not moved and
  // that actually offer it. A book sitting on the mover's own number has
  // converged, not lagged, so it is no cheaper and is skipped by the
  // comparison below rather than by a special case.
  let best: BookLine | null = null;
  for (const b of books) {
    if (b.book === mover.book) continue;
    if (side === 'over' ? !b.over_ok : !b.under_ok) continue;
    const better = side === 'over' ? b.line < mover.line : b.line > mover.line;
    if (!better) continue;
    if (!best || (side === 'over' ? b.line < best.line : b.line > best.line)) best = b;
  }
  if (!best) return null;

  return {
    mover: mover.book,
    book: best.book,
    side,
    move: mover.last_move!,
    gap: Math.abs(mover.line - best.line),
    at: mover.last_move_at!,
  };
}
