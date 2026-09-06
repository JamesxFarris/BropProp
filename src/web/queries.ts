import { q } from '../db.js';

// Only surface markets for matches that haven't already been played out.
// A six-hour grace window keeps in-progress series visible.
const LIVE_WINDOW = `(cl.scheduled_at IS NULL OR cl.scheduled_at > now() - interval '6 hours')`;

export type Disagreement = {
  canon_handle: string;
  handle: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
  pp_line: number;
  ud_line: number;
  delta: number;
  ud_over_price: number | null;
  ud_under_price: number | null;
  match_title: string | null;
  scheduled_at: string | null;
  observed_at: string;
  confirmed_at: string;
};

/**
 * Same player, same stat, same map range, priced differently by the two books.
 * Restricted to PrizePicks' `standard` variant: goblin and demon lines are
 * deliberately shifted, so comparing them to Underdog would report a
 * disagreement that is really just a different product.
 */
export async function disagreements(league: string | null): Promise<Disagreement[]> {
  return q<Disagreement>(
    `WITH cl AS (SELECT * FROM current_line)
     SELECT pp.canon_handle, pp.handle, pp.league, pp.stat, pp.map_start, pp.map_end,
            pp.line AS pp_line, ud.line AS ud_line,
            (pp.line - ud.line) AS delta,
            ud.over_price AS ud_over_price, ud.under_price AS ud_under_price,
            COALESCE(pp.match_title, ud.match_title) AS match_title,
            COALESCE(pp.scheduled_at, ud.scheduled_at) AS scheduled_at,
            GREATEST(pp.observed_at, ud.observed_at) AS observed_at,
            -- The older of the two confirmations: a pair is only as fresh as
            -- its stalest side.
            LEAST(pp.last_seen_at, ud.last_seen_at) AS confirmed_at
     FROM (SELECT * FROM cl WHERE cl.book = 'prizepicks' AND cl.variant = 'standard' AND ${LIVE_WINDOW}) pp
     JOIN (SELECT * FROM cl WHERE cl.book = 'underdog' AND ${LIVE_WINDOW}) ud
       ON  pp.canon_handle = ud.canon_handle
       AND pp.league = ud.league AND pp.stat = ud.stat
       AND pp.map_start = ud.map_start AND pp.map_end = ud.map_end
     WHERE pp.line <> ud.line
       AND ($1::text IS NULL OR pp.league = $1)
     ORDER BY abs(pp.line - ud.line) DESC, pp.handle`,
    [league],
  );
}

export type Movement = {
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
     SELECT pl.handle, b.code AS book, p.league, p.stat, p.map_start, p.map_end,
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
            -- ok is false until a run finishes, so a poll in flight is not a
            -- failure — reporting it as one made the banner fire during every
            -- single poll. A run only counts as failed once it has finished
            -- unsuccessfully, or once it has been running long enough that the
            -- container was clearly killed mid-poll.
            (SELECT string_agg(DISTINCT book_code, ', ') FROM poll_run
              WHERE started_at > now() - interval '1 hour'
                AND ((finished_at IS NOT NULL AND NOT ok)
                  OR (finished_at IS NULL AND started_at < now() - interval '10 minutes'))
            ) AS failing_books,
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
