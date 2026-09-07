-- pick_detail predates the per-leg payout multiplier; expose it so the slip can
-- work out what it will actually pay instead of assuming a standard rate.
-- Appended at the end: CREATE OR REPLACE VIEW can add columns but not reorder
-- the ones already there.
CREATE OR REPLACE VIEW pick_detail AS
SELECT p.id, p.slip_id, p.prop_id, p.side, p.line_at_pick, p.price_at_pick,
       p.book, p.status, p.actual_value, p.created_at,
       pl.handle, pl.canon_handle, pr.league, pr.stat,
       pr.map_start, pr.map_end, pr.variant,
       m.title AS match_title, m.scheduled_at,
       s.status AS slip_status, s.name AS slip_name, s.entry_type, s.stake,
       p.payout_mult
FROM pick p
JOIN prop pr   ON pr.id = p.prop_id
JOIN player pl ON pl.id = pr.player_id
JOIN slip s    ON s.id = p.slip_id
LEFT JOIN match m ON m.id = pr.match_id;
