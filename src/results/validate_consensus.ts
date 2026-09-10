import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { pricedEdges, MIN_BOOKS } from '../web/consensus.js';
import type { BookLine } from '../web/boardq.js';
import type { FormStats } from '../web/projection.js';

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
 * ## This one CAN be measured now
 *
 * The crowd path needs three books and there will not be a third — settled
 * 2026-09-10, see RUNBOOK. What runs instead is the priced-book anchor:
 * Underdog publishes two-sided odds and PrizePicks does not, so Underdog's
 * line is a stated coin flip that PrizePicks' different line can be measured
 * against. Both books have been logged since the beginning, so **this is
 * scoreable on snapshots already collected** rather than only forward.
 *
 * That makes it the first market-derived signal here that does not need
 * months of waiting before anyone knows whether it works.
 */

/** Maps must have been played inside this window around the scheduled time. */
const SETTLE_EARLY = 3 * 3600e3;
const SETTLE_LATE = 12 * 3600e3;
/** Ignore prices set long before kick-off; those are opening-line churn. */
const WINDOW_MS = 24 * 3600e3;

type Point = { at: number; line: number; over: number | null; under: number | null };
type Market = {
  books: Map<string, Point[]>;
  handle: string;
  stat: string;
  mapStart: number;
  mapEnd: number;
  scheduled: number | null;
};

/** The book's whole quote as of `t`, or null if it had not priced it yet. */
function pointAt(points: Point[], t: number): Point | null {
  let v: Point | null = null;
  for (const p of points) {
    if (p.at <= t) v = p;
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
    over_price: number | null; under_price: number | null;
  }>(`
    SELECT p.canon_handle, pr.stat, pr.map_start AS ms, pr.map_end AS me,
           b.code AS book, ps.line::float8 AS line,
           ps.over_price::float8 AS over_price, ps.under_price::float8 AS under_price,
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
    arr.push({
      at: Number(s.obs), line: Number(s.line),
      over: s.over_price === null ? null : Number(s.over_price),
      under: s.under_price === null ? null : Number(s.under_price),
    });
    m.books.set(s.book, arr);
  }

  const booksSeen = new Set(snaps.map((s) => s.book));
  const multi = [...markets.values()].filter((m) => m.books.size >= 2).length;
  const threeBook = [...markets.values()].filter((m) => m.books.size >= MIN_BOOKS).length;

  console.log(`books ever logged: ${[...booksSeen].sort().join(', ') || 'none'}`);
  console.log(`markets: ${markets.size}, priced by 2+ books: ${multi}, by ${MIN_BOOKS}+: ${threeBook}`);
  if (multi === 0) {
    console.log('\nNothing to measure: no market has ever been priced by two books.');
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

  /**
   * This player's range totals from series played BEFORE `before`.
   *
   * Walk-forward, and not a convenience: the spread is used to turn a price
   * into a distance, and building it from games that include the one being
   * predicted would leak the answer into the estimate. Every other validator
   * here makes the same cut for the same reason.
   */
  function priorTotals(m: Market, before: number): FormStats | undefined {
    const want = m.mapEnd - m.mapStart + 1;
    const rows = (byPlayer.get(m.handle) ?? []).filter((r) => Number(r.t) < before);
    // Group into series by kick-off day, the same way settle() brackets them.
    const bySeries = new Map<number, number[]>();
    for (const r of rows) {
      if (r.mn < m.mapStart || r.mn > m.mapEnd) continue;
      const v = (r as unknown as Record<string, number | null>)[m.stat];
      if (v === null || v === undefined) continue;
      const key = Math.round(Number(r.t) / (12 * 3600e3));
      const a = bySeries.get(key) ?? [];
      a.push(Number(v));
      bySeries.set(key, a);
    }
    const totals: number[] = [];
    const mapValues: number[] = [];
    for (const vals of bySeries.values()) {
      mapValues.push(...vals);
      if (vals.length === want) totals.push(vals.reduce((a, b) => a + b, 0));
    }
    if (totals.length === 0 && mapValues.length === 0) return undefined;
    const mean = totals.length
      ? totals.reduce((a, b) => a + b, 0) / totals.length
      : mapValues.reduce((a, b) => a + b, 0) / mapValues.length;
    return { series: totals.length, mean, sd: null, totals, mapValues, perMap: null };
  }

  let won = 0, lost = 0, pushed = 0, unsettled = 0;
  /** Which anchor each event used, so the two can be read apart. */
  const anchorCount = { crowd: 0, priced: 0 };
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
    if (m.books.size < 2) continue;

    // The last moment before kick-off at which every book had a price — the
    // closing consensus, which is what a bettor would actually have seen.
    const at = m.scheduled - 60e3;
    if (m.scheduled - at > WINDOW_MS) continue;

    const lines: BookLine[] = [];
    for (const [book, pts] of m.books) {
      const pt = pointAt(pts, at);
      if (pt === null) continue;
      lines.push({
        book, prop_id: 0, line: pt.line,
        // The prices as they stood at that moment. Without them the priced
        // anchor cannot be rebuilt and this whole measurement collapses back
        // to the crowd path, which has no data.
        over_price: pt.over, under_price: pt.under,
        // Availability is not reconstructable from snapshots, so every side is
        // treated as takeable here. That makes this measurement slightly
        // OPTIMISTIC — some flagged sides could not have been placed — which is
        // the direction to be aware of when reading the result.
        over_ok: true, under_ok: true,
        over_mult: null, under_mult: null,
        moved: null, last_move: null, last_move_at: null, side: null,
      });
    }
    if (lines.length < 2) continue;

    // The player's spread, as of the games played BEFORE this match. Using
    // every game including this one would leak the result into the estimate.
    const hist = priorTotals(m, m.scheduled);
    const edge = pricedEdges(lines, hist, m.mapEnd - m.mapStart + 1, `${m.handle}|${m.stat}`)[0];
    if (!edge) continue;

    if (lines.length >= MIN_BOOKS) anchorCount.crowd++;
    else anchorCount.priced++;

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

  console.log(`market side: ${won}-${lost}  ${((won / decided) * 100).toFixed(1)}%`);
  console.log(
    `anchors used: crowd ${anchorCount.crowd}, priced book ${anchorCount.priced}`,
  );

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
