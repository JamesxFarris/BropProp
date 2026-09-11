import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { normCdf, normInv, probAllWin } from '../web/slip.js';

/**
 * The opponent leg of a stack, measured in the tail — where the Gaussian model
 * is weakest.
 *
 * `slip.ts` models co-movement with two Gaussian factors fitted to PAIRS:
 * teammates at rho 0.324, opponents at 0.086. Pairs are the body of the
 * distribution. A stack is a tail event: five teammates ALL over, then one
 * opponent. On 2026-09-11 the books' own closing lines showed the opponent
 * following a five-over core 88% of the time, where the model says about 56%.
 *
 * This measures it across the whole CS2 archive, with no book lines needed:
 * each player's line is the median of his PRIOR series plus 0.5 (the same
 * walk-forward construction as `validate_correlation`), over maps 1-2 kills.
 * For every series and every core size k it asks, over all k-subsets of one
 * team and every player on the other:
 *
 *   P(B over  | A's k all over)     and     P(B under | A's k all under)
 *
 * Each is turned into a PROBIT SHIFT against the opponent's base rate:
 *
 *   shift = Φ⁻¹(P(B side | core)) − Φ⁻¹(P(B side))
 *
 * so it can be applied to a partner leg at any price: P = Φ(Φ⁻¹(p) + shift).
 * The model's own implied shift is printed alongside, and the gap between the
 * two is what the model misses. Significance is a bootstrap over whole series.
 *
 *   npm run validate:tail
 */

const MIN_PRIOR = 8;

type Row = {
  series_key: string; canon_handle: string; team: string | null;
  map_number: number; kills: number | null; played_at: string;
};

function combos<T>(arr: T[], k: number, start = 0, cur: T[] = [], out: T[][] = []): T[][] {
  if (cur.length === k) { out.push(cur.slice()); return out; }
  for (let i = start; i < arr.length; i++) { cur.push(arr[i]!); combos(arr, k, i + 1, cur, out); cur.pop(); }
  return out;
}

export async function main(): Promise<void> {
  const rows = await q<Row>(`
    SELECT series_key, canon_handle, team, map_number, kills,
           extract(epoch from played_at) * 1000 AS played_at
      FROM map_stat_dedup
     WHERE league = 'CS2' AND kills IS NOT NULL AND played_at IS NOT NULL
       AND team IS NOT NULL AND map_number IN (1, 2)`);
  console.log(`loaded ${rows.length} player-maps`);

  // One maps 1-2 total per player per series, only where both maps were played.
  const acc = new Map<string, { sum: number; maps: number; at: number; team: string }>();
  for (const r of rows) {
    const key = `${r.series_key}|${r.canon_handle}`;
    const a = acc.get(key) ?? { sum: 0, maps: 0, at: Number(r.played_at), team: r.team! };
    a.sum += Number(r.kills); a.maps++; a.at = Math.max(a.at, Number(r.played_at));
    acc.set(key, a);
  }
  const perSeries = new Map<string, { handle: string; total: number; team: string; at: number }[]>();
  const history = new Map<string, { at: number; total: number; sk: string }[]>();
  for (const [key, a] of acc) {
    if (a.maps !== 2) continue;
    const [sk, handle] = key.split('|') as [string, string];
    (perSeries.get(sk) ?? perSeries.set(sk, []).get(sk)!).push({ handle, total: a.sum, team: a.team, at: a.at });
    (history.get(handle) ?? history.set(handle, []).get(handle)!).push({ at: a.at, total: a.sum, sk });
  }

  // The walk-forward line, once per player in time order.
  const lineOf = new Map<string, number>();
  for (const [handle, h] of history) {
    h.sort((x, y) => x.at - y.at);
    const prior: number[] = [];
    for (const x of h) {
      if (prior.length >= MIN_PRIOR) {
        const s = [...prior].sort((a, b) => a - b), m = s.length >> 1;
        lineOf.set(`${x.sk}|${handle}`, (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) + 0.5);
      }
      prior.push(x.total);
    }
  }

  const scored: { teams: boolean[][]; at: number }[] = [];
  for (const [sk, ps] of perSeries) {
    const teams = new Map<string, boolean[]>();
    let at = 0;
    for (const p of ps) {
      const line = lineOf.get(`${sk}|${p.handle}`);
      if (line === undefined || p.total === line) continue;
      (teams.get(p.team) ?? teams.set(p.team, []).get(p.team)!).push(p.total > line);
      at = p.at;
    }
    if (teams.size === 2) scored.push({ teams: [...teams.values()], at });
  }
  console.log(`series with two scored teams: ${scored.length}\n`);

  // mulberry32 — see validate_correlation for why not an LCG.
  let seed = 424242 >>> 0;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  type S = { oo: number; uu: number; aO: number; aU: number; bO: number; at: number };
  const mean = (xs: S[], f: (x: S) => number) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
  const shiftsOf = (xs: S[]) => {
    const bO = mean(xs, (x) => x.bO);
    return {
      over: normInv(mean(xs, (x) => x.oo) / mean(xs, (x) => x.aO)) - normInv(bO),
      under: normInv(mean(xs, (x) => x.uu) / mean(xs, (x) => x.aU)) - normInv(1 - bO),
      bO,
    };
  };

  const table = { over: [0], under: [0] };
  for (const k of [1, 2, 3, 4, 5]) {
    const series: S[] = [];
    for (const s of scored) {
      let oo = 0, uu = 0, aO = 0, aU = 0, bO = 0, cnt = 0;
      const orders: [boolean[], boolean[]][] = [[s.teams[0]!, s.teams[1]!], [s.teams[1]!, s.teams[0]!]];
      for (const [A, B] of orders) {
        if (A.length < k || B.length < 1) continue;
        let m = 0, xoo = 0, xuu = 0, xaO = 0, xaU = 0;
        for (const core of combos(A, k)) for (const b of B) {
          m++;
          if (core.every(Boolean)) { xaO++; if (b) xoo++; }
          if (core.every((v) => !v)) { xaU++; if (!b) xuu++; }
        }
        oo += xoo / m; uu += xuu / m; aO += xaO / m; aU += xaU / m;
        bO += B.filter(Boolean).length / B.length; cnt++;
      }
      if (cnt) series.push({ oo: oo / cnt, uu: uu / cnt, aO: aO / cnt, aU: aU / cnt, bO: bO / cnt, at: s.at });
    }
    const pt = shiftsOf(series);
    const draws = { over: [] as number[], under: [] as number[], gap: [] as number[] };
    for (let r = 0; r < 2000; r++) {
      const smp = Array.from({ length: series.length }, () => series[Math.floor(rnd() * series.length)]!);
      const d = shiftsOf(smp);
      draws.over.push(d.over); draws.under.push(d.under); draws.gap.push(d.over - d.under);
    }
    for (const a of Object.values(draws)) a.sort((x, y) => x - y);
    const ci = (a: number[]) => `[${a[50]!.toFixed(3)}, ${a[1949]!.toFixed(3)}]`;

    // What the Gaussian model itself implies for the same shape at the same base.
    const leg = (p: number, team: string, side: 'over' | 'under') => ({ p, matchKey: 'M', side, team });
    const modelShift = (p: number, side: 'over' | 'under') => {
      const core = Array.from({ length: k }, () => leg(p, 'A', side));
      return normInv(probAllWin([...core, leg(p, 'B', side)]) / probAllWin(core)) - normInv(p);
    };

    const byHalf = new Map<string, S[]>();
    for (const x of series) {
      const d = new Date(x.at);
      const key = `${d.getUTCFullYear()}${d.getUTCMonth() < 6 ? 'H1' : 'H2'}`;
      (byHalf.get(key) ?? byHalf.set(key, []).get(key)!).push(x);
    }
    const halves = [...byHalf.keys()].sort().map((h) => {
      const d = shiftsOf(byHalf.get(h)!);
      return `${h} ${d.over.toFixed(2)}/${d.under.toFixed(2)}`;
    }).join('  ');

    console.log(`core ${k} + 1 opponent — ${series.length} series, opponent base over ${(pt.bO * 100).toFixed(1)}%`);
    console.log(`  over : P(B over | core over)   ${normCdf(normInv(pt.bO) + pt.over).toFixed(3)}  shift ${pt.over.toFixed(3)} CI ${ci(draws.over)}  model ${modelShift(pt.bO, 'over').toFixed(3)}`);
    console.log(`  under: P(B under | core under) ${normCdf(normInv(1 - pt.bO) + pt.under).toFixed(3)}  shift ${pt.under.toFixed(3)} CI ${ci(draws.under)}  model ${modelShift(1 - pt.bO, 'under').toFixed(3)}`);
    console.log(`  over minus under: CI ${ci(draws.gap)}   by half (over/under): ${halves}\n`);
    table.over.push(Number(pt.over.toFixed(3)));
    table.under.push(Number(pt.under.toFixed(3)));
  }
  console.log(`PARTNER_SHIFT = { over: [${table.over.join(', ')}], under: [${table.under.join(', ')}] }`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
