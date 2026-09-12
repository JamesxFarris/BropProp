import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { clusterBootstrap, type Pred } from './referee.js';
import { normInv } from '../web/slip.js';

/**
 * Is a market worth stacking? The same measurement kills and headshots had to
 * pass, run for any stat the apps actually list.
 *
 * The stack edge is not a forecast. It is the gap between how correlated
 * teammates' results are and how flat the payout ladder is, so a new market
 * only belongs in the builder once its correlation has been measured on its
 * own data. Kills and headshots were measured; `MARKET_STATS` has refused
 * everything else since a screenshot caught "under deaths" on a losing team —
 * a beaten team dies MORE, so the same reasoning that works for kills points
 * backwards for deaths.
 *
 * What this prints, per (league, stat, map range), all on walk-forward lines
 * (the median of the player's PRIOR series over the range, + 0.5, needing 8
 * prior series — no book lines exist historically):
 *
 *  - the base over rate, so the line convention is visible;
 *  - teammate and opponent pair agreement (phi), the body of the distribution;
 *  - the TAIL: after k teammates all land the same side, how often the next
 *    teammate and an opponent follow. This is what `slip.ts` prices a stack
 *    from, and it is where kills turned out to be far stronger than the
 *    pair-fitted copula implied;
 *  - the shape itself: how often k same-team legs plus one opponent leg all
 *    land, against the 3/5/6-pick break-evens.
 *
 * Every interval is a cluster bootstrap over whole series; the series is the
 * unit of evidence, never the leg.
 *
 *   npm run validate:market -- --league=LOL --stat=assists --maps=1-3
 */

const MIN_PRIOR = 8;
type Row = {
  league: string; series_key: string; canon_handle: string; team: string | null;
  map_number: number; v: number | null; played_at: string;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');

function combos<T>(arr: T[], k: number, start = 0, cur: T[] = [], out: T[][] = []): T[][] {
  if (cur.length === k) { out.push(cur.slice()); return out; }
  for (let i = start; i < arr.length; i++) { cur.push(arr[i]!); combos(arr, k, i + 1, cur, out); cur.pop(); }
  return out;
}

export async function main(opts: { league?: string; stat?: string; maps?: string } = {}): Promise<void> {
  const league = (opts.league ?? 'LOL').toUpperCase();
  const stat = (opts.stat ?? 'assists').toLowerCase();
  const [ms, me] = (opts.maps ?? '1-3').split('-').map(Number) as [number, number];
  const COL: Record<string, string> = { kills: 'kills', assists: 'assists', headshots: 'headshots', deaths: 'deaths' };
  const col = COL[stat];
  if (!col) throw new Error(`no stat column for "${stat}"`);

  console.log(`\n=== ${league} ${stat}, maps ${ms}-${me} — walk-forward lines (prior median + 0.5, >= ${MIN_PRIOR} prior) ===`);
  const rows = await q<Row>(
    `SELECT league, series_key, canon_handle, team, map_number, ${col} AS v,
            extract(epoch from played_at) * 1000 AS played_at
       FROM map_stat_dedup
      WHERE league = $1 AND ${col} IS NOT NULL AND played_at IS NOT NULL AND team IS NOT NULL
        AND map_number BETWEEN $2 AND $3`,
    [league, ms, me],
  );
  console.log(`loaded ${rows.length} player-maps`);

  // One range total per player per series, only where the whole range was played.
  const want = me - ms + 1;
  const acc = new Map<string, { sum: number; maps: number; at: number; team: string }>();
  for (const r of rows) {
    const key = `${r.series_key}|${r.canon_handle}`;
    const a = acc.get(key) ?? { sum: 0, maps: 0, at: Number(r.played_at), team: r.team! };
    a.sum += Number(r.v); a.maps++; a.at = Math.max(a.at, Number(r.played_at));
    acc.set(key, a);
  }
  const perSeries = new Map<string, { handle: string; total: number; team: string; at: number }[]>();
  const history = new Map<string, { at: number; total: number; sk: string }[]>();
  for (const [key, a] of acc) {
    if (a.maps !== want) continue;
    const [sk, handle] = key.split('|') as [string, string];
    (perSeries.get(sk) ?? perSeries.set(sk, []).get(sk)!).push({ handle, total: a.sum, team: a.team, at: a.at });
    (history.get(handle) ?? history.set(handle, []).get(handle)!).push({ at: a.at, total: a.sum, sk });
  }
  const lineOf = new Map<string, number>();
  for (const [handle, h] of history) {
    h.sort((x, y) => x.at - y.at);
    const prior: number[] = [];
    for (const x of h) {
      if (prior.length >= MIN_PRIOR) lineOf.set(`${x.sk}|${handle}`, median(prior) + 0.5);
      prior.push(x.total);
    }
  }

  // Score each series: who cleared their line, and on which team.
  const scored: { teams: boolean[][] }[] = [];
  let legs = 0, overs = 0;
  for (const [sk, ps] of perSeries) {
    const teams = new Map<string, boolean[]>();
    for (const p of ps) {
      const line = lineOf.get(`${sk}|${p.handle}`);
      if (line === undefined || p.total === line) continue;
      (teams.get(p.team) ?? teams.set(p.team, []).get(p.team)!).push(p.total > line);
      legs++; if (p.total > line) overs++;
    }
    if (teams.size === 2) scored.push({ teams: [...teams.values()] });
  }
  const base = overs / Math.max(1, legs);
  console.log(`series with two scored teams: ${scored.length}; leg over rate ${pct(base)} of ${legs}`);
  if (scored.length < 200) {
    console.log('too few series to judge this market — stop here.');
    return;
  }

  // Pair agreement, the body of the distribution.
  let tBoth = 0, tNeither = 0, tN = 0, oBoth = 0, oNeither = 0, oN = 0;
  for (const s of scored) {
    for (const side of [0, 1]) {
      const t = s.teams[side]!;
      for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
        tN++; if (t[i] && t[j]) tBoth++; else if (!t[i] && !t[j]) tNeither++;
      }
    }
    for (const a of s.teams[0]!) for (const b of s.teams[1]!) {
      oN++; if (a && b) oBoth++; else if (!a && !b) oNeither++;
    }
  }
  const phi = (both: number, n: number) => {
    const p = base, obs = both / n;
    return (obs - p * p) / (p * (1 - p));
  };
  console.log(`teammate pairs ${tN}: both over ${pct(tBoth / tN)} (independence ${pct(base * base)}), phi ${f3(phi(tBoth, tN))}`);
  console.log(`opponent pairs ${oN}: both over ${pct(oBoth / oN)} (independence ${pct(base * base)}), phi ${f3(phi(oBoth, oN))}`);

  // The tail: after k teammates land the same side, who follows?
  console.log(`\ncore  P(next teammate follows)   P(opponent follows)   series   (shift vs base)`);
  for (const k of [1, 2, 3, 4]) {
    const per: { mateW: number; mateN: number; oppW: number; oppN: number }[] = [];
    for (const s of scored) {
      let mateW = 0, mateN = 0, oppW = 0, oppN = 0;
      for (const [ai, bi] of [[0, 1], [1, 0]] as const) {
        const A = s.teams[ai]!, B = s.teams[bi]!;
        if (A.length < k + 1 && A.length < k) continue;
        for (const core of combos(A.map((_, i) => i), k)) {
          for (const dir of [true, false]) {
            if (!core.every((i) => A[i] === dir)) continue;
            for (let i = 0; i < A.length; i++) {
              if (core.includes(i)) continue;
              mateN++; if (A[i] === dir) mateW++;
            }
            for (const b of B) { oppN++; if (b === dir) oppW++; }
          }
        }
      }
      if (mateN + oppN > 0) per.push({ mateW, mateN, oppW, oppN });
    }
    if (per.length < 50) { console.log(`${k}   too thin`); continue; }
    const rate = (f: (x: typeof per[number]) => [number, number]) => (sample: Pred[]) => {
      let w = 0, n = 0;
      for (const x of sample as unknown as typeof per) { const [a, b] = f(x); w += a; n += b; }
      return n ? w / n : NaN;
    };
    const asPred = per.map((x, i) => ({ ...x, series: String(i), p: 0.5, won: false })) as unknown as Pred[];
    const mate = clusterBootstrap(asPred, rate((x) => [x.mateW, x.mateN]), 800);
    const opp = clusterBootstrap(asPred, rate((x) => [x.oppW, x.oppN]), 800);
    const shift = (v: number) => (Number.isFinite(v) ? (normInv(v) - normInv(0.5)).toFixed(3) : '—');
    console.log(`${k}     ${pct(mate.point)} [${pct(mate.lo)}, ${pct(mate.hi)}]        ${pct(opp.point)} [${pct(opp.lo)}, ${pct(opp.hi)}]      ${per.length}   mate ${shift(mate.point)} / opp ${shift(opp.point)}`);
  }

  // The shape that gets played: k on one team plus one opponent, all one side.
  // Both partner rules, because they are not the same bet. Where opponents
  // move together (CS2: everyone's kills rise with round count) the partner
  // belongs on the core's side. Where they move against each other (assists
  // are shared credit on kills, and kills are traded between the two teams)
  // the partner belongs on the opposite side, and taking the same side is the
  // worst leg on the board.
  console.log(`\nshape (k same-team, + 1 opponent)   same-side over  same-side under  OPPOSITE (core over, opp under)  OPPOSITE (core under, opp over)  series`);
  for (const k of [2, 4, 5]) {
    const per: { oo: number; uu: number; ou: number; uo: number; n: number }[] = [];
    for (const s of scored) {
      let oo = 0, uu = 0, ou = 0, uo = 0, n = 0;
      for (const [ai, bi] of [[0, 1], [1, 0]] as const) {
        const A = s.teams[ai]!, B = s.teams[bi]!;
        if (A.length < k || B.length < 1) continue;
        for (const core of combos(A, k)) for (const b of B) {
          n++;
          const allOver = core.every(Boolean), allUnder = core.every((v) => !v);
          if (allOver && b) oo++;
          if (allUnder && !b) uu++;
          if (allOver && !b) ou++;
          if (allUnder && b) uo++;
        }
      }
      if (n) per.push({ oo: oo / n, uu: uu / n, ou: ou / n, uo: uo / n, n });
    }
    if (per.length < 50) { console.log(`${k}+1   too thin`); continue; }
    const mean = (f: (x: typeof per[number]) => number) => (sample: Pred[]) => {
      const xs = sample as unknown as typeof per;
      return xs.reduce((a, x) => a + f(x), 0) / xs.length;
    };
    const asPred = per.map((x, i) => ({ ...x, series: String(i), p: 0.5, won: false })) as unknown as Pred[];
    const o = clusterBootstrap(asPred, mean((x) => x.oo), 800);
    const u = clusterBootstrap(asPred, mean((x) => x.uu), 800);
    const ou = clusterBootstrap(asPred, mean((x) => x.ou), 800);
    const uo = clusterBootstrap(asPred, mean((x) => x.uo), 800);
    const bar = k === 2 ? 1 / 6 : k === 4 ? 1 / 20 : 1 / 22;
    console.log(`${k}+1   ${pct(o.point)} [${pct(o.lo)}, ${pct(o.hi)}]   ${pct(u.point)} [${pct(u.lo)}, ${pct(u.hi)}]   ` +
      `${pct(ou.point)} [${pct(ou.lo)}, ${pct(ou.hi)}]   ${pct(uo.point)} [${pct(uo.lo)}, ${pct(uo.hi)}]   ${per.length}   bar ${pct(bar)}`);
  }
  console.log(`\n(bars: 3-pick 6x, 5-pick 20x, 6-pick 22x — the quoted correlated rate)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  main({ league: arg('league'), stat: arg('stat'), maps: arg('maps') })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
