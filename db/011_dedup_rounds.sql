-- Refresh map_stat_dedup so it carries `rounds`.
--
-- Postgres snapshots a view's column list at CREATE time. `008` defined
-- map_stat_dedup as `SELECT m.*` against map_stat as it existed then; `010`
-- added `map_stat.rounds` afterwards, and the view did not pick it up. The
-- view still reports the 15 columns it had in 008 — a column added to the
-- underlying table is not retroactively added to a view built on `*`.
--
-- This is silent until something names the column: the view keeps working,
-- every existing query keeps working, and nothing errors. It only surfaces
-- when a query asks map_stat_dedup for `rounds` and gets "column does not
-- exist" — or worse, if a looser caller tolerated a missing column and just
-- got nulls back, which is how a real modelling input quietly stays empty.
-- `src/web/projection.ts` and `src/web/boardq.ts` read `rounds` off this view,
-- not off `map_stat` directly, so Task 5's backfilled data was invisible to
-- them until this ran.
--
-- The fix is the view definition from 008, re-run verbatim. `CREATE OR
-- REPLACE VIEW` is allowed to append columns at the end of a view's column
-- list — which is exactly what happened here, since `ALTER TABLE ADD COLUMN`
-- always adds at the end — so this picks up `rounds` without dropping or
-- reordering anything the view already exposed. The dedup logic itself
-- (time-proximity match, 15-minute window, source ranking) is untouched.

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
