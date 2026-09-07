/** One player's line for one map of one series, as the source reported it. */
export type MapStat = {
  source: string;
  league: string;
  seriesKey: string;
  mapNumber: number;
  handleRaw: string;
  team: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  headshots: number | null;
  playedAt: string | null;
  raw?: Record<string, unknown>;
};

export type FetchStatsResult = {
  source: string;
  stats: MapStat[];
};

/**
 * Which canonical stats a source can actually produce.
 *
 * Declared rather than discovered so grading can mark a pick `ungradeable`
 * with a real reason instead of silently scoring it wrong. Leaguepedia has no
 * headshot concept at all; PrizePicks fantasy points use a scoring formula the
 * book doesn't publish, so deriving it would be a guess.
 */
export const SUPPORTED_STATS: Record<string, string[]> = {
  leaguepedia: ['kills', 'assists', 'deaths'],
  hltv: ['kills', 'headshots', 'deaths', 'assists'],
};
