import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { normCdf, normInv, probAllWin } from '../web/slip.js';

/**
 * Refit BOTH correlation constants against the scatter null, in one pass.
 *
 * `RHO_TEAMMATE` and `PARTNER_SHIFT` were fitted on walk-forward lines, and a
 * walk-forward line lags a player in form. When a team is running hot, all five
 * beat a stale number together whether or not they share a game — drift, not
 * correlation. The drift placebo (CLAUDE.md) put that at ~15% of teammate phi
 * and 16% of the five-core lift. A book re-sets its lines, so drift that lives
 * in the stand-in line is not something a real stack gets paid for.
 *
 * Two arms, same lines, same series:
 *
 *   REAL     every flag from the series itself
 *   SCATTER  each player's flag from a DIFFERENT nearby series of the same team,
 *            no two players sharing one — team, roster and era kept, game gone
 *
 * The same-game part is REAL minus SCATTER: in phi for pairs, in probit shift
 * for the opponent tail. Each is an additive approximation on its own natural
 * scale, and both constants are corrected by the same construction in the same
 * change, so the model stays internally consistent — lowering rho alone would
 * have left the tail overstated.
 *
 * The trap this avoids (it was hit once): drawing all five scattered flags from
 * ONE other game preserves a shared game and calls it drift. Here every player
 * is drawn from his own series, and no series is used twice within a group.
 *
 *   npm run validate:drift
 */

const MIN_PRIOR = 8;
/**
 * "Nearby": within this many of the team's own series either side. Drift is
 * local in time, so a wide window dilutes it — run `--window=1` and `--window=2`
 * before trusting a small drift share.
 */
const WINDOW = Number(process.argv.find((a) => a.startsWith('--window='))?.slice(9) ?? 10);
/** Scatter draws per series, averaged, so one unlucky draw does not set a constant. */
const REPS = 4;
const BOOT = 1000;

type Row = { series_key: string; canon_handle: string; team: string | null; map_number: number; kills: number | null; played_at: string };
type Pairs = { both: number; neither: number; n: number };
type Tail = { oo: number; uu: number; aO: number; aU: number; bO: number };
type Rec = { tm: [Pairs, Pairs]; op: [Pairs, Pairs]; tail: Array<[Tail | null, Tail | null]>; at: number };

function combos<T>(arr: T[], k: number, start = 0, cur: T[] = [], out: T[][] = []): T[][] {
  if (cur.length === k) { out.push(cur.slice()); return out; }
  for (let i = start; i < arr.length; i++) { cur.push(arr[i]!); combos(arr, k, i + 1, cur, out); cur.pop(); }
  return out;
}

const pairs = (): Pairs => ({ both: 0, neither: 0, n: 0 });

function pairTallies(teams: boolean[][]): { tm: Pairs; op: Pairs } {
  const tm = pairs(), op = pairs();
  const add = (t: Pairs, a: boolean, b: boolean) => { t.n++; if (a && b) t.both++; else if (!a && !b) t.neither++; };
  for (const T of teams) for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) add(tm, T[i]!, T[j]!);
  if (teams.length === 2) for (const a of teams[0]!) for (const b of teams[1]!) add(op, a, b);
  return { tm, op };
}

/** validate_tail's per-series statistic for one core size. */
function tailOf(teams: boolean[][], k: number): Tail | null {
  if (teams.length !== 2) return null;
  let oo = 0, uu = 0, aO = 0, aU = 0, bO = 0, cnt = 0;
  for (const [A, B] of [[teams[0]!, teams[1]!], [teams[1]!, teams[0]!]] as const) {
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
  return cnt ? { oo: oo / cnt, uu: uu / cnt, aO: aO / cnt, aU: aU / cnt, bO: bO / cnt } : null;
}

/** phi with the marginal implied by the tallies themselves (validate_correlation's bootstrap form). */
function phiOf(t: Pairs): number {
  if (!t.n) return NaN;
  const ob = t.both / t.n, oq = t.neither / t.n, pm = (1 + ob - oq) / 2, d = pm * (1 - pm);
  return d > 0 ? (ob - pm * pm) / d : NaN;
}

function shiftsOf(xs: Tail[]) {
  const mean = (f: (x: Tail) => number) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
  const bO = mean((x) => x.bO);
  return {
    over: normInv(mean((x) => x.oo) / mean((x) => x.aO)) - normInv(bO),
    under: normInv(mean((x) => x.uu) / mean((x) => x.aU)) - normInv(1 - bO),
    coreOver: mean((x) => x.aO),
    bO,
  };
}

export async function main(): Promise<void> {
  const rows = await q<Row>(`
    SELECT series_key, canon_handle, team, map_number, kills,
           extract(epoch from played_at) * 1000 AS played_at
      FROM map_stat_dedup
     WHERE league = 'CS2' AND kills IS NOT NULL AND played_at IS NOT NULL
       AND team IS NOT NULL AND map_number IN (1, 2)`);
  console.log(`loaded ${rows.length} player-maps`);

  // Same construction as validate_tail: maps 1-2 kills, both maps played.
  const acc = new Map<string, { sum: number; maps: number; at: number; team: string }>();
  for (const r of rows) {
    const key = `${r.series_key}|${r.canon_handle}`;
    const a = acc.get(key) ?? { sum: 0, maps: 0, at: Number(r.played_at), team: r.team! };
    a.sum += Number(r.kills); a.maps++; a.at = Math.max(a.at, Number(r.played_at));
    acc.set(key, a);
  }
  rows.length = 0;
  const history = new Map<string, { at: number; total: number; sk: string }[]>();
  const players = new Map<string, { handle: string; total: number; team: string; at: number }[]>();
  for (const [key, a] of acc) {
    if (a.maps !== 2) continue;
    const [sk, handle] = key.split('|') as [string, string];
    (players.get(sk) ?? players.set(sk, []).get(sk)!).push({ handle, total: a.sum, team: a.team, at: a.at });
    (history.get(handle) ?? history.set(handle, []).get(handle)!).push({ at: a.at, total: a.sum, sk });
  }
  const flag = new Map<string, boolean>();   // `${sk}|${handle}` -> over its walk-forward line
  for (const [handle, h] of history) {
    h.sort((x, y) => x.at - y.at);
    const prior: number[] = [];
    for (const x of h) {
      if (prior.length >= MIN_PRIOR) {
        const s = [...prior].sort((a, b) => a - b), m = s.length >> 1;
        const line = (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) + 0.5;
        if (x.total !== line) flag.set(`${x.sk}|${handle}`, x.total > line);
      }
      prior.push(x.total);
    }
  }

  // Real series with two scored teams, and each team's series in time order.
  type Series = { sk: string; at: number; teams: { team: string; handles: string[] }[] };
  const all: Series[] = [];
  const teamSeries = new Map<string, { sk: string; at: number }[]>();
  for (const [sk, ps] of players) {
    const byTeam = new Map<string, string[]>();
    let at = 0;
    for (const p of ps) {
      if (!flag.has(`${sk}|${p.handle}`)) continue;
      (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(p.handle);
      at = Math.max(at, p.at);
    }
    if (byTeam.size !== 2) continue;
    all.push({ sk, at, teams: [...byTeam].map(([team, handles]) => ({ team, handles })) });
    for (const team of byTeam.keys()) (teamSeries.get(team) ?? teamSeries.set(team, []).get(team)!).push({ sk, at });
  }
  const posOf = new Map<string, number>();   // `${team}|${sk}` -> index in the team's series
  for (const [team, list] of teamSeries) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((x, i) => posOf.set(`${team}|${x.sk}`, i));
  }
  console.log(`series with two scored teams: ${all.length}`);

  let seed = 20260913 >>> 0;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Each player's flag from his own different nearby series of the same team. */
  function scatter(s: Series): boolean[][] {
    const used = new Set<string>([s.sk]);
    return s.teams.map(({ team, handles }) => {
      const list = teamSeries.get(team)!, i = posOf.get(`${team}|${s.sk}`)!;
      const out: boolean[] = [];
      for (const h of handles) {
        const cands: string[] = [];
        for (let j = Math.max(0, i - WINDOW); j <= Math.min(list.length - 1, i + WINDOW); j++) {
          const sk = list[j]!.sk;
          if (!used.has(sk) && flag.has(`${sk}|${h}`)) cands.push(sk);
        }
        if (!cands.length) continue;
        const pick = cands[Math.floor(rnd() * cands.length)]!;
        used.add(pick);
        out.push(flag.get(`${pick}|${h}`)!);
      }
      return out;
    });
  }

  const avgTail = (xs: Array<Tail | null>): Tail | null => {
    const ok = xs.filter((x): x is Tail => x !== null);
    if (!ok.length) return null;
    const m = (f: (x: Tail) => number) => ok.reduce((a, x) => a + f(x), 0) / ok.length;
    return { oo: m((x) => x.oo), uu: m((x) => x.uu), aO: m((x) => x.aO), aU: m((x) => x.aU), bO: m((x) => x.bO) };
  };

  const recs: Rec[] = [];
  for (const s of all) {
    const real = s.teams.map(({ handles }) => handles.map((h) => flag.get(`${s.sk}|${h}`)!));
    const rp = pairTallies(real);
    const sp = { tm: pairs(), op: pairs() };
    const draws = Array.from({ length: REPS }, () => scatter(s));
    for (const d of draws) {
      const t = pairTallies(d);
      for (const f of ['both', 'neither', 'n'] as const) { sp.tm[f] += t.tm[f] / REPS; sp.op[f] += t.op[f] / REPS; }
    }
    const tail: Rec['tail'] = [];
    for (let k = 1; k <= 5; k++) tail[k] = [tailOf(real, k), avgTail(draws.map((d) => tailOf(d, k)))];
    recs.push({ tm: [rp.tm, sp.tm], op: [rp.op, sp.op], tail, at: s.at });
  }

  /** Every same-game quantity from a set of series records. */
  function fit(xs: Rec[]) {
    const sum = (arm: 0 | 1, kind: 'tm' | 'op'): Pairs =>
      xs.reduce((a, r) => ({ both: a.both + r[kind][arm].both, neither: a.neither + r[kind][arm].neither, n: a.n + r[kind][arm].n }), pairs());
    const phi = {
      tmReal: phiOf(sum(0, 'tm')), tmScat: phiOf(sum(1, 'tm')),
      opReal: phiOf(sum(0, 'op')), opScat: phiOf(sum(1, 'op')),
    };
    const tail: Array<{ real: ReturnType<typeof shiftsOf>; scat: ReturnType<typeof shiftsOf>; n: number }> = [];
    for (let k = 1; k <= 5; k++) {
      // Paired: only series that yield the shape in BOTH arms.
      const both = xs.filter((r) => r.tail[k]![0] && r.tail[k]![1]);
      tail[k] = { real: shiftsOf(both.map((r) => r.tail[k]![0]!)), scat: shiftsOf(both.map((r) => r.tail[k]![1]!)), n: both.length };
    }
    return { phi, tail };
  }

  const pt = fit(recs);
  const boot: ReturnType<typeof fit>[] = [];
  for (let b = 0; b < BOOT; b++) boot.push(fit(Array.from({ length: recs.length }, () => recs[Math.floor(rnd() * recs.length)]!)));
  const ci = (f: (x: ReturnType<typeof fit>) => number) => {
    const v = boot.map(f).filter(Number.isFinite).sort((a, b) => a - b);
    return `[${v[Math.floor(0.025 * v.length)]!.toFixed(3)}, ${v[Math.floor(0.975 * v.length)]!.toFixed(3)}]`;
  };
  const rho = (phi: number) => Math.sin(Math.PI * phi / 2);

  const { phi } = pt;
  console.log(`\n=== PAIRS (phi; copula rho = sin(pi*phi/2)) ===`);
  console.log(`teammate  REAL ${phi.tmReal.toFixed(4)}  SCATTER ${phi.tmScat.toFixed(4)}  same-game ${(phi.tmReal - phi.tmScat).toFixed(4)} CI ${ci((x) => x.phi.tmReal - x.phi.tmScat)}  -> rho ${rho(phi.tmReal - phi.tmScat).toFixed(3)} (was ${rho(0.210).toFixed(3)})`);
  console.log(`opponent  REAL ${phi.opReal.toFixed(4)}  SCATTER ${phi.opScat.toFixed(4)}  same-game ${(phi.opReal - phi.opScat).toFixed(4)} CI ${ci((x) => x.phi.opReal - x.phi.opScat)}  -> rho ${rho(phi.opReal - phi.opScat).toFixed(3)} (was ${rho(0.055).toFixed(3)})`);
  console.log(`drift share of teammate phi: ${(100 * phi.tmScat / phi.tmReal).toFixed(1)}%`);

  const rhoNew = rho(phi.tmReal - phi.tmScat);
  const table = { over: [0], under: [0] };
  console.log(`\n=== OPPONENT TAIL (probit shift; same-game = REAL - SCATTER) ===`);
  for (let k = 1; k <= 5; k++) {
    const t = pt.tail[k]!;
    // A narrow window runs out of distinct nearby series for big cores.
    if (t.n === 0) { console.log(`core ${k}: no series with a scattered core this size at --window=${WINDOW}`); continue; }
    const over = t.real.over - t.scat.over, under = t.real.under - t.scat.under;
    table.over.push(Number(over.toFixed(3)));
    table.under.push(Number(under.toFixed(3)));
    console.log(`core ${k} (${t.n} series, opp base over ${(100 * t.real.bO).toFixed(1)}%)`);
    console.log(`  over : REAL ${t.real.over.toFixed(3)}  SCATTER ${t.scat.over.toFixed(3)}  same-game ${over.toFixed(3)} CI ${ci((x) => x.tail[k]!.real.over - x.tail[k]!.scat.over)}  -> P ${normCdf(normInv(t.real.bO) + over).toFixed(3)}`);
    console.log(`  under: REAL ${t.real.under.toFixed(3)}  SCATTER ${t.scat.under.toFixed(3)}  same-game ${under.toFixed(3)} CI ${ci((x) => x.tail[k]!.real.under - x.tail[k]!.scat.under)}  -> P ${normCdf(normInv(1 - t.real.bO) + under).toFixed(3)}`);
    // The core itself: realised all-over rate per arm, against the model at the old and new rho.
    const p = t.real.bO, legs = Array.from({ length: k }, () => ({ p, matchKey: 'M', side: 'over' as const, team: 'A' }));
    console.log(`  core all-over: REAL ${(100 * t.real.coreOver).toFixed(2)}%  SCATTER ${(100 * t.scat.coreOver).toFixed(2)}%  indep ${(100 * p ** k).toFixed(2)}%  ` +
      `model rho ${rho(0.210).toFixed(3)} ${(100 * probAllWin(legs, rho(0.210))).toFixed(2)}%  rho ${rhoNew.toFixed(3)} ${(100 * probAllWin(legs, rhoNew)).toFixed(2)}%`);
  }

  console.log(`\nfitted: TEAMMATE phi ${(phi.tmReal - phi.tmScat).toFixed(3)}, OPPONENT phi ${(phi.opReal - phi.opScat).toFixed(3)}`);
  console.log(`PARTNER_SHIFT = { over: [${table.over.join(', ')}], under: [${table.under.join(', ')}] }`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
