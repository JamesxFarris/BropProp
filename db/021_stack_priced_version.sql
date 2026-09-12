-- Which pricing the stack's `required_mult` was computed with.
--
-- Until 2026-09-12 every leg of a stack was priced at the team-outcome baseline
-- (about 0.484) even on books that publish both sides. The search then picked
-- whichever legs the book priced LONGEST, so the bar it reported was the book's
-- discarded opinion rather than a bar: Sleeper stacks read "needs 10.9x" for
-- shapes the book itself priced near 40% a leg.
--
-- Fixed the same day: where a book prices both sides, its devigged number is the
-- leg's marginal and the correlation lift applies on top. Rows logged before the
-- fix landed carry a `required_mult` that cannot be compared with rows after it,
-- and the forward record is the entire point of this table — so they are marked
-- rather than deleted. The matches are real and still settle; grading keeps
-- them, and anything measuring the bar filters to version 2.
--
--   1 = every leg at the flat baseline (pre-fix)
--   2 = the book's own devigged marginal where it prices both sides
ALTER TABLE stack_log ADD COLUMN IF NOT EXISTS priced_version SMALLINT NOT NULL DEFAULT 2;

-- The deploy that carried the fix went live at 2026-09-12 05:00 UTC; the 02:27
-- batch is baseline-priced, the 05:29 batch is not. Bounded to that one day so
-- re-running this never touches anything logged later.
UPDATE stack_log
   SET priced_version = 1
 WHERE day = DATE '2026-09-12'
   AND logged_at < TIMESTAMPTZ '2026-09-12 05:00:00+00';

CREATE INDEX IF NOT EXISTS stack_log_priced_idx ON stack_log (priced_version, day DESC);
