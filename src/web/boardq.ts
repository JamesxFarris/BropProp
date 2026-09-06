import { q } from '../db.js';

/**
 * One row per MARKET, not per book.
 *
 * The old board listed each book separately, so the same player/stat appeared
 * twice and you had to hold both numbers in your head to see the gap. Pairing
 * them is the whole point of the product: the comparison is the row.
 */
export type MarketRow = {
  canon_handle: string;
  handle: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
  is_combo: boolean;

  pp_prop_id: number | null;
  pp_line: number | null;
  ud_prop_id: number | null;
  ud_line: number | null;
  ud_over_price: number | null;
  ud_under_price: number | null;

  delta: number | null;
  match_title: string | null;
  scheduled_at: string | null;
  confirmed_at: string;
  pp_side: string | null;
  ud_side: string | null;
  moved: number | null;
};

/**
 * `best` drops markets where the selected app has no price advantage.
 *
 * "Better on PrizePicks" is a property of a SIDE, not of a prop: if PP posts
 * 28.0 and UD 30.5, PP is better for the over (cheaper line) and UD is better
 * for the under (more room). So a market where the two lines differ always
 * favours the selected app on exactly one side, and a market where they match
 * favours it on neither — those are the ones worth hiding, along with nothing
 * else. Markets the other app doesn't list at all are kept: no comparison
 * exists, so they can't be called worse.
 */
export async function markets(opts: {
  league: string | null;
  book: string | null;
  matched: boolean;
  search: string | null;
  best?: boolean;
}): Promise<MarketRow[]> {
  return q<MarketRow>(
    `WITH cl AS (
       SELECT * FROM current_line
       WHERE variant = 'standard'
         AND (scheduled_at IS NULL OR scheduled_at > now() - interval '6 hours')
     ),
     open_picks AS (
       SELECT pk.prop_id, pk.side FROM pick pk
       JOIN slip s ON s.id = pk.slip_id AND s.status = 'open'
     ),
     -- How far each prop has travelled since it was first logged. Shown on the
     -- row so steam is visible without opening the history.
     moves AS (
       SELECT prop_id,
              (array_agg(line ORDER BY observed_at DESC))[1]
            - (array_agg(line ORDER BY observed_at))[1] AS moved
       FROM prop_snapshot GROUP BY prop_id HAVING count(*) > 1
     ),
     m AS (
       SELECT c.canon_handle, c.league, c.stat, c.map_start, c.map_end, c.is_combo,
              max(c.handle)                                          AS handle,
              max(c.match_title)                                     AS match_title,
              min(c.scheduled_at)                                    AS scheduled_at,
              min(c.last_seen_at)                                    AS confirmed_at,
              max(c.prop_id) FILTER (WHERE c.book = 'prizepicks')    AS pp_prop_id,
              max(c.line)    FILTER (WHERE c.book = 'prizepicks')    AS pp_line,
              max(c.prop_id) FILTER (WHERE c.book = 'underdog')      AS ud_prop_id,
              max(c.line)    FILTER (WHERE c.book = 'underdog')      AS ud_line,
              max(c.over_price)  FILTER (WHERE c.book = 'underdog')  AS ud_over_price,
              max(c.under_price) FILTER (WHERE c.book = 'underdog')  AS ud_under_price
       FROM cl c
       GROUP BY c.canon_handle, c.league, c.stat, c.map_start, c.map_end, c.is_combo
     )
     SELECT m.*,
            (m.pp_line - m.ud_line) AS delta,
            pp_pick.side AS pp_side,
            ud_pick.side AS ud_side,
            COALESCE(mv_pp.moved, mv_ud.moved) AS moved
     FROM m
     LEFT JOIN open_picks pp_pick ON pp_pick.prop_id = m.pp_prop_id
     LEFT JOIN open_picks ud_pick ON ud_pick.prop_id = m.ud_prop_id
     LEFT JOIN moves mv_pp ON mv_pp.prop_id = m.pp_prop_id
     LEFT JOIN moves mv_ud ON mv_ud.prop_id = m.ud_prop_id
     WHERE ($1::text IS NULL OR m.league = $1)
       AND ($2::text IS NULL
            OR ($2 = 'prizepicks' AND m.pp_prop_id IS NOT NULL)
            OR ($2 = 'underdog'   AND m.ud_prop_id IS NOT NULL))
       AND (NOT $3::boolean OR (m.pp_prop_id IS NOT NULL AND m.ud_prop_id IS NOT NULL))
       AND ($4::text IS NULL OR m.handle ILIKE '%' || $4 || '%'
            OR m.match_title ILIKE '%' || $4 || '%')
       AND (NOT $5::boolean OR $2::text IS NULL
            OR ($2 = 'prizepicks' AND (m.ud_line IS NULL OR m.pp_line <> m.ud_line))
            OR ($2 = 'underdog'   AND (m.pp_line IS NULL OR m.pp_line <> m.ud_line)))
     ORDER BY (m.pp_line IS NOT NULL AND m.ud_line IS NOT NULL
               AND m.pp_line <> m.ud_line) DESC,
              abs(COALESCE(m.pp_line - m.ud_line, 0)) DESC,
              m.scheduled_at NULLS LAST, m.handle, m.stat`,
    [opts.league, opts.book, opts.matched, opts.search, opts.best ?? false],
  );
}

export type HistoryPoint = { observed_at: string; line: number; over_price: number | null };

export type PropHistory = {
  prop_id: number;
  handle: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
  book: string;
  match_title: string | null;
  scheduled_at: string | null;
  points: HistoryPoint[];
};

/**
 * Every observed value for one prop. Snapshots are written only on change, so
 * this is the complete movement record — each point is a real move, not a
 * sample. Anything before logging began simply doesn't exist and isn't guessed.
 */
export async function propHistory(propId: number): Promise<PropHistory | null> {
  const head = await q<Omit<PropHistory, 'points'>>(
    `SELECT p.id AS prop_id, pl.handle, p.league, p.stat, p.map_start, p.map_end,
            b.code AS book, m.title AS match_title, m.scheduled_at
     FROM prop p
     JOIN player pl ON pl.id = p.player_id
     JOIN book b ON b.id = p.book_id
     LEFT JOIN match m ON m.id = p.match_id
     WHERE p.id = $1`,
    [propId],
  );
  if (!head[0]) return null;
  const points = await q<HistoryPoint>(
    `SELECT observed_at, line, over_price FROM prop_snapshot
     WHERE prop_id = $1 ORDER BY observed_at`,
    [propId],
  );
  return { ...head[0], points };
}

/** Sibling props for the same market, so history can link across books. */
export async function siblingProps(propId: number) {
  return q<{ prop_id: number; book: string; line: number }>(
    `WITH me AS (SELECT * FROM current_line WHERE prop_id = $1)
     SELECT c.prop_id, c.book, c.line FROM current_line c, me
     WHERE c.canon_handle = me.canon_handle AND c.league = me.league
       AND c.stat = me.stat AND c.map_start = me.map_start AND c.map_end = me.map_end
       AND c.variant = 'standard'
     ORDER BY c.book`,
    [propId],
  );
}
