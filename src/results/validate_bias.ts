import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { teamIndex } from '../adapters/teamname.js';
import { clusterBootstrap, mulberry32, signTest, type Pred } from './referee.js';

/**
 * Where are the DFS apps' lines systematically wrong? A pre-declared scan.
 *
 * Every question here comes down to one number, the OVER rate on settled
 * legs, taken in a slice. A slice whose over rate sits away from 50% (or away
 * from the book's own implied price, for the juice slice) is a place the app
 * prices one side wrong. The trap is slicing five days of lines fifty ways
 * and reporting the best-looking cut, so this file fixes the design before
 * it looks at any outcome:
 *
 *  - The slices and their levels are declared below, in `SLICES`, and never
 *    chosen from the results. Anything added after a first run is labelled
 *    EXPLORATORY in the output and kept out of the correction.
 *  - The unit of evidence is the SERIES. Intervals are series-cluster
 *    bootstraps (`referee.clusterBootstrap`); the test is an exact sign test
 *    over series (each series votes by the sign of Σ(won − p0) over its legs).
 *    No leg-level z-scores anywhere.
 *  - A level is TESTED only if it has ≥ 10 voting series (a sample-size rule,
 *    fixed before looking; thinner levels are printed as "thin" and are not
 *    in the family). Every tested level, plus the two pooled strategy tests,
 *    forms ONE Holm family. Holm-surviving = candidate edge; p < 0.05 raw
 *    only = hypothesis to track forward; anything else is a null.
 *
 * PRE-DECLARED SLICES (2026-09-11, before the first run):
 *
 *  1. book                PrizePicks / Underdog / Sleeper
 *  2. league              CS2 / LOL
 *  3. stat                kills / headshots / assists / …
 *  4. variant             standard / demon / goblin / promo   (ALL legs; demon
 *                         and goblin are over-only on PrizePicks, so their over
 *                         rate is the playable win rate)
 *  5. map range           e.g. CS2 1-2 vs 3; LOL 1-3 vs 4 vs 5
 *  6. line vs history     z = (line − prior median) / prior sd, over the
 *                         player's own prior series on the same stat and map
 *                         range (walk-forward: only series that started ≥ 3h
 *                         before this one, ≥ 8 of them). below z < −0.25,
 *                         near |z| ≤ 0.25, above z > 0.25.
 *  7. line movement       close − open (first pre-start snapshot): up / down / flat
 *  8. line age            start − first snapshot: < 6h / 6–24h / ≥ 24h
 *  9. apps listing        distinct books with a standard line on the same
 *                         market (handle, league, stat, range, starts ≤ 6h apart): 1 / 2 / 3
 * 10. agreement           multi-book markets: all closing lines equal / not
 * 11. position            in a disagreeing market, this book's line is the
 *                         low / high / mid one (low-line over and high-line
 *                         under are the line-shopping plays)
 * 12. juice side          Underdog/Sleeper closing prices, devigged:
 *                         P(over) ≥ 0.52 over-favoured / ≤ 0.48 under-favoured
 *                         / even. p0 = that implied probability, so this tests
 *                         realised vs the book's own price, not vs 50%.
 * 13. sleeper popularity  closing `sleeper_popularity`: < 0.4 / 0.4–0.6 / ≥ 0.6
 * 14. match tier          CS2 bo3.gg raw tier s / a / b / c
 * 15. favourite           Pinnacle P(team wins) ≥ 0.55 fav / ≤ 0.45 dog / even
 * 16. day                 UTC date of start
 *
 * Pooled strategy tests (one test each, same family):
 *  S1 follow the move     up-moved → over, down-moved → under
 *  S2 revert to history   above-history → under, below-history → over
 *  (Deliberately NOT pooled: "low-line over + high-line under" in the same
 *   market. Those two legs cannot both lose, so the pooled rate is ≥ 50% by
 *   construction. They are tested separately, as position=low / position=high.)
 *
 * Leg universe and hygiene, also fixed in advance:
 *  - Every slice except `variant` uses STANDARD legs only. Demon/goblin lines
 *    sit systematically off the standard line, and PrizePicks promo /
 *    flash-sale lines are a discount, not a price.
 *  - Closing line = last snapshot at or before start (the debugged recipe).
 *    **Sleeper's `scheduled_at` is always 23:59Z** (it gives a date only), so
 *    for Sleeper the start is taken from the same player's PrizePicks /
 *    Underdog match that day; a Sleeper leg with no such match is dropped
 *    (otherwise its "closing" line could be a live, post-start line and its
 *    settlement window would miss the match).
 *  - Settle: sum the player's map_stat_dedup rows with played_at in
 *    [start − 3h, start + 12h] and map_number in the range; exactly
 *    (map_end − map_start + 1) rows, all from ONE series_key (that is the
 *    cluster); pushes skipped. One leg per (book, series, player, stat, range,
 *    variant) — duplicate match rows inside one book count once.
 *  - Early/late halves (start ≤ 09-08 vs ≥ 09-09 UTC) are printed for every
 *    nominal hit: a real pricing bias should not live in one half.
 *
 * The archive (item 3 of the brief) cannot test app pricing — it has no app
 * lines — but it can say whether a real-line pattern has a structural cause.
 * Two pre-declared archive checks:
 *  A1 line vs history on pseudo-lines: a "form" line = floor(mean of the last
 *     5 prior series) + 0.5, banded by the same z against the long prior
 *     median. If lines above history go under here too, that is regression to
 *     the mean, and an app that chases form would be beatable by fading it.
 *  A2 tier: over rate of the walk-forward median + 0.5 line by CS2 tier — does
 *     a player's mixed-tier history mislead in a top-tier match?
 *
 *   npm run validate:bias      (add: "validate:bias": "tsx src/results/validate_bias.ts")
 */

const H = 3600e3;
const MIN_PRIOR = 8;
const Z_NEAR = 0.25;
const MIN_SERIES_TO_TEST = 10;
const EARLY_LAST_DAY = '2026-09-08';

/** The pre-declared slices, in order. Values are filled per leg; see the doc above. */
const SLICES = [
  'book', 'league', 'stat', 'variant', 'range', 'history', 'move', 'age', 'apps',
  'agreement', 'position', 'juice', 'popularity', 'tier', 'favourite', 'day',
] as const;
type Slice = (typeof SLICES)[number];

const STAT_COL: Record<string, 'kills' | 'deaths' | 'assists' | 'headshots'> = {
  kills: 'kills', deaths: 'deaths', assists: 'assists', headshots: 'headshots',
};

type PropRow = {
  id: number; book: string; league: string; stat: string; variant: string; handle: string;
  map_start: number; map_end: number; sched: number; team: string | null;
};
type SnapRow = { prop_id: number; at: number; line: number; over_price: number | null; under_price: number | null; extra: any };
type MapRow = {
  league: string; series_key: string; canon_handle: string; map_number: number;
  kills: number | null; deaths: number | null; assists: number | null; headshots: number | null;
  at: number; tier: string | null; team: string | null;
};

type Leg = Pred & { p0: number; day: string };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sd = (xs: number[]) => {
  const mu = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, xs.length - 1));
};
const dec = (am: number) => (am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am));
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const fp = (v: number) => (v < 0.0001 ? v.toExponential(1) : v.toFixed(4));
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const fin = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : v);

/** Output goes through here, so the daily job can run the scan quietly. */
let log: (...a: unknown[]) => void = (...a) => console.log(...a);

/** Over rate, series-bootstrap CI and the series sign test for one set of legs. */
function evaluate(legs: Leg[]) {
  const rate = (s: Pred[]) => s.filter((x) => x.won).length / s.length;
  const b = clusterBootstrap(legs, rate, 2000);
  const by = new Map<string, number>();
  for (const x of legs) by.set(x.series, (by.get(x.series) ?? 0) + (x.won ? 1 : 0) - x.p0);
  let up = 0, down = 0;
  for (const v of by.values()) { if (v > 1e-9) up++; else if (v < -1e-9) down++; }
  const meanP0 = legs.reduce((a, x) => a + x.p0, 0) / legs.length;
  return { legs: legs.length, series: b.series, rate: b.point, lo: b.lo, hi: b.hi, up, down, p: signTest(up, up + down), meanP0 };
}

/**
 * `since` scores only legs starting on or after that day (the forward window);
 * `store` writes the tracked leads' forward record to `lead_score` — the daily
 * job's mode, which is why it refuses to run without `since`; `quiet` mutes the
 * report.
 */
export async function main(opts: { since?: string | null; store?: boolean; quiet?: boolean } = {}): Promise<void> {
  if (opts.quiet) log = () => {};
  const now = Date.now();

  // ---------------------------------------------------------------- load
  const props = await q<PropRow>(`
    SELECT p.id, b.code AS book, p.league, p.stat, p.variant, pl.canon_handle AS handle,
           p.map_start, p.map_end, extract(epoch from m.scheduled_at) * 1000 AS sched, t.name AS team
      FROM prop p JOIN book b ON b.id = p.book_id JOIN player pl ON pl.id = p.player_id
      JOIN match m ON m.id = p.match_id LEFT JOIN team t ON t.id = pl.team_id
     WHERE p.is_combo = false AND m.scheduled_at IS NOT NULL AND m.scheduled_at < now() + interval '1 day'`);
  const snaps = await q<SnapRow>(`
    SELECT s.prop_id, extract(epoch from s.observed_at) * 1000 AS at, s.line::float8 AS line,
           s.over_price, s.under_price, s.extra
      FROM prop_snapshot s JOIN prop p ON p.id = s.prop_id
     WHERE p.is_combo = false ORDER BY s.prop_id, s.observed_at`);
  const maps = await q<MapRow>(`
    SELECT league, series_key, canon_handle, map_number, kills, deaths, assists, headshots,
           extract(epoch from played_at) * 1000 AS at, raw->>'tier' AS tier, team
      FROM map_stat_dedup WHERE played_at IS NOT NULL`);
  const odds = await q<{ home_name: string; away_name: string; p_home_win: number | null; starts_at: number; observed_at: number }>(`
    SELECT home_name, away_name, p_home_win::float8 AS p_home_win,
           extract(epoch from starts_at) * 1000 AS starts_at, extract(epoch from observed_at) * 1000 AS observed_at
      FROM match_odds WHERE p_home_win IS NOT NULL`);
  // The exact debugged closing recipe, used only to cross-check the JS closing below.
  const recipe = await q<{ id: number; book: string; line: number }>(`
    WITH closing AS (
      SELECT DISTINCT ON (ps.prop_id) ps.prop_id, ps.line::float8 AS line
        FROM prop_snapshot ps JOIN prop p ON p.id = ps.prop_id JOIN match m ON m.id = p.match_id
       WHERE ps.observed_at <= m.scheduled_at
       ORDER BY ps.prop_id, ps.observed_at DESC)
    SELECT p.id, b.code AS book, cl.line
      FROM closing cl JOIN prop p ON p.id = cl.prop_id JOIN book b ON b.id = p.book_id JOIN match m ON m.id = p.match_id
     WHERE p.is_combo = false AND m.scheduled_at < now()`);
  log(`loaded ${props.length} props, ${snaps.length} snapshots, ${maps.length} player-maps, ${odds.length} odds rows`);
  for (const r of maps) { r.at = Number(r.at); }
  for (const p of props) { p.sched = Number(p.sched); }

  const snapsOf = new Map<number, SnapRow[]>();
  for (const s of snaps) { s.at = Number(s.at); (snapsOf.get(s.prop_id) ?? snapsOf.set(s.prop_id, []).get(s.prop_id)!).push(s); }

  // Player-map rows by league|handle, and per-series summaries for history.
  const rowsOf = new Map<string, MapRow[]>();
  for (const r of maps) { const k = `${r.league}|${r.canon_handle}`; (rowsOf.get(k) ?? rowsOf.set(k, []).get(k)!).push(r); }
  type PSeries = { sk: string; at: number; maps: Map<number, MapRow>; tier: string | null };
  const seriesOf = new Map<string, PSeries[]>();
  for (const [k, rows] of rowsOf) {
    const bySk = new Map<string, PSeries>();
    for (const r of rows) {
      const s = bySk.get(r.series_key) ?? { sk: r.series_key, at: r.at, maps: new Map(), tier: r.tier };
      s.at = Math.min(s.at, r.at); s.maps.set(r.map_number, r); if (!s.tier && r.tier) s.tier = r.tier;
      bySk.set(r.series_key, s);
    }
    seriesOf.set(k, [...bySk.values()].sort((a, b) => a.at - b.at));
  }
  const totalOf = (s: PSeries, col: 'kills' | 'deaths' | 'assists' | 'headshots', ms: number, me: number): number | null => {
    let t = 0;
    for (let m = ms; m <= me; m++) { const r = s.maps.get(m); const v = r?.[col]; if (v === null || v === undefined) return null; t += Number(v); }
    return t;
  };

  // ---------------------------------------------------------------- start times (Sleeper fix)
  const ppudStarts = new Map<string, number[]>(); // league|handle -> starts
  for (const p of props) if (p.book !== 'sleeper') {
    const k = `${p.league}|${p.handle}`; (ppudStarts.get(k) ?? ppudStarts.set(k, []).get(k)!).push(p.sched);
  }
  const cover = new Map<string, number>(); // `${book}|${reason}` -> legs
  const drop = (book: string, reason: string) => cover.set(`${book}|${reason}`, (cover.get(`${book}|${reason}`) ?? 0) + 1);

  type Closed = PropRow & {
    start: number; close: SnapRow; open: SnapRow; firstAt: number; v: string; team: string | null;
  };
  const closed: Closed[] = [];
  for (const p of props) {
    const ss = snapsOf.get(p.id) ?? [];
    let start = p.sched;
    if (p.book === 'sleeper') {
      const date = ss.find((s) => s.extra?.sleeper_date)?.extra?.sleeper_date ?? utcDay(p.sched);
      const d0 = Date.parse(`${date}T00:00:00Z`);
      // Sleeper's date is a US (Eastern, UTC−4) calendar day. Hygiene fix after
      // the first run, made while Sleeper had ZERO settled legs (no outcome
      // seen): a first draft used a 36h UTC window, which caught a player's
      // next-day match too and dropped 72 legs as "ambiguous".
      const cands = [...new Set((ppudStarts.get(`${p.league}|${p.handle}`) ?? []).filter((t) => t >= d0 + 4 * H && t < d0 + 28 * H))].sort((a, b) => a - b);
      if (cands.length === 0) { drop(p.book, 'sleeper: no PP/UD start'); continue; }
      if (cands[cands.length - 1]! - cands[0]! > 6 * H) { drop(p.book, 'sleeper: ambiguous start'); continue; }
      start = cands[0]!;
    }
    if (start >= now) continue; // not started: not a leg yet
    const pre = ss.filter((s) => s.at <= start);
    if (pre.length === 0) { drop(p.book, 'no pre-start snapshot'); continue; }
    const close = pre[pre.length - 1]!, open = pre[0]!;
    let v = p.variant;
    if (p.book === 'prizepicks' && (close.extra?.is_promo === true || close.extra?.flash_sale_line_score != null)) v = 'promo';
    const team = (p.book === 'prizepicks' ? close.extra?.player_team : null) ?? p.team;
    closed.push({ ...p, start, close, open, firstAt: ss[0]!.at, v, team });
  }

  // Cross-check the JS closing against the SQL recipe for PrizePicks/Underdog.
  const recipeLine = new Map(recipe.map((r) => [r.id, Number(r.line)]));
  let agreeRecipe = 0, disagreeRecipe = 0, missingRecipe = 0;
  for (const c of closed) if (c.book !== 'sleeper') {
    const l = recipeLine.get(c.id);
    if (l === undefined) missingRecipe++; else if (l === c.close.line) agreeRecipe++; else disagreeRecipe++;
  }
  log(`closing cross-check vs SQL recipe (PP/UD): ${agreeRecipe} equal, ${disagreeRecipe} differ, ${missingRecipe} not in recipe; recipe rows ${recipe.length}`);

  // ---------------------------------------------------------------- cross-book market structure
  const mkKey = (c: Closed) => `${c.league}|${c.handle}|${c.stat}|${c.map_start}-${c.map_end}`;
  const std = closed.filter((c) => c.v === 'standard');
  const byMk = new Map<string, Closed[]>();
  for (const c of std) (byMk.get(mkKey(c)) ?? byMk.set(mkKey(c), []).get(mkKey(c))!).push(c);
  const market = new Map<number, { apps: number; agree: boolean | null; pos: string | null; gap: number }>();
  for (const group of byMk.values()) {
    for (const c of group) {
      const same = group.filter((o) => Math.abs(o.start - c.start) <= 6 * H);
      const perBook = new Map<string, number>();
      for (const o of same) perBook.set(o.book, o.close.line); // one line per book
      const lines = [...perBook.values()];
      const lo = Math.min(...lines), hi = Math.max(...lines);
      const apps = perBook.size;
      market.set(c.id, {
        apps,
        agree: apps > 1 ? lo === hi : null,
        pos: apps > 1 && lo !== hi ? (c.close.line === lo ? 'low' : c.close.line === hi ? 'high' : 'mid') : null,
        gap: hi - lo,
      });
    }
  }

  // Pinnacle: latest pre-start quote per fixture, one entry per side.
  const sides: { name: string; pWin: number; startsAt: number }[] = [];
  for (const o of odds) {
    sides.push({ name: o.home_name, pWin: Number(o.p_home_win), startsAt: Number(o.starts_at) });
    sides.push({ name: o.away_name, pWin: 1 - Number(o.p_home_win), startsAt: Number(o.starts_at) });
  }

  // ---------------------------------------------------------------- settle + tag
  type Settled = Closed & { over: boolean; sk: string; tier: string | null; tags: Record<Slice, string | null>; p0juice: number | null; z: number | null };
  const settled: Settled[] = [];
  const noRows: { c: Closed; off: number; anyMap: boolean }[] = [];
  let pushes = 0;
  const seen = new Map<string, Settled>();
  for (const c of closed) {
    const col = STAT_COL[c.stat];
    if (!col) { drop(c.book, `unsettleable stat (${c.stat})`); continue; }
    const want = c.map_end - c.map_start + 1;
    const rows = (rowsOf.get(`${c.league}|${c.handle}`) ?? []).filter((r) =>
      r.at >= c.start - 3 * H && r.at <= c.start + 12 * H && r.map_number >= c.map_start && r.map_number <= c.map_end);
    if (rows.length === 0) {
      // Where DID this player play, relative to the listed start? Separates
      // "not ingested / not covered" from "the listed start time is wrong".
      let off = Infinity, anyMap = false;
      for (const r of rowsOf.get(`${c.league}|${c.handle}`) ?? []) {
        const d = (r.at - c.start) / H; if (Math.abs(d) < Math.abs(off)) off = d;
        if (d >= -3 && d <= 12) anyMap = true;
      }
      noRows.push({ c, off, anyMap });
      drop(c.book, 'no stat rows in window'); continue;
    }
    if (rows.length !== want) { drop(c.book, want > 1 || c.map_start > 1 ? 'wrong row count (void/partial)' : 'wrong row count'); continue; }
    const sks = new Set(rows.map((r) => r.series_key));
    if (sks.size !== 1) { drop(c.book, 'rows from >1 series'); continue; }
    if (rows.some((r) => r[col] === null)) { drop(c.book, 'null stat'); continue; }
    const total = rows.reduce((a, r) => a + Number(r[col]), 0);
    if (total === c.close.line) { pushes++; drop(c.book, 'push'); continue; }
    const sk = `${c.league}|${[...sks][0]!}`;
    const tier = rows.find((r) => r.tier)?.tier ?? null;

    // line vs the player's own history
    let z: number | null = null;
    const hist = (seriesOf.get(`${c.league}|${c.handle}`) ?? [])
      .filter((s) => s.at < c.start - 3 * H && `${c.league}|${s.sk}` !== sk)
      .map((s) => totalOf(s, col, c.map_start, c.map_end)).filter((t): t is number => t !== null);
    if (hist.length >= MIN_PRIOR) { const s = sd(hist); z = s > 0 ? (c.close.line - median(hist)) / s : 0; }

    // juice (priced books only)
    let p0juice: number | null = null;
    if ((c.book === 'underdog' || c.book === 'sleeper') && c.close.over_price !== null && c.close.under_price !== null) {
      const io = 1 / dec(c.close.over_price), iu = 1 / dec(c.close.under_price);
      p0juice = io / (io + iu);
    }
    const mk = market.get(c.id);
    const pop = c.book === 'sleeper' ? c.close.extra?.sleeper_popularity : null;
    const ageH = (c.start - c.firstAt) / H;
    const mv = c.close.line - c.open.line;
    let fav: string | null = null;
    if (c.team && c.league === 'CS2') {
      const find = teamIndex(sides.filter((s) => Math.abs(s.startsAt - c.start) <= 6 * H), (s) => s.name);
      const hit = find(c.team);
      if (hit) fav = hit.pWin >= 0.55 ? 'fav' : hit.pWin <= 0.45 ? 'dog' : 'even';
    }
    const tags: Record<Slice, string | null> = {
      book: c.book, league: c.league, stat: `${c.league} ${c.stat}`, variant: c.v,
      range: `${c.league} ${c.map_start}-${c.map_end}`,
      history: z === null ? null : z < -Z_NEAR ? 'below' : z > Z_NEAR ? 'above' : 'near',
      move: mv > 0 ? 'up' : mv < 0 ? 'down' : 'flat',
      age: ageH < 6 ? '<6h' : ageH < 24 ? '6-24h' : '>=24h',
      apps: mk ? String(mk.apps) : null,
      agreement: mk?.agree === null || mk?.agree === undefined ? null : mk.agree ? 'agree' : 'disagree',
      position: mk?.pos ?? null,
      juice: p0juice === null ? null : p0juice >= 0.52 ? 'over-fav' : p0juice <= 0.48 ? 'under-fav' : 'even',
      popularity: typeof pop === 'number' ? (pop < 0.4 ? '<0.4' : pop >= 0.6 ? '>=0.6' : '0.4-0.6') : null,
      tier: c.league === 'CS2' ? (tier ?? 'unknown') : null,
      favourite: fav,
      day: utcDay(c.start),
    };
    const leg: Settled = { ...c, over: total > c.close.line, sk, tier, tags, p0juice, z };
    const dk = `${c.book}|${sk}|${c.handle}|${c.stat}|${c.map_start}-${c.map_end}|${c.v}`;
    const prev = seen.get(dk);
    if (prev) { drop(c.book, 'duplicate leg in book'); if (prev.close.at >= c.close.at) continue; }
    seen.set(dk, leg);
  }
  settled.push(...seen.values());

  // ---------------------------------------------------------------- coverage
  log(`\n=== COVERAGE (legs that started; why they did or did not settle) ===`);
  const books = [...new Set(props.map((p) => p.book))].sort();
  for (const b of books) {
    const s = settled.filter((x) => x.book === b).length;
    const reasons = [...cover.entries()].filter(([k]) => k.startsWith(`${b}|`)).map(([k, n]) => `${k.split('|')[1]} ${n}`).join('; ');
    log(`  ${b.padEnd(10)} settled ${s}   dropped: ${reasons || 'none'}`);
  }
  const days = [...new Set(closed.map((c) => utcDay(c.start)))].sort();
  log(`  settled / started by day: ` + days.map((d) => {
    const st = closed.filter((c) => utcDay(c.start) === d).length, se = settled.filter((x) => x.tags.day === d).length;
    return `${d.slice(5)} ${se}/${st}`;
  }).join('  '));
  const settledMk = settled.map((x) => ({ k: mkKey(x), start: x.start, book: x.book }));
  for (const b of books) {
    const nr = noRows.filter((x) => x.c.book === b);
    if (!nr.length) continue;
    const bucket = new Map<string, number>();
    // (First draft bucketed by the nearest map's sign only, which filed map-3
    // voids — player played maps 1-2 in the window, series ended 2-0 — as
    // "start listed late". Voids are now their own bucket.)
    for (const { c, off, anyMap } of nr) {
      const k = anyMap ? 'played in window, range not played (void, e.g. 2-0)'
        : now - c.start < 18 * H ? 'started <18h ago (ingest lag)'
        : !Number.isFinite(off) ? 'handle never in archive'
        : Math.abs(off) > 72 ? 'nothing within ±72h'
        : off < 0 ? 'played BEFORE window (start listed late)' : 'played AFTER window (start listed early)';
      bucket.set(k, (bucket.get(k) ?? 0) + 1);
    }
    const otherBook = nr.filter(({ c }) => settledMk.some((s) => s.book !== b && s.k === mkKey(c) && Math.abs(s.start - c.start) <= 24 * H)).length;
    log(`  ${b} no-rows breakdown: ${[...bucket.entries()].map(([k, n]) => `${k} ${n}`).join('; ')}; same market settled on another book: ${otherBook}`);
  }

  // ---------------------------------------------------------------- the family
  const toLeg = (x: Settled, won: boolean, p0 = 0.5): Leg => ({ series: x.sk, p: p0, won, p0, day: x.tags.day! });
  type Row = { slice: string; level: string; ev: ReturnType<typeof evaluate>; legsArr: Leg[]; tested: boolean };
  const rows: Row[] = [];
  // `--since=YYYY-MM-DD` scores only legs starting on or after that day: the
  // forward window for the slices pre-registered in TRACKED below.
  const since = opts.since ?? null;
  const scoped = since ? settled.filter((x) => x.tags.day! >= since) : settled;
  if (since) log(`\n*** scoring only legs starting on/after ${since}: ${scoped.length} legs ***`);
  const stdSettled = scoped.filter((x) => x.v === 'standard');
  for (const sl of SLICES) {
    const pool_ = sl === 'variant' ? scoped : stdSettled;
    const levels = [...new Set(pool_.map((x) => x.tags[sl]).filter((v): v is string => v !== null))].sort();
    for (const lv of levels) {
      const legs = pool_.filter((x) => x.tags[sl] === lv).map((x) => toLeg(x, x.over, sl === 'juice' ? x.p0juice! : 0.5));
      const ev = evaluate(legs);
      rows.push({ slice: sl, level: lv, ev, legsArr: legs, tested: ev.up + ev.down >= MIN_SERIES_TO_TEST });
    }
  }
  // Strategy tests.
  const follow = stdSettled.filter((x) => x.tags.move !== 'flat').map((x) => toLeg(x, x.tags.move === 'up' ? x.over : !x.over));
  const revert = stdSettled.filter((x) => x.tags.history === 'above' || x.tags.history === 'below')
    .map((x) => toLeg(x, x.tags.history === 'below' ? x.over : !x.over));
  for (const [lv, legs] of [['S1 follow the move (won = side of move)', follow], ['S2 revert to history (won = side toward median)', revert]] as const) {
    if (legs.length === 0) continue;
    const ev = evaluate(legs);
    rows.push({ slice: 'strategy', level: lv, ev, legsArr: legs, tested: ev.up + ev.down >= MIN_SERIES_TO_TEST });
  }

  // Holm across every tested row.
  const tested = rows.filter((r) => r.tested).sort((a, b) => a.ev.p - b.ev.p);
  const m = tested.length;
  const holm = new Map<Row, number>();
  let run = 0;
  tested.forEach((r, i) => { run = Math.max(run, Math.min(1, (m - i) * r.ev.p)); holm.set(r, run); });

  const all = evaluate(stdSettled.map((x) => toLeg(x, x.over)));
  log(`\n=== ALL STANDARD SETTLED LEGS: ${all.legs} legs, ${all.series} series, over ${pct(all.rate)} [${pct(all.lo)}, ${pct(all.hi)}], vote ${all.up}-${all.down} p=${fp(all.p)} ===`);
  log(`(all variants: ${settled.length} legs; pushes skipped ${pushes})`);
  log(`\n=== SLICE TABLE — over rate (series-bootstrap 95% CI); vote = series leaning over-down; sign-test p; Holm over ${m} tests ===`);
  log(`${'slice'.padEnd(10)} ${'level'.padEnd(46)} ${'legs'.padStart(5)} ${'ser'.padStart(4)}  ${'over'.padStart(6)}  ${'95% CI'.padEnd(15)} ${'vote'.padStart(7)}  ${'p raw'.padStart(7)}  ${'p Holm'.padStart(7)}  verdict`);
  for (const r of rows) {
    const e = r.ev;
    const h = holm.get(r);
    const verdict = !r.tested ? 'thin (not tested)' : h! < 0.05 ? 'SURVIVES HOLM' : e.p < 0.05 ? 'nominal: track fwd' : 'null';
    const juice = r.slice === 'juice' ? ` (implied ${pct(e.meanP0)})` : '';
    log(`${r.slice.padEnd(10)} ${(r.level + juice).padEnd(46)} ${String(e.legs).padStart(5)} ${String(e.series).padStart(4)}  ${pct(e.rate).padStart(6)}  [${pct(e.lo)}, ${pct(e.hi)}]`.padEnd(98) +
      `${`${e.up}-${e.down}`.padStart(7)}  ${fp(e.p).padStart(7)}  ${h === undefined ? '     —' : fp(h).padStart(7)}  ${verdict}`);
  }

  // Early/late halves and power for anything nominal, and for the top few by p.
  const shortlist = [...tested].slice(0, 8);
  log(`\n=== STABILITY + POWER for the ${shortlist.length} smallest-p tested rows ===`);
  log(`(power: series needed for 80% power, α=0.05 two-sided, to detect a 5-point shift from p0 — e.g. 55% vs 50%, the PP 5/6-pick break-even —`);
  log(` scaled from this slice's own bootstrap SE, so it carries the within-series clustering)`);
  for (const r of shortlist) {
    const early = r.legsArr.filter((x) => x.day <= EARLY_LAST_DAY), late = r.legsArr.filter((x) => x.day > EARLY_LAST_DAY);
    const e1 = early.length ? evaluate(early) : null, e2 = late.length ? evaluate(late) : null;
    const se = (r.ev.hi - r.ev.lo) / 3.92;
    const need = Math.ceil(r.ev.series * ((se * 2.8) / 0.05) ** 2);
    log(`  ${r.slice}=${r.level}: early ${e1 ? `${pct(e1.rate)} (${e1.series} ser, ${e1.up}-${e1.down})` : '—'}   late ${e2 ? `${pct(e2.rate)} (${e2.series} ser, ${e2.up}-${e2.down})` : '—'}   series needed ≈ ${need}`);
  }

  // Diagnostics that guard against artifacts.
  log(`\n=== ARTIFACT CHECKS ===`);
  const withZ = stdSettled.filter((x) => x.z !== null);
  log(`  history band available for ${withZ.length}/${stdSettled.length} standard legs; mean z ${(withZ.reduce((a, x) => a + x.z!, 0) / Math.max(1, withZ.length)).toFixed(3)}`);
  const closedStd = closed.filter((c) => c.v === 'standard');
  for (const b of books) {
    const st = closedStd.filter((c) => c.book === b), se = stdSettled.filter((x) => x.book === b);
    const mvStart = st.filter((c) => c.close.line !== c.open.line).length;
    log(`  ${b}: started std ${st.length}, settled ${se.length}; moved-before-close ${mvStart} (${pct(mvStart / Math.max(1, st.length))}); snapshots/leg ${(st.reduce((a, c) => a + (snapsOf.get(c.id)?.length ?? 0), 0) / Math.max(1, st.length)).toFixed(2)}`);
  }
  // Do settlement failures depend on a pre-match observable? (the outcome itself is unobservable for them)
  const settledIds = new Set(settled.map((x) => x.id));
  for (const [label, f] of [['moved', (c: Closed) => c.close.line !== c.open.line], ['multi-app', (c: Closed) => (market.get(c.id)?.apps ?? 1) > 1]] as const) {
    const a = closedStd.filter(f), b = closedStd.filter((c) => !f(c));
    log(`  settle rate ${label}: ${pct(a.filter((c) => settledIds.has(c.id)).length / Math.max(1, a.length))} (${a.length}) vs not: ${pct(b.filter((c) => settledIds.has(c.id)).length / Math.max(1, b.length))} (${b.length})`);
  }

  // ---------------------------------------------------------------- exploratory
  // Added AFTER the first run, to understand the three nominal rows. Not part
  // of the Holm family; nothing here is evidence, only a description.
  log(`\n=== EXPLORATORY (post-hoc; not in the Holm family) ===`);
  const ex = (label: string, xs: Settled[], won: (x: Settled) => boolean = (x) => x.over) => {
    if (!xs.length) { log(`  ${label.padEnd(52)} —`); return; }
    const e = evaluate(xs.map((x) => toLeg(x, won(x))));
    log(`  ${label.padEnd(52)} legs ${String(e.legs).padStart(4)} ser ${String(e.series).padStart(3)}  over ${pct(e.rate).padStart(6)} [${pct(e.lo)}, ${pct(e.hi)}]  vote ${e.up}-${e.down} p=${fp(e.p)}`);
  };
  for (const pos of ['high', 'low']) for (const b of books) ex(`position=${pos} book=${b}`, stdSettled.filter((x) => x.tags.position === pos && x.book === b));
  for (const pos of ['high', 'low']) {
    ex(`position=${pos} gap<=1`, stdSettled.filter((x) => x.tags.position === pos && (market.get(x.id)?.gap ?? 0) <= 1));
    ex(`position=${pos} gap>1`, stdSettled.filter((x) => x.tags.position === pos && (market.get(x.id)?.gap ?? 0) > 1));
  }
  for (const h of ['above', 'near', 'below']) ex(`position=high history=${h}`, stdSettled.filter((x) => x.tags.position === 'high' && x.tags.history === h));
  for (const h of ['above', 'near', 'below']) ex(`position!=high history=${h}`, stdSettled.filter((x) => x.tags.position !== 'high' && x.tags.history === h));
  for (const b of books) ex(`history=above book=${b}`, stdSettled.filter((x) => x.tags.history === 'above' && x.book === b));
  for (const st of ['kills', 'headshots']) ex(`history=above CS2 ${st}`, stdSettled.filter((x) => x.tags.history === 'above' && x.tags.stat === `CS2 ${st}`));
  for (const d of days) ex(`tier=b day=${d}`, stdSettled.filter((x) => x.tags.tier === 'b' && x.tags.day === d));

  // ---------------------------------------------------------------- tracked (pre-registered 2026-09-11 for the forward window)
  // Chosen from the run above; they only count as evidence on legs starting
  // 2026-09-12 or later (`--since=2026-09-12`). Three tests → Bonferroni 0.0167.
  // `needed`: series before a lead may be acted on — ~80% power to detect a
  // 5-point shift, scaled from each slice's own bootstrap spread (T2's 280 is
  // the level at which a ~60% true rate clears the 54.9% five-pick bar).
  const TRACKED: { key: string; label: string; sel: (x: Settled) => boolean; won: (x: Settled) => boolean; needed: number }[] = [
    { key: 'T1', label: 'Under at the high line when the apps disagree', sel: (x) => x.tags.position === 'high', won: (x) => !x.over, needed: 213 },
    { key: 'T2', label: "Under when the line sits above the player's own history", sel: (x) => x.tags.history === 'above', won: (x) => !x.over, needed: 280 },
    { key: 'T3', label: 'Under in CS2 tier-b matches', sel: (x) => x.tags.tier === 'b', won: (x) => !x.over, needed: 174 },
  ];
  log(`\n=== TRACKED (win = the tracked side; forward evidence only with --since=2026-09-12; Bonferroni α = 0.0167) ===`);
  for (const t of TRACKED) ex(`${t.key} ${t.label}`, stdSettled.filter(t.sel), t.won);

  if (opts.store) {
    // Only the forward window may become a lead's record: the leads were
    // chosen FROM the earlier days, so those days cannot confirm them.
    if (!since) throw new Error('--store needs --since: only the forward window is a lead record');
    for (const t of TRACKED) {
      const legs = stdSettled.filter(t.sel).map((x) => toLeg(x, t.won(x)));
      const e = legs.length ? evaluate(legs) : null;
      await q(
        `INSERT INTO lead_score (scored_on, lead, label, since, legs, series, win_rate, ci_lo, ci_hi,
                                 series_up, series_down, series_p, series_needed)
         VALUES (current_date, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (lead, scored_on) DO UPDATE SET
           label = EXCLUDED.label, since = EXCLUDED.since, legs = EXCLUDED.legs, series = EXCLUDED.series,
           win_rate = EXCLUDED.win_rate, ci_lo = EXCLUDED.ci_lo, ci_hi = EXCLUDED.ci_hi,
           series_up = EXCLUDED.series_up, series_down = EXCLUDED.series_down,
           series_p = EXCLUDED.series_p, series_needed = EXCLUDED.series_needed`,
        [t.key, t.label, since, e?.legs ?? 0, e?.series ?? 0, fin(e?.rate), fin(e?.lo), fin(e?.hi),
         e?.up ?? null, e?.down ?? null, fin(e?.p), t.needed],
      );
    }
    log(`stored ${TRACKED.length} lead scores for the window from ${since}`);
    // The daily job needs nothing past this point; the archive checks are for
    // a person reading the report.
    if (opts.quiet) return;
  }

  // ---------------------------------------------------------------- archive
  log(`\n=== ARCHIVE (walk-forward pseudo-lines; no app lines — structural checks only) ===`);
  const seriesBoot = (tallies: Map<string, { w: number; n: number }>, reps = 1000) => {
    const g = [...tallies.values()];
    const W = g.reduce((a, x) => a + x.w, 0), N = g.reduce((a, x) => a + x.n, 0);
    const rnd = mulberry32(20260911); const d: number[] = [];
    for (let r = 0; r < reps; r++) { let w = 0, n = 0; for (let i = 0; i < g.length; i++) { const x = g[Math.floor(rnd() * g.length)]!; w += x.w; n += x.n; } d.push(w / n); }
    d.sort((a, b) => a - b);
    return { rate: W / N, lo: d[Math.floor(0.025 * reps)]!, hi: d[Math.floor(0.975 * reps)]!, legs: N, series: g.length };
  };
  const ARCH: [string, 'kills' | 'headshots' | 'assists', number, number][] = [
    ['CS2', 'kills', 1, 2], ['CS2', 'headshots', 1, 2], ['LOL', 'kills', 1, 3], ['LOL', 'assists', 1, 3],
  ];
  for (const [lg, col, ms, me] of ARCH) {
    const band = new Map<string, Map<string, { w: number; n: number }>>();
    const tierT = new Map<string, Map<string, { w: number; n: number }>>();
    const add = (mp: Map<string, Map<string, { w: number; n: number }>>, k: string, sk: string, won: boolean) => {
      const inner = mp.get(k) ?? mp.set(k, new Map()).get(k)!;
      const t = inner.get(sk) ?? { w: 0, n: 0 }; t.n++; if (won) t.w++; inner.set(sk, t);
    };
    for (const [k, ss] of seriesOf) {
      if (!k.startsWith(`${lg}|`)) continue;
      const prior: number[] = [];
      for (const s of ss) {
        const t = totalOf(s, col, ms, me);
        if (t === null) continue;
        if (prior.length >= MIN_PRIOR) {
          const med = median(prior), sdev = sd(prior);
          const last5 = prior.slice(-5), form = Math.floor(last5.reduce((a, x) => a + x, 0) / last5.length) + 0.5;
          const z = sdev > 0 ? (form - med) / sdev : 0;
          add(band, z < -Z_NEAR ? 'below' : z > Z_NEAR ? 'above' : 'near', s.sk, t > form);
          if (lg === 'CS2') add(tierT, s.tier ?? 'unknown', s.sk, t > med + 0.5);
        }
        prior.push(t);
      }
    }
    log(`  ${lg} ${col} maps ${ms}-${me}:`);
    for (const lv of ['below', 'near', 'above']) {
      const tl = band.get(lv); if (!tl) continue; const b = seriesBoot(tl);
      log(`    A1 form line ${lv.padEnd(6)} over ${pct(b.rate)} [${pct(b.lo)}, ${pct(b.hi)}]  legs ${b.legs}, series ${b.series}`);
    }
    for (const lv of [...tierT.keys()].sort()) {
      const b = seriesBoot(tierT.get(lv)!);
      log(`    A2 tier ${lv.padEnd(8)} over median+0.5 ${pct(b.rate)} [${pct(b.lo)}, ${pct(b.hi)}]  legs ${b.legs}, series ${b.series}`);
    }
  }
  log(`\nForward-only data: book lines exist from 2026-09-06, Sleeper from 09-10/11, Pinnacle from 09-11.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main({
    since: process.argv.find((a) => a.startsWith('--since='))?.slice(8) ?? null,
    store: process.argv.includes('--store'),
    quiet: process.argv.includes('--quiet'),
  }).then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
