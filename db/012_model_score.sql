-- A dated scorecard for the model, so its record is a tracked series rather
-- than something re-derived by hand whenever someone asks.
--
-- The walk-forward replay behind this is far too slow for a page load — it
-- reads every settled market and every stat row for every player in them — so
-- a daily job writes one row and the Stats page reads the table.
--
-- Every column is a measurement, never a claim. `realised` is what the model's
-- picks actually did; `claimed` is what it said they would do; the gap between
-- them is the number worth watching. `auc` is the one that decides whether the
-- model has any ordering at all: 0.5 is no skill, and no amount of
-- recalibration rescues a model sitting on it.
CREATE TABLE IF NOT EXISTS model_score (
  id            BIGSERIAL PRIMARY KEY,
  scored_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  league        TEXT NOT NULL,

  -- Sample. `series` is the honest one: every player in a series shares its
  -- length, overtime and pace, so their legs move together and `calls` badly
  -- overstates how much independent evidence there is. Both are stored so the
  -- ratio between them stays visible.
  calls         INTEGER NOT NULL,
  series        INTEGER NOT NULL,
  days          INTEGER NOT NULL,

  realised      DOUBLE PRECISION,        -- share of the model's picks that won
  claimed       DOUBLE PRECISION,        -- mean probability it predicted
  auc           DOUBLE PRECISION,        -- 0.5 = no discriminative power

  -- What the same markets did with no model at all, so a hit rate can never be
  -- read as skill without its comparison sitting next to it.
  always_over   DOUBLE PRECISION,
  always_under  DOUBLE PRECISION,

  -- Series in which the model's calls came out ahead, and the exact two-sided
  -- sign-test p for that count. This is the significance figure to quote.
  series_ahead  INTEGER,
  series_judged INTEGER,
  series_p      DOUBLE PRECISION,

  claimed_ev    DOUBLE PRECISION,        -- mean claimed EV per priced bet
  realised_ev   DOUBLE PRECISION,

  -- One row per league per day is the intent; re-running the job on the same
  -- day should correct that day rather than append a second opinion.
  UNIQUE (league, scored_at)
);

CREATE INDEX IF NOT EXISTS model_score_time_idx ON model_score (league, scored_at DESC);
