import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';

/**
 * Does a map's kills-per-round move with how long the map ran?
 *
 * Task 8 resamples a kill rate and a round count to project CS2 kills. If the
 * two move together — a lopsided map runs short and produces a lopsided rate
 * — drawing them independently understates the spread: a resample could pair
 * a blowout's rate with a grinder's length, a combination the real data never
 * produces. `src/combo.ts` hit the same question for teammates' kills and
 * measured it (1.06x-1.18x what independence implied) rather than assuming
 * either way. This is that same measurement for rate versus round count.
 *
 * The backfill that populated `map_stat.rounds` left two outlier bands
 * discovered while validating it against KAST:
 *   - 91 rows below 13 rounds. A completed CS2 map is MR12 (first to 13), so
 *     nothing under 13 is a real completed map — these are forfeits and
 *     abandonments. Their KAST consistency (90.8%) confirms they're broken
 *     rather than merely short; a 1-round map with 2 kills reports a KPR of
 *     2.0 and would swing the correlation on nothing.
 *   - Rows at 46-60 rounds are genuine deep overtime, 100% KAST-consistent.
 *     These stay in — excluding them would hide exactly the long tail this
 *     measurement exists to characterise.
 *
 * So the headline correlation is computed over rounds >= 13, with the
 * all-rows number printed alongside it for contrast — the point of printing
 * both is to show the exclusion is earned by measurement, not asserted.
 *
 * Read-only. No database writes.
 */

interface Row {
  kills: number;
  rounds: number;
}

function pearson(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 2) return NaN;
  let sumX = 0, sumY = 0;
  for (const [x, y] of pairs) { sumX += x; sumY += y; }
  const meanX = sumX / n, meanY = sumY / n;
  let cov = 0, varX = 0, varY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX, dy = y - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return NaN;
  return cov / Math.sqrt(varX * varY);
}

interface Bucket {
  label: string;
  min: number;
  max: number; // inclusive; Infinity for open-ended
}

const BUCKETS: Bucket[] = [
  { label: '13-15', min: 13, max: 15 },
  { label: '16-19', min: 16, max: 19 },
  { label: '20-24', min: 20, max: 24 },
  { label: '25+', min: 25, max: Infinity },
];

async function main(): Promise<void> {
  const rows = await q<Row>(
    `SELECT kills, rounds
     FROM map_stat_dedup
     WHERE league = 'CS2' AND rounds IS NOT NULL AND kills IS NOT NULL`,
  );

  const all = rows.map((r): [number, number] => [r.kills / r.rounds, r.rounds]);
  const clean = rows
    .filter((r) => r.rounds >= 13)
    .map((r): [number, number] => [r.kills / r.rounds, r.rounds]);

  const rAll = pearson(all);
  const rClean = pearson(clean);

  console.log(`rows total (rounds & kills present): ${rows.length}`);
  console.log(`rows excluded (rounds < 13):         ${rows.length - clean.length}`);
  console.log(`rows in headline sample (>= 13):      ${clean.length}`);
  console.log();
  console.log(`Pearson r, kills-per-round vs rounds, rounds >= 13 (headline): ${rClean.toFixed(4)}`);
  console.log(`Pearson r, kills-per-round vs rounds, all rows (for contrast): ${rAll.toFixed(4)}`);
  console.log();

  console.log('mean KPR by round-length bucket (rounds >= 13):');
  console.log('bucket    count    mean KPR');
  for (const b of BUCKETS) {
    const inBucket = rows.filter((r) => r.rounds >= b.min && r.rounds <= b.max);
    const meanKpr = inBucket.length
      ? inBucket.reduce((s, r) => s + r.kills / r.rounds, 0) / inBucket.length
      : NaN;
    console.log(
      `${b.label.padEnd(9)} ${String(inBucket.length).padStart(6)}    ${meanKpr.toFixed(4)}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}
