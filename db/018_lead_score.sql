-- The forward record of every pre-registered lead, one row per lead per day.
--
-- A lead is a pricing pattern the bias scan (src/results/validate_bias.ts)
-- found in the first days of lines and could not yet confirm — "under when the
-- app's line sits above the player's own history" is the first. It was chosen
-- FROM those days, so those days cannot confirm it: only legs that start on or
-- after `since` count here. The daily job re-scores the whole forward window
-- and upserts today's row, so the latest row per lead is its current record.
--
-- `series`, not `legs`, is the honest sample size: every player in a series
-- shares its length and its winner. `series_needed` is the pre-registered
-- target before the lead may be acted on; `series_p` is the exact sign test
-- over series, to be judged against the Bonferroni bar across the tracked
-- leads (0.05 / 3 = 0.0167), never against 0.05.
CREATE TABLE IF NOT EXISTS lead_score (
  id             BIGSERIAL PRIMARY KEY,
  scored_on      DATE NOT NULL DEFAULT current_date,
  lead           TEXT NOT NULL,          -- short key, e.g. 'T2'
  label          TEXT NOT NULL,
  since          DATE NOT NULL,          -- first day of the forward window
  legs           INTEGER NOT NULL,
  series         INTEGER NOT NULL,
  win_rate       DOUBLE PRECISION,       -- share of legs the tracked side won
  ci_lo          DOUBLE PRECISION,       -- series-bootstrap 95% interval
  ci_hi          DOUBLE PRECISION,
  series_up      INTEGER,                -- series that leaned the tracked side's way
  series_down    INTEGER,
  series_p       DOUBLE PRECISION,
  series_needed  INTEGER,
  UNIQUE (lead, scored_on)
);
