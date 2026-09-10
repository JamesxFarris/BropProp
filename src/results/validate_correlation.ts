import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { signTest } from './validate_consensus.js';

/**
 * Do two players in the same match really beat their lines together?
 *
 * This is the last live lead in the project, and the only one that does not
 * require predicting anything. If legs from one match are positively
 * correlated, then an all-must-win entry stacked on a single match sweeps more
 * often than the book's flat payout ladder assumes — an edge that comes from
 * the payout structure rather than from knowing more than the market.
 *
 * The existing figure (1.159x for same-direction pairs) comes from
 * `raw/correlation.ts` and has three problems, all of which this fixes:
 *
 *  1. **It set each player's line at their career median over the whole
 *     sample.** That is a look-ahead: the "line" knows how the player did in
 *     the very series being scored. Worse, anything shared by two players and
 *     drifting over time — a patch, a meta, a roster change — gets absorbed
 *     into it and reappears as correlation. Here the line is the median of that
 *     player's PRIOR series only.
 *  2. **It never tested over independent series.** 35,702 pairs came from about
 *     800 series, and pairs inside one series are the very thing being
 *     measured, so a pair-level test assumes what it is trying to prove. Here
 *     the significance test is over series.
 *  3. **It never separated teammates from opponents.** Those plausibly differ
 *     in both sign and size — teammates share a win, opponents share only the
 *     length of the game — and PrizePicks requires two teams in a lineup, so
 *     the mix matters for what can actually be built.
 *
 * **This needs no book lines at all**, which is why it can run today at full
 * strength. Lines exist only from 2026-09-06; player performance goes back to
 * 2024-09 for CS2 and 2022-01 for LoL — 14,174 and 5,291 series. Every
 * line-dependent question in this project is starved; this one is not.
 *
 *   npm run validate:correlation
 */

/** Ranges the books actually offer, so the study measures a real market. */
const RANGE: Record<string, { start: number; end: number }> = {
  CS2: { start: 1, end: 2 },   // Bo3; maps 1-2 always complete
  LOL: { start: 1, end: 3 },   // Bo5; maps 1-3 always complete
};

/** Prior series a player needs before their median counts as a line. */
const MIN_PRIOR = 8;

type Row = {
  league: string; series_key: string; canon_handle: string; team: string | null;
  map_number: number; kills: number | null; played_at: string;
};

type PlayerSeries = { at: number; total: number; team: string | null };

export async function main(): Promise<void> {
  const rows = await q<Row>(`
    SELECT league, series_key, canon_handle, team, map_number, kills,
           extract(epoch from played_at) * 1000 AS played_at
      FROM map_stat_dedup
     WHERE kills IS NOT NULL AND played_at IS NOT NULL
     ORDER BY played_at`);

  console.log(`loaded ${rows.length} player-maps`);

  // Fold to one range total per player per series, keeping only series that
  // actually played the whole range — a short series is a void, not a loss.
  const perSeries = new Map<string, Map<string, PlayerSeries>>();
  const acc = new Map<string, { sum: number; maps: number; at: number; team: string | null; league: string }>();
  for (const r of rows) {
    const range = RANGE[r.league];
    if (!range) continue;
    if (r.map_number < range.start || r.map_number > range.end) continue;
    const key = `${r.league}|${r.series_key}|${r.canon_handle}`;
    const a = acc.get(key) ?? { sum: 0, maps: 0, at: Number(r.played_at), team: r.team, league: r.league };
    a.sum += Number(r.kills);
    a.maps++;
    a.at = Math.max(a.at, Number(r.played_at));
    if (!a.team && r.team) a.team = r.team;
    acc.set(key, a);
  }

  for (const [key, a] of acc) {
    const [league, seriesKey, handle] = key.split('|');
    const want = RANGE[league!]!.end - RANGE[league!]!.start + 1;
    if (a.maps !== want) continue;             // range not completed
    const sk = `${league}|${seriesKey}`;
    const m = perSeries.get(sk) ?? new Map();
    m.set(handle!, { at: a.at, total: a.sum, team: a.team });
    perSeries.set(sk, m);
  }

  // Every player's series totals in time order, for the walk-forward median.
  const history = new Map<string, { at: number; total: number }[]>();
  for (const [sk, players] of perSeries) {
    const league = sk.split('|')[0]!;
    for (const [handle, ps] of players) {
      const k = `${league}|${handle}`;
      const h = history.get(k) ?? [];
      h.push({ at: ps.at, total: ps.total });
      history.set(k, h);
    }
  }
  for (const h of history.values()) h.sort((a, b) => a.at - b.at);

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };

  /** The line as it would have stood BEFORE this series: prior median + 0.5. */
  function lineBefore(league: string, handle: string, at: number): number | null {
    const h = history.get(`${league}|${handle}`) ?? [];
    const prior = h.filter((x) => x.at < at).map((x) => x.total);
    if (prior.length < MIN_PRIOR) return null;
    // Books post half-points so a bet cannot tie. Median + 0.5 makes the over
    // slightly the harder side, which is why the marginal comes in under 50%.
    return median(prior) + 0.5;
  }

  type Cell = { both: number; split: number; neither: number; n: number };
  const cell = (): Cell => ({ both: 0, split: 0, neither: 0, n: 0 });
  const stats: Record<string, Record<string, Cell>> = {};
  const overs: Record<string, { over: number; n: number }> = {};
  /** Per series: did same-side pairs beat what independence predicts? */
  const seriesConcordance: Record<string, { up: number; down: number }> = {};
  /**
   * Per-series pair tallies, kept so significance can be done by CLUSTER
   * BOOTSTRAP rather than by a sign test.
   *
   * The sign test asks only "did this series have more agreement than
   * disagreement", which throws away magnitude and is close to powerless here.
   * Under a shared-factor model a series with the factor near zero lands at
   * about 50% agreement whatever the correlation, so half the series carry no
   * sign at all even when the effect is large and real. Resampling whole series
   * keeps the magnitude and still respects the fact that pairs inside a series
   * are not independent observations.
   */
  const seriesPairs: Record<string, { both: number; neither: number; n: number }[]> = {};

  for (const [sk, players] of perSeries) {
    const league = sk.split('|')[0]!;
    stats[league] ??= { teammate: cell(), opponent: cell() };
    overs[league] ??= { over: 0, n: 0 };
    seriesConcordance[league] ??= { up: 0, down: 0 };

    const scored: { handle: string; team: string | null; over: boolean }[] = [];
    for (const [handle, ps] of players) {
      const line = lineBefore(league, handle, ps.at);
      if (line === null) continue;
      if (ps.total === line) continue;           // impossible at a half-point
      scored.push({ handle, team: ps.team, over: ps.total > line });
      overs[league]!.over += ps.total > line ? 1 : 0;
      overs[league]!.n++;
    }
    if (scored.length < 2) continue;

    let concordant = 0, pairs = 0;
    const tally = { both: 0, neither: 0, n: 0 };
    for (let i = 0; i < scored.length; i++) {
      for (let j = i + 1; j < scored.length; j++) {
        const a = scored[i]!, b = scored[j]!;
        const kind = a.team && b.team && a.team === b.team ? 'teammate' : 'opponent';
        const c = stats[league]![kind]!;
        c.n++;
        if (a.over && b.over) c.both++;
        else if (!a.over && !b.over) c.neither++;
        else c.split++;
        // Teammate pairs only: that is where the effect lives, and it is the
        // stack a lineup can actually be built from.
        if (kind === 'teammate') {
          tally.n++;
          if (a.over && b.over) tally.both++;
          else if (!a.over && !b.over) tally.neither++;
        }
        if (a.over === b.over) concordant++;
        pairs++;
      }
    }
    // A series counts once. Under independence a little over half of pairs
    // agree by chance (exactly half when the marginal is 50%), so "more
    // agreement than disagreement" is the per-series sign.
    if (pairs > 0) {
      if (concordant * 2 > pairs) seriesConcordance[league]!.up++;
      else if (concordant * 2 < pairs) seriesConcordance[league]!.down++;
    }
    if (tally.n > 0) {
      seriesPairs[league] ??= [];
      seriesPairs[league]!.push(tally);
    }
  }

  for (const league of Object.keys(stats).sort()) {
    const o = overs[league]!;
    const p = o.over / o.n;
    console.log(`\n===== ${league} =====`);
    console.log(`player-series scored: ${o.n}, over rate ${(p * 100).toFixed(2)}%`);
    console.log(`  (a line at prior median + 0.5 makes the over the harder side, so this sits under 50%)`);

    for (const kind of ['teammate', 'opponent'] as const) {
      const c = stats[league]![kind]!;
      if (c.n === 0) { console.log(`\n  ${kind}: no pairs`); continue; }
      // Independence uses the observed marginal, not 0.5 — comparing against
      // 0.5 would report the line convention as if it were correlation.
      const expBoth = p * p, expNeither = (1 - p) * (1 - p);
      const obsBoth = c.both / c.n, obsNeither = c.neither / c.n;
      const lift = obsBoth / expBoth;
      console.log(`\n  ${kind} pairs: ${c.n}`);
      console.log(`    both over    observed ${(obsBoth * 100).toFixed(2)}%  independence ${(expBoth * 100).toFixed(2)}%  lift ${lift.toFixed(3)}`);
      console.log(`    both under   observed ${(obsNeither * 100).toFixed(2)}%  independence ${(expNeither * 100).toFixed(2)}%  lift ${(obsNeither / expNeither).toFixed(3)}`);
      console.log(`    split        observed ${((c.split / c.n) * 100).toFixed(2)}%  independence ${((2 * p * (1 - p)) * 100).toFixed(2)}%`);
      // Phi coefficient: the correlation of the two binary outcomes.
      const phi = (obsBoth - expBoth) / Math.sqrt(p * (1 - p) * p * (1 - p));
      console.log(`    phi ${phi.toFixed(4)}   (the copula rho is a little above this)`);
    }

    const sc = seriesConcordance[league]!;
    const nSeries = sc.up + sc.down;
    console.log(`\n  INDEPENDENT SERIES: ${nSeries}`);
    console.log(`  series with more agreement than disagreement: ${sc.up}-${sc.down}`);
    console.log(`  sign test (low power, see below): p = ${signTest(sc.up, nSeries).toFixed(4)}`);

    // Cluster bootstrap on teammate phi, resampling whole series.
    const sp = seriesPairs[league] ?? [];
    if (sp.length >= 30) {
      const phiOf = (sample: typeof sp): number => {
        let both = 0, neither = 0, n = 0;
        for (const t of sample) { both += t.both; neither += t.neither; n += t.n; }
        if (n === 0) return NaN;
        const ob = both / n;
        // Recover the marginal implied by this resample so the baseline moves
        // with it rather than being held fixed at the full-sample value.
        const oq = neither / n;
        const pm = (1 + ob - oq) / 2;
        const denom = pm * (1 - pm);
        return denom > 0 ? (ob - pm * pm) / denom : NaN;
      };
      const point = phiOf(sp);
      // mulberry32. The obvious LCG — `seed * 1103515245 + 12345` — is broken
      // in JavaScript: that product runs past 2^53, so the multiply is inexact,
      // the sequence degenerates, and the first run of this bootstrap returned
      // a 95% CI sitting entirely ABOVE its own point estimate. That is
      // impossible when the resampling is sound, and it is the tell.
      let seed = 987654321 >>> 0;
      const rnd = () => {
        seed = (seed + 0x6D2B79F5) >>> 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const draws: number[] = [];
      for (let b = 0; b < 2000; b++) {
        const sample = new Array(sp.length);
        for (let i = 0; i < sp.length; i++) sample[i] = sp[Math.floor(rnd() * sp.length)]!;
        const v = phiOf(sample);
        if (Number.isFinite(v)) draws.push(v);
      }
      draws.sort((a, b) => a - b);
      const lo = draws[Math.floor(0.025 * draws.length)]!;
      const hi = draws[Math.floor(0.975 * draws.length)]!;
      const below = draws.filter((v) => v <= 0).length / draws.length;
      console.log(`\n  CLUSTER BOOTSTRAP on teammate phi (2000 resamples of ${sp.length} whole series)`);
      console.log(`    point estimate  phi = ${point.toFixed(4)}`);
      console.log(`    95% CI          [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
      console.log(`    share of resamples at or below zero: ${(below * 100).toFixed(2)}%`);
      console.log(`    -> correlation is ${lo > 0 ? 'REAL at series level' : 'NOT established at series level'}`);
    }

    console.log(
      `\n  Why two tests: the sign test only asks whether a series had more\n` +
      `  agreement than disagreement, which discards magnitude. Under a shared\n` +
      `  factor a series whose factor sits near zero lands at about 50% whatever\n` +
      `  the correlation, so half the series carry no sign even when the effect\n` +
      `  is large. The bootstrap resamples whole series, so it respects the same\n` +
      `  independence structure without throwing the magnitude away.`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
