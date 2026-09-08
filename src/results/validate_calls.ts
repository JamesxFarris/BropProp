import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { evaluate, HISTORY, type FormStats, type LineOption } from '../web/projection.js';

/**
 * Would the board have been right?
 *
 * Every market we logged a pre-match line for, replayed through the real
 * `evaluate()` with only the stat history that existed BEFORE that match
 * started, then scored against what actually happened. This is the only
 * honest way to ask whether a "Take" is a number or a wish, and it is the
 * single most important measurement in the project — so it lives in the tree
 * rather than in scratch.
 *
 *   npm run validate:calls
 *
 * Three things it reports that a naive win rate does not:
 *
 * **Baselines.** The projection is known to sit above the book's line 61% of
 * the time, which means "always take the under" is not a neutral comparison —
 * it is a strategy that exploits the same bias. A model that wins 58% is only
 * interesting if always-under does not win 58% too.
 *
 * **Independent matches.** 271 markets once came from roughly 10 real
 * matches, because both books list the same fixture and one match carries a
 * leg for every player in it. Legs inside a match are correlated; the honest
 * denominator for a significance test is the match count, printed alongside.
 *
 * **Calibration, not just accuracy.** A model that says 70% and hits 55% is
 * wrong in a way a win rate hides, and the price gate depends on the claimed
 * probability being roughly true.
 *
 * History limits mirror production exactly (`HISTORY` totals, `HISTORY * 3`
 * single maps). An earlier scratch version used 20 and 60, which quietly fed
 * the backtest a smaller sample than the live board gets and made the result
 * unrepresentative in the pessimistic direction.
 */

/** Settlement window around kick-off, matching `validate_stale.ts`. */
const SETTLE_EARLY = '3 hours';
const SETTLE_LATE = '12 hours';

type Mkt = {
  canon_handle: string; stat: string; map_start: number; map_end: number;
  scheduled_at: string; line: string; total: string; book: string;
  series_key: string;
  over_price: number | null; under_price: number | null;
};

type Arm = { n: number; won: number };
const arm = (): Arm => ({ n: 0, won: 0 });

/**
 * Two-sided exact binomial p for `k` successes in `n` fair coin flips.
 *
 * Exact rather than normal-approximate on purpose: the series counts this is
 * asked about are in the teens, where the approximation that made 462 legs
 * look like z=5.11 is exactly the thing being corrected.
 */
function signTest(k: number, n: number): number {
  if (n === 0) return 1;
  const logFact: number[] = [0];
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1]! + Math.log(i);
  const pmf = (i: number) =>
    Math.exp(logFact[n]! - logFact[i]! - logFact[n - i]! - n * Math.LN2);
  const obs = pmf(k);
  let p = 0;
  // Sum every outcome no more likely than the observed one — the standard
  // two-sided construction, and it handles the asymmetry when k is extreme.
  for (let i = 0; i <= n; i++) {
    const v = pmf(i);
    if (v <= obs * (1 + 1e-9)) p += v;
  }
  return Math.min(1, p);
}

/**
 * Area under the ROC curve, by the rank identity rather than by trapezoids.
 *
 * Equal predictions get the average rank, which matters here: `evaluate()`
 * shrinks toward a prior, so ties are common and a naive implementation would
 * score them as wins for whichever order they happened to be in.
 */
function auc(rows: Array<{ p: number; won: boolean }>): number {
  const wins = rows.filter((r) => r.won).length;
  const losses = rows.length - wins;
  if (!wins || !losses) return 0.5;

  const sorted = [...rows].sort((a, b) => a.p - b.p);
  const ranks = new Array<number>(sorted.length);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.p === sorted[i]!.p) j++;
    // Ranks are 1-based; the average of the tied block goes to every member.
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }

  let rankSum = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.won) rankSum += ranks[i]!;
  return (rankSum - (wins * (wins + 1)) / 2) / (wins * losses);
}

/**
 * Everything one replay measured. Returned rather than printed so the daily
 * job can store it and the CLI can format it, from one computation.
 */
export type Scorecard = {
  settled: number;
  calls: number;
  pushes: number;
  series: number;
  days: number;
  realised: number | null;
  claimed: number | null;
  auc: number | null;
  alwaysOver: number | null;
  alwaysUnder: number | null;
  seriesAhead: number;
  seriesJudged: number;
  seriesP: number;
  underSeries: number;
  underSeriesJudged: number;
  underSeriesP: number;
  claimedEv: number | null;
  realisedEv: number | null;
  byRange: Array<{ range: string; under: number; n: number; margin: number }>;
  buckets: Array<{ band: string; n: number; won: number; claimedEv: number; realEv: number }>;
};

export async function scoreCalls(): Promise<Scorecard> {
  const markets = await q<Mkt>(`
    WITH lines AS (
      SELECT pr.id AS prop_id, p.canon_handle, pr.stat, pr.map_start, pr.map_end,
             m.scheduled_at, b.code AS book,
             (array_agg(ps.line ORDER BY ps.observed_at DESC))[1]::numeric AS line,
             (array_agg(ps.over_price ORDER BY ps.observed_at DESC))[1]::int AS over_price,
             (array_agg(ps.under_price ORDER BY ps.observed_at DESC))[1]::int AS under_price
        FROM prop pr
        JOIN player p ON p.id = pr.player_id
        JOIN book b ON b.id = pr.book_id
        JOIN match m ON m.id = pr.match_id
        JOIN prop_snapshot ps ON ps.prop_id = pr.id
       WHERE pr.league = 'CS2' AND pr.is_combo = false AND pr.variant = 'standard'
         AND pr.stat IN ('kills', 'headshots')
         -- The last line seen BEFORE kick-off. A snapshot taken after the
         -- match started has the result leaking into it.
         AND ps.observed_at < m.scheduled_at
       GROUP BY 1, 2, 3, 4, 5, 6, 7
    )
    SELECT l.canon_handle, l.stat, l.map_start, l.map_end,
           l.scheduled_at::text, l.book, l.line::text,
           l.over_price, l.under_price,
           -- The series this settled against. It is the unit of independence:
           -- every player in one series shares its length, its overtime and
           -- its pace, so their props rise and fall together.
           min(ms.series_key) AS series_key,
           sum(CASE WHEN l.stat = 'kills' THEN ms.kills ELSE ms.headshots END)::text AS total
      FROM lines l
      JOIN map_stat_dedup ms
        ON ms.canon_handle = l.canon_handle AND ms.league = 'CS2'
       AND ms.played_at BETWEEN l.scheduled_at - interval '${SETTLE_EARLY}'
                            AND l.scheduled_at + interval '${SETTLE_LATE}'
       AND ms.map_number BETWEEN l.map_start AND l.map_end
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
    -- Every map in the range must have been played, or the prop voided.
    HAVING count(*) = (l.map_end - l.map_start + 1)
       AND sum(CASE WHEN l.stat = 'kills' THEN ms.kills ELSE ms.headshots END) IS NOT NULL`);

  const empty: Scorecard = {
    settled: 0, calls: 0, pushes: 0, series: 0, days: 0,
    realised: null, claimed: null, auc: null, alwaysOver: null, alwaysUnder: null,
    seriesAhead: 0, seriesJudged: 0, seriesP: 1,
    underSeries: 0, underSeriesJudged: 0, underSeriesP: 1,
    claimedEv: null, realisedEv: null, byRange: [], buckets: [],
  };
  if (markets.length === 0) return empty;

  const handles = [...new Set(markets.map((m) => m.canon_handle))];
  const hist = await q<{
    canon_handle: string; series_key: string; map_number: number;
    played_at: string; kills: number | null; headshots: number | null;
  }>(
    `SELECT canon_handle, series_key, map_number, played_at, kills, headshots
       FROM map_stat_dedup WHERE league = 'CS2' AND canon_handle = ANY($1)`,
    [handles],
  );

  const byPlayer = new Map<string, typeof hist>();
  for (const r of hist) {
    const a = byPlayer.get(r.canon_handle) ?? [];
    a.push(r);
    byPlayer.set(r.canon_handle, a);
  }

  /**
   * `FormStats` from only what was known before `cutoff` — the whole point.
   *
   * Shaped to match `projectBoard` exactly: exact-range series only for
   * `totals`, every single map for `mapValues`, both most-recent-first and
   * cut at production's limits.
   */
  function formBefore(
    handle: string, stat: string, ms: number, me: number, cutoff: number,
  ): FormStats {
    const col = stat === 'kills' ? 'kills' : 'headshots';
    const rows = (byPlayer.get(handle) ?? [])
      .filter((r) => new Date(r.played_at).getTime() < cutoff);

    const series = new Map<string, { at: number; maps: Map<number, number> }>();
    const mapValues: Array<{ at: number; v: number }> = [];
    for (const r of rows) {
      const v = (r as unknown as Record<string, number | null>)[col];
      if (v === null || v === undefined) continue;
      const at = new Date(r.played_at).getTime();
      mapValues.push({ at, v });
      let s = series.get(r.series_key);
      if (!s) { s = { at: 0, maps: new Map() }; series.set(r.series_key, s); }
      s.at = Math.max(s.at, at);
      s.maps.set(r.map_number, v);
    }

    const totals = [...series.values()]
      .sort((a, b) => b.at - a.at)
      .filter((s) => {
        for (let m = ms; m <= me; m++) if (!s.maps.has(m)) return false;
        return true;
      })
      .map((s) => {
        let t = 0;
        for (let m = ms; m <= me; m++) t += s.maps.get(m)!;
        return t;
      })
      .slice(0, HISTORY);

    const mv = mapValues.sort((a, b) => b.at - a.at).map((x) => x.v).slice(0, HISTORY * 3);
    const mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
    const sd = totals.length > 1
      ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (totals.length - 1))
      : null;

    return {
      series: totals.length, mean, sd, totals, mapValues: mv,
      perMap: mv.length ? mv.reduce((a, b) => a + b, 0) / mv.length : null,
    };
  }

  const model = arm();
  const alwaysOver = arm();
  const alwaysUnder = arm();
  const underByRange = new Map<string, Arm & { margin: number }>();
  const buckets = new Map<string, { n: number; won: number; claimedEv: number; realEv: number }>();
  const rows: Array<{ p: number; won: boolean; ev: number | null }> = [];
  let pushes = 0, claimedSum = 0, realSum = 0, priced = 0;
  const calledSeries = new Set<string>();
  const days = new Set<string>();
  /** Per-series tally, so the baselines can be tested at the honest unit. */
  const seriesLean = new Map<string, { under: number; n: number }>();
  /** Per-series tally of the model's own calls. */
  const seriesModel = new Map<string, { won: number; n: number }>();

  for (const m of markets) {
    const cutoff = new Date(m.scheduled_at).getTime();
    const line = Number(m.line);
    const total = Number(m.total);

    // Baselines are scored on every settled market, called or not — they are
    // strategies that need no model, so gating them on the model's own
    // selection would flatter whichever one the model happens to agree with.
    days.add(m.scheduled_at.slice(0, 10));
    if (total !== line) {
      alwaysOver.n++; if (total > line) alwaysOver.won++;
      alwaysUnder.n++; if (total < line) alwaysUnder.won++;
      const sl = seriesLean.get(m.series_key) ?? { under: 0, n: 0 };
      sl.n++; if (total < line) sl.under++;
      seriesLean.set(m.series_key, sl);
      // Split by map range, because the direction of the shade is not the
      // same everywhere: maps 1-2 land under, map 3 alone lands over, and
      // averaging the two hides both.
      const k = `${m.map_start}-${m.map_end}`;
      const u = underByRange.get(k) ?? { ...arm(), margin: 0 };
      u.n++; if (total < line) u.won++;
      u.margin += total - line;
      underByRange.set(k, u);
    }

    const form = formBefore(m.canon_handle, m.stat, m.map_start, m.map_end, cutoff);
    const opt: LineOption = {
      book: m.book === 'underdog' ? 'underdog' : 'prizepicks',
      line, overOk: true, underOk: true,
      overPrice: m.over_price, underPrice: m.under_price,
    };
    const { play } = evaluate({
      form, options: [opt], maps: m.map_end - m.map_start + 1, stat: m.stat,
    });
    if (!play) continue;

    if (total === line) { pushes++; continue; }
    const won = play.side === 'over' ? total > line : total < line;
    model.n++; if (won) model.won++;
    calledSeries.add(m.series_key);
    const sm = seriesModel.get(m.series_key) ?? { won: 0, n: 0 };
    sm.n++; if (won) sm.won++;
    seriesModel.set(m.series_key, sm);

    const price = play.side === 'over' ? m.over_price : m.under_price;
    const profit = price === null ? null : (price < 0 ? 100 / -price : price / 100);
    const realised = profit === null ? null : (won ? profit : -1);
    if (play.ev !== null && realised !== null) {
      claimedSum += play.ev; realSum += realised; priced++;
    }
    rows.push({ p: play.hitRate, won, ev: play.ev });

    const lo = Math.floor(play.hitRate * 20) * 5;
    const b = `${lo}-${lo + 5}%`;
    const cur = buckets.get(b) ?? { n: 0, won: 0, claimedEv: 0, realEv: 0 };
    cur.n++; if (won) cur.won++;
    if (play.ev !== null && realised !== null) { cur.claimedEv += play.ev; cur.realEv += realised; }
    buckets.set(b, cur);
  }

  const rate = (a: Arm) => (a.n ? a.won / a.n : null);

  // Series where the model's calls came out ahead of even, versus behind.
  // Series it split exactly are dropped rather than counted as half, which is
  // what a sign test needs.
  const mLeans = [...seriesModel.values()].filter((v) => v.won * 2 !== v.n);
  const mAhead = mLeans.filter((v) => v.won * 2 > v.n).length;

  // The same question for the direction baseline, asked once per series
  // instead of once per leg. This is the test that survives the correlation.
  const leans = [...seriesLean.values()].filter((v) => v.under * 2 !== v.n);
  const underSeries = leans.filter((v) => v.under * 2 > v.n).length;

  return {
    settled: markets.length,
    calls: model.n,
    pushes,
    series: calledSeries.size,
    days: days.size,
    realised: rate(model),
    claimed: rows.length ? rows.reduce((a, r) => a + r.p, 0) / rows.length : null,
    auc: rows.length ? auc(rows) : null,
    alwaysOver: rate(alwaysOver),
    alwaysUnder: rate(alwaysUnder),
    seriesAhead: mAhead,
    seriesJudged: mLeans.length,
    seriesP: signTest(mAhead, mLeans.length),
    underSeries,
    underSeriesJudged: leans.length,
    underSeriesP: signTest(underSeries, leans.length),
    claimedEv: priced ? claimedSum / priced : null,
    realisedEv: priced ? realSum / priced : null,
    byRange: [...underByRange]
      .sort()
      .map(([range, v]) => ({ range, under: v.won, n: v.n, margin: v.margin / v.n })),
    buckets: [...buckets.entries()]
      .sort()
      .map(([band, v]) => ({ band, n: v.n, won: v.won, claimedEv: v.claimedEv, realEv: v.realEv })),
  };
}

/** The scorecard as a person reads it. Kept apart from the measuring. */
export function report(s: Scorecard): void {
  const p1 = (v: number | null) => (v === null ? '—' : `${(100 * v).toFixed(1)}%`);

  console.log(`settled markets with a pre-match line: ${s.settled}`);
  if (s.settled === 0) { console.log('Nothing to score yet.'); return; }

  console.log(`calls the model would have made: ${s.calls}  (pushes excluded: ${s.pushes})`);
  console.log(`those legs came from ${s.series} distinct series on ${s.days} distinct days`);
  console.log();
  console.log('Leg counts below are NOT sample sizes. Every player in a series');
  console.log('shares its length, its overtime and its pace, so their props move');
  console.log('together — a long map sends everyone over at once. The series');
  console.log('count is the honest n, and it is the number the verdict uses.');
  console.log();
  console.log(`MODEL (its picks)      ${p1(s.realised)}`);
  console.log(`baseline: always over  ${p1(s.alwaysOver)}`);
  console.log(`baseline: always under ${p1(s.alwaysUnder)}`);

  console.log('\nunder rate by map range (the shade is not one direction):');
  for (const r of s.byRange) {
    console.log(
      `  maps ${r.range.padEnd(8)} ${String(r.under).padStart(4)}/${String(r.n).padEnd(4)}` +
      ` = ${((100 * r.under) / r.n).toFixed(1)}%   mean(total-line) ${r.margin.toFixed(2)}`);
  }

  console.log(`\nat the series level: ${s.underSeries}/${s.underSeriesJudged} series ` +
              `leaned under  (two-sided p ${s.underSeriesP.toFixed(3)})`);

  console.log(`\nthe model PREDICTED an average of ${p1(s.claimed)}`);
  console.log(`it realised ${p1(s.realised)}`);
  if (s.claimed !== null && s.realised !== null) {
    console.log(`>>> claimed minus realised: ${(100 * (s.claimed - s.realised)).toFixed(1)} points`);
  }

  // Discrimination, separately from calibration. Being 8 points overconfident
  // is fixable by shrinking every number toward 0.5 — being unable to tell a
  // winner from a loser is not, and only one of those two is worth fixing.
  //
  // AUC is the chance that a randomly chosen winning call carried a higher
  // predicted probability than a randomly chosen losing one. 0.5 is no skill;
  // below 0.5 means the ranking is backwards.
  console.log(`discrimination (AUC): ${s.auc === null ? '—' : s.auc.toFixed(3)}` +
              `   [0.50 = no skill]`);

  console.log('\ncalibration by predicted probability:');
  console.log('predicted      n   realised   claimed EV/bet   realised EV/bet');
  for (const b of s.buckets) {
    console.log(
      b.band.padEnd(13), String(b.n).padStart(4),
      `${((100 * b.won) / b.n).toFixed(0)}%`.padStart(9),
      `${((100 * b.claimedEv) / b.n).toFixed(1)}%`.padStart(16),
      `${((100 * b.realEv) / b.n).toFixed(1)}%`.padStart(17),
    );
  }

  if (s.claimedEv !== null && s.realisedEv !== null) {
    console.log(`\nper priced bet:`);
    console.log(`  claimed  EV: ${(100 * s.claimedEv).toFixed(1)}%`);
    console.log(`  realised EV: ${(100 * s.realisedEv).toFixed(1)}%`);
  }

  console.log();
  if (!s.calls) { console.log('VERDICT: no calls to score.'); return; }

  console.log(`the model's calls led in ${s.seriesAhead}/${s.seriesJudged} series ` +
              `(two-sided p ${s.seriesP.toFixed(3)})`);
  console.log();

  const beatsBoth =
    s.realised !== null && s.alwaysOver !== null && s.alwaysUnder !== null &&
    s.realised > s.alwaysOver && s.realised > s.alwaysUnder;
  // Say what the AUC actually is rather than asserting a fixed conclusion.
  // It drifts as results settle, and a line reading "AUC 0.542 says its
  // confidence carries no information" is its own small dishonesty.
  const a = s.auc;
  const aucNote = a === null
    ? 'AUC could not be computed.'
    : Math.abs(a - 0.5) < 0.02
      ? `AUC ${a.toFixed(3)} is a coin flip: its confidence carries no information, ` +
        `and no recalibration fixes that because there is no ordering to correct.`
      : a < 0.5
        ? `AUC ${a.toFixed(3)} is below 0.5, meaning the ranking is pointing the ` +
          `wrong way on this sample.`
        : `AUC ${a.toFixed(3)} is above a coin flip, but well short of evidence — ` +
          `on ${s.series} series that is comfortably inside noise.`;

  console.log(
    !beatsBoth
      ? `VERDICT: the model does not beat a no-model baseline ` +
        `(${p1(s.realised)} vs over ${p1(s.alwaysOver)} / under ${p1(s.alwaysUnder)}). ` +
        aucNote
      : `VERDICT: model ${p1(s.realised)} beats both baselines. ${aucNote}`);
  console.log(
    `Either way, ${s.series} series across ${s.days} days is far too little to ` +
    `conclude anything, and none of it is out of sample — book lines only exist ` +
    `from the day logging started, so a shade found here can only ever be ` +
    `confirmed forward, never backtested.`);
}

/**
 * Store today's scorecard, so the model's record is a series rather than a
 * number someone re-derives by hand. `--store` on the CLI, and the daily job.
 *
 * One row per league per day: re-running corrects today rather than appending
 * a second opinion, because two runs hours apart differ only by whatever
 * settled in between and both are "today's" answer.
 */
export async function storeScore(s: Scorecard, league = 'CS2'): Promise<void> {
  await q(
    `INSERT INTO model_score
       (scored_at, league, calls, series, days, realised, claimed, auc,
        always_over, always_under, series_ahead, series_judged, series_p,
        claimed_ev, realised_ev)
     VALUES (date_trunc('day', now()), $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (league, scored_at) DO UPDATE SET
       calls = EXCLUDED.calls, series = EXCLUDED.series, days = EXCLUDED.days,
       realised = EXCLUDED.realised, claimed = EXCLUDED.claimed, auc = EXCLUDED.auc,
       always_over = EXCLUDED.always_over, always_under = EXCLUDED.always_under,
       series_ahead = EXCLUDED.series_ahead, series_judged = EXCLUDED.series_judged,
       series_p = EXCLUDED.series_p,
       claimed_ev = EXCLUDED.claimed_ev, realised_ev = EXCLUDED.realised_ev`,
    [league, s.calls, s.series, s.days, s.realised, s.claimed, s.auc,
     s.alwaysOver, s.alwaysUnder, s.seriesAhead, s.seriesJudged, s.seriesP,
     s.claimedEv, s.realisedEv],
  );
}

export async function main(): Promise<void> {
  const s = await scoreCalls();
  report(s);
  if (process.argv.includes('--store')) {
    await storeScore(s);
    console.log('\nstored to model_score.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}
