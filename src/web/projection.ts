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

/** A player's totals over one map range, line-independent. */
export type FormStats = {
  series: number;
  mean: number;
  sd: number | null;
  totals: number[];      // most recent first
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
};

const MIN_SERIES = 6;    // below this, form is noise wearing a number
const MIN_EDGE = 0.5;    // half a kill is inside the rounding of a line

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
): Play | null {
  if (!form || form.series < MIN_SERIES) return null;

  const lines: { book: 'prizepicks' | 'underdog'; line: number }[] = [];
  if (ppLine !== null) lines.push({ book: 'prizepicks', line: ppLine });
  if (udLine !== null) lines.push({ book: 'underdog', line: udLine });
  if (lines.length === 0) return null;

  // An over wants the lowest number available; an under wants the highest.
  const forOver = lines.reduce((a, b) => (b.line < a.line ? b : a));
  const forUnder = lines.reduce((a, b) => (b.line > a.line ? b : a));

  const overEdge = form.mean - forOver.line;
  const underEdge = forUnder.line - form.mean;

  const pick =
    overEdge >= underEdge
      ? { side: 'over' as const, ...forOver, edge: overEdge }
      : { side: 'under' as const, ...forUnder, edge: underEdge };

  if (pick.edge < MIN_EDGE) return null;

  const wins = form.totals.filter((t) =>
    pick.side === 'over' ? t > pick.line : t < pick.line,
  ).length;
  const hitRate = wins / form.totals.length;

  // Relative to how much the player actually swings: two kills on a 30-kill
  // line is a smaller claim than two kills on a 5-kill line, and ranking them
  // the same would put noisy high-volume markets on top every time.
  const edgeSd = form.sd && form.sd > 0 ? pick.edge / form.sd : null;

  return {
    side: pick.side,
    book: pick.book,
    line: pick.line,
    edge: pick.edge,
    edgeSd,
    hitRate,
    series: form.series,
    // Hit rate carries the ranking, nudged by how big the edge is relative to
    // the player's own variance. Sample size damps small-sample confidence.
    strength:
      (hitRate - 0.5) * 2 * (edgeSd ?? 0.5) * Math.min(1, form.series / 12),
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

    // Line-independent: the two books price the same market differently, and
    // the recommendation has to weigh both lines against one set of totals.
    for (const m of group) {
      const key = `${m.canon_handle}|${m.stat}|${m.map_start}|${m.map_end}`;
      if (out.has(key)) continue;
      const s = stats.get(`${m.canon_handle}|${m.league}|${m.map_start}|${m.map_end}`);
      if (!s || !s.totals?.length) continue;
      const totals = s.totals;
      const n = totals.length;
      const mean = totals.reduce((a, b) => a + b, 0) / n;
      const sd =
        n > 1 ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
      out.set(key, { series: n, mean, sd, totals });
    }
  }

  return out;
}
