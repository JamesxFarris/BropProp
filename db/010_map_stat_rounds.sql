-- How many rounds a map actually ran.
--
-- Without it every map is one observation of "kills" and a 13-4 stomp counts
-- the same as a 16-14 grinder — 17 rounds against 30. A player's projected
-- mean then inherits the round-length mix of whatever sample they happen to
-- have, so ten blowouts in a row projects them low for a reason that says
-- nothing about the player, and the model cannot tell that apart from a real
-- decline.
--
-- Nullable on purpose, and it must stay that way. League of Legends has no
-- rounds and never will, and a CS2 map whose count could not be established
-- has to stay empty rather than carry a guess — the same rule grading uses
-- when a source cannot produce a stat.
--
-- Its own column rather than another key in `raw`: this is a modelling input
-- now, read on every board render, and burying it in JSON would make every
-- query that needs it pay to dig it out.

ALTER TABLE map_stat ADD COLUMN IF NOT EXISTS rounds smallint;

-- `measure_rounds.ts` and `validate_kpr.ts` both scan for `rounds IS NOT
-- NULL` by league — one to correlate kills-per-round against round length,
-- the other to build a held-out round-length pool for validation. Partial,
-- since every LoL row and every un-backfilled CS2 row is null and neither
-- script ever selects those.
CREATE INDEX IF NOT EXISTS map_stat_rounds_idx
  ON map_stat (league, rounds) WHERE rounds IS NOT NULL;
