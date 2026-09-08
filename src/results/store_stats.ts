import { q } from '../db.js';
import { canonHandle } from '../normalize.js';
import type { MapStat } from './types.js';

/**
 * Write stat lines, whoever fetched them.
 *
 * Shared by the scheduled results run and by the standalone backfills, so a
 * correction to the upsert rule cannot apply to one path and not the other.
 *
 * The upsert is what makes every fetch safe to repeat: a source that revises a
 * scoreboard after the fact updates the row rather than forking the player's
 * history into two rows that both look real.
 */
export async function storeStats(stats: MapStat[]): Promise<number> {
  let written = 0;
  for (const s of stats) {
    const res = await q(
      `INSERT INTO map_stat (source, league, series_key, map_number, handle_raw,
                             canon_handle, team, kills, deaths, assists, headshots,
                             played_at, raw, rounds, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (source, series_key, map_number, canon_handle) DO UPDATE
         SET kills = EXCLUDED.kills, deaths = EXCLUDED.deaths,
             assists = EXCLUDED.assists, headshots = EXCLUDED.headshots,
             team = COALESCE(EXCLUDED.team, map_stat.team),
             played_at = COALESCE(EXCLUDED.played_at, map_stat.played_at),
             rounds = COALESCE(EXCLUDED.rounds, map_stat.rounds),
             fetched_at = now()
       RETURNING id`,
      [s.source, s.league, s.seriesKey, s.mapNumber, s.handleRaw,
       canonHandle(s.handleRaw), s.team, s.kills, s.deaths, s.assists, s.headshots,
       s.playedAt, s.raw ?? {}, s.rounds],
    );
    if (res.length) written++;
  }
  return written;
}
