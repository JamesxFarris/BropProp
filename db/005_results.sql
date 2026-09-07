-- Phase 2: match results, and grading picks against them.
--
-- Stat lines are stored raw, per player per map, exactly as the source
-- reported them. Grading is a separate step that reads these — so a grading
-- bug can be fixed and re-run without re-scraping, and a source that
-- disappears doesn't take the history with it.

CREATE TABLE IF NOT EXISTS map_stat (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,              -- leaguepedia | hltv
  league        TEXT NOT NULL,              -- canonical: CS2 | LOL

  -- The source's own identifier for the series, so maps can be grouped into
  -- the series they belong to. Never parsed for meaning.
  series_key    TEXT NOT NULL,
  map_number    SMALLINT NOT NULL,          -- 1-based, matches "Maps 1-2"

  handle_raw    TEXT NOT NULL,
  canon_handle  TEXT NOT NULL,              -- the join key to player
  team          TEXT,

  kills         INTEGER,
  deaths        INTEGER,
  assists       INTEGER,
  headshots     INTEGER,

  played_at     TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw           JSONB,

  -- Re-running a fetch must update a row, never duplicate it.
  UNIQUE (source, series_key, map_number, canon_handle)
);
CREATE INDEX IF NOT EXISTS map_stat_lookup_idx
  ON map_stat (canon_handle, league, played_at DESC);
CREATE INDEX IF NOT EXISTS map_stat_series_idx ON map_stat (series_key, map_number);

-- Audit of each fetch, mirroring poll_run: a grader that quietly stopped
-- should be as visible as a logger that did.
CREATE TABLE IF NOT EXISTS result_run (
  id           SERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  rows_seen    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  picks_graded INTEGER NOT NULL DEFAULT 0,
  ok           BOOLEAN NOT NULL DEFAULT false,
  error        TEXT
);

-- Why a pick was graded the way it was. Without this, a wrong grade is
-- impossible to argue with after the fact.
ALTER TABLE pick ADD COLUMN IF NOT EXISTS grade_note   TEXT;
ALTER TABLE pick ADD COLUMN IF NOT EXISTS grade_source TEXT;
ALTER TABLE pick ADD COLUMN IF NOT EXISTS series_key   TEXT;

-- 'void' already allowed by the column being free text; document the set:
--   pending | won | lost | push | void | ungradeable
-- void        = a map in the range was never played (series ended early)
-- ungradeable = no stat line found, or the stat isn't derivable from the source

CREATE OR REPLACE VIEW pick_grade AS
SELECT p.id, p.slip_id, p.prop_id, p.side, p.line_at_pick, p.status,
       p.actual_value, p.grade_note, p.grade_source, p.graded_at,
       pl.canon_handle, pl.handle, pr.league, pr.stat,
       pr.map_start, pr.map_end, pr.is_combo,
       m.title AS match_title, m.scheduled_at, s.status AS slip_status
FROM pick p
JOIN prop pr   ON pr.id = p.prop_id
JOIN player pl ON pl.id = pr.player_id
JOIN slip s    ON s.id = p.slip_id
LEFT JOIN match m ON m.id = pr.match_id;
