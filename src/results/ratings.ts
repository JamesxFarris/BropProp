/**
 * Walk-forward team strength: a map-level Elo with the few extras esports
 * needs, and nothing that can see the future.
 *
 * Choices, and why:
 *
 *  - **Map-level updates.** A series is one to five maps; updating per map uses
 *    every result instead of collapsing a 2-1 into the same signal as a 2-0,
 *    and the per-map probability converts exactly to any best-of (`pSeries`).
 *  - **Optional margin of victory** (`movMultiplier`): a 13-2 map says more than
 *    a 13-11. Log-damped, and with FiveThirtyEight's autocorrelation correction
 *    so a favourite's routine blowouts do not inflate its rating without bound.
 *  - **Inactivity decay toward the mean** (`halfLifeDays`), applied lazily when a
 *    rating is read: a team that vanishes for six months, typically because the
 *    roster broke up, should not come back at its old strength.
 *  - **New-team prior** (`initial`) and a **provisional K boost** for a team's
 *    first maps, so a newcomer reaches its level quickly.
 *
 * Roster churn is handled only through decay and K: teams are keyed by name as
 * the source gives it, so a rebrand starts fresh and a team that keeps its name
 * through a full roster swap keeps its rating. That is the known limit.
 *
 * Pure: no database, no clock. `runElo` is the only way the study reads
 * ratings, and it records each series' pre-match numbers BEFORE applying that
 * series' maps — the leak guard is structural, and tested.
 */

export type EloConfig = {
  /** Base K per map. */
  k: number;
  /** 0 ignores the margin; 1 applies the full log-margin multiplier. */
  movWeight: number;
  /** Days for an idle team's rating to halve toward 0. Infinity = no decay. */
  halfLifeDays: number;
  /** Rating of a team never seen before (0 = an average established team). */
  initial: number;
  /** A team's first maps get a K boost that decays linearly to 1 over this many maps. */
  provisionalMaps: number;
  /** K multiplier on a team's very first map. */
  provisionalBoost: number;
  /** Logistic scale: a gap of `scale` is 10:1 odds per map. */
  scale: number;
};

export const ELO_DEFAULTS: EloConfig = {
  k: 32, movWeight: 0, halfLifeDays: Infinity, initial: 0,
  provisionalMaps: 10, provisionalBoost: 2, scale: 400,
};

const DAY = 86_400_000;

export const logistic = (x: number): number => 1 / (1 + Math.exp(-x));
export const logit = (p: number): number => {
  const c = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(c / (1 - c));
};

/** Expected map score for a rating gap (A minus B). */
export function expected(gap: number, scale = 400): number {
  return 1 / (1 + 10 ** (-gap / scale));
}

/**
 * Margin-of-victory multiplier. `diff` is the winner's margin (rounds in CS2,
 * kills in LoL); `typicalDiff` is the margin that should count as 1x;
 * `gap` is winner rating minus loser rating before the map.
 */
export function movMultiplier(diff: number, typicalDiff: number, gap: number, weight: number): number {
  if (weight === 0) return 1;
  const raw = Math.log(1 + Math.max(0, diff)) / Math.log(1 + typicalDiff);
  const ac = 2.2 / (Math.max(-400, gap) * 0.001 + 2.2);
  return Math.max(0.1, 1 + weight * (raw * ac - 1));
}

type TeamState = { r: number; at: number; maps: number };

export class Elo {
  private readonly teams = new Map<string, TeamState>();
  constructor(readonly cfg: EloConfig) {}

  /** Rating as of `at`, with decay applied but not stored. */
  rating(team: string, at: number): number {
    const s = this.teams.get(team);
    if (!s) return this.cfg.initial;
    const h = this.cfg.halfLifeDays;
    if (!Number.isFinite(h) || at <= s.at) return s.r;
    return s.r * 0.5 ** ((at - s.at) / DAY / h);
  }

  mapsPlayed(team: string): number { return this.teams.get(team)?.maps ?? 0; }

  pMap(a: string, b: string, at: number): number {
    return expected(this.rating(a, at) - this.rating(b, at), this.cfg.scale);
  }

  private kFor(team: string): number {
    const n = this.mapsPlayed(team);
    const { k, provisionalMaps: pm, provisionalBoost: pb } = this.cfg;
    return n < pm ? k * (1 + (pb - 1) * (1 - n / pm)) : k;
  }

  /** Apply one map: `mult` is the margin multiplier (1 without MOV). */
  update(winner: string, loser: string, at: number, mult = 1): void {
    const rw = this.rating(winner, at), rl = this.rating(loser, at);
    const e = expected(rw - rl, this.cfg.scale);
    const kw = this.kFor(winner), kl = this.kFor(loser);
    this.teams.set(winner, { r: rw + kw * mult * (1 - e), at, maps: this.mapsPlayed(winner) + 1 });
    this.teams.set(loser, { r: rl - kl * mult * (1 - e), at, maps: this.mapsPlayed(loser) + 1 });
  }
}

/** P(win a best-of-n) from a per-map probability, maps independent. NaN for even n. */
export function pSeries(pMap: number, bestOf: number): number {
  if (!Number.isInteger(bestOf) || bestOf < 1 || bestOf % 2 === 0) return NaN;
  const w = (bestOf + 1) / 2, q = 1 - pMap;
  let total = 0, c = 1; // c = C(w-1+j, j)
  for (let j = 0; j < w; j++) {
    if (j > 0) c = (c * (w - 1 + j)) / j;
    total += c * pMap ** w * q ** j;
  }
  return total;
}

/** P(exactly k map wins out of n), k = 0..n, maps independent. */
export function winsDistribution(pMap: number, n: number): number[] {
  const out: number[] = [];
  let c = 1;
  for (let k = 0; k <= n; k++) {
    if (k > 0) c = (c * (n - k + 1)) / k;
    out.push(c * pMap ** k * (1 - pMap) ** (n - k));
  }
  return out;
}

export type RatedSeries = {
  key: string;
  /** Series start, ms. Ordering key: everything strictly earlier is known. */
  at: number;
  a: string;
  b: string;
  /** Maps in play order: who won, and the winner's margin (for MOV). */
  maps: { winner: string; diff: number }[];
};

export type PreMatch = { rA: number; rB: number; pMapA: number; nA: number; nB: number };

export type Probe = { at: number; a: string; b: string };

/**
 * Walk the series in time order. Each series' pre-match numbers are recorded
 * from ratings built on strictly earlier series, and only then are its maps
 * applied. Probes (e.g. a Pinnacle fixture) are read at their own time.
 */
export function runElo(
  series: RatedSeries[], cfg: EloConfig, typicalDiff: number, probes: Probe[] = [],
): { pre: Map<string, PreMatch>; probes: PreMatch[]; elo: Elo } {
  const elo = new Elo(cfg);
  const sorted = [...series].sort((x, y) => x.at - y.at);
  const order = probes.map((p, i) => ({ p, i })).sort((x, y) => x.p.at - y.p.at);
  const probeOut: PreMatch[] = new Array(probes.length);
  const read = (a: string, b: string, at: number): PreMatch => ({
    rA: elo.rating(a, at), rB: elo.rating(b, at), pMapA: elo.pMap(a, b, at),
    nA: elo.mapsPlayed(a), nB: elo.mapsPlayed(b),
  });
  let pi = 0;
  const pre = new Map<string, PreMatch>();
  for (const s of sorted) {
    while (pi < order.length && order[pi]!.p.at <= s.at) {
      const { p, i } = order[pi++]!;
      probeOut[i] = read(p.a, p.b, p.at);
    }
    pre.set(s.key, read(s.a, s.b, s.at));
    for (const m of s.maps) {
      const loser = m.winner === s.a ? s.b : s.a;
      const gap = elo.rating(m.winner, s.at) - elo.rating(loser, s.at);
      elo.update(m.winner, loser, s.at, movMultiplier(m.diff, typicalDiff, gap, cfg.movWeight));
    }
  }
  while (pi < order.length) { const { p, i } = order[pi++]!; probeOut[i] = read(p.a, p.b, p.at); }
  return { pre, probes: probeOut, elo };
}

/**
 * One-parameter calibration: p' = logistic(t · logit(p)). Fit t by log loss
 * (golden section on [0.2, 3]). Fit on an early block, then frozen.
 */
export function fitTemperature(xs: { p: number; y: boolean }[]): number {
  const loss = (t: number) => {
    let s = 0;
    for (const x of xs) {
      const q = logistic(t * logit(x.p));
      s -= Math.log(x.y ? Math.max(1e-9, q) : Math.max(1e-9, 1 - q));
    }
    return s;
  };
  let lo = 0.2, hi = 3;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = hi - g * (hi - lo), d = lo + g * (hi - lo);
  for (let i = 0; i < 60; i++) {
    if (loss(c) < loss(d)) hi = d; else lo = c;
    c = hi - g * (hi - lo); d = lo + g * (hi - lo);
  }
  return (lo + hi) / 2;
}

/**
 * Logistic regression with a fixed offset: logit P = offset + β·x, no
 * intercept (features are centred by the caller). Newton's method on a small
 * dense system. Used to fit environment effects on the early block only.
 */
export function fitOffsetLogistic(rows: { offset: number; x: number[]; y: boolean }[], iters = 25, ridge = 1e-6): number[] {
  const d = rows[0]?.x.length ?? 0;
  const beta = new Array<number>(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array<number>(d).fill(0);
    const H = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (const r of rows) {
      let eta = r.offset;
      for (let j = 0; j < d; j++) eta += beta[j]! * r.x[j]!;
      const p = logistic(eta);
      const w = p * (1 - p);
      const e = (r.y ? 1 : 0) - p;
      for (let j = 0; j < d; j++) {
        g[j]! += e * r.x[j]!;
        for (let k = 0; k < d; k++) H[j]![k]! += w * r.x[j]! * r.x[k]!;
      }
    }
    for (let j = 0; j < d; j++) H[j]![j]! += ridge * rows.length;
    const step = solve(H, g);
    let big = 0;
    for (let j = 0; j < d; j++) { beta[j]! += step[j]!; big = Math.max(big, Math.abs(step[j]!)); }
    if (big < 1e-9) break;
  }
  return beta;
}

/** Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const v = M[c]![c]!;
    if (Math.abs(v) < 1e-15) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / v;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-15 ? 0 : row[n]! / row[i]!));
}
