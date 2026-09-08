import { q } from '../db.js';

/**
 * Numbers for the stats page.
 *
 * Deliberately about the DATA rather than about profit. The honest headline
 * of this project is that it has accumulated a year of per-map history nobody
 * sells, and that the history is what everything else depends on — not that
 * it has found an edge, which four failed experiments say it has not yet.
 */

export type Counters = {
  statLines: number; series: number; players: number;
  props: number; lineChanges: number; matches: number;
  oldest: string | null; newest: string | null;
};

export async function counters(): Promise<Counters> {
  const [a] = await q<{
    stat_lines: number; series: number; players: number;
    oldest: string | null; newest: string | null;
  }>(`SELECT count(*)::int stat_lines,
             count(DISTINCT series_key)::int series,
             count(DISTINCT canon_handle)::int players,
             to_char(min(played_at),'YYYY-MM-DD') oldest,
             to_char(max(played_at),'YYYY-MM-DD') newest
        FROM map_stat_dedup`);
  const [b] = await q<{ props: number; line_changes: number; matches: number }>(
    `SELECT (SELECT count(*)::int FROM prop) props,
            (SELECT count(*)::int FROM prop_snapshot) line_changes,
            (SELECT count(*)::int FROM match) matches`);
  return {
    statLines: a?.stat_lines ?? 0, series: a?.series ?? 0, players: a?.players ?? 0,
    props: b?.props ?? 0, lineChanges: b?.line_changes ?? 0, matches: b?.matches ?? 0,
    oldest: a?.oldest ?? null, newest: a?.newest ?? null,
  };
}

/** Stat lines collected per week — the shape of the history growing. */
export async function historyByWeek(): Promise<Array<{ week: string; league: string; n: number }>> {
  return q(`SELECT to_char(date_trunc('week', played_at),'YYYY-MM-DD') week,
                   league, count(*)::int n
              FROM map_stat_dedup
             WHERE played_at IS NOT NULL
             GROUP BY 1, 2 ORDER BY 1`);
}

/**
 * How much of the board the model can actually speak to, per league.
 *
 * The number that governs whether the board is useful: a player under the
 * six-series threshold gets no call however good the engine is.
 */
export async function coverage(): Promise<Array<{ league: string; total: number; ready: number }>> {
  return q(`WITH per AS (
              SELECT p.canon_handle, pr.league,
                     count(DISTINCT ms.series_key)::int s
                FROM player p
                JOIN prop pr ON pr.player_id = p.id
                LEFT JOIN map_stat_dedup ms
                  ON ms.canon_handle = p.canon_handle AND ms.league = pr.league
               GROUP BY 1, 2)
            SELECT league, count(*)::int total,
                   count(*) FILTER (WHERE s >= 6)::int ready
              FROM per GROUP BY 1 ORDER BY 1`);
}

/** Graded picks by outcome, so the record is visible however small it is. */
export async function record(): Promise<Array<{ status: string; n: number }>> {
  return q(`SELECT status, count(*)::int n FROM pick GROUP BY 1 ORDER BY 2 DESC`);
}

/** Per-source provenance — which feed each stat line came from. */
export async function sources(): Promise<Array<{ source: string; league: string; n: number }>> {
  return q(`SELECT source, league, count(*)::int n
              FROM map_stat GROUP BY 1, 2 ORDER BY n DESC`);
}

/** One stored scorecard — see `db/012_model_score.sql`. */
export type ScoreRow = {
  day: string;
  calls: number;
  series: number;
  days: number;
  realised: number | null;
  claimed: number | null;
  auc: number | null;
  always_over: number | null;
  always_under: number | null;
  series_ahead: number | null;
  series_judged: number | null;
  series_p: number | null;
  ours_mae: number | null;
  line_mae: number | null;
  ours_bias: number | null;
  line_bias: number | null;
  est_n: number | null;
};

/**
 * The model's record over time, newest first.
 *
 * Read rather than computed: the walk-forward replay behind each row reads
 * every settled market and every stat row for the players in them, which is a
 * scheduled job's work, not a page load's.
 */
export async function scoreHistory(limit = 60, league = 'CS2'): Promise<ScoreRow[]> {
  return q(
    `SELECT to_char(scored_at, 'YYYY-MM-DD') AS day,
            calls, series, days, realised, claimed, auc,
            always_over, always_under, series_ahead, series_judged, series_p,
            ours_mae, line_mae, ours_bias, line_bias, est_n
       FROM model_score
      WHERE league = $2
      ORDER BY scored_at DESC
      LIMIT $1`,
    [limit, league],
  );
}
