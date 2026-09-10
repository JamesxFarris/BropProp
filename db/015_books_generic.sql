-- Make side availability a rule about the DATA rather than about which two
-- books happen to exist.
--
-- `current_line` decided over_ok/under_ok with `CASE WHEN b.code = 'underdog'
-- THEN over_price IS NOT NULL ELSE <PrizePicks' allowed_wager_types>`. The
-- else-branch is the trap: a third book falls into it and gets read through
-- PrizePicks' payload shape, so a market it lists one way only would show a
-- take button for a side that cannot be placed. Offering an unplaceable side
-- is the specific bug 006 was written to stop.
--
-- The distinguishing fact is whether a book expresses price as ODDS or by
-- MOVING THE LINE, and that is a property of the book, so it is recorded on
-- the book. One row per book, set once by whoever adds the adapter — not
-- inferred per query, which would mean scanning prop_snapshot on every board
-- load to answer a question that never changes.
ALTER TABLE book ADD COLUMN IF NOT EXISTS prices_sides BOOLEAN NOT NULL DEFAULT false;

-- Underdog publishes genuine two-sided American odds and omits the side it
-- does not offer. PrizePicks cannot: it charges a flat multiplier on the whole
-- entry and shifts the line instead, so it says what it offers in
-- `allowed_wager_types` on the projection itself.
UPDATE book SET prices_sides = true  WHERE code = 'underdog';
UPDATE book SET prices_sides = false WHERE code = 'prizepicks';

-- Column list and order are unchanged from 006, so REPLACE is legal here.
CREATE OR REPLACE VIEW current_line AS
SELECT DISTINCT ON (s.prop_id)
       s.prop_id, p.book_id, b.code AS book, p.league, p.stat,
       p.map_start, p.map_end, p.variant, p.is_combo,
       pl.handle, pl.canon_handle, m.title AS match_title, m.scheduled_at,
       s.line, s.over_price, s.under_price, s.status, s.observed_at,
       p.last_seen_at,

       -- A book that prices sides tells you what it offers by which price it
       -- publishes. One that does not tells you in the payload, and a book
       -- that says nothing at all is offering both — which is what putting a
       -- market on a pick'em board means.
       CASE WHEN b.prices_sides THEN s.over_price IS NOT NULL
            ELSE COALESCE(s.extra->>'allowed_wager_types', 'both') <> 'under'
       END AS over_ok,
       CASE WHEN b.prices_sides THEN s.under_price IS NOT NULL
            ELSE COALESCE(s.extra->>'allowed_wager_types', 'both') <> 'over'
       END AS under_ok,

       (s.extra->>'over_multiplier')::numeric  AS over_multiplier,
       (s.extra->>'under_multiplier')::numeric AS under_multiplier
FROM prop_snapshot s
JOIN prop p   ON p.id = s.prop_id
JOIN book b   ON b.id = p.book_id
JOIN player pl ON pl.id = p.player_id
LEFT JOIN match m ON m.id = p.match_id
ORDER BY s.prop_id, s.observed_at DESC;

-- `cross_book_diff` named both books in its own body, so it could only ever
-- answer a two-book question — and it answered it as a self-join, which
-- silently drops a market the moment a third book prices it differently again.
--
-- Dropped rather than replaced: the column list changes shape entirely, and
-- CREATE OR REPLACE cannot remove a column. `npm run report` is the only
-- reader and is updated alongside this.
DROP VIEW IF EXISTS cross_book_diff;

-- One line per BOOK first, and only for markets still live.
--
-- The first draft grouped every prop ever logged. Run against production in a
-- rolled-back transaction on 2026-09-10 it reported tripp's kills as a 10-point
-- disagreement with low_book and high_book both "underdog": two Underdog props
-- for the same player from different matches, days apart, compared as though
-- they were two books quoting one market. Counting rows as "books" hid it.
CREATE VIEW cross_book_diff AS
WITH per_book AS (
  SELECT DISTINCT ON (canon_handle, league, stat, map_start, map_end, book)
         canon_handle, league, stat, map_start, map_end, book,
         handle, line, match_title, scheduled_at, observed_at
    FROM current_line
   WHERE variant = 'standard'
     AND (scheduled_at IS NULL OR scheduled_at > now() - interval '6 hours')
   ORDER BY canon_handle, league, stat, map_start, map_end, book, observed_at DESC
)
SELECT canon_handle, league, stat, map_start, map_end,
       max(handle)                             AS handle,
       count(*)                                AS books,
       min(line)                               AS low_line,
       max(line)                               AS high_line,
       max(line) - min(line)                   AS line_diff,
       (array_agg(book ORDER BY line))[1]      AS low_book,
       (array_agg(book ORDER BY line DESC))[1] AS high_book,
       max(match_title)                        AS match_title,
       min(scheduled_at)                       AS scheduled_at,
       max(observed_at)                        AS observed_at
FROM per_book
GROUP BY canon_handle, league, stat, map_start, map_end
HAVING count(*) > 1 AND max(line) <> min(line);
