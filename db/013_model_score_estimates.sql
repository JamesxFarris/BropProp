-- Track how close each central estimate got to the actual total.
--
-- The board's most prominent number is "Ours", and the lean beside it reads
-- "+3.6 in your favour" — which is the distance between our projection and the
-- book's line. That gap is only worth reading if our projection is the better
-- estimate, and until 2026-09-08 nobody had checked. On CS2 it is not: MAE
-- 5.25 against the line's 5.01 over 823 settled markets, with our bias at
-- +1.16 against the line's +0.43.
--
-- Stored per day so a correction, if one is ever fitted, has to show itself
-- here rather than in an argument. Nullable throughout: a league with no
-- exact-range series has no estimate to score.
ALTER TABLE model_score ADD COLUMN IF NOT EXISTS ours_mae   DOUBLE PRECISION;
ALTER TABLE model_score ADD COLUMN IF NOT EXISTS line_mae   DOUBLE PRECISION;
-- Signed, so the direction of the miss survives. Positive means the estimate
-- sat above what the player actually did.
ALTER TABLE model_score ADD COLUMN IF NOT EXISTS ours_bias  DOUBLE PRECISION;
ALTER TABLE model_score ADD COLUMN IF NOT EXISTS line_bias  DOUBLE PRECISION;
-- Markets behind those four numbers, which is not the same as `calls`: every
-- settled market with real series history is scored here, called or not.
ALTER TABLE model_score ADD COLUMN IF NOT EXISTS est_n      INTEGER;
