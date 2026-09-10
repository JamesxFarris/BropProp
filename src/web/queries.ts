import { q } from '../db.js';

// Only surface markets for matches that haven't already been played out.
// A six-hour grace window keeps in-progress series visible.
const LIVE_WINDOW = `(cl.scheduled_at IS NULL OR cl.scheduled_at > now() - interval '6 hours')`;

/**
 * The old `disagreements()` query lived here and has been removed.
 *
 * It self-joined PrizePicks against Underdog to find markets they priced
 * differently, which is the board's whole job and is now done in `boardq.ts`
 * over any number of books. Nothing called it. It is noted rather than simply
 * deleted because a two-book self-join is an easy thing to reinvent, and the
 * reason not to is that it cannot answer the question that matters — which
 * book is the outlier — without a third book to break the tie.
 */

export type Movement = {
  prop_id: number;
  handle: string;
  book: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
  opened: number;
  latest: number;
  move: number;
  observations: number;
  first_at: string;
  last_at: string;
  match_title: string | null;
};

/** Props whose line is not where it opened. This is the steam detector. */
export async function movements(league: string | null): Promise<Movement[]> {
  return q<Movement>(
    `WITH hist AS (
       SELECT prop_id, count(*) AS observations,
              (array_agg(line ORDER BY observed_at))[1] AS opened,
              (array_agg(line ORDER BY observed_at DESC))[1] AS latest,
              min(observed_at) AS first_at,
              max(observed_at) AS last_at
       FROM prop_snapshot GROUP BY prop_id HAVING count(*) > 1
     )
     SELECT h.prop_id, pl.handle, b.code AS book, p.league, p.stat, p.map_start, p.map_end,
            h.opened, h.latest, (h.latest - h.opened) AS move,
            h.observations, h.first_at, h.last_at, m.title AS match_title
     FROM hist h
     JOIN prop p    ON p.id = h.prop_id
     JOIN book b    ON b.id = p.book_id
     JOIN player pl ON pl.id = p.player_id
     LEFT JOIN match m ON m.id = p.match_id
     WHERE h.opened <> h.latest
       AND (m.scheduled_at IS NULL OR m.scheduled_at > now() - interval '6 hours')
       AND ($1::text IS NULL OR p.league = $1)
     ORDER BY abs(h.latest - h.opened) DESC, h.last_at DESC
     LIMIT 60`,
    [league],
  );
}

export type Health = {
  matched: number;
  books_live: number;
  last_poll: string | null;
  last_ok_poll: string | null;
  failing_books: string | null;
  props_tracked: number;
  snapshots: number;
  logging_since: string | null;
};

/**
 * Surfaced on the page rather than hidden in logs: a dashboard reading from a
 * logger that quietly stopped an hour ago looks exactly like a quiet board.
 */
export async function health(league: string | null): Promise<Health> {
  const rows = await q<Health>(
    `WITH cl AS (SELECT * FROM current_line),
     m AS (
       SELECT count(*) AS matched
       FROM (SELECT * FROM cl WHERE book='prizepicks' AND variant='standard' AND ${LIVE_WINDOW}) pp
       JOIN (SELECT * FROM cl WHERE book='underdog' AND ${LIVE_WINDOW}) ud
         ON pp.canon_handle=ud.canon_handle AND pp.league=ud.league AND pp.stat=ud.stat
        AND pp.map_start=ud.map_start AND pp.map_end=ud.map_end
       WHERE ($1::text IS NULL OR pp.league=$1)
     )
     SELECT (SELECT matched FROM m) AS matched,
            (SELECT count(DISTINCT book_code) FROM poll_run
              WHERE ok AND finished_at IS NOT NULL
                AND started_at > now() - interval '1 hour') AS books_live,
            (SELECT max(started_at) FROM poll_run) AS last_poll,
            (SELECT max(started_at) FROM poll_run WHERE ok) AS last_ok_poll,
            -- A book is "failing" only if it is failing NOW: its most recent
            -- finished run failed, or it has produced no successful run in an
            -- hour. Counting any failure in the window meant one run orphaned
            -- by a container restart poisoned the banner for the next hour
            -- while every poll since had succeeded — which trains you to
            -- ignore the one warning that should always be trusted.
            (SELECT string_agg(book_code, ', ') FROM (
               SELECT r.book_code
               FROM (SELECT DISTINCT book_code FROM poll_run
                      WHERE started_at > now() - interval '6 hours') r
               LEFT JOIN LATERAL (
                 SELECT ok FROM poll_run
                  WHERE book_code = r.book_code AND finished_at IS NOT NULL
                  ORDER BY started_at DESC LIMIT 1
               ) last ON true
               WHERE COALESCE(last.ok, false) = false
                  OR NOT EXISTS (
                       SELECT 1 FROM poll_run
                        WHERE book_code = r.book_code AND ok
                          AND started_at > now() - interval '1 hour')
             ) bad) AS failing_books,
            (SELECT count(*) FROM prop) AS props_tracked,
            (SELECT count(*) FROM prop_snapshot) AS snapshots,
            (SELECT min(observed_at) FROM prop_snapshot) AS logging_since`,
    [league],
  );
  return rows[0]!;
}

export async function leagues(): Promise<string[]> {
  const rows = await q<{ league: string }>(
    `SELECT DISTINCT league FROM prop ORDER BY league`,
  );
  return rows.map((r) => r.league);
}
