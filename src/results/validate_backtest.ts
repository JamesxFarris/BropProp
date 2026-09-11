import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { evaluate, HISTORY, type CallStatus, type FormStats, type LineOption } from '../web/projection.js';
import { americanToProb } from '../devig.js';
import {
  type Pred, type EdgeRow, report, reportBy, edgeTable, perLegBreakEven, clusterBootstrap,
  brier, logLoss, auc, reliability, roiOf,
} from './referee.js';

/**
 * The board's per-prop model, scored by the referee — once on the archive,
 * once on every real closing line we have.
 *
 *   npm run validate:backtest            (full run, ~10 minutes: run it detached)
 *   npm run validate:backtest -- --quick (counts and point estimates only)
 *
 * **What is being tested** is `evaluate()` from `projection.ts` exactly as it
 * ships: fed only the stat history that existed before the match, with the
 * same HISTORY limits the board uses (the replay mirrors `formBefore` in
 * `validate_calls.ts`). For every leg the model is asked for its probability
 * on each takeable side, and `p` in every `Pred` below is **the probability of
 * the side the model picks** — the number the board would print. `won` is
 * whether that side won. Legs are scored whether or not the board would have
 * made them a call; the edge tables are where "only the calls" lives.
 *
 * **Two data sets, never pooled.**
 * - *Archive*: no book lines exist before 2026-09-06, so each leg's line is the
 *   median of the player's PRIOR range totals + 0.5 (≥ 8 prior series), the
 *   walk-forward construction from `validate_correlation.ts`. This is a line a
 *   book could have set from public history, not a line a book did set — so it
 *   measures "does recent form beat a long-run median", which is a weaker
 *   opponent than a real trader. Plenty of data; the wrong adversary.
 * - *Real*: every settled closing line (last snapshot at or before kick-off),
 *   settled with the recipe in the header of `validate_calls.ts`. The right
 *   adversary; five days of data.
 *
 * **Everything that could be tuned was fixed before any result was read**:
 * the archive markets (the six the books list most that have a settling
 * column), the train/test split (2026-01-01), the real-line split
 * (2026-09-09), the edge thresholds (the referee's defaults), the slices. A
 * slice only counts as an edge if its series-bootstrap ROI interval is above
 * zero on the LATER block. With dozens of cells, about 2.5% of them will clear
 * that bar by luck, so the count of cells tested is printed next to every hit.
 *
 * **Leak guards.** Archive history is every series that ended before this one
 * started. Real-line history is every map played before the scheduled start
 * AND not part of the series that settles the leg — a match that started early
 * would otherwise hand the model its own first map. Both counts are printed.
 *
 * The constants in `projection.ts` (HISTORY, PRIOR) were chosen on this same
 * archive by Brier; they moved Brier in the fourth decimal, so the archive is
 * out of sample for every decision that matters here, but not literally for
 * all of them.
 *
 * The last line of output is one JSON object, `BACKTEST_SUMMARY {...}`, for
 * the Stats page.
 */

const COLS = ['kills', 'headshots', 'assists', 'deaths'] as const;
type Col = typeof COLS[number];
const isCol = (s: string): s is Col => (COLS as readonly string[]).includes(s);

/** Mirrors `MIN_P` in projection.ts (not exported). Only used to rank sides the same way `evaluate` does. */
const MIN_P = 0.55;
const MIN_PRIOR = 8;
const TRAIN_END = Date.UTC(2026, 0, 1);        // archive: train < this <= test
const LINES_START = Date.UTC(2026, 8, 6);      // first logged book line
const REAL_SPLIT = Date.UTC(2026, 8, 9);       // real lines: early < this <= late
const SETTLE_EARLY = 3 * 3600e3;
const SETTLE_LATE = 12 * 3600e3;
const THRESHOLDS = [0, 0.02, 0.04, 0.06, 0.08, 0.10];
const LEG_COUNTS = [3, 5, 6] as const;
const BE: Record<number, number> = Object.fromEntries(LEG_COUNTS.map((n) => [n, perLegBreakEven(n)]));

/** The markets the books list most, among those with a settling column. Chosen from `prop` counts, not from results. */
const ARCHIVE_MARKETS: { league: string; stat: Col; ms: number; me: number }[] = [
  { league: 'CS2', stat: 'kills', ms: 1, me: 2 },
  { league: 'CS2', stat: 'headshots', ms: 1, me: 2 },
  { league: 'CS2', stat: 'kills', ms: 3, me: 3 },
  { league: 'CS2', stat: 'headshots', ms: 3, me: 3 },
  { league: 'LOL', stat: 'kills', ms: 1, me: 3 },
  { league: 'LOL', stat: 'assists', ms: 1, me: 3 },
];

type Rec = { at: number } & Record<Col, number | null>;
type SeriesRec = { key: string; start: number; end: number; maps: Map<number, Rec> };

/** One scored leg: a referee `Pred` plus what the baselines need. */
type Leg = Pred & {
  at: number;
  /** Model P(over) and whether the over won — for the direction-free AUC. */
  pOver: number | null;
  overWon: boolean;
  /** Whether each side was takeable, and whether it won (null = not offered). */
  underWon: boolean | null;
  overWonIfOffered: boolean | null;
  call: boolean;
};

const pct = (v: number, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');
const f4 = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : '—');
const r4 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`;
const hitStat = (s: Pred[]) => (s.length ? s.filter((x) => x.won).length / s.length : NaN);
const seriesCount = (ps: Pred[]) => new Set(ps.map((x) => x.series)).size;
const clip = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));

function median(sorted: number[]): number {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}
function insertSorted(a: number[], v: number): void {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid]! <= v) lo = mid + 1; else hi = mid; }
  a.splice(lo, 0, v);
}

/** The player's total over [ms, me] in one series, or null if any map is missing. */
function rangeTotal(s: SeriesRec, col: Col, ms: number, me: number): number | null {
  let t = 0;
  for (let m = ms; m <= me; m++) {
    const v = s.maps.get(m)?.[col];
    if (v === null || v === undefined) return null;
    t += v;
  }
  return t;
}

/**
 * `FormStats` from only what was known before `cutoff`, shaped exactly like
 * `formBefore` in validate_calls.ts (and so like `projectBoard`): exact-range
 * totals most recent first capped at HISTORY, every single map capped at
 * HISTORY * 3. Walks newest-first and stops once both caps are full — exact
 * because one player's series do not overlap in time (overlaps are counted
 * and printed as a data check).
 */
function formBefore(
  list: SeriesRec[], cutoff: number, col: Col, ms: number, me: number, exclude?: Set<string>,
): FormStats {
  let hi = 0, top = list.length;
  while (hi < top) { const mid = (hi + top) >> 1; if (list[mid]!.start < cutoff) hi = mid + 1; else top = mid; }
  const totals: { at: number; t: number }[] = [];
  const mv: { at: number; v: number }[] = [];
  for (let j = hi - 1; j >= 0; j--) {
    if (totals.length >= HISTORY && mv.length >= HISTORY * 3) break;
    const s = list[j]!;
    if (exclude?.has(s.key)) continue;
    let at = -Infinity;
    const vals = new Map<number, number>();
    for (const [mn, r] of s.maps) {
      if (r.at >= cutoff) continue;
      const v = r[col];
      if (v === null || v === undefined) continue;
      mv.push({ at: r.at, v });
      vals.set(mn, v);
      at = Math.max(at, r.at);
    }
    if (vals.size === 0) continue;
    let t = 0, ok = true;
    for (let m = ms; m <= me; m++) { const v = vals.get(m); if (v === undefined) { ok = false; break; } t += v; }
    if (ok) totals.push({ at, t });
  }
  const tot = totals.sort((a, b) => b.at - a.at).map((x) => x.t).slice(0, HISTORY);
  const mapValues = mv.sort((a, b) => b.at - a.at).map((x) => x.v).slice(0, HISTORY * 3);
  const mean = tot.length ? tot.reduce((a, b) => a + b, 0) / tot.length : 0;
  const sd = tot.length > 1 ? Math.sqrt(tot.reduce((a, b) => a + (b - mean) ** 2, 0) / (tot.length - 1)) : null;
  return {
    series: tot.length, mean, sd, totals: tot, mapValues,
    perMap: mapValues.length ? mapValues.reduce((a, b) => a + b, 0) / mapValues.length : null,
  };
}

/** The probability `evaluate` assigned its best side, whether or not it became a call. */
function sideP(st: CallStatus): number | null {
  if (st.play !== null) return st.play.hitRate;
  const w = st.why;
  return w.kind === 'fair' || w.kind === 'priced-out' ? w.p : null;
}

type Ask = {
  form: FormStats; line: number; book: string; maps: number; stat: string; seed: string;
  overPrice: number | null; underPrice: number | null; overOk: boolean; underOk: boolean;
};
type Answer = { side: 'over' | 'under'; p: number; pOver: number | null; call: boolean; mismatch: boolean };

/**
 * Ask the model about one leg. Each side is evaluated alone to read its
 * probability (evaluate reports only the winner's), then the side is chosen
 * the way `evaluate` chooses — largest margin over max(MIN_P, price
 * break-even), over first on a tie — and checked against the real call.
 */
function ask(a: Ask): Answer | null {
  const base = { book: a.book as LineOption['book'], line: a.line, overPrice: a.overPrice, underPrice: a.underPrice };
  const run = (overOk: boolean, underOk: boolean) =>
    evaluate({ form: a.form, options: [{ ...base, overOk, underOk }], maps: a.maps, stat: a.stat, seed: a.seed });
  const pO = sideP(run(true, false));
  const pU = sideP(run(false, true));
  const bar = (price: number | null) => (price !== null && Number.isFinite(price) ? Math.max(MIN_P, americanToProb(price)) : MIN_P);
  const cands: { side: 'over' | 'under'; p: number; margin: number }[] = [];
  if (a.overOk && pO !== null) cands.push({ side: 'over', p: pO, margin: pO - bar(a.overPrice) });
  if (a.underOk && pU !== null) cands.push({ side: 'under', p: pU, margin: pU - bar(a.underPrice) });
  if (cands.length === 0) return null;
  const pick = cands.reduce((x, y) => (Math.abs(y.margin - x.margin) > 1e-9 && y.margin > x.margin ? y : x));
  const full = run(a.overOk, a.underOk);
  const mismatch = full.play !== null && (full.play.side !== pick.side || Math.abs(full.play.hitRate - pick.p) > 1e-12);
  return { side: pick.side, p: pick.p, pOver: pO, call: full.play !== null, mismatch };
}

// ───────────────────────────── data ─────────────────────────────

async function loadPlayers(): Promise<{ players: Map<string, SeriesRec[]>; overlaps: number; rows: number }> {
  const rows = await q<{
    league: string; series_key: string; canon_handle: string; map_number: number; at: string;
    kills: number | null; headshots: number | null; assists: number | null; deaths: number | null;
  }>(`SELECT league, series_key, canon_handle, map_number, extract(epoch from played_at) * 1000 AS at,
             kills, headshots, assists, deaths
        FROM map_stat_dedup
       WHERE played_at IS NOT NULL AND league IN ('CS2', 'LOL')`);
  const bySeries = new Map<string, Map<string, SeriesRec>>();
  for (const r of rows) {
    const pk = `${r.league}|${r.canon_handle}`;
    const at = Number(r.at);
    const m = bySeries.get(pk) ?? bySeries.set(pk, new Map()).get(pk)!;
    const s = m.get(r.series_key) ?? m.set(r.series_key, { key: r.series_key, start: at, end: at, maps: new Map() }).get(r.series_key)!;
    s.start = Math.min(s.start, at);
    s.end = Math.max(s.end, at);
    s.maps.set(Number(r.map_number), { at, kills: r.kills, headshots: r.headshots, assists: r.assists, deaths: r.deaths });
  }
  const players = new Map<string, SeriesRec[]>();
  let overlaps = 0;
  for (const [pk, m] of bySeries) {
    const list = [...m.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key));
    for (let i = 1; i < list.length; i++) if (list[i]!.start <= list[i - 1]!.end) overlaps++;
    players.set(pk, list);
  }
  return { players, overlaps, rows: rows.length };
}

/** Walk-forward pseudo-lines on the archive. */
/**
 * How the archive's stand-in line is set. `career` is the construction the
 * task specifies (median of ALL prior range totals + 0.5). `recent` uses only
 * the last RECENT_LINE of them — a line that already knows about form, the
 * way a trader's does. The model reads the last HISTORY series, so against a
 * career median it is partly measuring "recent form beats a stale number";
 * the recent line takes that away, and whatever edge survives it is the part
 * that could plausibly survive a real book.
 */
type LineMode = 'career' | 'recent';
const RECENT_LINE = 10;

function archiveLegs(players: Map<string, SeriesRec[]>, lineMode: LineMode = 'career'): { legs: Leg[]; pushes: number; dupSuspect: number; mismatches: number; noView: number } {
  const legs: Leg[] = [];
  let pushes = 0, dupSuspect = 0, mismatches = 0, noView = 0;
  for (const M of ARCHIVE_MARKETS) {
    const range = `${M.ms}-${M.me}`;
    for (const [pk, list] of players) {
      if (!pk.startsWith(`${M.league}|`)) continue;
      const handle = pk.slice(M.league.length + 1);
      const prior: number[] = [];
      const chrono: number[] = [];
      let ptr = 0;
      for (let i = 0; i < list.length; i++) {
        const s = list[i]!;
        while (ptr < i && list[ptr]!.end < s.start) {
          const t = rangeTotal(list[ptr]!, M.stat, M.ms, M.me);
          if (t !== null) { insertSorted(prior, t); chrono.push(t); }
          ptr++;
        }
        const total = rangeTotal(s, M.stat, M.ms, M.me);
        // Same eligibility in both modes, so the two line constructions are
        // scored on the same players and series.
        if (total === null || prior.length < MIN_PRIOR) continue;
        const line = lineMode === 'career'
          ? median(prior) + 0.5
          : median(chrono.slice(-RECENT_LINE).sort((a, b) => a - b)) + 0.5;
        if (total === line) { pushes++; continue; }
        // A duplicate of this very series under another key, just before it,
        // would leak the result into both the line and the form. Counted, not
        // silently trusted.
        if (i > 0) {
          const prev = list[i - 1]!;
          if (s.start - prev.end < 12 * 3600e3) {
            let same = true;
            for (let m = M.ms; m <= M.me; m++) if (prev.maps.get(m)?.[M.stat] !== s.maps.get(m)?.[M.stat]) same = false;
            if (same) dupSuspect++;
          }
        }
        const form = formBefore(list, s.start, M.stat, M.ms, M.me);
        const ans = ask({
          form, line, book: 'prizepicks', maps: M.me - M.ms + 1, stat: M.stat, seed: `${handle}|${M.stat}|${range}`,
          overPrice: null, underPrice: null, overOk: true, underOk: true,
        });
        if (!ans) { noView++; continue; }
        if (ans.mismatch) mismatches++;
        const overWon = total > line;
        legs.push({
          series: `${M.league}|${s.key}`,
          p: ans.p,
          won: ans.side === 'over' ? overWon : !overWon,
          at: s.start,
          pOver: ans.pOver,
          overWon,
          underWon: !overWon,
          overWonIfOffered: overWon,
          call: ans.call,
          tags: {
            league: M.league, stat: M.stat, range, market: `${M.league} ${M.stat} ${range}`,
            block: s.start < TRAIN_END ? 'train' : 'test', call: ans.call ? 'yes' : 'no', side: ans.side,
          },
        });
      }
    }
  }
  return { legs, pushes, dupSuspect, mismatches, noView };
}

type LineRow = {
  prop_id: number; book: string; prices_sides: boolean | null; league: string; stat: string; variant: string;
  canon_handle: string; line: number; map_start: number; map_end: number; sched: string;
  over_price: number | null; under_price: number | null; wager: string | null;
};

/** Every settled real closing line, the model fed only what came before. */
async function realLegs(players: Map<string, SeriesRec[]>) {
  // The closing-line recipe, verbatim, plus the same snapshot's prices and
  // side availability (the `current_line` rule) so the model sees what the
  // board saw.
  const lines = await q<LineRow>(`
    WITH closing AS (
      SELECT DISTINCT ON (ps.prop_id) ps.prop_id, ps.line::float8 AS line,
             ps.over_price, ps.under_price, ps.extra->>'allowed_wager_types' AS wager
        FROM prop_snapshot ps JOIN prop p ON p.id = ps.prop_id JOIN match m ON m.id = p.match_id
       WHERE ps.observed_at <= m.scheduled_at
       ORDER BY ps.prop_id, ps.observed_at DESC)
    SELECT cl.prop_id, b.code AS book, b.prices_sides, p.league, p.stat, p.variant, pl.canon_handle, cl.line,
           p.map_start, p.map_end, extract(epoch from m.scheduled_at) * 1000 AS sched,
           cl.over_price, cl.under_price, cl.wager
      FROM closing cl JOIN prop p ON p.id = cl.prop_id JOIN player pl ON pl.id = p.player_id
      JOIN book b ON b.id = p.book_id JOIN match m ON m.id = p.match_id
     WHERE p.is_combo = false AND m.scheduled_at < now()`);

  const legs: Leg[] = [];
  const skip = { unsupported: 0, noStats: 0, unsettled: 0, pushes: 0, noView: 0, leakGuard: 0, mismatches: 0 };
  const earlyMins: number[] = [];
  /**
   * The same real legs — same players, same matches, same outcomes — scored
   * against the archive's stand-in line (career median + 0.5) instead of the
   * book's. If the model "wins" here and loses against the book on the very
   * same games, the archive result is about the stand-in line, not the model.
   * One leg per player-market-series: several books listing the same market
   * would otherwise count it several times.
   */
  const pseudo: Leg[] = [];
  const pseudoSeen = new Set<string>();
  for (const L of lines) {
    if (!isCol(L.stat)) { skip.unsupported++; continue; }
    const col = L.stat;
    const list = players.get(`${L.league}|${L.canon_handle}`);
    if (!list) { skip.noStats++; continue; }
    const sched = Number(L.sched), ms = Number(L.map_start), me = Number(L.map_end), line = Number(L.line);
    const lo = sched - SETTLE_EARLY, hi = sched + SETTLE_LATE;
    let n = 0, total = 0, bad = false, firstStart = Infinity;
    const keys = new Set<string>();
    for (const s of list) {
      if (s.end < lo || s.start > hi) continue;
      for (const [mn, r] of s.maps) {
        if (mn < ms || mn > me || r.at < lo || r.at > hi) continue;
        n++;
        const v = r[col];
        if (v === null || v === undefined) bad = true; else total += v;
        keys.add(s.key);
        firstStart = Math.min(firstStart, s.start);
      }
    }
    if (n !== me - ms + 1 || bad) { skip.unsettled++; continue; }
    if (total === line) { skip.pushes++; continue; }
    // A series recorded as starting before the scheduled time: its maps are
    // withheld from the history below, and the minutes are kept so the
    // closing line's own exposure (a snapshot after the real start could be
    // live) can be checked.
    const startedEarly = firstStart < sched;
    if (startedEarly) { skip.leakGuard++; earlyMins.push((sched - firstStart) / 60e3); }
    const form = formBefore(list, sched, col, ms, me, keys);
    const ps = !!L.prices_sides;
    const overOk = ps ? L.over_price !== null : (L.wager ?? 'both') !== 'under';
    const underOk = ps ? L.under_price !== null : (L.wager ?? 'both') !== 'over';
    const ans = ask({
      form, line, book: L.book, maps: me - ms + 1, stat: col, seed: `${L.canon_handle}|${col}|${ms}-${me}`,
      overPrice: L.over_price, underPrice: L.under_price, overOk, underOk,
    });
    if (!ans) { skip.noView++; continue; }
    if (ans.mismatch) skip.mismatches++;
    const overWon = total > line;
    const day = new Date(sched).toISOString().slice(0, 10);
    legs.push({
      series: `${L.league}|${[...keys].sort()[0]}`,
      p: ans.p,
      won: ans.side === 'over' ? overWon : !overWon,
      at: sched,
      pOver: ans.pOver,
      overWon,
      underWon: underOk ? !overWon : null,
      overWonIfOffered: overOk ? overWon : null,
      call: ans.call,
      tags: {
        league: L.league, stat: col, range: `${ms}-${me}`, book: L.book, variant: L.variant, day,
        block: sched < REAL_SPLIT ? 'early' : 'late', call: ans.call ? 'yes' : 'no',
        startedEarly: startedEarly ? 'yes' : 'no', side: ans.side,
      },
    });

    const seriesId = `${L.league}|${[...keys].sort()[0]}`;
    const pk = `${seriesId}|${L.canon_handle}|${col}|${ms}-${me}`;
    if (!pseudoSeen.has(pk)) {
      pseudoSeen.add(pk);
      // Prior range totals from series that ended before the scheduled start
      // and are not the one being settled — the archive's construction.
      const prior: number[] = [];
      for (const s of list) {
        if (s.end >= sched || keys.has(s.key)) continue;
        const t = rangeTotal(s, col, ms, me);
        if (t !== null) prior.push(t);
      }
      if (prior.length >= MIN_PRIOR) {
        const pl = median(prior.sort((a, b) => a - b)) + 0.5;
        if (total !== pl) {
          const pa = ask({
            form, line: pl, book: 'prizepicks', maps: me - ms + 1, stat: col, seed: `${L.canon_handle}|${col}|${ms}-${me}`,
            overPrice: null, underPrice: null, overOk: true, underOk: true,
          });
          if (pa) {
            const ow = total > pl;
            pseudo.push({
              series: seriesId, p: pa.p, won: pa.side === 'over' ? ow : !ow, at: sched,
              pOver: pa.pOver, overWon: ow, underWon: !ow, overWonIfOffered: ow, call: pa.call,
              tags: { league: L.league, stat: col, range: `${ms}-${me}`, side: pa.side },
            });
          }
        }
      }
    }
  }
  return { legs, lines: lines.length, skip, earlyMins, pseudo };
}

// ──────────────────────────── scoring ────────────────────────────

type Headline = {
  legs: number; series: number; from: string; to: string; claimed: number | null; realised: number | null;
  brier: number | null; brierLo: number | null; brierHi: number | null; logLoss: number | null;
  auc: number | null; aucLo: number | null; aucHi: number | null; aucOver: number | null;
  plays: { legs: number; series: number; hit: number | null; roi: number | null; lo: number | null; hi: number | null };
};

function headline(legs: Leg[], quick: boolean): Headline {
  let minAt = Infinity, maxAt = -Infinity;
  for (const l of legs) { if (l.at < minAt) minAt = l.at; if (l.at > maxAt) maxAt = l.at; }
  const br = quick ? { point: brier(legs), lo: NaN, hi: NaN } : clusterBootstrap(legs, brier, 1000);
  const au = quick ? { point: auc(legs), lo: NaN, hi: NaN } : clusterBootstrap(legs, auc, 1000);
  const ov = legs.filter((l) => l.pOver !== null).map((l) => ({ series: l.series, p: l.pOver!, won: l.overWon }));
  const play = quick
    ? (() => { const s = legs.filter((l) => l.p >= BE[5]!); return { legs: s.length, series: seriesCount(s), hitRate: hitStat(s), roi: roiOf(BE[5]!)(s), roiLo: NaN, roiHi: NaN }; })()
    : edgeTable(legs, BE[5]!, [0])[0]!;
  return {
    legs: legs.length, series: seriesCount(legs),
    from: legs.length ? new Date(minAt).toISOString().slice(0, 10) : '',
    to: legs.length ? new Date(maxAt).toISOString().slice(0, 10) : '',
    claimed: r4(legs.reduce((a, l) => a + l.p, 0) / legs.length), realised: r4(hitStat(legs)),
    brier: r4(br.point), brierLo: r4(br.lo), brierHi: r4(br.hi), logLoss: r4(logLoss(legs)),
    auc: r4(au.point), aucLo: r4(au.lo), aucHi: r4(au.hi), aucOver: r4(auc(ov)),
    plays: { legs: play.legs, series: play.series, hit: r4(play.hitRate), roi: r4(play.roi), lo: r4(play.roiLo), hi: r4(play.roiHi) },
  };
}

function printEdgeRows(rows: EdgeRow[], indent = '  '): void {
  for (const r of rows) {
    console.log(`${indent}edge ≥ ${pct(r.minEdge, 0).padStart(4)}  legs ${String(r.legs).padStart(6)}  series ${String(r.series).padStart(5)}  ` +
      `hit ${pct(r.hitRate)}  ROI ${pct(r.roi)} [${pct(r.roiLo)}, ${pct(r.roiHi)}]`);
  }
}

/** The referee report at the 5-pick bar, plus the edge tables at the 3- and 6-pick bars. */
function fullReport(label: string, legs: Leg[]): void {
  console.log(`\n${report(label, legs, BE[5])}`);
  for (const n of [3, 6]) {
    console.log(`ROI by minimum edge over the ${n}-pick Power break-even ${pct(BE[n]!, 2)}:`);
    printEdgeRows(edgeTable(legs, BE[n]!, THRESHOLDS));
  }
}

function baselines(label: string, legs: Leg[]): Record<string, number | null> {
  console.log(`\n--- baselines on the same legs: ${label} ---`);
  const as = (f: (l: Leg) => boolean | null) =>
    legs.filter((l) => f(l) !== null).map((l) => ({ series: l.series, p: 0.5, won: f(l)! }));
  const under = as((l) => l.underWon);
  const over = as((l) => l.overWonIfOffered);
  const line = (name: string, ps: Pred[]) => {
    const h = clusterBootstrap(ps, hitStat, 1000);
    const r = clusterBootstrap(ps, roiOf(BE[5]!), 1000);
    console.log(`  ${name.padEnd(34)} legs ${String(ps.length).padStart(6)}  series ${String(h.series).padStart(5)}  ` +
      `hit ${pct(h.point)} [${pct(h.lo)}, ${pct(h.hi)}]  ROI@5-pick ${pct(r.point)} [${pct(r.lo)}, ${pct(r.hi)}]`);
    return h;
  };
  console.log(`  coin flip (p = 0.5)                Brier 0.250, log loss 0.693, AUC 0.500; never clears ${pct(BE[5]!)}, so it plays nothing`);
  const m = line('model, its side, every leg', legs);
  const u = line('always under (where offered)', under);
  line('always over (where offered)', over);
  // The fair comparison for the calls: on exactly the legs the model would
  // play, did its side beat simply taking the under?
  const plays = legs.filter((l) => l.p - BE[5]! >= 0 && l.underWon !== null);
  const diff = clusterBootstrap(plays, (s) => {
    const x = s as Leg[];
    return x.length ? (x.filter((l) => l.won).length - x.filter((l) => l.underWon).length) / x.length : NaN;
  }, 1000);
  console.log(`  on the model's own plays (p ≥ ${pct(BE[5]!)}; ${plays.length} legs, ${diff.series} series):`);
  console.log(`    model hit ${pct(hitStat(plays))} vs under ${pct(plays.filter((l) => l.underWon).length / Math.max(1, plays.length))} ` +
    `on the same legs; model − under ${pct(diff.point)} [${pct(diff.lo)}, ${pct(diff.hi)}]`);
  return { modelHit: r4(m.point), underHit: r4(u.point), underLo: r4(u.lo), underHi: r4(u.hi), playsMinusUnder: r4(diff.point), playsMinusUnderLo: r4(diff.lo), playsMinusUnderHi: r4(diff.hi) };
}

/** Log-loss-optimal k for p → 0.5 + k(p − 0.5), and the Brier-optimal one in closed form. */
function fitK(legs: Pred[]): { k: number; kBrier: number } {
  const ll = (k: number) => {
    let s = 0;
    for (const l of legs) { const p = clip(0.5 + k * (l.p - 0.5)); s -= l.won ? Math.log(p) : Math.log(1 - p); }
    return s / legs.length;
  };
  let a = -1.5, b = 1.5;
  for (let i = 0; i < 100; i++) {
    const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
    if (ll(m1) <= ll(m2)) b = m2; else a = m1;
  }
  let num = 0, den = 0;
  for (const l of legs) { num += (l.p - 0.5) * ((l.won ? 1 : 0) - 0.5); den += (l.p - 0.5) ** 2; }
  return { k: (a + b) / 2, kBrier: den > 0 ? num / den : NaN };
}
const shrink = <T extends Pred>(legs: T[], k: number): T[] => legs.map((l) => ({ ...l, p: 0.5 + k * (l.p - 0.5) }));

/** Fit on an earlier block, judge on a later one. Nothing about the later block touches k. */
function calibrationFix(label: string, fitOn: Leg[], fitLabel: string, test: Leg[], quick: boolean): Record<string, number | string | null> {
  console.log(`\n--- calibration fix: ${label} ---`);
  if (fitOn.length === 0 || test.length === 0) { console.log('  nothing to fit or test'); return {}; }
  const { k, kBrier } = fitK(fitOn);
  const after = shrink(test, k);
  console.log(`  k fitted on ${fitLabel} (${fitOn.length} legs, ${seriesCount(fitOn)} series): k = ${f3(k)} (log loss), ${f3(kBrier)} (Brier)`);
  const pairedDiff = (f: (s: Pred[]) => number) => (quick
    ? { point: f(shrink(test, k)) - f(test), lo: NaN, hi: NaN }
    : clusterBootstrap(test, (s) => f(shrink(s, k)) - f(s), 1000));
  const dB = pairedDiff(brier), dL = pairedDiff(logLoss);
  console.log(`  held-out (${test.length} legs, ${seriesCount(test)} series):`);
  console.log(`    Brier    ${f4(brier(test))} → ${f4(brier(after))}   change ${f4(dB.point)} [${f4(dB.lo)}, ${f4(dB.hi)}]`);
  console.log(`    log loss ${f4(logLoss(test))} → ${f4(logLoss(after))}   change ${f4(dL.point)} [${f4(dL.lo)}, ${f4(dL.hi)}]`);
  console.log(`    AUC unchanged by construction (a monotone map cannot reorder legs): ${f3(auc(test))}`);
  console.log(`    calibration after shrinking (claimed → realised):`);
  for (const b of reliability(after, 8)) {
    console.log(`      n=${String(b.n).padStart(6)}  claimed ${pct(b.meanP)}  realised ${pct(b.hitRate)}`);
  }
  const before5 = test.filter((l) => l.p >= BE[5]!), after5 = after.filter((l) => l.p >= BE[5]!);
  console.log(`    legs clearing the 5-pick bar ${pct(BE[5]!)}: ${before5.length} (${seriesCount(before5)} series) before, ` +
    `${after5.length} (${seriesCount(after5)} series) after`);
  if (after5.length && !quick) {
    console.log(`    ROI of what still clears, after shrinking:`);
    printEdgeRows(edgeTable(after, BE[5]!, [0]), '      ');
  }
  return {
    fitOn: fitLabel, k: r4(k), kBrier: r4(kBrier),
    brierBefore: r4(brier(test)), brierAfter: r4(brier(after)), brierChangeLo: r4(dB.lo), brierChangeHi: r4(dB.hi),
    logLossBefore: r4(logLoss(test)), logLossAfter: r4(logLoss(after)),
    playsBefore: before5.length, playsAfter: after5.length,
  };
}

type Hit = { set: string; slice: string; legs: number; minEdge: number; block: string; roi: number; lo: number; hi: number; series: number; confirmed: boolean };

/**
 * Every pre-declared slice × threshold × payout, on each block. An ROI
 * interval above zero on the LATER block is a hit; one that was also above
 * zero on the earlier block is a replicated hit. The full grid is printed at
 * the 5-pick bar; the 3- and 6-pick grids print only their hits.
 */
function scan(set: string, dims: string[], early: { name: string; legs: Leg[] }, late: { name: string; legs: Leg[] }): { cells: number; hits: Hit[] } {
  console.log(`\n--- slice scan: ${set} (ROI interval above zero on "${late.name}" = hit; also above on "${early.name}" = replicated) ---`);
  const hits: Hit[] = [];
  let cells = 0;
  const groups: { slice: string; f: (l: Leg) => boolean }[] = [{ slice: 'all', f: () => true }];
  for (const d of dims) {
    const vals = [...new Set([...early.legs, ...late.legs].map((l) => l.tags?.[d] ?? '(none)'))].sort();
    for (const v of vals) groups.push({ slice: `${d}=${v}`, f: (l) => (l.tags?.[d] ?? '(none)') === v });
  }
  for (const n of LEG_COUNTS) {
    if (n === 5) console.log(`  at the 5-pick bar ${pct(BE[5]!, 2)}:  slice | edge | ${early.name}: legs/series hit ROI [CI] | ${late.name}: legs/series hit ROI [CI]`);
    for (const g of groups) {
      const a = edgeTable(early.legs.filter(g.f), BE[n]!, THRESHOLDS);
      const b = edgeTable(late.legs.filter(g.f), BE[n]!, THRESHOLDS);
      for (let i = 0; i < THRESHOLDS.length; i++) {
        const x = a[i]!, y = b[i]!;
        if (y.series < 2) continue;
        cells++;
        const hit = y.roiLo > 0;
        const confirmed = hit && x.roiLo > 0;
        const cell = (r: EdgeRow) => `${String(r.legs).padStart(5)}/${String(r.series).padStart(4)} ${pct(r.hitRate).padStart(6)} ${pct(r.roi).padStart(7)} [${pct(r.roiLo)}, ${pct(r.roiHi)}]`;
        const flag = confirmed ? '  <== REPLICATED' : hit ? `  <== hit on ${late.name} only` : x.roiLo > 0 ? `  (${early.name} only)` : '';
        if (n === 5 || hit) {
          console.log(`  ${n === 5 ? '' : `[${n}-pick] `}${g.slice.padEnd(26)} ≥${pct(THRESHOLDS[i]!, 0).padStart(3)} | ${cell(x)} | ${cell(y)}${flag}`);
        }
        if (hit) hits.push({ set, slice: g.slice, legs: n, minEdge: THRESHOLDS[i]!, block: late.name, roi: y.roi, lo: y.roiLo, hi: y.roiHi, series: y.series, confirmed });
      }
    }
  }
  console.log(`  ${cells} cells tested on "${late.name}"; ~${(cells * 0.025).toFixed(1)} would clear by luck alone (one-sided 2.5%). ` +
    `Hits: ${hits.length}, replicated: ${hits.filter((h) => h.confirmed).length}.`);
  return { cells, hits };
}

// ───────────────────────────── main ─────────────────────────────

export async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  const { players, overlaps, rows } = await loadPlayers();
  console.log(`${stamp()} loaded ${rows} player-maps, ${players.size} players; overlapping consecutive series (data check): ${overlaps}`);

  const A = archiveLegs(players);
  console.log(`${stamp()} archive: ${A.legs.length} legs, ${seriesCount(A.legs)} series; pushes skipped ${A.pushes}; ` +
    `no view ${A.noView}; duplicate-series suspects ${A.dupSuspect}; side mismatches vs evaluate ${A.mismatches}`);
  const R = await realLegs(players);
  console.log(`${stamp()} real: ${R.lines} closing lines → ${R.legs.length} scored legs, ${seriesCount(R.legs)} series; skipped ${JSON.stringify(R.skip)}`);
  console.log(`  (leakGuard = legs whose settling series began before the scheduled start; its maps were withheld from the model's history)`);
  if (R.earlyMins.length) {
    const e = [...R.earlyMins].sort((a, b) => a - b);
    const qt = (f: number) => e[Math.min(e.length - 1, Math.floor(f * e.length))]!.toFixed(0);
    console.log(`  how early those series began, minutes before scheduled: median ${qt(0.5)}, p90 ${qt(0.9)}, max ${qt(1)}; ` +
      `> 30 min: ${e.filter((x) => x > 30).length}`);
    const clean = R.legs.filter((l) => l.tags?.startedEarly === 'no');
    console.log(`  sensitivity, legs whose series began on or after schedule only: ${clean.length} legs / ${seriesCount(clean)} series, ` +
      `claimed ${pct(clean.reduce((a, l) => a + l.p, 0) / Math.max(1, clean.length))} vs realised ${pct(hitStat(clean))}, AUC ${f3(auc(clean))}`);
  }

  const train = A.legs.filter((l) => l.at < TRAIN_END), test = A.legs.filter((l) => l.at >= TRAIN_END);
  const early = R.legs.filter((l) => l.at < REAL_SPLIT), late = R.legs.filter((l) => l.at >= REAL_SPLIT);
  const preLines = A.legs.filter((l) => l.at < LINES_START);
  console.log(`  archive train (< 2026-01-01) ${train.length} legs / ${seriesCount(train)} series; test ${test.length} / ${seriesCount(test)}`);
  console.log(`  real early (< 2026-09-09) ${early.length} legs / ${seriesCount(early)} series; late ${late.length} / ${seriesCount(late)}`);
  console.log(`  p below is the model's probability for the side it picks; won = that side won. Bars: 3-pick ${pct(BE[3]!, 2)}, 5-pick ${pct(BE[5]!, 2)}, 6-pick ${pct(BE[6]!, 2)}.`);

  const H = {
    archive: headline(A.legs, quick), archiveTest: headline(test, quick),
    real: headline(R.legs, quick), realLate: headline(late, quick),
  };
  console.log(`${stamp()} headlines: ${JSON.stringify(H)}`);

  let bl: Record<string, unknown> = {};
  let fix: Record<string, unknown> = {};
  const scans: { cells: number; hits: Hit[] }[] = [];
  if (!quick) {
    console.log(`\n${'='.repeat(70)}\nARCHIVE — walk-forward pseudo-lines (prior median + 0.5)\n${'='.repeat(70)}`);
    fullReport('ARCHIVE, all legs', A.legs);
    console.log(`${stamp()}`);
    fullReport('ARCHIVE, held-out block (2026-01-01 on)', test);
    console.log(`\n${reportBy('ARCHIVE held-out', test, 'league', BE[5])}`);
    console.log(`\n${reportBy('ARCHIVE held-out', test, 'stat', BE[5])}`);
    console.log(`\n${reportBy('ARCHIVE held-out', test, 'range', BE[5])}`);
    console.log(`${stamp()}`);

    console.log(`\n${'='.repeat(70)}\nREAL CLOSING LINES — ${H.real.from} to ${H.real.to} (five days: thin)\n${'='.repeat(70)}`);
    fullReport('REAL closing lines, all', R.legs);
    for (const t of ['league', 'stat', 'range', 'book', 'variant']) console.log(`\n${reportBy('REAL', R.legs, t, BE[5])}`);
    console.log(`${stamp()}`);

    console.log(`\n${'='.repeat(70)}\nBASELINES\n${'='.repeat(70)}`);
    bl = { archiveTest: baselines('archive held-out block', test), real: baselines('real closing lines', R.legs) };

    console.log(`\n${'='.repeat(70)}\nCALIBRATION FIX  p → 0.5 + k(p − 0.5)\n${'='.repeat(70)}`);
    fix = {
      archive: calibrationFix('archive', train, 'archive < 2026-01-01', test, quick),
      realFromArchive: calibrationFix('real lines, k from the archive', preLines, 'archive < 2026-09-06', R.legs, quick),
      realFromEarly: calibrationFix('real lines, k from the early days', early, 'real < 2026-09-09', late, quick),
    };
    console.log(`${stamp()}`);

    console.log(`\n${'='.repeat(70)}\nIS ANY SLICE PROFITABLE ON HELD-OUT DATA?\n${'='.repeat(70)}`);
    scans.push(scan('archive', ['league', 'stat', 'range', 'market'], { name: 'train', legs: train }, { name: 'test', legs: test }));
    scans.push(scan('real', ['league', 'stat', 'range', 'book', 'variant'], { name: 'early', legs: early }, { name: 'late', legs: late }));
    console.log(`${stamp()}`);
  } else {
    fix = { archive: calibrationFix('archive (quick)', train, 'archive < 2026-01-01', test, true) };
  }

  // The leak hunt. The archive "edge" and the real-line loss cannot both be
  // about the model; this asks which line each one was beating.
  console.log(`\n${'='.repeat(70)}\nWHICH LINE IS BEING BEATEN? (the leak hunt)\n${'='.repeat(70)}`);
  const sideSplit = (label: string, legs: Leg[]) => {
    for (const side of ['over', 'under']) {
      const s = legs.filter((l) => l.tags?.side === side && l.p - BE[5]! >= 0.04);
      console.log(`  ${label} — ${side} plays at edge ≥ 4%: ${s.length} legs / ${seriesCount(s)} series, hit ${pct(hitStat(s))}`);
    }
  };
  const underRate = (legs: Leg[]) => legs.filter((l) => !l.overWon).length / Math.max(1, legs.length);
  sideSplit('archive held-out, career line', test);
  const AR = archiveLegs(players, 'recent');
  const testRecent = AR.legs.filter((l) => l.at >= TRAIN_END);
  console.log(`\n  archive held-out against a RECENT line (median of the last ${RECENT_LINE} prior + 0.5), same eligibility: ` +
    `${testRecent.length} legs / ${seriesCount(testRecent)} series; under wins ${pct(underRate(testRecent))} (career line: ${pct(underRate(test))})`);
  const tRecent = edgeTable(testRecent, BE[5]!, THRESHOLDS);
  printEdgeRows(tRecent);
  sideSplit('archive held-out, recent line', testRecent);
  console.log(`\n  the REAL games against the career stand-in line (same players, matches, outcomes; ${R.pseudo.length} legs / ${seriesCount(R.pseudo)} series):`);
  const tPseudo = edgeTable(R.pseudo, BE[5]!, THRESHOLDS);
  printEdgeRows(tPseudo);
  console.log(`  the same games against the BOOKS' closing lines (${R.legs.length} legs / ${seriesCount(R.legs)} series):`);
  const tBook = edgeTable(R.legs, BE[5]!, THRESHOLDS);
  printEdgeRows(tBook);
  const row4 = (r: EdgeRow) => ({ legs: r.legs, series: r.series, hit: r4(r.hitRate), roi: r4(r.roi), lo: r4(r.roiLo), hi: r4(r.roiHi) });
  const i4 = THRESHOLDS.indexOf(0.04);
  const adversary = {
    note: 'edge >= 4% at the 5-pick bar; the archive result depends on which line it is scored against',
    archiveCareerLine: row4(edgeTable(test, BE[5]!, [0.04])[0]!),
    archiveRecentLine: row4(tRecent[i4]!),
    realGamesCareerLine: row4(tPseudo[i4]!),
    realGamesBookLine: row4(tBook[i4]!),
  };
  console.log(`${stamp()}`);

  const hits = scans.flatMap((s) => s.hits);
  const cells = scans.reduce((a, s) => a + s.cells, 0);
  const replicated = hits.filter((h) => h.confirmed);
  console.log(`\n${'='.repeat(70)}\nVERDICT (numbers, not adjectives)\n${'='.repeat(70)}`);
  const v = (name: string, h: Headline) => console.log(
    `  ${name.padEnd(22)} ${h.legs} legs / ${h.series} series  claimed ${pct(h.claimed ?? NaN)} vs realised ${pct(h.realised ?? NaN)}  ` +
    `Brier ${f4(h.brier ?? NaN)} [${f4(h.brierLo ?? NaN)}, ${f4(h.brierHi ?? NaN)}]  AUC ${f3(h.auc ?? NaN)} [${f3(h.aucLo ?? NaN)}, ${f3(h.aucHi ?? NaN)}]  ` +
    `plays@5-pick ${h.plays.legs} legs ROI ${pct(h.plays.roi ?? NaN)} [${pct(h.plays.lo ?? NaN)}, ${pct(h.plays.hi ?? NaN)}]`);
  v('archive, all', H.archive); v('archive, held-out', H.archiveTest); v('real, all', H.real); v('real, late days', H.realLate);
  if (!quick) {
    console.log(`  slice scan: ${cells} held-out cells, ${hits.length} with ROI interval above zero (≈${(cells * 0.025).toFixed(1)} expected by luck), ${replicated.length} replicated on the earlier block.`);
    // The archive cells beat a stand-in line; only the real cells beat a book.
    // They are reported apart so a long list of the first cannot read as the second.
    const archN = replicated.filter((h) => h.set === 'archive').length;
    console.log(`    archive (career-median stand-in line): ${hits.filter((h) => h.set === 'archive').length} hits, ${archN} replicated — ` +
      `see the leak hunt above for which line they beat.`);
    console.log(`    real closing lines: ${hits.filter((h) => h.set === 'real').length} hits, ` +
      `${replicated.filter((h) => h.set === 'real').length} replicated.`);
    for (const h of replicated.filter((x) => x.set === 'real')) {
      console.log(`    replicated (real): ${h.slice} edge ≥ ${pct(h.minEdge, 0)} at ${h.legs}-pick: ROI ${pct(h.roi)} [${pct(h.lo)}, ${pct(h.hi)}] on ${h.series} series`);
    }
  }

  const realRep = replicated.filter((h) => h.set === 'real');
  const summary = {
    kind: 'backtest', generatedAt: new Date().toISOString(), model: 'projection.evaluate', unit: 'series',
    p: 'probability of the side the model picks',
    breakEven: { 3: r4(BE[3]!), 5: r4(BE[5]!), 6: r4(BE[6]!) },
    ...H, baselines: bl, calibration: fix,
    scan: {
      luckRatePerCell: 0.025,
      archive: {
        line: 'career-median stand-in, not a book', cells: scans[0]?.cells ?? 0,
        hits: hits.filter((h) => h.set === 'archive').length,
        replicated: replicated.filter((h) => h.set === 'archive').length,
      },
      real: {
        cells: scans[1]?.cells ?? 0, hits: hits.filter((h) => h.set === 'real').length,
        replicated: realRep.map((h) => `${h.slice}:e${h.minEdge}:${h.legs}pick`),
      },
    },
    adversary,
    /** The only question that pays: does anything beat the books' own lines, held out? */
    anyHeldOutEdgeVsBooks: realRep.length > 0,
  };
  console.log(`BACKTEST_SUMMARY ${JSON.stringify(summary)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
