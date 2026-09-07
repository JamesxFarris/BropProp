import { q } from '../db.js';

/**
 * What a player has actually done over the same map range, and how that sits
 * against the line being offered.
 *
 * Deliberately empirical rather than a fitted distribution. "Cleared 8.5 in 9
 * of their last 12 series" is a statement about what happened; a normal
 * distribution fitted to a dozen noisy esports games is a statement about an
 * assumption. With samples this small the assumption does more work than the
 * data, so it isn't made.
 *
 * The same rule grading uses applies here: only series where every map in the
 * range was actually played are counted. Including a 2-0 sweep in a "maps 1-3"
 * sample would drag every average down with a total that could never have been
 * bet.
 */

const STAT_COLUMN: Record<string, string> = {
  kills: 'kills', headshots: 'headshots', assists: 'assists', deaths: 'deaths',
};

export type Projection = {
  series: number;        // sample size: completed series covering the range
  mean: number;          // average total over the range
  sd: number | null;
  last: number | null;   // most recent series total
  overCount: number;     // how many cleared the line
  hitRate: number | null;
  edge: number | null;   // mean minus line, in stat units
};

/**
 * A player's output, held two ways.
 *
 * `totals` are real observed totals over the exact map range, from series that
 * actually played every map in it — the truest measure, and the scarcest. A
 * Bo3 that ends 2-0 contributes nothing to a "maps 1-3" sample, and a Bo1
 * league contributes nothing at all.
 *
 * `mapValues` are single-map outputs from every series regardless of length.
 * Far more data, and it can answer any map range including ones the books
 * haven't offered yet — at the cost of assuming maps are interchangeable.
 */
export type FormStats = {
  series: number;
  mean: number;
  sd: number | null;
  totals: number[];      // most recent first, exact-range series only
  mapValues: number[];   // most recent first, every map played
  perMap: number | null; // mean of a single map
};

export type Play = {
  side: 'over' | 'under';
  book: 'prizepicks' | 'underdog';
  line: number;
  edge: number;          // stat units in your favour at that line
  edgeSd: number | null; // edge relative to how much this player swings
  hitRate: number;       // share of past series that would have won this side
  series: number;
  strength: number;      // ranking score, not a probability
  score: number;         // strength on a 0-99 scale, for reading at a glance
  method: 'series' | 'maps';  // measured over the exact range, or modelled from single maps
  sample: number;        // series counted, or maps drawn from
};

const MIN_SERIES = 6;    // below this, form is noise wearing a number
const MIN_MAPS = 12;     // single maps needed before modelling a range from them
const MIN_EDGE = 0.5;    // half a kill is inside the rounding of a line
const DRAWS = 4000;

/** Deterministic PRNG, so the same board renders the same numbers every time. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    return x / 4294967296;
  };
}

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Totals for an n-map range, resampled from single-map outputs.
 *
 * A Bo3 that ends 2-0 tells you nothing about a three-map total directly, but
 * it still tells you what this player does in a map. Drawing n maps at random
 * and summing turns two maps of evidence into an estimate for any range —
 * including ranges the books haven't offered yet.
 *
 * The assumption is that maps are interchangeable and independent. They aren't
 * quite: a player having a good series tends to be good across all of it, so
 * real totals swing wider than this produces. Calls built this way are
 * therefore marked, and their score is damped rather than trusted equally.
 */
function resampleTotals(mapValues: number[], maps: number, seed: string): number[] {
  const rand = rng(seedFrom(seed));
  const out: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    let sum = 0;
    for (let m = 0; m < maps; m++) sum += mapValues[Math.floor(rand() * mapValues.length)]!;
    out.push(sum);
  }
  return out;
}

/**
 * Which side to take, on which app.
 *
 * The two questions are separate and were being answered as one. Direction is a
 * question about the player: does their real output sit above or below this
 * number. App is a question about price: for an over you want the LOWEST line
 * available, for an under the HIGHEST — opposite books win opposite sides.
 *
 * So each direction is evaluated at the best line available for it, and the
 * direction with the larger edge wins. That naturally picks the book too.
 *
 * No call is made below MIN_SERIES or MIN_EDGE. A recommendation off four games
 * would be a coin flip wearing a decimal point.
 */
export function recommend(
  form: FormStats | undefined,
  ppLine: number | null,
  udLine: number | null,
  maps = 1,
  seed = '',
): Play | null {
  if (!form) return null;

  // Prefer real totals over the exact range. Fall back to modelling the range
  // from single maps only when there aren't enough of them — more data, but
  // one assumption further from what actually happened.
  const useSeries = form.series >= MIN_SERIES;
  const sample = useSeries
    ? form.totals
    : form.mapValues.length >= MIN_MAPS
      ? resampleTotals(form.mapValues, maps, `${seed}|${maps}`)
      : null;
  if (!sample || sample.length === 0) return null;

  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const sd =
    sample.length > 1
      ? Math.sqrt(sample.reduce((a, b) => a + (b - mean) ** 2, 0) / (sample.length - 1))
      : null;

  const lines: { book: 'prizepicks' | 'underdog'; line: number }[] = [];
  if (ppLine !== null) lines.push({ book: 'prizepicks', line: ppLine });
  if (udLine !== null) lines.push({ book: 'underdog', line: udLine });
  if (lines.length === 0) return null;

  // An over wants the lowest number available; an under wants the highest.
  const forOver = lines.reduce((a, b) => (b.line < a.line ? b : a));
  const forUnder = lines.reduce((a, b) => (b.line > a.line ? b : a));

  const overEdge = mean - forOver.line;
  const underEdge = forUnder.line - mean;

  const pick =
    overEdge >= underEdge
      ? { side: 'over' as const, ...forOver, edge: overEdge }
      : { side: 'under' as const, ...forUnder, edge: underEdge };

  if (pick.edge < MIN_EDGE) return null;

  const wins = sample.filter((t) => (pick.side === 'over' ? t > pick.line : t < pick.line)).length;
  const hitRate = wins / sample.length;

  // Relative to how much the player actually swings: two kills on a 30-kill
  // line is a smaller claim than two kills on a 5-kill line, and ranking them
  // the same would put noisy high-volume markets on top every time.
  const edgeSd = sd && sd > 0 ? pick.edge / sd : null;

  // Hit rate carries the ranking, nudged by how big the edge is relative to
  // the player's own variance. Sample size damps small-sample confidence, and
  // a modelled range is damped again — it rests on an assumption a measured
  // total doesn't need.
  const evidence = useSeries
    ? Math.min(1, form.series / 12)
    : 0.75 * Math.min(1, form.mapValues.length / 30);
  const strength = (hitRate - 0.5) * 2 * (edgeSd ?? 0.5) * evidence;

  return {
    side: pick.side,
    book: pick.book,
    line: pick.line,
    edge: pick.edge,
    edgeSd,
    hitRate,
    series: form.series,
    strength,
    method: useSeries ? 'series' : 'maps',
    sample: useSeries ? form.series : form.mapValues.length,
    // A rank, not a probability. 60 is a better bet than 30; it is not a claim
    // that it wins 60% of the time — hit rate is shown separately for that.
    score: Math.max(1, Math.min(99, Math.round(strength * 100))),
  };
}

export async function projectFor(opts: {
  canonHandle: string;
  league: string;
  stat: string;
  mapStart: number;
  mapEnd: number;
  line: number;
  limit?: number;
}): Promise<Projection | null> {
  const col = STAT_COLUMN[opts.stat];
  if (!col) return null;
  const need = opts.mapEnd - opts.mapStart + 1;

  const rows = await q<{
    series: number; mean: number | null; sd: number | null;
    last: number | null; over_count: number;
  }>(
    `WITH totals AS (
       SELECT series_key,
              max(played_at) AS at,
              count(*) FILTER (WHERE map_number BETWEEN $3 AND $4)      AS maps_played,
              sum(${col}) FILTER (WHERE map_number BETWEEN $3 AND $4)   AS total
       FROM map_stat
       WHERE canon_handle = $1 AND league = $2
       GROUP BY series_key
     ),
     usable AS (
       -- Only series that actually played the whole range, and where the stat
       -- exists for it. A source that knows the map happened but not this stat
       -- must not count as a zero.
       SELECT * FROM totals
       WHERE maps_played = $5 AND total IS NOT NULL
       ORDER BY at DESC
       LIMIT $6
     )
     SELECT count(*)::int                                   AS series,
            avg(total)::float                               AS mean,
            stddev_samp(total)::float                       AS sd,
            (array_agg(total ORDER BY at DESC))[1]::float    AS last,
            count(*) FILTER (WHERE total > $7)::int          AS over_count
     FROM usable`,
    [opts.canonHandle, opts.league, opts.mapStart, opts.mapEnd, need, opts.limit ?? 20, opts.line],
  );

  const r = rows[0];
  if (!r || r.series === 0 || r.mean === null) return null;
  return {
    series: r.series,
    mean: r.mean,
    sd: r.sd,
    last: r.last,
    overCount: r.over_count,
    hitRate: r.series > 0 ? r.over_count / r.series : null,
    edge: r.mean - opts.line,
  };
}

/**
 * Projections for a whole board in one query, keyed by `canon|stat|start|end`.
 *
 * Per-row lookups would mean hundreds of round trips to render one page. The
 * line differs per book, so hit rate is computed against the line passed in
 * for each market.
 */
export async function projectBoard(
  markets: {
    canon_handle: string; league: string; stat: string;
    map_start: number; map_end: number;
  }[],
  limit = 20,
): Promise<Map<string, FormStats>> {
  const out = new Map<string, FormStats>();
  const wanted = markets.filter((m) => STAT_COLUMN[m.stat]);
  if (wanted.length === 0) return out;

  // One query per stat column, since the column name can't be parameterised.
  const byCol = new Map<string, typeof wanted>();
  for (const m of wanted) {
    const col = STAT_COLUMN[m.stat]!;
    const list = byCol.get(col);
    if (list) list.push(m);
    else byCol.set(col, [m]);
  }

  for (const [col, group] of byCol) {
    const rows = await q<{
      canon_handle: string; league: string; map_start: number; map_end: number;
      totals: number[];
    }>(
      `WITH want AS (
         SELECT DISTINCT canon_handle, league, map_start, map_end
         FROM unnest($1::text[], $2::text[], $3::int[], $4::int[])
              AS t(canon_handle, league, map_start, map_end)
       ),
       totals AS (
         SELECT w.canon_handle, w.league, w.map_start, w.map_end,
                ms.series_key,
                max(ms.played_at) AS at,
                count(*) FILTER (WHERE ms.map_number BETWEEN w.map_start AND w.map_end)     AS maps_played,
                sum(ms.${col}) FILTER (WHERE ms.map_number BETWEEN w.map_start AND w.map_end) AS total
         FROM want w
         JOIN map_stat ms ON ms.canon_handle = w.canon_handle AND ms.league = w.league
         GROUP BY w.canon_handle, w.league, w.map_start, w.map_end, ms.series_key
       ),
       ranked AS (
         SELECT *, row_number() OVER (
                  PARTITION BY canon_handle, league, map_start, map_end ORDER BY at DESC) AS rn
         FROM totals
         WHERE maps_played = (map_end - map_start + 1) AND total IS NOT NULL
       )
       SELECT canon_handle, league, map_start, map_end,
              array_agg(total ORDER BY at DESC)::float[] AS totals
       FROM ranked WHERE rn <= $5
       GROUP BY canon_handle, league, map_start, map_end`,
      [
        group.map((m) => m.canon_handle),
        group.map((m) => m.league),
        group.map((m) => m.map_start),
        group.map((m) => m.map_end),
        limit,
      ],
    );

    const stats = new Map(
      rows.map((r) => [`${r.canon_handle}|${r.league}|${r.map_start}|${r.map_end}`, r]),
    );

    // Every single map this player has produced, whatever the series length.
    // This is what lets a "maps 1-3" prop be projected from Bo1 and Bo2 play,
    // and what will answer whatever map range the books invent next.
    const mapRows = await q<{ canon_handle: string; league: string; vals: number[] }>(
      `WITH want AS (
         SELECT DISTINCT canon_handle, league
         FROM unnest($1::text[], $2::text[]) AS t(canon_handle, league)
       ),
       m AS (
         SELECT w.canon_handle, w.league, ms.${col} AS v, ms.played_at,
                row_number() OVER (PARTITION BY w.canon_handle, w.league
                                   ORDER BY ms.played_at DESC) AS rn
         FROM want w
         JOIN map_stat ms ON ms.canon_handle = w.canon_handle AND ms.league = w.league
         WHERE ms.${col} IS NOT NULL
       )
       SELECT canon_handle, league, array_agg(v ORDER BY played_at DESC)::float[] AS vals
       FROM m WHERE rn <= $3
       GROUP BY canon_handle, league`,
      [group.map((m) => m.canon_handle), group.map((m) => m.league), limit * 3],
    );
    const maps = new Map(mapRows.map((r) => [`${r.canon_handle}|${r.league}`, r.vals]));

    // Line-independent: the two books price the same market differently, and
    // the recommendation has to weigh both lines against one set of totals.
    for (const m of group) {
      const key = `${m.canon_handle}|${m.stat}|${m.map_start}|${m.map_end}`;
      if (out.has(key)) continue;
      const s = stats.get(`${m.canon_handle}|${m.league}|${m.map_start}|${m.map_end}`);
      const mapValues = maps.get(`${m.canon_handle}|${m.league}`) ?? [];
      const totals = s?.totals ?? [];
      if (totals.length === 0 && mapValues.length === 0) continue;
      const n = totals.length;
      const mean = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
      const sd =
        n > 1 ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
      const perMap = mapValues.length
        ? mapValues.reduce((a, b) => a + b, 0) / mapValues.length
        : null;
      out.set(key, { series: n, mean, sd, totals, mapValues, perMap });
    }
  }

  return out;
}
