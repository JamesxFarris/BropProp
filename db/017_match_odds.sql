-- The market's view of each CS2 match: who wins, and by how much.
--
-- Measured 2026-09-10 over 4,967 CS2 series: a losing team's players went under
-- their lines 62.0% of the time against 48.2% for the winners, and 66.0% when
-- the loss was a blowout (p < 0.000001 across 4,180 independent series). That
-- is hindsight — acting on it needs a view of who will lose BEFORE kick-off,
-- which is what a moneyline is. Pinnacle's, via OddsPapi's free tier.
--
-- One row per fixture per pull. Kept as a history rather than overwritten, for
-- the same reason prop_snapshot is: a price has to be remembered as it stood
-- when a slip was built, or a later backtest measures the wrong thing.
CREATE TABLE IF NOT EXISTS match_odds (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT        NOT NULL DEFAULT 'oddspapi',
  bookmaker     TEXT        NOT NULL,
  fixture_id    TEXT        NOT NULL,
  league        TEXT        NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  home_name     TEXT        NOT NULL,
  away_name     TEXT        NOT NULL,
  -- Decimal prices as quoted, so a different devig can be tried later on the
  -- same numbers.
  home_price    NUMERIC(8,3),
  away_price    NUMERIC(8,3),
  -- Margin removed, multiplicatively. Null when either side is missing.
  p_home_win    NUMERIC(6,4),
  -- Everything else the fixture carried, verbatim: handicaps, totals, per-map
  -- winners. Parsed later once each market's outcome pairing is confirmed.
  markets       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS match_odds_fixture_idx ON match_odds (fixture_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS match_odds_start_idx   ON match_odds (starts_at);

-- The latest quote per fixture — what the board reads.
CREATE OR REPLACE VIEW current_match_odds AS
SELECT DISTINCT ON (fixture_id) *
  FROM match_odds
 ORDER BY fixture_id, observed_at DESC;

-- OddsPapi identifies teams by number only, and the name lookup is a whole
-- request of its own — 989 CS2 participants. Names barely change, so they are
-- kept here and fetched again only when a fixture turns up an id not yet seen.
-- Without this, every daily pull pays an extra request for a list that did not
-- move.
CREATE TABLE IF NOT EXISTS oddspapi_participant (
  sport_id       INTEGER NOT NULL,
  participant_id TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sport_id, participant_id)
);

-- Every call made against a metered API.
--
-- OddsPapi's free tier is 250 requests a MONTH. A container restarts on every
-- deploy and has no memory of its own, so the count has to live here or the
-- budget is really "250 per container lifetime", which is no budget at all.
CREATE TABLE IF NOT EXISTS api_call (
  id         BIGSERIAL PRIMARY KEY,
  api        TEXT        NOT NULL,
  endpoint   TEXT        NOT NULL,
  status     INTEGER,
  called_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_call_api_idx ON api_call (api, called_at DESC);
