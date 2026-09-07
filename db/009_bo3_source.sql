-- bo3.gg becomes the CS2 stat source, ranked above HLTV.
--
-- The dedup view keeps one row per player per map and breaks ties by source
-- rank, so adding a CS2 source without ranking it would leave the winner
-- decided by insertion order. Two measured reasons bo3 outranks HLTV:
--
--   * Coverage. Of 60 recent finished tier-C matches, every map of a parsed
--     match carried per-player stats (74 of 75). The HLTV crawler, measured
--     the same way, found stats in one of thirty results, and none of that
--     match's players were on our board.
--   * Headshots. bo3 publishes them as a plain column. HLTV keeps them only
--     under /stats/, which 403s even in a real browser, so every CS2 headshot
--     prop graded from HLTV was `ungradeable` by construction.
--
-- HLTV stays ranked rather than removed. Rows it already wrote are real, and
-- an unranked source sorts last, which would silently demote that history
-- below anything added later.

CREATE OR REPLACE FUNCTION map_stat_source_rank(src TEXT) RETURNS INT
  IMMUTABLE PARALLEL SAFE LANGUAGE SQL AS $$
    SELECT CASE src
             WHEN 'oracleselixir' THEN 1   -- season file, most complete
             WHEN 'leaguepedia'   THEN 2   -- fast, occasionally revised
             WHEN 'bo3'           THEN 3   -- CS2: full per-map stats incl. headshots
             WHEN 'hltv'          THEN 4   -- CS2: sparse, no headshots, needs a browser
             ELSE 9
           END;
$$;
