-- Payout multiplier on the slip.
--
-- Stored per slip rather than derived from leg count at read time: the books
-- change their payout tables, and run promos. A slip has to remember the terms
-- it was actually placed under, for the same reason a pick remembers the line
-- it was taken at.
ALTER TABLE slip ADD COLUMN IF NOT EXISTS payout_multiplier NUMERIC(8,2);
