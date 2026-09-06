-- BropProp Phase 1: line logger
-- Design goals:
--   1. Never lose a line movement (append-only snapshots, change-detected).
--   2. Identify a market by its MEANING, not the book's id, so cross-book
--      joins work and an id reshuffle upstream doesn't fork the history.
--   3. Leave clean attachment points for Phase 2 (results) and Phase 3 (grading).

CREATE TABLE IF NOT EXISTS book (
  id    SMALLSERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE          -- 'prizepicks' | 'underdog'
);

CREATE TABLE IF NOT EXISTS team (
  id           SERIAL PRIMARY KEY,
  book_id      SMALLINT NOT NULL REFERENCES book(id),
  external_id  TEXT NOT NULL,
  name         TEXT,
  abbr         TEXT,
  UNIQUE (book_id, external_id)
);

CREATE TABLE IF NOT EXISTS player (
  id            SERIAL PRIMARY KEY,
  book_id       SMALLINT NOT NULL REFERENCES book(id),
  external_id   TEXT NOT NULL,
  handle        TEXT NOT NULL,
  -- lowercased, punctuation-stripped handle: the cross-book / cross-source join key
  canon_handle  TEXT NOT NULL,
  league        TEXT NOT NULL,
  team_id       INTEGER REFERENCES team(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (book_id, external_id)
);
CREATE INDEX IF NOT EXISTS player_canon_idx ON player (canon_handle, league);

CREATE TABLE IF NOT EXISTS match (
  id            SERIAL PRIMARY KEY,
  book_id       SMALLINT NOT NULL REFERENCES book(id),
  external_id   TEXT NOT NULL,
  league        TEXT NOT NULL,
  title         TEXT,
  home_team_id  INTEGER REFERENCES team(id),
  away_team_id  INTEGER REFERENCES team(id),
  scheduled_at  TIMESTAMPTZ,
  status        TEXT,
  UNIQUE (book_id, external_id)
);
CREATE INDEX IF NOT EXISTS match_sched_idx ON match (scheduled_at);

-- A prop is a market identity. The unique key is deliberately the semantic
-- tuple, not external_id, so that a book minting a fresh id for the same
-- market appends to the existing history instead of starting a new one.
CREATE TABLE IF NOT EXISTS prop (
  id            SERIAL PRIMARY KEY,
  book_id       SMALLINT NOT NULL REFERENCES book(id),
  external_id   TEXT,
  player_id     INTEGER NOT NULL REFERENCES player(id),
  match_id      INTEGER REFERENCES match(id),
  league        TEXT NOT NULL,
  stat          TEXT NOT NULL,           -- canonical: kills | headshots | assists | fantasy_points | ...
  map_start     SMALLINT NOT NULL,       -- 1 for "MAPS 1-2"
  map_end       SMALLINT NOT NULL,       -- 2 for "MAPS 1-2"
  is_combo      BOOLEAN NOT NULL DEFAULT false,
  variant       TEXT NOT NULL DEFAULT 'standard',  -- standard | goblin | demon
  display_stat  TEXT,                    -- the book's own wording, kept for debugging
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT is essential: match_id is nullable, and under default
  -- Postgres semantics two NULL match_ids compare as distinct, so an unmatched
  -- prop would insert a fresh duplicate row on every single poll.
  UNIQUE NULLS NOT DISTINCT (book_id, player_id, match_id, stat, map_start, map_end, variant, is_combo)
);
CREATE INDEX IF NOT EXISTS prop_lookup_idx ON prop (league, stat, map_start, map_end);

-- Append-only. One row per OBSERVED CHANGE, not per poll: if nothing moved we
-- only bump prop.last_seen_at. That keeps line-movement history exact while
-- stopping the table from growing by 480 rows every 15 minutes.
CREATE TABLE IF NOT EXISTS prop_snapshot (
  id            BIGSERIAL PRIMARY KEY,
  prop_id       INTEGER NOT NULL REFERENCES prop(id) ON DELETE CASCADE,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  poll_run_id   INTEGER,
  line          NUMERIC(8,2) NOT NULL,
  over_price    INTEGER,                 -- american odds, null when book doesn't publish
  under_price   INTEGER,
  status        TEXT,
  is_live       BOOLEAN NOT NULL DEFAULT false,
  extra         JSONB
);
CREATE INDEX IF NOT EXISTS snap_prop_time_idx ON prop_snapshot (prop_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS poll_run (
  id           SERIAL PRIMARY KEY,
  book_code    TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  http_status  INTEGER,
  props_seen   INTEGER NOT NULL DEFAULT 0,
  snaps_written INTEGER NOT NULL DEFAULT 0,
  ok           BOOLEAN NOT NULL DEFAULT false,
  error        TEXT
);

INSERT INTO book (code) VALUES ('prizepicks'), ('underdog')
  ON CONFLICT (code) DO NOTHING;

-- Current line per prop.
CREATE OR REPLACE VIEW current_line AS
SELECT DISTINCT ON (s.prop_id)
       s.prop_id, p.book_id, b.code AS book, p.league, p.stat,
       p.map_start, p.map_end, p.variant, p.is_combo,
       pl.handle, pl.canon_handle, m.title AS match_title, m.scheduled_at,
       s.line, s.over_price, s.under_price, s.status, s.observed_at
FROM prop_snapshot s
JOIN prop p   ON p.id = s.prop_id
JOIN book b   ON b.id = p.book_id
JOIN player pl ON pl.id = p.player_id
LEFT JOIN match m ON m.id = p.match_id
ORDER BY s.prop_id, s.observed_at DESC;

-- The Phase 1 payoff: same player, same stat, same map range, different books.
CREATE OR REPLACE VIEW cross_book_diff AS
SELECT pp.canon_handle, pp.league, pp.stat, pp.map_start, pp.map_end,
       pp.handle       AS pp_handle,
       ud.handle       AS ud_handle,
       pp.line         AS pp_line,
       ud.line         AS ud_line,
       (pp.line - ud.line) AS line_diff,
       pp.variant      AS pp_variant,
       pp.match_title, pp.scheduled_at,
       GREATEST(pp.observed_at, ud.observed_at) AS observed_at
FROM current_line pp
JOIN current_line ud
  ON  ud.book = 'underdog'
  AND pp.canon_handle = ud.canon_handle
  AND pp.league    = ud.league
  AND pp.stat      = ud.stat
  AND pp.map_start = ud.map_start
  AND pp.map_end   = ud.map_end
WHERE pp.book = 'prizepicks'
  AND pp.variant = 'standard'
  AND pp.line <> ud.line;

-- PrizePicks addresses leagues by numeric id, and hardcoding them rots.
-- Seeded with known ids, then self-heals: every poll re-reads the id/name
-- pairs out of the JSON:API `included` block and upserts them here.
CREATE TABLE IF NOT EXISTS league_ref (
  book_code    TEXT NOT NULL,
  league       TEXT NOT NULL,        -- canonical code
  external_id  TEXT NOT NULL,
  external_name TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (book_code, league)
);

INSERT INTO league_ref (book_code, league, external_id, external_name) VALUES
  ('prizepicks', 'CS2',  '265', 'CS2'),
  ('prizepicks', 'LOL',  '121', 'LoL'),
  ('prizepicks', 'APEX', '268', 'APEX')
ON CONFLICT (book_code, league) DO NOTHING;
