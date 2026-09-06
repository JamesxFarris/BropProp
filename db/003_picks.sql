-- Taking props: a slip is a group of picks, a pick is one side of one prop.
--
-- These tables are the bridge between "what the books offered" (phase 1) and
-- "was I right" (phase 3+). Without them the logger only ever knows what the
-- market did, never what you did.

CREATE TABLE IF NOT EXISTS slip (
  id          SERIAL PRIMARY KEY,
  name        TEXT,
  book        TEXT,                                   -- prizepicks | underdog | mixed
  entry_type  TEXT NOT NULL DEFAULT 'power',          -- power | flex | single
  stake       NUMERIC(10,2),
  -- open: still being built. placed: locked in, awaiting results.
  -- won/lost/push/void: settled, set by grading in phase 2.
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  placed_at   TIMESTAMPTZ,
  settled_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS slip_status_idx ON slip (status, created_at DESC);

-- Only one slip may be open at a time, so "add to slip" is never ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS slip_single_open_idx ON slip ((status)) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS pick (
  id            SERIAL PRIMARY KEY,
  slip_id       INTEGER NOT NULL REFERENCES slip(id) ON DELETE CASCADE,
  prop_id       INTEGER NOT NULL REFERENCES prop(id),
  side          TEXT NOT NULL CHECK (side IN ('over', 'under')),

  -- The line AT THE MOMENT OF THE PICK, copied rather than joined.
  -- Lines move; grading must use the number actually taken, not whatever the
  -- board says hours later. Joining to the live line here would silently
  -- re-write history and make every backtest a lie.
  line_at_pick  NUMERIC(8,2) NOT NULL,
  price_at_pick INTEGER,
  book          TEXT NOT NULL,

  status        TEXT NOT NULL DEFAULT 'pending',      -- pending | won | lost | push | void
  actual_value  NUMERIC(8,2),                         -- filled by phase 2 grading
  graded_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The same prop twice on one slip is always a mistake, not an intent.
  UNIQUE (slip_id, prop_id)
);
CREATE INDEX IF NOT EXISTS pick_slip_idx ON pick (slip_id);
CREATE INDEX IF NOT EXISTS pick_pending_idx ON pick (status) WHERE status = 'pending';

-- Picks with everything grading will need: who, what market, which side, the
-- line taken, and when the match starts.
CREATE OR REPLACE VIEW pick_detail AS
SELECT p.id, p.slip_id, p.prop_id, p.side, p.line_at_pick, p.price_at_pick,
       p.book, p.status, p.actual_value, p.created_at,
       pl.handle, pl.canon_handle, pr.league, pr.stat,
       pr.map_start, pr.map_end, pr.variant,
       m.title AS match_title, m.scheduled_at,
       s.status AS slip_status, s.name AS slip_name, s.entry_type, s.stake
FROM pick p
JOIN prop pr   ON pr.id = p.prop_id
JOIN player pl ON pl.id = pr.player_id
JOIN slip s    ON s.id = p.slip_id
LEFT JOIN match m ON m.id = pr.match_id;
