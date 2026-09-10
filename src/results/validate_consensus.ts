import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { bookEdges, MIN_BOOKS } from '../web/consensus.js';
import type { BookLine } from '../web/boardq.js';

/**
 * Does the book that is off the crowd actually lose?
 *
 * The consensus signal claims that when three or more books price a market and
 * one of them is out of step, that book's cheap side wins more often than a
 * coin flip. It is the only signal in the app whose direction does not come
 * from our own projection, and it is currently **unmeasured**. This is the
 * script that will measure it.
 *
 * Everything else here has been through this loop and most of it failed:
 *
 *   the projection's own calls   52.0%, AUC 0.495    no skill
 *   the stale-line signal        41-41, 50.0%        no skill
 *   opponent strength            r = 0.018           nothing
 *
 * So the prior for this one should be pessimistic too, and the bar is not "is
 * the hit rate above 55%" — it is "does this beat a coin flip on a count of
 * INDEPENDENT SERIES". Until it clears that, nothing here is an edge and the
 * board must not present it as one.
 *
 *   npm run validate:consensus
 *
 * ## Why this will print nothing for a while
 *
 * It needs three books to have priced the same market at the same moment, and
 * only two books have ever been logged. It will report zero events until a
 * third adapter has been running long enough for its markets to settle. That
 * is the expected output, not a bug — and it is the honest reason the board
 * cell stays blank in the meantime.
 *
 * Book lines also only exist from the day logging started. There is no
 * historical line data to buy or scrape, so this can only ever be confirmed
 * FORWARD. Time logging is the only thing that moves it.
 */

/** Maps must have been played inside this window around the scheduled time. */
const SETTLE_EARLY = 3 * 3600e3;
const SETTLE_LATE = 12 * 3600e3;
/** Ignore prices set long before kick-off; those are opening-line churn. */
const WINDOW_MS = 24 * 3600e3;

type Point = { at: number; line: number };
type Market = {
  books: Map<string, Point[]>;
  handle: string;
  stat: string;
  mapStart: number;
  mapEnd: number;
  scheduled: number | null;
};

/** The book's line as of `t`, or null if it had not priced the market yet. */
function lineAt(points: Point[], t: number): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.at <= t) v = p.line;
    else break;
  }
  return v;
}

/**
 * An exact two-sided sign test.
 *
 * Not a z-score, and deliberately so. Leg-level statistics on prop data have
 * now been wrong three times in this project, always the same way: legs inside
 * one series share its length, its overtime and its pace, so one long map
 * sends every player on it over together. 520 settled legs came from 17 series
 * over 3 days, and an under lean that read z = 5.11 per leg was p = 0.077 per
 * series. Only the series count is real evidence, and at those counts the
 * normal approximation is not safe either.
 */
export function signTest(wins: number, n: number): number {
  if (n === 0) return 1;
  // Sum the binomial tail at p = 0.5, both sides.
  const logC: number[] = [0];
  for (let k = 1; k <= n; k++) logC.push(logC[k - 1]! + Math.log((n - k + 1) / k));
  const at = (k: number) => Math.exp(logC[k]! + n * Math.log(0.5));
  const observed = at(wins);
  let p = 0;
  for (let k = 0; k <= n; k++) {
    const d = at(k);
    // Include every outcome at least as extreme as the one seen, with a
    // tolerance so floating point does not drop the mirrored term.
    if (d <= observed * (1 + 1e-9)) p += d;
  }
  return Math.min(1, p);
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
    if (m.scheduled === null && s.sched !== null) m.scheduled = Number(s.sched);
    const arr = m.books.get(s.book) ?? [];
    arr.push({ at: Number(s.obs), line: Number(s.line) });
    m.books.set(s.book, arr);
  }

  const booksSeen = new Set(snaps.map((s) => s.book));
  const threeBook = [...markets.values()].filter((m) => m.books.size >= MIN_BOOKS).length;

  console.log(`books ever logged: ${[...booksSeen].sort().join(', ') || 'none'}`);
  console.log(`markets: ${markets.size}, priced by ${MIN_BOOKS}+ books: ${threeBook}`);
  if (threeBook === 0) {
    console.log(
      `\nNothing to measure. A consensus needs ${MIN_BOOKS} books and only ` +
      `${booksSeen.size} have ever been logged.\n` +
      `This is the expected output until a third adapter has been running long ` +
      `enough for its markets to settle — see the comment at the top of this file.`,
    );
    return;
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

  /** The player's total over the range, or null when it cannot be settled. */
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

  let won = 0, lost = 0, pushed = 0, unsettled = 0;
  const byGap = new Map<string, { won: number; lost: number }>();
  /**
   * One entry per SERIES, holding whether the consensus side won.
   *
   * This is the count that gets the significance test. Legs are recorded too,
   * for description only — printing a p-value over legs would be the same
   * mistake this project has now made three times.
   */
  const bySeries = new Map<string, { won: number; lost: number }>();

  for (const m of markets.values()) {
    if (m.scheduled === null) continue;
    if (m.books.size < MIN_BOOKS) continue;

    // The last moment before kick-off at which every book had a price — the
    // closing consensus, which is what a bettor would actually have seen.
    const at = m.scheduled - 60e3;
    if (m.scheduled - at > WINDOW_MS) continue;

    const lines: BookLine[] = [];
    for (const [book, pts] of m.books) {
      const line = lineAt(pts, at);
      if (line === null) continue;
      lines.push({
        book, prop_id: 0, line,
        over_price: null, under_price: null,
        // Availability is not reconstructable from snapshots, so every side is
        // treated as takeable here. That makes this measurement slightly
        // OPTIMISTIC — some flagged sides could not have been placed — which is
        // the direction to be aware of when reading the result.
        over_ok: true, under_ok: true,
        over_mult: null, under_mult: null,
        moved: null, last_move: null, last_move_at: null, side: null,
      });
    }
    if (lines.length < MIN_BOOKS) continue;

    const edge = bookEdges(lines)[0];
    if (!edge) continue;

    const total = settle(m);
    if (total === null) { unsettled++; continue; }

    if (total === edge.line) { pushed++; continue; }
    const win = edge.side === 'over' ? total > edge.line : total < edge.line;
    if (win) won++; else lost++;

    // Buckets by how far off the crowd the book was, to see whether a bigger
    // gap actually wins more — the property the ranking depends on.
    const bucket = edge.gap >= 3 ? '3.0+' : edge.gap >= 2 ? '2.0-2.9' : edge.gap >= 1 ? '1.0-1.9' : '0.5-0.9';
    const g = byGap.get(bucket) ?? { won: 0, lost: 0 };
    if (win) g.won++; else g.lost++;
    byGap.set(bucket, g);

    const seriesKey = `${m.handle}|${m.scheduled}`;
    const s = bySeries.get(seriesKey) ?? { won: 0, lost: 0 };
    if (win) s.won++; else s.lost++;
    bySeries.set(seriesKey, s);
  }

  const decided = won + lost;
  console.log(`\nsettled legs: ${decided} (${pushed} pushed, ${unsettled} unsettled)`);
  if (decided === 0) {
    console.log('Nothing decided yet.');
    return;
  }

  console.log(`consensus side: ${won}-${lost}  ${((won / decided) * 100).toFixed(1)}%`);

  console.log('\nby how far off the crowd:');
  for (const b of ['0.5-0.9', '1.0-1.9', '2.0-2.9', '3.0+']) {
    const g = byGap.get(b);
    if (!g) continue;
    const n = g.won + g.lost;
    console.log(`  ${b.padEnd(9)} ${String(g.won).padStart(3)}-${String(g.lost).padEnd(3)} ${((g.won / n) * 100).toFixed(1)}%  (${n} legs)`);
  }

  /**
   * The only number here that is evidence.
   *
   * A series counts once, and it counts as a win only if the consensus side
   * won more of its legs than it lost. Legs inside a series are not
   * independent observations of anything.
   */
  let sWon = 0, sLost = 0;
  for (const s of bySeries.values()) {
    if (s.won > s.lost) sWon++;
    else if (s.lost > s.won) sLost++;
  }
  const sN = sWon + sLost;
  console.log(`\nindependent series: ${sN}`);
  console.log(`series the consensus side led: ${sWon}-${sLost}`);
  console.log(`exact two-sided sign test: p = ${signTest(sWon, sN).toFixed(3)}`);
  console.log(
    '\nNo leg-level z-score is printed, on purpose. Legs inside a series share ' +
    'its length, overtime and pace, so a leg-level test reads far more ' +
    'significant than the data supports — this project has made that mistake ' +
    'three times. The series line above is the claim.',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
