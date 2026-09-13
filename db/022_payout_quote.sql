-- What an app actually quotes for an entry of a given shape.
--
-- This is the one number this project cannot compute and cannot read from any
-- feed. PrizePicks publishes no multiplier anywhere reachable (verified against
-- its partner projections payload: odds_type and promo flags, nothing else),
-- and the entry multiplier — correlation discount included — exists only inside
-- the authenticated entry builder.
--
-- It matters more than any other missing number. The stack's whole verdict is
-- "does the quote beat the required multiplier", and the bar moves from 2.9% to
-- 4.5% depending on the discount. Measured against the three quotes this
-- project already owned, the apps cut roughly 7.5% off the list price for each
-- leg beyond the first in the same MATCH — not the same team, which is the
-- structurally important part, because it means a stack's opponent leg is
-- charged exactly like another teammate. Three points cannot carry that claim
-- out to the six-leg single-match shape we actually build, so this table exists
-- to hold a deliberate calibration sweep across concentrations.
--
-- One row per quote read off an app. Nothing is staked: a quote is worth
-- recording whether or not the entry is ever placed, and requiring a stake is
-- what left the project with three data points in a month.
CREATE TABLE IF NOT EXISTS payout_quote (
  id            BIGSERIAL PRIMARY KEY,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  book          TEXT    NOT NULL,
  -- The shape, stored as measured rather than recomputed later: the board moves.
  size          INTEGER NOT NULL,           -- legs in the entry
  matches       INTEGER NOT NULL,           -- distinct matches among them
  max_per_team  INTEGER NOT NULL,           -- largest single-team block
  max_per_match INTEGER NOT NULL,           -- largest single-match block
  same_side     BOOLEAN,                    -- every leg the same way?
  -- size - matches. The variable the discount measured against; stored rather
  -- than derived so a later change of definition cannot silently rewrite history.
  excess        INTEGER NOT NULL,
  quoted        NUMERIC(8,2) NOT NULL,      -- what the app said
  legs          JSONB NOT NULL,             -- the exact legs, for audit
  note          TEXT
);

CREATE INDEX IF NOT EXISTS payout_quote_shape_idx ON payout_quote (book, size, excess);
