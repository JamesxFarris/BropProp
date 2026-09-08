import { q } from '../db.js';

/**
 * Closing line value: did the market move toward the number you took?
 *
 * The scoreboard that works on the sample size this project actually has.
 * Win rate needs hundreds of settled bets before it says anything — the
 * backtest earlier found only about ten independent matches, because props
 * inside one match move together and a single short series drags every leg
 * under at once. CLV needs dozens, because it measures each pick against what
 * the market later decided rather than against one noisy outcome.
 *
 * The logic is direction-dependent and easy to get backwards. An over wants a
 * LOW number: take over 28.5, watch it close at 30.5, and the number you hold
 * is cheaper than anything available at the close — that is positive value.
 * An under wants a HIGH number, so the sign flips.
 *
 * Beating the close consistently is the definition of being sharp, and it is
 * true independently of whether the last ten picks happened to land. That is
 * the whole reason to track it: it separates "was this a good bet" from "did
 * this bet win", which on ten matches of evidence are very different
 * questions. DESIGN.md's phase 5 asked for exactly this.
 */

export type Clv = {
  pickId: number;
  handle: string;
  stat: string;
  side: 'over' | 'under';
  book: string;
  taken: number;
  closing: number;
  /** Stat units in your favour against the closing number. Negative is bad. */
  clv: number;
  status: string;
  takenAt: string;
};

export type ClvSummary = {
  picks: number;
  beat: number;
  tied: number;
  lost: number;
  meanClv: number;
  /** Share of picks that got a better number than the close. */
  beatRate: number;
  rows: Clv[];
};

/**
 * Every placed pick whose market kept moving after it was taken.
 *
 * The closing line is the last snapshot before kick-off — not the last
 * snapshot outright, because a line logged after a match starts is a live
 * number and a different product. Picks on markets with no later snapshot
 * are skipped rather than scored at their own price, which would report a
 * perfect zero and quietly inflate the average toward nothing.
 */
export async function clv(limit = 200): Promise<ClvSummary> {
  const rows = await q<{
    id: number; handle: string; stat: string; side: 'over' | 'under';
    book: string; taken: string; closing: string; status: string; taken_at: string;
  }>(
    `SELECT pk.id, pl.handle, pr.stat, pk.side, pk.book,
            pk.line_at_pick::text AS taken,
            (SELECT ps.line FROM prop_snapshot ps
              WHERE ps.prop_id = pk.prop_id
                AND ps.observed_at > pk.created_at
                AND (m.scheduled_at IS NULL OR ps.observed_at <= m.scheduled_at)
              ORDER BY ps.observed_at DESC LIMIT 1)::text AS closing,
            pk.status, pk.created_at::text AS taken_at
       FROM pick pk
       JOIN slip s    ON s.id = pk.slip_id AND s.status <> 'open'
       JOIN prop pr   ON pr.id = pk.prop_id
       JOIN player pl ON pl.id = pr.player_id
       LEFT JOIN match m ON m.id = pr.match_id
      ORDER BY pk.created_at DESC
      LIMIT $1`,
    [limit],
  );

  const out: Clv[] = [];
  for (const r of rows) {
    if (r.closing === null || r.closing === undefined) continue;
    const taken = Number(r.taken);
    const closing = Number(r.closing);
    if (!Number.isFinite(taken) || !Number.isFinite(closing)) continue;
    // Over wants the lower number, under the higher. Get this backwards and
    // the metric reports the opposite of the truth.
    const value = r.side === 'over' ? closing - taken : taken - closing;
    out.push({
      pickId: r.id, handle: r.handle, stat: r.stat, side: r.side, book: r.book,
      taken, closing, clv: value, status: r.status, takenAt: r.taken_at,
    });
  }

  const beat = out.filter((x) => x.clv > 0).length;
  const lost = out.filter((x) => x.clv < 0).length;
  const tied = out.length - beat - lost;
  const meanClv = out.length ? out.reduce((a, x) => a + x.clv, 0) / out.length : 0;
  // Ties are real information — the line never moved — so they stay in the
  // denominator. Dropping them would flatter the rate.
  return {
    picks: out.length, beat, tied, lost, meanClv,
    beatRate: out.length ? beat / out.length : 0,
    rows: out,
  };
}
