import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';

/**
 * Does the stale side actually win?
 *
 * The board shows "one book moved, the other hasn't" (`src/web/stale.ts`).
 * That cell was added on the strength of a measurement about *books*: when the
 * lagging book finally responds, it agrees with the mover about 6.5 to 1. The
 * obvious next question is whether taking the stale number *wins*, which is a
 * claim about *players* and needs settled outcomes to answer.
 *
 * This is that check. It reconstructs the signal from snapshot history rather
 * than calling `staleLine()` — that function reads one live board row and has
 * no notion of a past moment, so the reconstruction here is deliberately
 * separate and deliberately stricter: an event counts only when the lagging
 * book's number is on the *cheap* side of the move.
 *
 * Two arms, because they are different claims:
 *
 *   stale  take the mover's direction at the LAGGING book's number  <- the pitch
 *   mover  take the same direction at the MOVER's own new number    <- control
 *
 * If only `stale` wins, the value is in the stale price and it is worth
 * chasing. If both win, it is just "follow the move" and staleness is
 * decoration. If neither wins, the cell is reporting something that predicts
 * other books rather than outcomes — which is what it in fact does, as of
 * 2026-09-08: 41-41, exactly 50.0%, over 49 independent player-matches.
 *
 * Re-run as history accumulates. 49 matches carries a standard error near 7
 * points, which excludes a large edge and not a small one.
 *
 *   npm run validate:stale
 */

/** How long a move stays "recent" — matches FRESH_MS in `web/stale.ts`. */
const FRESH_MS = 6 * 3600e3;
/** Ignore moves made long before kick-off; those are opening-line churn. */
const WINDOW_MS = FRESH_MS * 4;
/** Maps must have been played inside this window around the scheduled time. */
const SETTLE_EARLY = 3 * 3600e3;
const SETTLE_LATE = 12 * 3600e3;

type Point = { at: number; line: number };
type Market = {
  books: Map<string, Point[]>;
  handle: string;
  stat: string;
  mapStart: number;
  mapEnd: number;
  scheduled: number | null;
};

type Arm = { won: number; lost: number; pushed: number };
const arm = (): Arm => ({ won: 0, lost: 0, pushed: 0 });

/** The book's line as of `t`, or null if it had not priced the market yet. */
function lineAt(points: Point[], t: number): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.at <= t) v = p.line;
    else break;
  }
  return v;
}

export async function main(): Promise<void> {
  const snaps = await q<{
    canon_handle: string; stat: string; ms: number; me: number;
    book: string; line: number; obs: number; sched: number | null;
  }>(`
    SELECT p.canon_handle, pr.stat, pr.map_start AS ms, pr.map_end AS me,
           b.code AS book, ps.line::float8 AS line,
           extract(epoch from ps.observed_at) * 1000 AS obs,
           extract(epoch from m.scheduled_at) * 1000 AS sched
      FROM prop_snapshot ps
      JOIN prop pr ON pr.id = ps.prop_id
      JOIN player p ON p.id = pr.player_id
      JOIN book b ON b.id = pr.book_id
      LEFT JOIN match m ON m.id = pr.match_id
     WHERE pr.is_combo = false AND pr.variant = 'standard' AND pr.league = 'CS2'
     ORDER BY ps.observed_at`);

  const markets = new Map<string, Market>();
  for (const s of snaps) {
    const key = `${s.canon_handle}|${s.stat}|${s.ms}-${s.me}`;
    let m = markets.get(key);
    if (!m) {
      m = { books: new Map(), handle: s.canon_handle, stat: s.stat,
            mapStart: s.ms, mapEnd: s.me, scheduled: null };
      markets.set(key, m);
    }
    // Each book carries its own match row, so kick-off comes from whichever
    // book supplied one first. They agree to within minutes.
    if (m.scheduled === null && s.sched !== null) m.scheduled = Number(s.sched);
    const arr = m.books.get(s.book) ?? [];
    arr.push({ at: Number(s.obs), line: Number(s.line) });
    m.books.set(s.book, arr);
  }

  const results = await q<{
    h: string; mn: number; t: number;
    kills: number | null; headshots: number | null;
    assists: number | null; deaths: number | null;
  }>(`SELECT canon_handle AS h, map_number AS mn, kills, headshots, assists, deaths,
             extract(epoch from played_at) * 1000 AS t
        FROM map_stat_dedup
       WHERE league = 'CS2' AND played_at IS NOT NULL`);

  const byPlayer = new Map<string, typeof results>();
  for (const r of results) {
    const a = byPlayer.get(r.h) ?? [];
    a.push(r);
    byPlayer.set(r.h, a);
  }

  /**
   * The player's total over the map range, or null when it cannot be settled.
   *
   * Null covers two different situations on purpose: the series has not been
   * collected yet, and the series ended before the range did (a maps-1-3 prop
   * on a 2-0 sweep). Both are voids, neither is a loss.
   */
  function settle(m: Market): number | null {
    const sched = m.scheduled;
    if (sched === null) return null;
    const want = m.mapEnd - m.mapStart + 1;
    const rows = (byPlayer.get(m.handle) ?? []).filter((r) => {
      const t = Number(r.t);
      return t >= sched - SETTLE_EARLY && t <= sched + SETTLE_LATE
        && r.mn >= m.mapStart && r.mn <= m.mapEnd;
    });
    if (rows.length !== want) return null;
    let total = 0;
    for (const r of rows) {
      const v = (r as unknown as Record<string, number | null>)[m.stat];
      if (v === null || v === undefined) return null;
      total += Number(v);
    }
    return total;
  }

  const stale = arm();
  const mover = arm();
  const byGap = new Map<number, { won: number; lost: number }>();
  let events = 0, settled = 0, unsettled = 0;
  const playerMatches = new Set<string>();

  for (const m of markets.values()) {
    if (m.scheduled === null) continue;
    const pp = m.books.get('prizepicks');
    const ud = m.books.get('underdog');
    if (!pp || !ud) continue;

    for (const [moverPts, lagPts] of [[pp, ud], [ud, pp]] as const) {
      for (let i = 1; i < moverPts.length; i++) {
        const from = moverPts[i - 1]!.line;
        const to = moverPts[i]!.line;
        const at = moverPts[i]!.at;
        if (from === to) continue;
        if (at > m.scheduled) continue;                    // pre-match only
        if (m.scheduled - at > WINDOW_MS) continue;
        const dir = Math.sign(to - from);
        const lag = lineAt(lagPts, at);
        if (lag === null || lag === to) continue;          // no gap to take
        // The lagging number must be the cheap one. If a book raised its line
        // and the other is already higher still, there is nothing to take.
        if (Math.sign(to - lag) !== dir) continue;
        events++;

        const total = settle(m);
        if (total === null) { unsettled++; continue; }
        settled++;
        playerMatches.add(`${m.handle}|${m.scheduled}`);

        const over = dir > 0;
        for (const [a, line] of [[stale, lag], [mover, to]] as const) {
          if (total === line) { a.pushed++; continue; }
          if (over ? total > line : total < line) a.won++;
          else a.lost++;
        }

        const gap = Math.abs(to - lag);
        const g = byGap.get(gap) ?? { won: 0, lost: 0 };
        byGap.set(gap, g);
        if (total !== lag) {
          if (over ? total > lag : total < lag) g.won++;
          else g.lost++;
        }
      }
    }
  }

  const show = (name: string, a: Arm) => {
    const n = a.won + a.lost;
    if (!n) { console.log(`${name.padEnd(24)} nothing decided`); return; }
    const rate = a.won / n;
    const se = Math.sqrt(0.25 / n);
    console.log(
      `${name.padEnd(24)} ${String(a.won).padStart(4)}-${String(a.lost).padEnd(4)}` +
      ` = ${(rate * 100).toFixed(1)}%   push ${String(a.pushed).padStart(2)}` +
      `   z ${((rate - 0.5) / se).toFixed(2)}`);
  };

  const both = [...markets.values()].filter((m) => m.books.size > 1).length;
  console.log(`markets priced by both books: ${both}`);
  console.log(`stale events (gap on the cheap side): ${events}`);
  console.log(`  settled ${settled}, not settled ${unsettled}`);
  console.log(`  independent player-matches: ${playerMatches.size}`);
  console.log();
  show('take @ stale line', stale);
  show('take @ mover line', mover);

  console.log('\nstale arm, by gap size:');
  for (const [gap, v] of [...byGap].sort((a, b) => a[0] - b[0])) {
    const n = v.won + v.lost;
    if (!n) continue;
    console.log(`  ${gap.toFixed(1)}  ${String(v.won).padStart(3)}-${String(v.lost).padEnd(3)}` +
                ` = ${((v.won / n) * 100).toFixed(0)}%   n=${n}`);
  }

  const n = stale.won + stale.lost;
  console.log();
  if (!n) {
    console.log('VERDICT: nothing has settled yet. Needs more logging time.');
  } else {
    const rate = stale.won / n;
    const se = Math.sqrt(0.25 / n);
    const z = (rate - 0.5) / se;
    console.log(
      Math.abs(z) < 2
        ? `VERDICT: no measurable edge. ${(rate * 100).toFixed(1)}% is within ` +
          `${Math.abs(z).toFixed(2)} standard errors of a coin flip. At n=${n} ` +
          `this excludes a large edge, not a small one.`
        : `VERDICT: ${(rate * 100).toFixed(1)}% at z=${z.toFixed(2)}. Check the ` +
          `independent-match count (${playerMatches.size}) before believing it — ` +
          `legs inside one match are not independent.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}
