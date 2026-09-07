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
  oracleselixir: ['kills', 'assists', 'deaths'],
  // bo3.gg publishes headshots as a plain column, so CS2 headshot props are
  // gradeable. They were not under HLTV, whose headshot numbers live only in
  // the /stats/ section that 403s even in a real browser.
  bo3: ['kills', 'headshots', 'deaths', 'assists'],
  hltv: ['kills', 'headshots', 'deaths', 'assists'],
};
