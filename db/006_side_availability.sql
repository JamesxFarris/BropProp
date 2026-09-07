-- Which sides can actually be taken, and what each leg pays.
--
-- Two things were being stored and never used:
--
--  1. Underdog lists some markets one way only — every LoL assists prop is
--     higher-only, with no lower option at all. Offering an under there is
--     offering a bet that cannot be placed.
--  2. Underdog attaches a payout multiplier to each side. A leg at 0.85 pays
--     less than a standard one, which is why a four-leg slip can pay 5.5x
--     instead of 10x. That is knowable, not something to type in by hand.

CREATE OR REPLACE VIEW current_line AS
SELECT DISTINCT ON (s.prop_id)
       s.prop_id, p.book_id, b.code AS book, p.league, p.stat,
       p.map_start, p.map_end, p.variant, p.is_combo,
       pl.handle, pl.canon_handle, m.title AS match_title, m.scheduled_at,
       s.line, s.over_price, s.under_price, s.status, s.observed_at,
       p.last_seen_at,

       -- Underdog publishes a price per side and omits the side it doesn't
       -- offer. PrizePicks prices by moving the line instead, so both sides
       -- exist unless it says otherwise on the projection itself.
       CASE WHEN b.code = 'underdog'
            THEN s.over_price IS NOT NULL
            ELSE COALESCE(s.extra->>'allowed_wager_types', 'both') <> 'under'
       END AS over_ok,
       CASE WHEN b.code = 'underdog'
            THEN s.under_price IS NOT NULL
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

-- What this leg pays relative to a standard one, recorded at pick time for the
-- same reason the line is: the book changes it, and a slip has to remember the
-- terms it was actually taken under.
ALTER TABLE pick ADD COLUMN IF NOT EXISTS payout_mult NUMERIC(6,3);
