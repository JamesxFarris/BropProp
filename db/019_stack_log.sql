-- Every stack the Build page recommends, and what happened to it.
--
-- The stack is the one shape in this project with a measured edge behind it:
-- teammates' results move together, and after a whole team clears its lines the
-- opponent follows far more often than the payout ladder assumes. Measured, a
-- five-plus-one stack hits about 8-11% where a 22x quote needs 4.5%. That is a
-- claim from 60 series and one screenshot of a payout, so it gets a forward
-- record rather than trust.
--
-- One row per stack per day (lines move, so the day's last look wins), whether
-- or not it was played: unplayed recommendations are still evidence about the
-- shape, and waiting only for placed slips would take months to say anything.
-- `quoted_mult` is filled only when a slip was actually placed from it — the
-- app's real number, which is the half of the EV this project cannot compute.
CREATE TABLE IF NOT EXISTS stack_log (
  id             BIGSERIAL PRIMARY KEY,
  logged_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  day            DATE NOT NULL DEFAULT current_date,

  book           TEXT NOT NULL,
  league         TEXT,
  match_key      TEXT NOT NULL,         -- the match; the cluster for scoring
  team           TEXT NOT NULL,         -- the team the core sits on
  side           TEXT NOT NULL,         -- over | under, every leg the same way
  size           INTEGER NOT NULL,      -- legs in the entry

  -- Each leg as it was recommended: prop, player, market, the line at the time
  -- and the side. Copied, never joined later — lines move, and a stack must be
  -- graded against the numbers it was recommended at.
  legs           JSONB NOT NULL,

  win_prob       DOUBLE PRECISION,      -- P(all legs win), correlation and tail included
  indep_prob     DOUBLE PRECISION,      -- the same product if legs were independent
  required_mult  DOUBLE PRECISION,      -- 1 / win_prob: the bar the app must clear

  -- Filled when a slip was placed from this stack.
  slip_id        INTEGER REFERENCES slip(id) ON DELETE SET NULL,
  quoted_mult    NUMERIC(8,2),

  -- pending until every leg has a result; one lost leg settles it as lost.
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | won | lost | void | ungradeable
  legs_settled   INTEGER,
  legs_won       INTEGER,
  graded_at      TIMESTAMPTZ,

  UNIQUE (day, book, match_key, team, side, size)
);

CREATE INDEX IF NOT EXISTS stack_log_pending_idx ON stack_log (status, day DESC);
