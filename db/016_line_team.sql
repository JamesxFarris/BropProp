-- Put the player's team on the line.
--
-- The correlation measured on 2026-09-10 is overwhelmingly a TEAMMATE effect:
-- over 8,923 independent CS2 series, teammate pairs came in at phi = 0.193
-- while opponent pairs managed 0.055. Copula rho 0.324 against 0.086 — nearly
-- four times the strength.
--
-- The slip maths cannot use that without knowing who plays for whom. Until now
-- `current_line` exposed no team at all, so `slip.ts` had to fall back to a
-- single blended correlation for any two legs in the same match, deliberately
-- set near the opponent figure because over-crediting correlation makes a slip
-- look better than it is. That fallback is the difference between a 6-pick
-- stack reading as 10.85x and reading as something far more pessimistic.
--
-- Columns are APPENDED. CREATE OR REPLACE VIEW can add a column at the end but
-- cannot remove, rename or reorder one — which is why 015 had to drop and
-- recreate cross_book_diff rather than replace it.
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

       -- Appended. Books name teams differently and a player's team_id is
       -- per-book, so the NAME is what survives a cross-book comparison — two
       -- books both call it "Team Spirit" while their internal ids differ.
       t.name AS team_name
FROM prop_snapshot s
JOIN prop p   ON p.id = s.prop_id
JOIN book b   ON b.id = p.book_id
JOIN player pl ON pl.id = p.player_id
LEFT JOIN team t ON t.id = pl.team_id
LEFT JOIN match m ON m.id = p.match_id
ORDER BY s.prop_id, s.observed_at DESC;
