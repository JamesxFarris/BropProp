-- "Seen" must mean "we last confirmed this line is still on the board", not
-- "the line last changed". A stable line that we re-confirmed 30 seconds ago
-- was reading as hours stale, which is exactly backwards for a tool whose
-- value depends on knowing how current a number is.
-- Columns are appended, so dependent views keep working.
CREATE OR REPLACE VIEW current_line AS
SELECT DISTINCT ON (s.prop_id)
       s.prop_id, p.book_id, b.code AS book, p.league, p.stat,
       p.map_start, p.map_end, p.variant, p.is_combo,
       pl.handle, pl.canon_handle, m.title AS match_title, m.scheduled_at,
       s.line, s.over_price, s.under_price, s.status, s.observed_at,
       p.last_seen_at
FROM prop_snapshot s
JOIN prop p   ON p.id = s.prop_id
JOIN book b   ON b.id = p.book_id
JOIN player pl ON pl.id = p.player_id
LEFT JOIN match m ON m.id = p.match_id
ORDER BY s.prop_id, s.observed_at DESC;
