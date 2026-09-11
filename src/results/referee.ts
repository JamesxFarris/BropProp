/**
 * The referee: one scoring kit for every predictor this project tests.
 *
 * Every model idea — the projection, a team-strength environment, a market
 * consensus, a pricing bias — ends up as the same thing: a list of legs, each
 * with a predicted probability of winning and what actually happened. This
 * file scores that list the same way every time, so two ideas can be compared
 * on one scale and none of them gets to invent its own flattering metric.
 *
 * Two rules are built in rather than left to each caller, because this project
 * has broken both before:
 *
 * 1. **The series is the unit of evidence, not the leg.** Every player in one
 *    match shares its length, its overtime and its winner, so fifty legs from
 *    one series are one observation, not fifty. Every interval here comes from
 *    a CLUSTER bootstrap that resamples whole series. There is deliberately no
 *    leg-level z-score or p-value anywhere in this file.
 * 2. **ROI is measured at a real payout.** A leg is only worth playing when its
 *    win rate clears the per-leg break-even of the entry it joins, so ROI is
 *    reported against that bar — PrizePicks' Power ladder by default — not
 *    against even money.
 *
 * Pure functions, no database. Callers build the `Pred` list however they
 * like — walk-forward on the archive, or on the books' real closing lines.
 */

export type Pred = {
  /** The cluster: legs sharing a series share an outcome environment. */
  series: string;
  /** Predicted probability the leg wins, in (0, 1). */
  p: number;
  /** What happened. */
  won: boolean;
  /** Optional slice labels — stat, league, book, anything to break results out by. */
  tags?: Record<string, string>;
};

/** PrizePicks Power payouts by leg count, as published in its ladder. */
export const PP_POWER: Record<number, number> = { 2: 3, 3: 6, 4: 10, 5: 20, 6: 37.5 };

/**
 * The per-leg win rate an n-leg Power entry needs to break even, if its legs
 * were independent: M^(-1/n). 3-pick 6x → 55.0%, 5-pick 20x → 54.9%, 6-pick
 * 37.5x → 54.7%. (Correlated stacks are priced separately, in slip.ts.)
 */
export function perLegBreakEven(n: number, ladder: Record<number, number> = PP_POWER): number {
  const m = ladder[n];
  if (!m || m <= 1) throw new Error(`no payout for a ${n}-leg entry`);
  return m ** (-1 / n);
}

const clip = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));

/** Mean squared error of the probability. 0.25 is what "always 50%" scores. */
export function brier(ps: Pred[]): number {
  if (ps.length === 0) return NaN;
  return ps.reduce((a, x) => a + (x.p - (x.won ? 1 : 0)) ** 2, 0) / ps.length;
}

/** Mean negative log-likelihood. ln 2 ≈ 0.693 is what "always 50%" scores. */
export function logLoss(ps: Pred[]): number {
  if (ps.length === 0) return NaN;
  return -ps.reduce((a, x) => a + Math.log(x.won ? clip(x.p) : 1 - clip(x.p)), 0) / ps.length;
}

/**
 * Area under the ROC curve: the chance a random winning leg was rated higher
 * than a random losing one. 0.5 is no ordering at all. Ties get average ranks,
 * which matters — a model that rounds its outputs produces many.
 */
export function auc(ps: Pred[]): number {
  const n = ps.length;
  const pos = ps.filter((x) => x.won).length;
  const neg = n - pos;
  if (pos === 0 || neg === 0) return NaN;
  const idx = ps.map((x, i) => ({ p: x.p, i })).sort((a, b) => a.p - b.p);
  const rank = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && idx[j + 1]!.p === idx[i]!.p) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k]!.i] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  ps.forEach((x, i) => { if (x.won) sumPos += rank[i]!; });
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Equal-count bins of predicted probability, each with its realised hit rate. */
export function reliability(ps: Pred[], bins = 10): { lo: number; hi: number; n: number; meanP: number; hitRate: number }[] {
  const sorted = [...ps].sort((a, b) => a.p - b.p);
  const out: { lo: number; hi: number; n: number; meanP: number; hitRate: number }[] = [];
  const size = Math.max(1, Math.ceil(sorted.length / bins));
  for (let s = 0; s < sorted.length; s += size) {
    const b = sorted.slice(s, s + size);
    out.push({
      lo: b[0]!.p,
      hi: b[b.length - 1]!.p,
      n: b.length,
      meanP: b.reduce((a, x) => a + x.p, 0) / b.length,
      hitRate: b.filter((x) => x.won).length / b.length,
    });
  }
  return out;
}

/** mulberry32 — see validate_correlation for why never an LCG in JavaScript. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A statistic with a 95% interval from resampling whole SERIES with
 * replacement. The only interval this project reports for leg outcomes.
 */
export function clusterBootstrap(
  ps: Pred[],
  stat: (sample: Pred[]) => number,
  reps = 2000,
  seed = 20260911,
): { point: number; lo: number; hi: number; series: number } {
  const bySeries = new Map<string, Pred[]>();
  for (const x of ps) (bySeries.get(x.series) ?? bySeries.set(x.series, []).get(x.series)!).push(x);
  const groups = [...bySeries.values()];
  const point = stat(ps);
  if (groups.length < 2) return { point, lo: NaN, hi: NaN, series: groups.length };
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let r = 0; r < reps; r++) {
    const sample: Pred[] = [];
    for (let i = 0; i < groups.length; i++) sample.push(...groups[Math.floor(rnd() * groups.length)]!);
    const v = stat(sample);
    if (Number.isFinite(v)) draws.push(v);
  }
  draws.sort((a, b) => a - b);
  return {
    point,
    lo: draws[Math.floor(0.025 * draws.length)] ?? NaN,
    hi: draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))] ?? NaN,
    series: groups.length,
  };
}

/** Exact two-sided binomial sign test at p = 0.5. */
export function signTest(k: number, n: number): number {
  if (n === 0) return 1;
  const lc: number[] = [0];
  for (let i = 1; i <= n; i++) lc.push(lc[i - 1]! + Math.log((n - i + 1) / i));
  const at = (i: number) => Math.exp(lc[i]! + n * Math.log(0.5));
  const obs = at(k);
  let p = 0;
  for (let i = 0; i <= n; i++) { const d = at(i); if (d <= obs * (1 + 1e-9)) p += d; }
  return Math.min(1, p);
}

/**
 * Per series, did the legs mostly win? The coarse, assumption-light check
 * that sits beside the bootstrap: a series whose legs split evenly casts no
 * vote.
 */
export function seriesVote(ps: Pred[]): { up: number; down: number; p: number } {
  const bySeries = new Map<string, { w: number; n: number }>();
  for (const x of ps) {
    const s = bySeries.get(x.series) ?? { w: 0, n: 0 };
    s.n++; if (x.won) s.w++;
    bySeries.set(x.series, s);
  }
  let up = 0, down = 0;
  for (const s of bySeries.values()) { if (s.w * 2 > s.n) up++; else if (s.w * 2 < s.n) down++; }
  return { up, down, p: signTest(up, up + down) };
}

/**
 * ROI of playing only the legs whose predicted probability clears the
 * break-even by at least `minEdge`, paid at the fair per-leg multiplier
 * 1 / breakEven. A realised win rate equal to the break-even is ROI 0.
 */
export function roiAt(ps: Pred[], breakEven: number, minEdge = 0): Pred[] {
  return ps.filter((x) => x.p - breakEven >= minEdge);
}
export const roiOf = (breakEven: number) => (sample: Pred[]) =>
  sample.length === 0 ? NaN : sample.filter((x) => x.won).length / sample.length / breakEven - 1;

export type EdgeRow = {
  minEdge: number; legs: number; series: number;
  hitRate: number; roi: number; roiLo: number; roiHi: number;
};

/** ROI by minimum predicted edge — the table that says whether bigger edges are real. */
export function edgeTable(
  ps: Pred[],
  breakEven: number,
  thresholds = [0, 0.02, 0.04, 0.06, 0.08, 0.10],
): EdgeRow[] {
  return thresholds.map((t) => {
    const sel = roiAt(ps, breakEven, t);
    const b = clusterBootstrap(sel, roiOf(breakEven), 1000);
    return {
      minEdge: t,
      legs: sel.length,
      series: b.series,
      hitRate: sel.length ? sel.filter((x) => x.won).length / sel.length : NaN,
      roi: b.point, roiLo: b.lo, roiHi: b.hi,
    };
  });
}

const pct = (v: number, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');

/**
 * The full report for one predictor, as text. The same layout for every
 * caller, so two runs can be read side by side.
 */
export function report(label: string, ps: Pred[], breakEven = perLegBreakEven(5)): string {
  const lines: string[] = [];
  const hit = ps.filter((x) => x.won).length / Math.max(1, ps.length);
  const meanP = ps.reduce((a, x) => a + x.p, 0) / Math.max(1, ps.length);
  const br = clusterBootstrap(ps, brier, 1000);
  const ll = clusterBootstrap(ps, logLoss, 1000);
  const au = clusterBootstrap(ps, auc, 1000);
  // Skill against the trivial forecaster that always says the base rate.
  const base = ps.map((x) => ({ ...x, p: hit }));
  const vote = seriesVote(ps);
  lines.push(`=== ${label} ===`);
  lines.push(`legs ${ps.length}, series ${br.series}; claimed ${pct(meanP)} vs realised ${pct(hit)}`);
  lines.push(`Brier   ${f3(br.point)} [${f3(br.lo)}, ${f3(br.hi)}]   base-rate forecaster ${f3(brier(base))}   coin flip 0.250`);
  lines.push(`LogLoss ${f3(ll.point)} [${f3(ll.lo)}, ${f3(ll.hi)}]   base-rate forecaster ${f3(logLoss(base))}   coin flip 0.693`);
  lines.push(`AUC     ${f3(au.point)} [${f3(au.lo)}, ${f3(au.hi)}]   (0.5 = no ordering)`);
  lines.push(`series mostly won: ${vote.up}-${vote.down}, sign test p = ${vote.p.toFixed(4)}`);
  lines.push(`calibration (equal-count bins): claimed → realised`);
  for (const b of reliability(ps, 8)) {
    lines.push(`  ${pct(b.lo)}–${pct(b.hi)}  n=${String(b.n).padStart(5)}  claimed ${pct(b.meanP)}  realised ${pct(b.hitRate)}`);
  }
  lines.push(`ROI by minimum edge over the ${pct(breakEven)} break-even (series-bootstrap 95% CI):`);
  for (const r of edgeTable(ps, breakEven)) {
    lines.push(`  edge ≥ ${pct(r.minEdge, 0).padStart(4)}  legs ${String(r.legs).padStart(5)}  series ${String(r.series).padStart(4)}  ` +
      `hit ${pct(r.hitRate)}  ROI ${pct(r.roi)} [${pct(r.roiLo)}, ${pct(r.roiHi)}]`);
  }
  return lines.join('\n');
}

/** The same report, once per value of one tag (stat, league, book…). */
export function reportBy(label: string, ps: Pred[], tag: string, breakEven = perLegBreakEven(5)): string {
  const groups = new Map<string, Pred[]>();
  for (const x of ps) {
    const k = x.tags?.[tag] ?? '(none)';
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(x);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, g]) => report(`${label} — ${tag}=${k}`, g, breakEven))
    .join('\n\n');
}
