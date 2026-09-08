/**
 * One book moved. The other hasn't yet.
 *
 * This is the only signal in the app that does not rest on a projection, and
 * it is the only one that has shown a measurable edge. Four modelling ideas
 * have now failed to beat a player's own flat average — opponent strength,
 * recency weighting, kernel smoothing, longer history — because kills are
 * close to conserved in CS2 and the book already knows the average.
 *
 * So this asks a different question. Not "what will this player score", which
 * we cannot answer better than the market, but "did the book that just moved
 * know something the other one hasn't priced yet". Measured 2026-09-08 across
 * 2,101 snapshots and 147 events where exactly that happened:
 *
 *   the lagging book followed the same direction   39   (26.5%)
 *   it moved the opposite way                       6   ( 4.1%)
 *   it never moved at all                         102   (69.4%)
 *
 * When it responds it agrees about 6.5 to 1, so a move is information rather
 * than noise. And two thirds of the time it never catches up, leaving a
 * median full stat unit standing.
 *
 * Neither book leads — PrizePicks moved first 63 times to Underdog's 84 — so
 * the rule is not "follow Underdog", it is "follow whichever one moved".
 *
 * Not yet proven profitable: that needs settled outcomes the log has not
 * accumulated. Presented as an observation about the two lines, never as a
 * claim about the player.
 */

/** How recent a move has to be to still be worth acting on. */
export const FRESH_MS = 6 * 3600e3;

export type Stale = {
  /** The book that has not moved — the one holding the stale number. */
  book: 'prizepicks' | 'underdog';
  /** The book that moved first. */
  mover: 'prizepicks' | 'underdog';
  /** Which side the move points at: the mover raised its line, so the over got harder. */
  side: 'over' | 'under';
  /** Size of the mover's most recent step, signed. */
  move: number;
  /** Gap between the two books right now, absolute. */
  gap: number;
  /** When the mover moved. */
  at: string;
};

type Row = {
  pp_line: number | string | null;
  ud_line: number | string | null;
  pp_last_move: number | string | null;
  pp_last_move_at: string | null;
  ud_last_move: number | string | null;
  ud_last_move_at: string | null;
};

const num = (v: number | string | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Whether one book has moved recently and left the other behind.
 *
 * Both books must price the market — with one line there is nothing to be
 * stale against. The move must be recent, because a line that moved yesterday
 * and was never followed is not a lag, it is just two books disagreeing.
 *
 * The side is the mover's direction, not a view about the player. If the
 * mover pushed its line UP, it thinks the over is harder than it was, so the
 * stale book's lower line is the cheap over.
 */
export function staleLine(r: Row, now = Date.now()): Stale | null {
  const pp = num(r.pp_line);
  const ud = num(r.ud_line);
  if (pp === null || ud === null) return null;
  // Already on the same number: whatever the timestamps say, the books agree
  // and there is no cheaper side to take. Two books that both moved to 30.5
  // have converged, not lagged — and without a gap there is nothing to act on.
  if (pp === ud) return null;

  const cand = (
    mover: 'prizepicks' | 'underdog',
    move: number | null,
    at: string | null,
    otherAt: string | null,
  ): Stale | null => {
    if (move === null || move === 0 || at === null) return null;
    const t = Date.parse(at);
    if (!Number.isFinite(t) || now - t > FRESH_MS) return null;
    // If the other book moved at the same time or later, it is not lagging —
    // they are both reacting and there is nothing stale about either number.
    if (otherAt !== null) {
      const o = Date.parse(otherAt);
      if (Number.isFinite(o) && o >= t) return null;
    }
    return {
      mover,
      book: mover === 'prizepicks' ? 'underdog' : 'prizepicks',
      // A line pushed up means the over just got harder on the mover, so the
      // side still worth taking is the over — on the book that hasn't moved.
      side: move > 0 ? 'over' : 'under',
      move,
      gap: Math.abs(pp - ud),
      at,
    };
  };

  const fromPP = cand('prizepicks', num(r.pp_last_move), r.pp_last_move_at, r.ud_last_move_at);
  const fromUD = cand('underdog', num(r.ud_last_move), r.ud_last_move_at, r.pp_last_move_at);

  // If somehow both qualify, the more recent move is the live one.
  if (fromPP && fromUD) return Date.parse(fromPP.at) >= Date.parse(fromUD.at) ? fromPP : fromUD;
  return fromPP ?? fromUD;
}
