import { q } from '../db.js';
import type { BookCode } from '../books.js';

/**
 * One row per MARKET, with every book that prices it nested inside.
 *
 * The old shape pivoted books into fixed columns — `pp_line`, `ud_line`,
 * `ud_over_price` — which made "there are exactly two books" a fact about the
 * type, repeated at sixty-nine call sites. Every DFS comparison tool worth
 * copying works by consensus across MANY books, and a consensus needs at least
 * three: the median of two numbers is their midpoint, and which of the two is
 * the outlier is undefined. A pivot cannot express that, so it had to go.
 *
 * The pairing is still the point of the row — the comparison is the row, not
 * the book. What changed is that the row now holds a list.
 */
export type BookLine = {
  book: BookCode;
  prop_id: number;
  line: number;
  over_price: number | null;
  under_price: number | null;
  /** Some markets are listed one way only; offering the missing side is offering an unplaceable bet. */
  over_ok: boolean;
  under_ok: boolean;
  /** Underdog pays some legs below a standard one. Null where a book doesn't say. */
  over_mult: number | null;
  under_mult: number | null;
  /**
   * The WHOLE payout for this pick, where the book publishes one — Sleeper's
   * 1.86 or 2.26. Not the same thing as `over_mult` above: that is relative to
   * a standard leg and needs the book's base ladder, this needs nothing. An
   * entry made of picks like these pays the product of them, which is why a
   * Sleeper stack can be priced without anyone typing a quote.
   */
  payout_over?: number | null;
  payout_under?: number | null;
  /** Total drift since this prop was first logged. */
  moved: number | null;
  /** The most recent single step, and when — for the stale-line signal. */
  last_move: number | null;
  last_move_at: string | null;
  /** Side of an open pick on this prop, if there is one. */
  side: string | null;
  /**
   * The player's team, as the book names it.
   *
   * Teammates correlate roughly four times as strongly as opponents, so this is
   * what lets the slip maths tell a genuine stack from an assortment.
   */
  team: string | null;
};

export type MarketRow = {
  canon_handle: string;
  handle: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
  is_combo: boolean;

  /** Every book pricing this market, in a stable order. Never empty. */
  books: BookLine[];

  /**
   * Widest disagreement on the row: highest line minus lowest.
   *
   * Replaces the old signed `pp_line - ud_line`. A signed difference only has
   * a meaning once you know which book is which way round, which is exactly
   * the assumption being removed. Direction now comes from comparing a book
   * against the others in `books`, which works for any number of them.
   */
  spread: number | null;

  match_title: string | null;
  scheduled_at: string | null;
  confirmed_at: string;
};

/**
 * `best` drops markets where the selected app has no price advantage.
 *
 * "Better on PrizePicks" is a property of a SIDE, not of a prop: if PP posts
 * 28.0 and another book 30.5, PP is better for the over (cheaper line) and the
 * other is better for the under (more room). So a market where lines differ
 * favours the selected app on exactly one side, and a market where every book
 * agrees favours it on neither — those are the ones worth hiding, along with
 * nothing else. Markets no other app lists are kept: no comparison exists, so
 * they can't be called worse.
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
            - (array_agg(line ORDER BY observed_at))[1] AS moved,
              -- The most recent step on its own, and when it happened.
              -- Snapshots are change-detected, so consecutive rows are real
              -- moves and the newest timestamp IS when this line last changed.
              -- Total drift says where a line ended up; this says whether it
              -- moved five minutes ago, which is the part that is actionable.
              (array_agg(line ORDER BY observed_at DESC))[1]
            - (array_agg(line ORDER BY observed_at DESC))[2] AS last_move,
              (array_agg(observed_at ORDER BY observed_at DESC))[1] AS last_move_at
       FROM prop_snapshot GROUP BY prop_id HAVING count(*) > 1
     ),
     -- One row per market per BOOK.
     --
     -- DISTINCT ON matters here. A book can list the same market twice, and the
     -- old pivot took max(line) and max(prop_id) as separate aggregates — which
     -- could return a line from one prop and the id of another, so the button
     -- staked a different number than the cell displayed. Picking a whole row
     -- keeps the line and the id that belong together, and the freshest
     -- observation is the one the board should be showing anyway.
     bl AS (
       SELECT DISTINCT ON (c.canon_handle, c.league, c.stat, c.map_start, c.map_end, c.book)
              c.canon_handle, c.league, c.stat, c.map_start, c.map_end,
              c.book, c.prop_id, c.line, c.is_combo, c.handle,
              c.match_title, c.scheduled_at, c.last_seen_at,
              c.over_price, c.under_price, c.over_ok, c.under_ok,
              c.over_multiplier, c.under_multiplier, c.team_name,
              c.payout_over, c.payout_under,
              -- Selected because it is ordered on. Nothing downstream reads
              -- it; leaving it out of the list is the kind of thing that works
              -- until a Postgres upgrade decides it shouldn't.
              c.observed_at,
              mv.moved, mv.last_move, mv.last_move_at, op.side
       FROM cl c
       LEFT JOIN moves mv ON mv.prop_id = c.prop_id
       LEFT JOIN open_picks op ON op.prop_id = c.prop_id
       ORDER BY c.canon_handle, c.league, c.stat, c.map_start, c.map_end, c.book,
                c.observed_at DESC, c.prop_id DESC
     ),
     m AS (
       SELECT b.canon_handle, b.league, b.stat, b.map_start, b.map_end,
              -- NOT a grouping key. A combo's canon_handle is the members run
              -- together ("binxunknight") and can't collide with a real
              -- player's, so grouping by it already keeps combos separate.
              -- Grouping by the flag as well only splits a market in two when
              -- the books disagree about it — which they do: PrizePicks marks
              -- the CS2 player eraa a combo and Underdog lists the same kills
              -- market as an ordinary player, so the pair never met and the
              -- board showed two half-rows with no gap between them.
              bool_or(b.is_combo)   AS is_combo,
              max(b.handle)         AS handle,
              max(b.match_title)    AS match_title,
              min(b.scheduled_at)   AS scheduled_at,
              min(b.last_seen_at)   AS confirmed_at,
              count(*)              AS n_books,
              -- NULL, not zero, when only one book prices it. With one line
              -- there is no disagreement to measure, and "max - min = 0" would
              -- render as "same" — telling the reader the books agree about a
              -- market only one of them has heard of.
              CASE WHEN count(*) > 1 THEN max(b.line) - min(b.line) END AS spread,
              count(*) FILTER (WHERE b.book = $2) > 0    AS has_sel,
              json_agg(json_build_object(
                'book',          b.book,
                'prop_id',       b.prop_id,
                'line',          b.line::float8,
                'over_price',    b.over_price,
                'under_price',   b.under_price,
                'over_ok',       b.over_ok,
                'under_ok',      b.under_ok,
                'over_mult',     b.over_multiplier::float8,
                'under_mult',    b.under_multiplier::float8,
                'payout_over',   b.payout_over::float8,
                'payout_under',  b.payout_under::float8,
                'moved',         b.moved::float8,
                'last_move',     b.last_move::float8,
                'last_move_at',  b.last_move_at,
                'side',          b.side,
                'team',          b.team_name
              ) ORDER BY b.book)                         AS books
       FROM bl b
       GROUP BY b.canon_handle, b.league, b.stat, b.map_start, b.map_end
     )
     SELECT m.canon_handle, m.league, m.stat, m.map_start, m.map_end,
            m.is_combo, m.handle, m.match_title, m.scheduled_at, m.confirmed_at,
            m.books, m.spread::float8 AS spread
     FROM m
     WHERE ($1::text IS NULL OR m.league = $1)
       AND ($2::text IS NULL OR m.has_sel)
       AND (NOT $3::boolean OR m.n_books > 1)
       AND ($4::text IS NULL OR m.handle ILIKE '%' || $4 || '%'
            OR m.match_title ILIKE '%' || $4 || '%')
       -- "No price advantage" generalises to "every book pricing this market
       -- agrees with the selected one". With only one book listing it there is
       -- no comparison to lose, so the market is kept.
       AND (NOT $5::boolean OR $2::text IS NULL
            OR m.n_books = 1 OR m.spread > 0)
     ORDER BY (m.spread > 0) DESC NULLS LAST,
              m.spread DESC NULLS LAST,
              m.scheduled_at NULLS LAST, m.handle, m.stat`,
    [opts.league, opts.book, opts.matched, opts.search, opts.best ?? false],
  );
}

export type HistoryPoint = { observed_at: string; line: number; over_price: number | null };

export type PropHistory = {
  prop_id: number;
  handle: string;
  canon_handle: string;
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
    `SELECT p.id AS prop_id, pl.handle, pl.canon_handle, p.league, p.stat,
            p.map_start, p.map_end,
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


/**
 * A player's recent series, for the exact market being viewed.
 *
 * Built to survive the data changing underneath it, which it will:
 *
 * - Sources come and go, so rows are keyed only by canon_handle and league.
 *   Nothing here parses a series key or assumes which source produced it.
 * - Map counts vary by format, so the range is measured per series rather
 *   than assumed. A series that didn't play the whole range is returned and
 *   labelled, not silently dropped and not silently summed short — the same
 *   rule grading uses, so the page can't disagree with the grader.
 * - A player with no rows returns an empty list, never an error. New names
 *   appear on the board constantly and must render as "nothing yet" rather
 *   than breaking the page they're on.
 */
export type PlayerGame = {
  series_key: string;
  played_at: string | null;
  team: string | null;
  values: number[] | null;   // the stat, map by map, within the range
  maps_in_range: number;
  maps_total: number;
  total: number | null;      // null when the range wasn't completed
};

const GAME_STAT_COLUMN: Record<string, string> = {
  kills: 'kills', headshots: 'headshots', assists: 'assists', deaths: 'deaths',
};

export async function playerGames(opts: {
  canonHandle: string;
  league: string;
  stat: string;
  mapStart: number;
  mapEnd: number;
  limit?: number;
}): Promise<PlayerGame[]> {
  const col = GAME_STAT_COLUMN[opts.stat];
  // Fantasy points have no stored column; say nothing rather than guess.
  if (!col) return [];

  return q<PlayerGame>(
    `WITH s AS (
       SELECT series_key,
              max(played_at) AS played_at,
              max(team)      AS team,
              count(*)                                                     AS maps_total,
              count(*) FILTER (WHERE map_number BETWEEN $3 AND $4)          AS maps_in_range,
              array_agg(${col} ORDER BY map_number)
                FILTER (WHERE map_number BETWEEN $3 AND $4)                 AS values,
              sum(${col}) FILTER (WHERE map_number BETWEEN $3 AND $4)       AS range_total
       FROM map_stat_dedup
       WHERE canon_handle = $1 AND league = $2 AND ${col} IS NOT NULL
       GROUP BY series_key
     )
     SELECT series_key, played_at, team, values, maps_in_range, maps_total,
            CASE WHEN maps_in_range = $5 THEN range_total ELSE NULL END AS total
     FROM s
     ORDER BY played_at DESC NULLS LAST
     LIMIT $6`,
    [opts.canonHandle, opts.league, opts.mapStart, opts.mapEnd,
     opts.mapEnd - opts.mapStart + 1, opts.limit ?? 12],
  );
}
