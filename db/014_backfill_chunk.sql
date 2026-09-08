-- A ledger of backfill windows already completed.
--
-- A deploy replaces the container, so nothing running inside it can survive
-- one. A long backfill therefore cannot be made to *continue* across a deploy;
-- it can only be made to *resume* — and resuming is only cheap if the work was
-- divided into pieces that can be marked done.
--
-- Before this, `npm run bo3 730` was one indivisible eight-hour walk from
-- newest to oldest. Five deploys in a day meant five restarts, each re-walking
-- everything already stored, and net progress of about 4,000 rows against
-- several hours of runtime. Rows were never lost — the sink writes as it goes,
-- and stored maps are skipped — but *position* was, every time.
--
-- One row per completed window. The chunk boundaries are derived, not stored
-- as a plan, so changing the chunk size later does not orphan the history:
-- worst case a differently-sized window is re-walked once, and every map in it
-- is skipped on the way through.
CREATE TABLE IF NOT EXISTS backfill_chunk (
  source       TEXT NOT NULL,          -- 'bo3'
  league       TEXT NOT NULL,          -- 'CS2'
  -- Inclusive lower bound, exclusive upper bound, matching the API filters.
  since        DATE NOT NULL,
  until        DATE NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What the window actually yielded, so a chunk that returned nothing is
  -- distinguishable from one that was never run.
  matches      INTEGER,
  maps         INTEGER,
  written      INTEGER,
  PRIMARY KEY (source, league, since, until)
);

CREATE INDEX IF NOT EXISTS backfill_chunk_window_idx
  ON backfill_chunk (source, league, since DESC);
