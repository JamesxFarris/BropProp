-- One row per player per map, whichever sources reported it.
--
-- The same real game arrives from more than one place: Leaguepedia within
-- minutes of a match finishing, Oracle's Elixir in the season file later. They
-- name series differently ("LCS/2026 Season/Summer Season_Week 7_4" versus
-- "oe:LCS:2026-09-06:Disguised|LYON"), so the unique key on
-- (source, series_key, map_number, canon_handle) never saw a collision and
-- both were kept. Every average and hit rate was then counting recent games
-- twice.
--
-- Deduplicating across sources by time proximity rather than by date or by
-- series key:
--   * a series key can't be compared across sources, and never will be
--   * a date bucket would merge two different series a player played on the
--     same day, which happens in group stages
-- Two reports of the same map land seconds apart (22:34:00 vs 22:34:24); two
-- genuinely different series never start their Nth map within a quarter hour
-- of each other.
--
-- Adding a source later needs only a line in the ranking below. An unranked
-- source sorts last and is kept when nothing else covered that map, so a new
-- feed can never silently erase a player's history.

CREATE OR REPLACE FUNCTION map_stat_source_rank(src TEXT) RETURNS INT
  IMMUTABLE PARALLEL SAFE LANGUAGE SQL AS $$
    SELECT CASE src
             WHEN 'oracleselixir' THEN 1   -- season file, most complete
             WHEN 'leaguepedia'   THEN 2   -- fast, occasionally revised
             WHEN 'hltv'          THEN 3   -- the only CS2 source
             ELSE 9
           END;
$$;

CREATE OR REPLACE VIEW map_stat_dedup AS
SELECT m.*
FROM map_stat m
WHERE NOT EXISTS (
  SELECT 1
  FROM map_stat o
  WHERE o.canon_handle = m.canon_handle
    AND o.league       = m.league
    AND o.map_number   = m.map_number
    AND o.source      <> m.source
    AND o.played_at IS NOT NULL
    AND m.played_at IS NOT NULL
    AND o.played_at BETWEEN m.played_at - interval '15 minutes'
                        AND m.played_at + interval '15 minutes'
    -- Ties broken by id so two equally ranked sources still yield one row.
    AND (map_stat_source_rank(o.source) < map_stat_source_rank(m.source)
      OR (map_stat_source_rank(o.source) = map_stat_source_rank(m.source) AND o.id < m.id))
);
