import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pool, q } from '../db.js';
import { normTeam } from '../adapters/teamname.js';
import { auc, brier, clusterBootstrap, logLoss, mulberry32, reliability, report, type Pred } from './referee.js';
import {
  ELO_DEFAULTS, fitOffsetLogistic, fitTemperature, logistic, logit, pSeries, runElo, winsDistribution,
  type EloConfig, type PreMatch, type Probe, type RatedSeries,
} from './ratings.js';
import { CS2_TRUTH, LOL_TRUTH, type Cs2Match, type LolGame } from './env_truth.js';

/**
 * Does the pre-match game environment — who should win, how close it should
 * be, how long it should run — predict player props beyond the line?
 *
 * 1. Team ratings: map-level Elo (`ratings.ts`), walk-forward, hyperparameters
 *    picked on the EARLY half of each league's series only, plus a one-number
 *    temperature fitted there. Scored on the LATE half against the real winner
 *    (bo3.gg / Oracle's Elixir, fetched by `env_truth.ts`).
 * 2. The kills-proxy for the winner, graded against that truth.
 * 3. Player props on walk-forward pseudo-lines (median of prior series + 0.5,
 *    >= 8 prior): baseline B0 (the player's own over-rate against his lines,
 *    shrunk) versus the environment models on the SAME legs, fitted early,
 *    evaluated late, paired cluster bootstrap by series.
 * 4. The same environment on the books' real closing lines since 2026-09-06.
 *
 * Pre-declared: shrink strength 10 pseudo-series; >= 1000 prior population
 * legs before a leg is scored; 90-day rating burn-in excluded from tuning and
 * scoring; split = median decided-series date per league; features for the
 * fitted model are [relative strength, closeness, expected pace], no intercept.
 *
 *   npx tsx src/results/env_truth.ts all      # once; writes /tmp caches
 *   npm run validate:environment
 */

const DAY = 86_400_000;
const MIN_PRIOR = 8;
const SHRINK = 10;
const MIN_POP = 1000;
const BURN_DAYS = 90;
const REAL_FROM = Date.parse('2026-09-06T00:00:00Z');
/** matchodds.ts' constants: P(under) for a winning / losing team's player. */
const BOARD_UNDER = { win: 0.457, lose: 0.572 };
const TYPICAL_DIFF: Record<League, number> = { CS2: 6, LOL: 10 };

/**
 * Data comes from the database or, when ENV_DUMP names a file written by
 * `--dump` inside the container, from that file — so the study can also run
 * where the LoL truth can be downloaded (Drive refuses the container's IP).
 */
const ROWS_SQL = `
    SELECT league, series_key, map_number, canon_handle, team, kills, deaths, headshots,
           extract(epoch from played_at) * 1000 AS played_at
      FROM map_stat_dedup WHERE kills IS NOT NULL AND played_at IS NOT NULL`;
/** The debugged closing-line recipe, verbatim. */
const REAL_SQL = `
    WITH closing AS (
      SELECT DISTINCT ON (ps.prop_id) ps.prop_id, ps.line::float8 AS line
        FROM prop_snapshot ps JOIN prop p ON p.id = ps.prop_id JOIN match m ON m.id = p.match_id
       WHERE ps.observed_at <= m.scheduled_at
       ORDER BY ps.prop_id, ps.observed_at DESC)
    SELECT b.code AS book, p.league, p.stat, pl.canon_handle, cl.line, p.map_start, p.map_end,
           extract(epoch from m.scheduled_at) * 1000 AS sched
      FROM closing cl JOIN prop p ON p.id = cl.prop_id JOIN player pl ON pl.id = p.player_id
      JOIN book b ON b.id = p.book_id JOIN match m ON m.id = p.match_id
     WHERE p.is_combo = false AND m.scheduled_at < now()`;
const ODDS_SQL = `
    SELECT home_name, away_name, p_home_win::float8 AS p, extract(epoch from starts_at) * 1000 AS at
      FROM current_match_odds ORDER BY starts_at`;
type RealRow = { book: string; league: string; stat: string; canon_handle: string; line: number; map_start: number; map_end: number; sched: string };
type OddsRow = { home_name: string; away_name: string; p: number; at: string };
type Dump = { rows: (string | number | null)[][]; real: RealRow[]; odds: OddsRow[] };
const ROW_COLS = ['league', 'series_key', 'map_number', 'canon_handle', 'team', 'kills', 'deaths', 'headshots', 'played_at'] as const;
let dumped: Dump | null = null;
const fromDump = (): Dump | null => {
  const f = process.env.ENV_DUMP;
  return f ? (dumped ??= load<Dump>(f)) : null;
};
async function loadRows(): Promise<Row[]> {
  const d = fromDump();
  const raw = d
    ? (d.rows.map((a) => Object.fromEntries(ROW_COLS.map((c, i) => [c, a[i]]))) as unknown as Row[])
    : await q<Row>(ROWS_SQL);
  return raw.map((r) => ({ ...r, played_at: Number(r.played_at) }));
}
async function loadReal(): Promise<RealRow[]> { const d = fromDump(); return d ? d.real : q<RealRow>(REAL_SQL); }
async function loadOdds(): Promise<OddsRow[]> { const d = fromDump(); return d ? d.odds : q<OddsRow>(ODDS_SQL); }
/** Read-only: three SELECTs written to a local JSON file. */
async function writeDump(path: string): Promise<void> {
  const rows = await q<Row>(ROWS_SQL);
  const out: Dump = {
    rows: rows.map((r) => ROW_COLS.map((c) => (c === 'played_at' ? Number(r.played_at) : (r[c] as string | number | null)))),
    real: await q<RealRow>(REAL_SQL),
    odds: await q<OddsRow>(ODDS_SQL),
  };
  writeFileSync(path, JSON.stringify(out));
  console.log(`dumped ${out.rows.length} rows, ${out.real.length} closing legs, ${out.odds.length} fixtures to ${path}`);
}

type League = 'CS2' | 'LOL';
type TMap = { n: number; winner: string; diff: number; val: number | null };
type TSeries = {
  key: string; league: League; at: number; a: string; b: string; bo: number | null;
  tier: string | null; maps: TMap[]; winner: string | null;
};
type Row = {
  league: League; series_key: string; map_number: number; canon_handle: string; team: string | null;
  kills: number | null; deaths: number | null; headshots: number | null; played_at: number;
};

const pct = (v: number, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');
const f4 = (v: number) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(4) : '—');
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

function load<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`${path} missing — run: npx tsx src/results/env_truth.ts all`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function seriesWinner(maps: TMap[], a: string, b: string, bo: number | null): string | null {
  const wa = maps.filter((m) => m.winner === a).length, wb = maps.filter((m) => m.winner === b).length;
  if (bo && bo % 2 === 1) {
    const need = (bo + 1) / 2;
    return wa >= need && wa > wb ? a : wb >= need && wb > wa ? b : null;
  }
  if (bo === 2) return null;
  return wa > wb ? a : wb > wa ? b : null;
}

function cs2Series(ms: Cs2Match[]): { list: TSeries[]; odd: number } {
  const list: TSeries[] = [];
  let odd = 0;
  for (const m of ms) {
    const games = [...m.games].sort((x, y) => x.n - y.n);
    const names = [...new Set(games.flatMap((g) => [g.w, g.l]))].sort();
    const at = Date.parse(m.start ?? games[0]?.at ?? '');
    if (games.length === 0 || names.length !== 2 || !Number.isFinite(at)) { odd++; continue; }
    const [a, b] = names as [string, string];
    const maps = games.map((g) => ({ n: g.n, winner: g.w, diff: g.ws - g.ls, val: g.rounds ?? g.ws + g.ls }));
    list.push({ key: `bo3:${m.id}`, league: 'CS2', at, a, b, bo: m.bo, tier: m.tier, maps, winner: seriesWinner(maps, a, b, m.bo) });
  }
  return { list, odd };
}

/** Series from OE games, keyed exactly as `oracleselixir.ts` keys map_stat. */
function lolSeries(gs: LolGame[]): TSeries[] {
  const by = new Map<string, { at: number; names: string[]; maps: TMap[] }>();
  for (const g of gs) {
    const names = g.t.map((t) => t.name).sort();
    const at = Date.parse(`${g.date.replace(' ', 'T')}Z`);
    const w = g.t.find((t) => t.result === 1), l = g.t.find((t) => t.result === 0);
    if (!w || !l || !Number.isFinite(at)) continue;
    const key = `oe:${g.league}:${g.date.slice(0, 10)}:${names.join('|')}`;
    const e = by.get(key) ?? { at, names, maps: [] };
    e.at = Math.min(e.at, at);
    const ok = Number.isFinite(w.kills) && Number.isFinite(l.kills);
    e.maps.push({ n: Number.isFinite(g.n) ? g.n : 1, winner: w.name, diff: ok ? Math.abs(w.kills - l.kills) : TYPICAL_DIFF.LOL, val: ok ? w.kills + l.kills : null });
    by.set(key, e);
  }
  const out: TSeries[] = [];
  for (const [key, e] of by) {
    const [a, b] = e.names as [string, string];
    const maps = e.maps.sort((x, y) => x.n - y.n);
    const wmax = Math.max(maps.filter((m) => m.winner === a).length, maps.filter((m) => m.winner === b).length);
    // Format is fixed before the match; the winner's map count only reveals it
    // (a Bo3 winner has 2, a Bo5 winner 3). Used for the best-of conversion and
    // to pick Bo5 series for the maps 1-3 market.
    const bo = 2 * wmax - 1;
    out.push({ key, league: 'LOL', at: e.at, a, b, bo, tier: null, maps, winner: seriesWinner(maps, a, b, bo) });
  }
  return out;
}

/**
 * Fallback when Oracle's Elixir is unreachable (Drive answers "Quota
 * exceeded"): each stored LoL map's winner is the team whose stored players
 * have the higher mean (K−D); with one team stored, the sign of its mean.
 * Both team names come from the series key, which `oracleselixir.ts` builds
 * from the two teams. Labels only — no pace, since partial rosters make
 * stored kills meaningless as a game total. Known cost: a player's own kills
 * help decide his history's win/loss labels, which overstates his
 * conditionals; that can only make the mixture look WORSE held-out.
 */
let LOL_PROXY = false;
function lolProxySeries(rows: Row[]): TSeries[] {
  const by = new Map<string, { at: number; maps: Map<number, Map<string, number[]>> }>();
  for (const r of rows) {
    if (r.league !== 'LOL' || !r.team || r.kills === null || r.deaths === null || !r.series_key.startsWith('oe:')) continue;
    const e = by.get(r.series_key) ?? by.set(r.series_key, { at: r.played_at, maps: new Map() }).get(r.series_key)!;
    e.at = Math.min(e.at, r.played_at);
    const m = e.maps.get(r.map_number) ?? e.maps.set(r.map_number, new Map()).get(r.map_number)!;
    (m.get(r.team) ?? m.set(r.team, []).get(r.team)!).push(r.kills - r.deaths);
  }
  const out: TSeries[] = [];
  for (const [key, e] of by) {
    const km = /^oe:.*:\d{4}-\d{2}-\d{2}:(.*)$/.exec(key);
    const names = km ? km[1]!.split('|') : [];
    if (names.length !== 2) continue;
    const [a, b] = names as [string, string];
    const maps: TMap[] = [];
    for (const [n, teams] of [...e.maps.entries()].sort((x, y) => x[0] - y[0])) {
      const kd = (t: string) => { const v = teams.get(t); return v ? mean(v) : null; };
      const ka = kd(a), kb = kd(b);
      let winner: string | null = null;
      if (ka !== null && kb !== null) winner = ka === kb ? null : ka > kb ? a : b;
      else if (ka !== null) winner = ka === 0 ? null : ka > 0 ? a : b;
      else if (kb !== null) winner = kb === 0 ? null : kb > 0 ? b : a;
      if (winner) maps.push({ n, winner, diff: TYPICAL_DIFF.LOL, val: null });
    }
    if (maps.length === 0) continue;
    const wmax = Math.max(maps.filter((m) => m.winner === a).length, maps.filter((m) => m.winner === b).length);
    const bo = 2 * wmax - 1;
    out.push({ key, league: 'LOL', at: e.at, a, b, bo, tier: null, maps, winner: seriesWinner(maps, a, b, bo) });
  }
  return out;
}

// ---------------------------------------------------------------- metrics

function summary(label: string, ps: Pred[]): void {
  if (ps.length < 20) { console.log(`${label}: only ${ps.length} predictions`); return; }
  const b = clusterBootstrap(ps, brier, 500), l = clusterBootstrap(ps, logLoss, 500), a = clusterBootstrap(ps, auc, 500);
  const hit = ps.filter((x) => x.won).length / ps.length;
  const base = ps.map((x) => ({ ...x, p: hit }));
  console.log(`${label}`);
  console.log(`  n ${ps.length} (series ${a.series}); claimed ${pct(mean(ps.map((x) => x.p)))}, realised ${pct(hit)}`);
  console.log(`  Brier ${f3(b.point)} [${f3(b.lo)}, ${f3(b.hi)}] base ${f3(brier(base))} | LogLoss ${f3(l.point)} [${f3(l.lo)}, ${f3(l.hi)}] base ${f3(logLoss(base))} | AUC ${f3(a.point)} [${f3(a.lo)}, ${f3(a.hi)}]`);
  console.log(`  calibration: ${reliability(ps, 5).map((r) => `${pct(r.meanP, 0)}→${pct(r.hitRate, 0)}`).join('  ')}`);
}

/** Model minus baseline on the SAME legs, 95% CI by resampling whole series. */
function paired(label: string, base: Pred[], model: Pred[], reps = 500): { dll: number; lo: number; hi: number } {
  const groups = new Map<string, number[]>();
  base.forEach((x, i) => (groups.get(x.series) ?? groups.set(x.series, []).get(x.series)!).push(i));
  const g = [...groups.values()];
  const stat = (idx: number[]) => {
    const b = idx.map((i) => base[i]!), m = idx.map((i) => model[i]!);
    return [logLoss(m) - logLoss(b), brier(m) - brier(b), auc(m) - auc(b)];
  };
  const all = base.map((_, i) => i);
  const pt = stat(all);
  const rnd = mulberry32(20260911);
  const dr: number[][] = [[], [], []];
  for (let r = 0; r < reps; r++) {
    const idx: number[] = [];
    for (let i = 0; i < g.length; i++) idx.push(...g[Math.floor(rnd() * g.length)]!);
    stat(idx).forEach((v, j) => { if (Number.isFinite(v)) dr[j]!.push(v); });
  }
  const ci = (j: number): [number, number] => { const d = dr[j]!.sort((x, y) => x - y); return [d[Math.floor(0.025 * d.length)]!, d[Math.floor(0.975 * d.length)]!]; };
  const [l0, h0] = ci(0), [l1, h1] = ci(1), [l2, h2] = ci(2);
  console.log(`  ${label.padEnd(34)} legs ${String(base.length).padStart(6)} series ${String(g.length).padStart(5)} | ` +
    `ΔLogLoss ${f4(pt[0]!)} [${f4(l0)}, ${f4(h0)}] | ΔBrier ${f4(pt[1]!)} [${f4(l1)}, ${f4(h1)}] | ` +
    `AUC ${f3(auc(model))} vs ${f3(auc(base))} (Δ ${f4(pt[2]!)} [${f4(l2)}, ${f4(h2)}])`);
  return { dll: pt[0]!, lo: l0, hi: h0 };
}

const overPred = (series: string, p: number, over: boolean, tags?: Record<string, string>): Pred => ({ series, p, won: over, tags });
/** The side a model would actually play, for ROI tables. */
const pickPred = (series: string, p: number, over: boolean): Pred => ({ series, p: Math.max(p, 1 - p), won: (p >= 0.5) === over });

function bootCorr(xs: number[], ys: number[], reps = 1000): [number, number, number] {
  const c = (idx: number[]) => {
    const n = idx.length; let sx = 0, sy = 0;
    for (const i of idx) { sx += xs[i]!; sy += ys[i]!; }
    const mx = sx / n, my = sy / n; let cxy = 0, cxx = 0, cyy = 0;
    for (const i of idx) { const dx = xs[i]! - mx, dy = ys[i]! - my; cxy += dx * dy; cxx += dx * dx; cyy += dy * dy; }
    return cxy / Math.sqrt(cxx * cyy);
  };
  const all = xs.map((_, i) => i);
  const rnd = mulberry32(99);
  const d: number[] = [];
  for (let r = 0; r < reps; r++) d.push(c(all.map(() => Math.floor(rnd() * all.length))));
  d.sort((x, y) => x - y);
  return [c(all), d[Math.floor(0.025 * reps)]!, d[Math.floor(0.975 * reps)]!];
}

// ---------------------------------------------------------------- ratings

type Rated = { pre: Map<string, PreMatch>; t: number; cfg: EloConfig; splitAt: number; burnEnd: number; probes: PreMatch[] };
const cal = (p: number, t: number) => logistic(t * logit(p));

function rateLeague(league: League, series: TSeries[], probes: Probe[]): Rated {
  const decided = series.filter((s) => s.winner && s.bo && s.bo % 2 === 1);
  const ats = decided.map((s) => s.at).sort((x, y) => x - y);
  const splitAt = ats[Math.floor(ats.length / 2)]!;
  const burnEnd = ats[0]! + BURN_DAYS * DAY;
  const rs: RatedSeries[] = series.map((s) => ({ key: s.key, at: s.at, a: s.a, b: s.b, maps: s.maps.map((m) => ({ winner: m.winner, diff: m.diff })) }));
  const tune = decided.filter((s) => s.at >= burnEnd && s.at < splitAt);
  const grid: { cfg: EloConfig; ll: number }[] = [];
  for (const k of [16, 24, 32, 48, 64]) for (const movWeight of [0, 1]) for (const halfLifeDays of [Infinity, 180]) for (const initial of [0, -100]) {
    const cfg = { ...ELO_DEFAULTS, k, movWeight, halfLifeDays, initial };
    const { pre } = runElo(rs, cfg, TYPICAL_DIFF[league]);
    let ll = 0;
    for (const s of tune) {
      const p = Math.min(1 - 1e-9, Math.max(1e-9, pSeries(pre.get(s.key)!.pMapA, s.bo!)));
      ll -= Math.log(s.winner === s.a ? p : 1 - p);
    }
    grid.push({ cfg, ll: ll / tune.length });
  }
  grid.sort((x, y) => x.ll - y.ll);
  const show = (g: { cfg: EloConfig; ll: number }) =>
    `K${g.cfg.k} mov${g.cfg.movWeight} half${g.cfg.halfLifeDays} init${g.cfg.initial} → ${g.ll.toFixed(4)}`;
  console.log(`\n${league}: ${series.length} series (${decided.length} decided, odd best-of); split at ${new Date(splitAt).toISOString().slice(0, 10)}; tuning on ${tune.length} early series`);
  console.log(`  grid (early-block series log loss), best 4: ${grid.slice(0, 4).map(show).join(' | ')}`);
  console.log(`  worst: ${show(grid[grid.length - 1]!)}`);
  const cfg = grid[0]!.cfg;
  const run = runElo(rs, cfg, TYPICAL_DIFF[league], probes);
  const xs: { p: number; y: boolean }[] = [];
  for (const s of series) {
    if (s.at < burnEnd || s.at >= splitAt) continue;
    const p = run.pre.get(s.key)!.pMapA;
    for (const m of s.maps) xs.push({ p, y: m.winner === s.a });
  }
  const t = fitTemperature(xs);
  console.log(`  temperature on early maps: ${t.toFixed(3)} (1 = Elo already calibrated)`);
  return { pre: run.pre, t, cfg, splitAt, burnEnd, probes: run.probes };
}

function ratingReport(league: League, series: TSeries[], R: Rated): void {
  const dec = (ss: TSeries[]) => ss.filter((s) => s.winner && s.bo && s.bo % 2 === 1);
  const sp = (ss: TSeries[]) => dec(ss).map((s) => ({
    series: s.key, p: pSeries(cal(R.pre.get(s.key)!.pMapA, R.t), s.bo!), won: s.winner === s.a,
  }));
  const early = series.filter((s) => s.at >= R.burnEnd && s.at < R.splitAt);
  const late = series.filter((s) => s.at >= R.splitAt);
  console.log(`\n--- ${league} ratings: does P(team A wins the series) predict the winner? ---`);
  summary(`${league} series, EARLY block (tuned here)`, sp(early));
  summary(`${league} series, LATE block (held out)`, sp(late));
  const est = late.filter((s) => { const p = R.pre.get(s.key)!; return p.nA >= 20 && p.nB >= 20; });
  summary(`${league} series, LATE, both teams >= 20 prior maps`, sp(est));
  const mp: Pred[] = [];
  for (const s of late) { const p = cal(R.pre.get(s.key)!.pMapA, R.t); for (const m of s.maps) mp.push({ series: s.key, p, won: m.winner === s.a }); }
  summary(`${league} maps, LATE (clustered by series)`, mp);
  const fav = sp(late);
  const favWon = fav.filter((x) => (x.p >= 0.5) === x.won).length;
  console.log(`  late favourite won ${favWon}/${fav.length} = ${pct(favWon / fav.length)}`);
  if (league === 'CS2') {
    for (const tier of ['s', 'a', 'b', 'c']) summary(`  CS2 LATE series, tier ${tier}`, sp(late.filter((s) => s.tier === tier)));
  }
}

// ---------------------------------------------------------------- proxy

function proxyCheck(league: League, rows: Row[], series: Map<string, TSeries>): void {
  const maps = new Map<string, Map<string, { k: number; d: number }[]>>();
  for (const r of rows) {
    if (r.league !== league || r.team === null || r.kills === null || r.deaths === null) continue;
    const key = `${r.series_key}#${r.map_number}`;
    const m = maps.get(key) ?? maps.set(key, new Map()).get(key)!;
    (m.get(r.team) ?? m.set(r.team, []).get(r.team)!).push({ k: r.kills, d: r.deaths });
  }
  type Cat = { n: number; sumOk: number; kdOk: number; undecided: number };
  const cats: Record<string, Cat> = {};
  const cat = (c: string) => (cats[c] ??= { n: 0, sumOk: 0, kdOk: 0, undecided: 0 });
  let noTruth = 0, badName = 0;
  for (const [key, teams] of maps) {
    const [sk, mn] = key.split('#') as [string, string];
    const s = series.get(sk);
    const tm = s?.maps.find((m) => m.n === Number(mn));
    if (!s || !tm) { noTruth++; continue; }
    const names = [...teams.keys()];
    if (names.some((n) => n !== s.a && n !== s.b)) { badName++; continue; }
    const kd = (n: string) => mean(teams.get(n)!.map((x) => x.k - x.d));
    const sum = (n: string) => teams.get(n)!.reduce((a, x) => a + x.k, 0);
    if (names.length === 2) {
      const [x, y] = names as [string, string];
      const full = teams.get(x)!.length === 5 && teams.get(y)!.length === 5;
      const c = cat(full ? 'both teams, full 5v5' : 'both teams, partial rosters');
      c.n++;
      const sw = sum(x) === sum(y) ? null : sum(x) > sum(y) ? x : y;
      const kw = kd(x) === kd(y) ? null : kd(x) > kd(y) ? x : y;
      if (sw === tm.winner) c.sumOk++;
      if (kw === tm.winner) c.kdOk++;
      if (sw === null) c.undecided++;
    } else {
      const x = names[0]!;
      const c = cat('one team only');
      c.n++;
      const v = kd(x);
      if (v === 0) c.undecided++;
      else if ((v > 0) === (x === tm.winner)) c.kdOk++;
    }
  }
  console.log(`\n--- ${league} map-winner proxy vs the real winner (${noTruth} stored maps without truth, ${badName} with a team name not in the truth) ---`);
  for (const [k, c] of Object.entries(cats)) {
    console.log(`  ${k.padEnd(28)} maps ${String(c.n).padStart(6)} | more summed kills: ${k === 'one team only' ? '  n/a ' : pct(c.sumOk / c.n)} | ` +
      `higher mean (K−D) per stored player${k === 'one team only' ? ' (sign)' : ''}: ${pct(c.kdOk / c.n)} | ties ${c.undecided}`);
  }
}

// ---------------------------------------------------------------- pace

/** Expected per-map value (CS2 rounds, LoL combined kills) from both teams' last 30 maps, shrunk. */
function paceMap(series: TSeries[]): Map<string, number> {
  const last = new Map<string, number[]>();
  let ps = 0, pn = 0;
  const out = new Map<string, number>();
  for (const s of [...series].sort((x, y) => x.at - y.at)) {
    if (pn > 0) {
      const pm = ps / pn;
      const sh = (t: string) => { const h = last.get(t) ?? []; return (h.reduce((a, x) => a + x, 0) + SHRINK * pm) / (h.length + SHRINK); };
      out.set(s.key, (sh(s.a) + sh(s.b)) / 2);
    }
    for (const m of s.maps) {
      if (m.val === null) continue;
      for (const t of [s.a, s.b]) { const h = last.get(t) ?? []; h.push(m.val); if (h.length > 30) h.shift(); last.set(t, h); }
      ps += m.val; pn++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- props

type Spec = { name: string; league: League; stat: 'kills' | 'headshots'; start: number; end: number; ok: (s: TSeries) => boolean };
const SPECS: Spec[] = [
  { name: 'CS2 kills m1-2', league: 'CS2', stat: 'kills', start: 1, end: 2, ok: () => true },
  { name: 'CS2 headshots m1-2', league: 'CS2', stat: 'headshots', start: 1, end: 2, ok: () => true },
  { name: 'LOL kills m1-3 (Bo5)', league: 'LOL', stat: 'kills', start: 1, end: 3, ok: (s) => s.bo === 5 },
  { name: 'LOL kills m1-2 (Bo3+Bo5)', league: 'LOL', stat: 'kills', start: 1, end: 2, ok: (s) => (s.bo ?? 0) >= 3 },
];

type Leg = {
  key: string; at: number; over: boolean; pm: number; pw: number; close: number; pace: number; rel: number;
  won: boolean | null; b0: number; m1: number; m1pop: number; m1b: number; oracle: number;
  /** Population over-rate before this series: the no-information baseline. */
  p0: number;
};
type Center = { rel: number; close: number; pace: number; paceSd: number };
type Fitted = { beta: number[]; c: Center };

const feats = (l: { rel: number; close: number; pace: number }, c: Center): number[] =>
  [l.rel - c.rel, l.close - c.close, Number.isFinite(l.pace) ? (l.pace - c.pace) / c.paceSd : 0];

function centerOf(ls: Leg[]): Center {
  const pc = ls.map((l) => l.pace).filter(Number.isFinite);
  const pm = mean(pc);
  return { rel: mean(ls.map((l) => l.rel)), close: mean(ls.map((l) => l.close)), pace: pm, paceSd: Math.sqrt(mean(pc.map((x) => (x - pm) ** 2))) || 1 };
}

function fitEnv(ls: Leg[], cols = [0, 1, 2], off: (l: Leg) => number = (l) => l.b0): Fitted {
  const c = centerOf(ls);
  const beta = fitOffsetLogistic(ls.map((l) => ({ offset: logit(off(l)), x: cols.map((j) => feats(l, c)[j]!), y: l.over })));
  const full = [0, 0, 0];
  cols.forEach((j, i) => { full[j] = beta[i]!; });
  return { beta: full, c };
}
const applyEnv = (f: Fitted, base: number, l: { rel: number; close: number; pace: number }) =>
  logistic(logit(base) + feats(l, f.c).reduce((a, x, j) => a + x * f.beta[j]!, 0));

type Ctx = {
  series: Map<string, TSeries>; R: Record<League, Rated>; pace: Map<string, number>;
  /** per league|handle: sorted (at, pm) with prefix sums, for relative strength */
  pmHist: Map<string, { at: number[]; cum: number[] }>;
  byPS: Map<string, Map<string, Row[]>>;
};

function teamOf(team: string | null, s: TSeries): string | null {
  if (!team) return null;
  if (team === s.a || team === s.b) return team;
  const n = normTeam(team);
  return n && n === normTeam(s.a) ? s.a : n && n === normTeam(s.b) ? s.b : null;
}
function pmFor(ctx: Ctx, s: TSeries, team: string): number {
  const R = ctx.R[s.league];
  const p = cal(R.pre.get(s.key)!.pMapA, R.t);
  return team === s.a ? p : 1 - p;
}
function relOf(ctx: Ctx, league: League, handle: string, at: number, pm: number): number {
  const h = ctx.pmHist.get(`${league}|${handle}`);
  if (!h) return 0;
  let lo = 0, hi = h.at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (h.at[mid]! < at) lo = mid + 1; else hi = mid; }
  return lo === 0 ? 0 : pm - h.cum[lo - 1]! / lo;
}

function propStudy(spec: Spec, ctx: Ctx): { legs: Leg[]; fitReal: Fitted | null } {
  const N = spec.end - spec.start + 1;
  const R = ctx.R[spec.league];
  const list = [...ctx.series.values()].filter((s) => s.league === spec.league && spec.ok(s) && ctx.byPS.has(s.key)).sort((x, y) => x.at - y.at);
  type H = { totals: number[]; ov: number; n: number; ovW: number; nW: number; ovL: number; nL: number; ovS: number[]; nS: number[] };
  const hist = new Map<string, H>();
  const newH = (): H => ({ totals: [], ov: 0, n: 0, ovW: 0, nW: 0, ovL: 0, nL: 0, ovS: new Array(N + 1).fill(0), nS: new Array(N + 1).fill(0) });
  const pop = { ov: 0, n: 0, ovW: 0, nW: 0, ovL: 0, nL: 0, ovS: new Array<number>(N + 1).fill(0), nS: new Array<number>(N + 1).fill(0) };
  const legs: Leg[] = [];
  let skipRange = 0, skipTeam = 0;
  for (const s of list) {
    const inRange = s.maps.filter((m) => m.n >= spec.start && m.n <= spec.end);
    if (new Set(inRange.map((m) => m.n)).size !== N) { skipRange++; continue; }
    const winsA = inRange.filter((m) => m.winner === s.a).length;
    const pmA = cal(R.pre.get(s.key)!.pMapA, R.t);
    const cands: { handle: string; team: string; total: number }[] = [];
    for (const [handle, rows] of ctx.byPS.get(s.key)!) {
      const rs = rows.filter((r) => r.map_number >= spec.start && r.map_number <= spec.end);
      if (rs.length !== N || rs.some((r) => r[spec.stat] === null)) continue;
      const team = teamOf(rs[0]!.team, s);
      if (!team) { skipTeam++; continue; }
      cands.push({ handle, team, total: rs.reduce((a, r) => a + r[spec.stat]!, 0) });
    }
    const updates: { h: H; over: boolean; won: boolean | null; rw: number }[] = [];
    for (const c of cands) {
      const h = hist.get(c.handle) ?? hist.set(c.handle, newH()).get(c.handle)!;
      if (h.totals.length >= MIN_PRIOR) {
        const srt = [...h.totals].sort((x, y) => x - y), mid = srt.length >> 1;
        const line = (srt.length % 2 ? srt[mid]! : (srt[mid - 1]! + srt[mid]!) / 2) + 0.5;
        if (c.total !== line) {
          const over = c.total > line;
          const won = s.winner === null ? null : s.winner === c.team;
          const rw = c.team === s.a ? winsA : N - winsA;
          updates.push({ h, over, won, rw });
          if (pop.n >= MIN_POP) {
            const pm = c.team === s.a ? pmA : 1 - pmA;
            const pw = s.bo && s.bo % 2 === 1 && s.bo >= 3 ? pSeries(pm, s.bo) : NaN;
            const pr = pop.ov / pop.n;
            const b0 = (h.ov + SHRINK * pr) / (h.n + SHRINK);
            let m1 = NaN, m1pop = NaN, oracle = NaN;
            if (Number.isFinite(pw) && pop.nW > 0 && pop.nL > 0) {
              const rW = pop.ovW / pop.nW, rL = pop.ovL / pop.nL;
              const pW = (h.ovW + SHRINK * rW) / (h.nW + SHRINK), pL = (h.ovL + SHRINK * rL) / (h.nL + SHRINK);
              m1 = pw * pW + (1 - pw) * pL;
              m1pop = pw * rW + (1 - pw) * rL;
              if (won !== null) oracle = won ? pW : pL;
            }
            const dist = winsDistribution(pm, N);
            let m1b = 0;
            for (let k = 0; k <= N; k++) {
              const rk = pop.nS[k]! > 0 ? pop.ovS[k]! / pop.nS[k]! : pr;
              m1b += dist[k]! * (h.ovS[k]! + SHRINK * rk) / (h.nS[k]! + SHRINK);
            }
            legs.push({
              key: s.key, at: s.at, over, pm, pw, close: 1 - 2 * Math.abs(pm - 0.5), pace: ctx.pace.get(s.key) ?? NaN,
              rel: relOf(ctx, spec.league, c.handle, s.at, pm), won, b0, m1, m1pop, m1b, oracle, p0: pr,
            });
          }
        }
      }
    }
    // Only now does this series enter anyone's history.
    for (const c of cands) hist.get(c.handle)!.totals.push(c.total);
    for (const u of updates) {
      for (const t of [u.h, pop]) {
        t.ov += u.over ? 1 : 0; t.n++;
        if (u.won === true) { t.ovW += u.over ? 1 : 0; t.nW++; }
        if (u.won === false) { t.ovL += u.over ? 1 : 0; t.nL++; }
        t.ovS[u.rw]! += u.over ? 1 : 0; t.nS[u.rw]!++;
      }
    }
  }

  const early = legs.filter((l) => l.at >= R.burnEnd && l.at < R.splitAt);
  const late = legs.filter((l) => l.at >= R.splitAt);
  console.log(`\n=============== ${spec.name} — pseudo-lines${spec.league === 'LOL' && LOL_PROXY ? ' [LoL winners = K−D PROXY]' : ''} ===============`);
  console.log(`legs scored ${legs.length} (early ${early.length}, late ${late.length}); series skipped for incomplete range ${skipRange}; player rows with unmatched team ${skipTeam}`);
  if (early.length < 500 || late.length < 200) { console.log('  too few legs for a split test'); return { legs, fitReal: null }; }

  const ow = late.filter((l) => l.won === true), ol = late.filter((l) => l.won === false);
  console.log(`late over-rate: all ${pct(mean(late.map((l) => +l.over)))} | team won series ${pct(mean(ow.map((l) => +l.over)))} (n ${ow.length}) | lost ${pct(mean(ol.map((l) => +l.over)))} (n ${ol.length})`);

  const full = fitEnv(early);
  const single = [0, 1, 2].map((j) => fitEnv(early, [j]));
  console.log(`fitted on early legs: β rel ${f3(full.beta[0]!)} close ${f3(full.beta[1]!)} pace ${f3(full.beta[2]!)} | singles rel ${f3(single[0]!.beta[0]!)} close ${f3(single[1]!.beta[1]!)} pace ${f3(single[2]!.beta[2]!)}`);
  console.log(`  (centres: rel ${f3(full.c.rel)}, close ${f3(full.c.close)}, pace ${f3(full.c.pace)} sd ${f3(full.c.paceSd)})`);

  const B = (ls: Leg[]) => ls.map((l) => overPred(l.key, l.b0, l.over));
  const M = (ls: Leg[], f: (l: Leg) => number) => ls.map((l) => overPred(l.key, f(l), l.over));
  summary('B0 baseline (player over-rate vs his walk-forward line, shrunk), LATE', B(late));
  console.log('LATE, model minus B0 on the same legs (negative ΔLogLoss/ΔBrier = better):');
  const mw = late.filter((l) => Number.isFinite(l.m1));
  paired('M1 mixture (player cond., pWin)', B(mw), M(mw, (l) => l.m1));
  paired('M1pop mixture (population cond.)', B(mw), M(mw, (l) => l.m1pop));
  paired('M1b range-state mixture (pMap)', B(late), M(late, (l) => l.m1b));
  paired('M2 fitted [rel, close, pace]', B(late), M(late, (l) => applyEnv(full, l.b0, l)));
  paired('M2 rel only', B(late), M(late, (l) => applyEnv(single[0]!, l.b0, l)));
  paired('M2 closeness only', B(late), M(late, (l) => applyEnv(single[1]!, l.b0, l)));
  paired('M2 pace only', B(late), M(late, (l) => applyEnv(single[2]!, l.b0, l)));
  const orc = late.filter((l) => Number.isFinite(l.oracle));
  paired('CEILING: M1 told the real winner', B(orc), M(orc, (l) => l.oracle));

  // B0 is itself noisy (a player's own over-rate against his own median has
  // no skill), so a model can beat it just by ignoring player history. These
  // rows isolate the environment: population base rate P0, with and without it.
  const P = (ls: Leg[]) => ls.map((l) => overPred(l.key, l.p0, l.over));
  const fullP = fitEnv(early, [0, 1, 2], (l) => l.p0);
  console.log(`LATE, against the POPULATION base rate P0 (isolates the environment): β rel ${f3(fullP.beta[0]!)} close ${f3(fullP.beta[1]!)} pace ${f3(fullP.beta[2]!)}`);
  paired('B0 player history (vs P0)', P(late), B(late));
  paired('M1pop mixture (vs P0)', P(mw), M(mw, (l) => l.m1pop));
  paired('P0 + fitted [rel, close, pace]', P(late), M(late, (l) => applyEnv(fullP, l.p0, l)));
  // Ceiling on P0's scale: the early block's P(over | won) / P(over | lost), told the real outcome.
  const rWe = mean(early.filter((l) => l.won === true).map((l) => +l.over));
  const rLe = mean(early.filter((l) => l.won === false).map((l) => +l.over));
  paired('CEILING: P0 told the real winner', P(orc), M(orc, (l) => (l.won ? rWe : rLe)));

  // (ii) closeness at series level: both teams' residual overs against |pWin − 0.5|.
  const bySer = new Map<string, { r: number; n: number; c: number }>();
  for (const l of late) { const e = bySer.get(l.key) ?? { r: 0, n: 0, c: l.close }; e.r += +l.over - l.b0; e.n++; bySer.set(l.key, e); }
  const ser = [...bySer.values()];
  const slope = (xs: typeof ser) => {
    const W = xs.reduce((a, x) => a + x.n, 0);
    const mx = xs.reduce((a, x) => a + x.n * x.c, 0) / W, my = xs.reduce((a, x) => a + x.r, 0) / W;
    let sxy = 0, sxx = 0;
    for (const x of xs) { sxy += x.n * (x.c - mx) * (x.r / x.n - my); sxx += x.n * (x.c - mx) ** 2; }
    return sxy / sxx;
  };
  const rnd = mulberry32(5);
  const sd: number[] = [];
  for (let r = 0; r < 1000; r++) sd.push(slope(ser.map(() => ser[Math.floor(rnd() * ser.length)]!)));
  sd.sort((x, y) => x - y);
  const srt = [...late].sort((x, y) => x.close - y.close), third = Math.floor(srt.length / 3);
  const res = (ls: Leg[]) => mean(ls.map((l) => +l.over - l.b0));
  console.log(`closeness (ii), LATE series ${ser.length}: slope of (over − B0) on closeness ${f4(slope(ser))} [${f4(sd[25]!)}, ${f4(sd[974]!)}] per unit (0 = mismatch, 1 = coin flip)` +
    ` | residual over-rate, least-close third ${pct(res(srt.slice(0, third)))} vs closest third ${pct(res(srt.slice(-third)))}`);

  if (spec.name.startsWith('CS2 kills')) {
    console.log(report(`${spec.name}: M2 fitted, played side, LATE`, late.map((l) => pickPred(l.key, applyEnv(full, l.b0, l), l.over))));
    console.log(report(`${spec.name}: B0 baseline, played side, LATE`, late.map((l) => pickPred(l.key, l.b0, l.over))));
  }
  const pre = legs.filter((l) => l.at >= R.burnEnd && l.at < REAL_FROM);
  return { legs, fitReal: spec.league === 'CS2' ? fitEnv(pre) : null };
}

/** Mechanism checks: does closeness / pace predict the actual length of maps in range? */
function mechanism(league: League, ctx: Ctx, start: number, end: number): void {
  const R = ctx.R[league];
  const xsC: number[] = [], xsP: number[] = [], ys: number[] = [], ysP: number[] = [];
  for (const s of ctx.series.values()) {
    if (s.league !== league || s.at < R.splitAt) continue;
    const ms = s.maps.filter((m) => m.n >= start && m.n <= end && m.val !== null);
    if (ms.length !== end - start + 1) continue;
    const v = mean(ms.map((m) => m.val!));
    const pm = cal(R.pre.get(s.key)!.pMapA, R.t);
    xsC.push(1 - 2 * Math.abs(pm - 0.5)); ys.push(v);
    const p = ctx.pace.get(s.key);
    if (p !== undefined) { xsP.push(p); ysP.push(v); }
  }
  const unit = league === 'CS2' ? 'rounds per map' : 'combined kills per game';
  const [c, lo, hi] = bootCorr(xsC, ys), [c2, lo2, hi2] = bootCorr(xsP, ysP);
  console.log(`\n${league} mechanism, LATE series ${ys.length}, maps ${start}-${end}: corr(closeness, actual ${unit}) ${f3(c)} [${f3(lo)}, ${f3(hi)}]; corr(expected pace, actual) ${f3(c2)} [${f3(lo2)}, ${f3(hi2)}] (n ${ysP.length})`);
}

// ---------------------------------------------------------------- real lines

async function realLines(ctx: Ctx, rows: Row[], fits: Record<string, Fitted | null>): Promise<void> {
  const real = await loadReal();
  const byHandle = new Map<string, Row[]>();
  for (const r of rows) (byHandle.get(`${r.league}|${r.canon_handle}`) ?? byHandle.set(`${r.league}|${r.canon_handle}`, []).get(`${r.league}|${r.canon_handle}`)!).push(r);
  type RL = { group: string; book: string; key: string; over: boolean; pm: number; pw: number; close: number; pace: number; rel: number; won: boolean | null; fitKey: string | null };
  const legs: RL[] = [];
  const skip: Record<string, number> = {};
  const no = (why: string) => { skip[why] = (skip[why] ?? 0) + 1; };
  for (const p of real) {
    const league = p.league as League;
    if (!(p.stat === 'kills' || (p.stat === 'headshots' && league === 'CS2'))) { no(`stat ${league} ${p.stat}`); continue; }
    const sched = Number(p.sched), N = p.map_end - p.map_start + 1;
    const rs = (byHandle.get(`${league}|${p.canon_handle}`) ?? []).filter((r) =>
      r.played_at >= sched - 3 * 3600_000 && r.played_at <= sched + 12 * 3600_000 && r.map_number >= p.map_start && r.map_number <= p.map_end);
    if (rs.length !== N || new Set(rs.map((r) => r.series_key)).size !== 1) { no('unsettled'); continue; }
    const stat = p.stat as 'kills' | 'headshots';
    if (rs.some((r) => r[stat] === null)) { no('unsettled'); continue; }
    const total = rs.reduce((a, r) => a + r[stat]!, 0);
    if (total === Number(p.line)) { no('push'); continue; }
    const s = ctx.series.get(rs[0]!.series_key);
    if (!s || !ctx.R[league].pre.has(s.key)) { no('no truth series'); continue; }
    const team = teamOf(rs[0]!.team, s);
    if (!team) { no('team not matched'); continue; }
    const pm = pmFor(ctx, s, team);
    const pw = s.bo && s.bo % 2 === 1 && s.bo >= 3 ? pSeries(pm, s.bo) : pm;
    const range = `m${p.map_start}-${p.map_end}`;
    legs.push({
      group: `${league} ${stat} ${range}`, book: p.book, key: s.key, over: total > Number(p.line), pm, pw,
      close: 1 - 2 * Math.abs(pm - 0.5), pace: ctx.pace.get(s.key) ?? NaN, rel: relOf(ctx, league, p.canon_handle, s.at, pm),
      won: s.winner === null ? null : s.winner === team,
      fitKey: league === 'CS2' && range === 'm1-2' ? `CS2 ${stat} m1-2` : null,
    });
  }
  console.log(`\n=============== REAL closing lines (since the logger started) ===============`);
  console.log(`closing legs ${real.length}; graded ${legs.length}; not graded: ${Object.entries(skip).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const groups = new Map<string, RL[]>();
  for (const l of legs) (groups.get(l.group) ?? groups.set(l.group, []).get(l.group)!).push(l);
  for (const [g, ls] of [...groups.entries()].sort((x, y) => y[1].length - x[1].length)) {
    const base = mean(ls.map((l) => +l.over));
    const nSer = new Set(ls.map((l) => l.key)).size;
    const w = ls.filter((l) => l.won === true), lo = ls.filter((l) => l.won === false);
    console.log(`\n${g}: legs ${ls.length}, series ${nSer}, over-rate ${pct(base)} | team won ${pct(mean(w.map((l) => +l.over)))} (n ${w.length}) vs lost ${pct(mean(lo.map((l) => +l.over)))} (n ${lo.length})  [outcome, not a forecast]`);
    if (nSer < 15) { console.log('  too few series to grade'); continue; }
    const B = ls.map((l) => overPred(l.key, base, l.over));
    const board = ls.map((l) => overPred(l.key, 1 - (l.pw * BOARD_UNDER.win + (1 - l.pw) * BOARD_UNDER.lose), l.over));
    console.log('  model minus constant base rate (base rate is the realised rate on these legs, so it flatters the base):');
    paired('board mixture with rating pWin', B, board);
    const f = l0(ls)?.fitKey ? fits[l0(ls)!.fitKey!] : null;
    if (f) paired('M2 [rel, close, pace] fit on archive', B, ls.map((l) => overPred(l.key, applyEnv(f, base, l), l.over)));
    const ordr = clusterBootstrap(ls.map((l) => overPred(l.key, l.pm, l.over)), auc, 1000);
    const cls = clusterBootstrap(ls.map((l) => overPred(l.key, l.close, l.over)), auc, 1000);
    console.log(`  ordering alone: AUC of team map-win prob vs over ${f3(ordr.point)} [${f3(ordr.lo)}, ${f3(ordr.hi)}]; AUC of closeness ${f3(cls.point)} [${f3(cls.lo)}, ${f3(cls.hi)}]`);
    if (g === 'CS2 kills m1-2' || g === 'CS2 headshots m1-2') {
      console.log(report(`${g}: board mixture with rating pWin, played side (REAL lines)`, ls.map((l) => pickPred(l.key, 1 - (l.pw * BOARD_UNDER.win + (1 - l.pw) * BOARD_UNDER.lose), l.over))));
    }
  }
}
const l0 = <T>(xs: T[]): T | undefined => xs[0];

// ---------------------------------------------------------------- main

export async function main(): Promise<void> {
  if (process.argv[2] === '--dump') { await writeDump(process.argv[3] ?? '/tmp/env_dump.json'); return; }
  const rows = await loadRows();
  const cs2 = cs2Series(load<Cs2Match[]>(CS2_TRUTH));
  const lolGames = existsSync(LOL_TRUTH) ? load<LolGame[]>(LOL_TRUTH) : [];
  let lol = lolSeries(lolGames);
  if (lol.length === 0) { lol = lolProxySeries(rows); LOL_PROXY = true; }
  console.log(`truth: CS2 ${cs2.list.length} series from bo3.gg (${cs2.odd} unusable); LoL ${lol.length} series ` +
    (LOL_PROXY ? `from the K−D PROXY (Oracle's Elixir unreachable: Drive quota)` : `from ${lolGames.length} OE games`));
  const series = new Map<string, TSeries>();
  for (const s of [...cs2.list, ...lol]) series.set(s.key, s);
  const archiveSeries = new Set(rows.map((r) => r.series_key));
  const covered = (lg: League) => [...archiveSeries].filter((k) => k.startsWith(lg === 'CS2' ? 'bo3:' : 'oe:'));
  for (const lg of ['CS2', 'LOL'] as League[]) {
    const ks = covered(lg);
    console.log(`archive ${lg}: ${ks.length} series keys, ${ks.filter((k) => series.has(k)).length} with a real winner source`);
  }

  // Pinnacle fixtures, read as probes at their own start time.
  const odds = await loadOdds();
  // A sanity check only, so a normalised-name collision ("FURIA" and "FURIA
  // Academy" both normalise to "furia") resolves to the name with the most
  // series in the 120 days before the fixture, instead of being dropped as
  // teamIndex does — which matched 0 of 12 fixtures on the first run.
  const byNorm = new Map<string, Map<string, number[]>>();
  for (const s of cs2.list) for (const t of [s.a, s.b]) {
    const k = normTeam(t);
    if (!k) continue;
    const m = byNorm.get(k) ?? byNorm.set(k, new Map()).get(k)!;
    (m.get(t) ?? m.set(t, []).get(t)!).push(s.at);
  }
  const resolve = (name: string, at: number): string | null => {
    const m = byNorm.get(normTeam(name));
    if (!m) return null;
    let best: string | null = null, bestN = 0;
    for (const [t, ats] of m) {
      const n = ats.filter((x) => x < at && x >= at - 120 * DAY).length;
      if (n > bestN) { best = t; bestN = n; }
    }
    return best;
  };
  const fx = odds.map((o) => ({ o, a: resolve(o.home_name, Number(o.at)), b: resolve(o.away_name, Number(o.at)), at: Number(o.at) }));
  const probes = fx.filter((f) => f.a && f.b).map((f) => ({ at: f.at, a: f.a!, b: f.b! }));

  const R = { CS2: rateLeague('CS2', cs2.list, probes), LOL: rateLeague('LOL', lol, []) } as Record<League, Rated>;
  ratingReport('CS2', cs2.list, R.CS2);
  ratingReport('LOL', lol, R.LOL);

  console.log(`\n--- Pinnacle sanity (${odds.length} fixtures, ${probes.length} matched by name) ---`);
  let pi = 0;
  const pr: number[] = [], pp: number[] = [];
  for (const f of fx) {
    if (!f.a || !f.b) { console.log(`  ${f.o.home_name} v ${f.o.away_name}: no name match`); continue; }
    const pre = R.CS2.probes[pi++]!;
    const mine = pSeries(cal(pre.pMapA, R.CS2.t), 3);
    pr.push(mine); pp.push(Number(f.o.p));
    const played = cs2.list.find((s) => s.at >= f.at - 6 * 3600_000 && s.at <= f.at + 6 * 3600_000 && new Set([s.a, s.b, f.a, f.b]).size === 2);
    console.log(`  ${new Date(f.at).toISOString().slice(5, 16)} ${f.a} v ${f.b}: ratings ${pct(mine)} (maps ${pre.nA}/${pre.nB}) | Pinnacle ${pct(Number(f.o.p))}${played ? ` | played: ${played.winner ?? '?'} won` : ''}`);
  }
  if (pr.length >= 3) {
    const agree = pr.filter((x, i) => (x > 0.5) === (pp[i]! > 0.5)).length;
    console.log(`  same favourite ${agree}/${pr.length}; mean |diff| ${pct(mean(pr.map((x, i) => Math.abs(x - pp[i]!))))}`);
  }

  proxyCheck('CS2', rows, series);
  if (LOL_PROXY) console.log('\n--- LoL proxy check skipped: no LoL truth this run (the proxy IS the label) ---');
  else proxyCheck('LOL', rows, series);

  // Relative-strength history: every archive player-series, its pre-match map-win prob.
  const byPS = new Map<string, Map<string, Row[]>>();
  for (const r of rows) {
    const m = byPS.get(r.series_key) ?? byPS.set(r.series_key, new Map()).get(r.series_key)!;
    (m.get(r.canon_handle) ?? m.set(r.canon_handle, []).get(r.canon_handle)!).push(r);
  }
  const ctx: Ctx = { series, R, pace: new Map([...paceMap(cs2.list), ...paceMap(lol)]), pmHist: new Map(), byPS };
  const tmp = new Map<string, { at: number; pm: number }[]>();
  for (const [sk, players] of byPS) {
    const s = series.get(sk);
    if (!s || !R[s.league].pre.has(sk)) continue;
    for (const [h, rs] of players) {
      const team = teamOf(rs[0]!.team, s);
      if (!team) continue;
      const k = `${s.league}|${h}`;
      (tmp.get(k) ?? tmp.set(k, []).get(k)!).push({ at: s.at, pm: pmFor(ctx, s, team) });
    }
  }
  for (const [k, xs] of tmp) {
    xs.sort((x, y) => x.at - y.at);
    let c = 0;
    ctx.pmHist.set(k, { at: xs.map((x) => x.at), cum: xs.map((x) => (c += x.pm)) });
  }

  const fits: Record<string, Fitted | null> = {};
  for (const spec of SPECS) fits[spec.name] = propStudy(spec, ctx).fitReal;
  mechanism('CS2', ctx, 1, 2);
  mechanism('LOL', ctx, 1, 2);
  await realLines(ctx, rows, fits);
  console.log('\nDONE');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
