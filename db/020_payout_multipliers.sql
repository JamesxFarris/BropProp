-- Put the books' own PAYOUT multipliers on the line, where they publish them.
--
-- Two different things wear the word "multiplier", and conflating them would
-- quietly mis-price every slip:
--
--   over_multiplier / under_multiplier  — Underdog's, RELATIVE to a standard
--     leg (1.09, 0.87, or 1.0 when the line is balanced). An entry's payout is
--     the book's base for that leg count TIMES the product of these.
--   payout_over / payout_under          — Sleeper's, the WHOLE payout for that
--     pick (1.86, 2.26, 1.45). There is no base ladder: an entry pays the
--     product of its picks' own multipliers.
--
-- Sleeper's were deliberately kept out of `over_multiplier` when the adapter
-- was written, for exactly this reason — a 1.86 read as "relative to standard"
-- would tell the optimiser a Sleeper leg pays 1.86 standard legs. They have
-- simply had nowhere to live since, so the board never saw them and a Sleeper
-- stack's payout had to be typed in by hand. It is published; it should be
-- read.
--
-- PrizePicks publishes neither: its partner feed carries odds_type
-- (standard/demon/goblin), promo flags and a flash-sale line, and no payout
-- field anywhere in the projection or its included resources. Verified against
-- the live feed 2026-09-12. Its entry multiplier — including the discount for
-- a correlated slip — exists only inside the entry builder, so it stays a
-- number the reader records.
--
-- Columns are APPENDED: CREATE OR REPLACE VIEW can add at the end but cannot
-- remove, rename or reorder.
CREATE OR REPLACE VIEW current_line AS
SELECT DISTINCT ON (s.prop_id)
       s.prop_id, p.book_id, b.code AS book, p.league, p.stat,
       p.map_start, p.map_end, p.variant, p.is_combo,
       pl.handle, pl.canon_handle, m.title AS match_title, m.scheduled_at,
       s.line, s.over_price, s.under_price, s.status, s.observed_at,
       p.last_seen_at,

       CASE WHEN b.prices_sides THEN s.over_price IS NOT NULL
            ELSE COALESCE(s.extra->>'allowed_wager_types', 'both') <> 'under'
       END AS over_ok,
       CASE WHEN b.prices_sides THEN s.under_price IS NOT NULL
            ELSE COALESCE(s.extra->>'allowed_wager_types', 'both') <> 'over'
       END AS under_ok,

       (s.extra->>'over_multiplier')::numeric  AS over_multiplier,
       (s.extra->>'under_multiplier')::numeric AS under_multiplier,

       t.name AS team_name,

       -- Appended: the whole-payout multipliers, where a book publishes them.
       -- Named generically because another book may start doing the same; the
       -- key it arrives under is the adapter's business, not the view's.
       (s.extra->>'sleeper_over_mult')::numeric  AS payout_over,
       (s.extra->>'sleeper_under_mult')::numeric AS payout_under
FROM prop_snapshot s
JOIN prop p   ON p.id = s.prop_id
JOIN book b   ON b.id = p.book_id
JOIN player pl ON pl.id = p.player_id
LEFT JOIN team t ON t.id = pl.team_id
LEFT JOIN match m ON m.id = p.match_id
ORDER BY s.prop_id, s.observed_at DESC;
