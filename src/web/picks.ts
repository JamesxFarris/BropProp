import { q, one, pool } from '../db.js';

export type BoardRow = {
  prop_id: number;
  book: string;
  league: string;
  handle: string;
  canon_handle: string;
  stat: string;
  map_start: number;
  map_end: number;
  variant: string;
  is_combo: boolean;
  line: number;
  over_price: number | null;
  under_price: number | null;
  match_title: string | null;
  scheduled_at: string | null;
  confirmed_at: string;
  other_line: number | null;
  picked_side: string | null;
};

/**
 * The full board, which is what you actually take props off.
 *
 * `other_line` is the same market on the opposite book when it exists, so the
 * cross-book gap is visible inline instead of forcing a jump to the
 * disagreements panel to check whether you're taking the better number.
 */
export async function board(league: string | null, bookFilter: string | null): Promise<BoardRow[]> {
  return q<BoardRow>(
    `WITH cl AS (
       SELECT * FROM current_line
       WHERE (scheduled_at IS NULL OR scheduled_at > now() - interval '6 hours')
     ),
     open_picks AS (
       SELECT pk.prop_id, pk.side FROM pick pk
       JOIN slip s ON s.id = pk.slip_id AND s.status = 'open'
     )
     SELECT c.prop_id, c.book, c.league, c.handle, c.canon_handle, c.stat,
            c.map_start, c.map_end, c.variant, c.is_combo, c.line, c.over_price, c.under_price,
            c.match_title, c.scheduled_at, c.last_seen_at AS confirmed_at,
            o.line AS other_line,
            op.side AS picked_side
     FROM cl c
     LEFT JOIN LATERAL (
       SELECT x.line FROM cl x
       WHERE x.canon_handle = c.canon_handle AND x.league = c.league
         AND x.stat = c.stat AND x.map_start = c.map_start AND x.map_end = c.map_end
         AND x.book <> c.book AND x.variant = 'standard'
         AND x.is_combo = c.is_combo
       LIMIT 1
     ) o ON true
     LEFT JOIN open_picks op ON op.prop_id = c.prop_id
     WHERE ($1::text IS NULL OR c.league = $1)
       AND ($2::text IS NULL OR c.book = $2)
       AND c.variant = 'standard'
     ORDER BY c.scheduled_at NULLS LAST, c.handle, c.stat, c.book`,
    [league, bookFilter],
  );
}

/**
 * Exactly one slip is open at a time (enforced by a partial unique index), so
 * "add this prop" never has to ask which slip you meant.
 */
export async function openSlip(): Promise<{ id: number }> {
  const existing = await one<{ id: number }>(`SELECT id FROM slip WHERE status = 'open' LIMIT 1`);
  if (existing) return existing;
  const created = await one<{ id: number }>(
    `INSERT INTO slip (status) VALUES ('open') RETURNING id`,
  );
  return created!;
}

/**
 * Copy the line as it stands right now onto the pick. Never join to the live
 * line later — the board moves, and a pick has to remember the number it was
 * actually taken at or every future backtest is measuring the wrong thing.
 */
export async function addPick(propId: number, side: 'over' | 'under'): Promise<void> {
  const line = await one<{ line: number; over_price: number | null; under_price: number | null; book: string }>(
    `SELECT line, over_price, under_price, book FROM current_line WHERE prop_id = $1`,
    [propId],
  );
  if (!line) throw new Error(`no current line for prop ${propId}`);

  const slip = await openSlip();
  await q(
    `INSERT INTO pick (slip_id, prop_id, side, line_at_pick, price_at_pick, book)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (slip_id, prop_id) DO UPDATE
       SET side = EXCLUDED.side,
           line_at_pick = EXCLUDED.line_at_pick,
           price_at_pick = EXCLUDED.price_at_pick`,
    [slip.id, propId, side, line.line, side === 'over' ? line.over_price : line.under_price, line.book],
  );
}

export async function removePick(pickId: number): Promise<void> {
  await q(`DELETE FROM pick WHERE id = $1 AND slip_id IN (SELECT id FROM slip WHERE status='open')`, [pickId]);
}

export async function clearOpenSlip(): Promise<void> {
  await q(`DELETE FROM slip WHERE status = 'open'`);
}

export type PickRow = {
  id: number;
  prop_id: number;
  side: string;
  line_at_pick: number;
  price_at_pick: number | null;
  book: string;
  handle: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
  match_title: string | null;
  scheduled_at: string | null;
  status: string;
  current_line: number | null;
};

/** Open picks, each showing whether the line has moved since it was taken. */
export async function openPicks(): Promise<PickRow[]> {
  return q<PickRow>(
    `SELECT d.id, d.prop_id, d.side, d.line_at_pick, d.price_at_pick, d.book,
            d.handle, d.league, d.stat, d.map_start, d.map_end,
            d.match_title, d.scheduled_at, d.status,
            cl.line AS current_line
     FROM pick_detail d
     LEFT JOIN current_line cl ON cl.prop_id = d.prop_id
     WHERE d.slip_status = 'open'
     ORDER BY d.created_at`,
  );
}

/**
 * Lock the slip. Picks keep the line they were taken at; only the slip's
 * status changes, so a placed slip is an immutable record of a decision.
 */
export async function placeSlip(opts: {
  name: string | null;
  entryType: string;
  stake: number | null;
}): Promise<number | null> {
  const slip = await one<{ id: number; n: number }>(
    `SELECT s.id, count(p.id)::int AS n FROM slip s
     LEFT JOIN pick p ON p.slip_id = s.id
     WHERE s.status = 'open' GROUP BY s.id`,
  );
  if (!slip || slip.n === 0) return null;

  // A slip drawn from one book is that book's; mixing is legitimate for
  // comparison but is never a real entry, so label it honestly.
  const books = await q<{ book: string }>(`SELECT DISTINCT book FROM pick WHERE slip_id = $1`, [slip.id]);
  const book = books.length === 1 ? books[0]!.book : 'mixed';

  await q(
    `UPDATE slip SET status = 'placed', placed_at = now(),
                     name = $2, entry_type = $3, stake = $4, book = $5
      WHERE id = $1`,
    [slip.id, opts.name, opts.entryType, opts.stake, book],
  );
  return slip.id;
}

export type SlipSummary = {
  id: number;
  name: string | null;
  book: string | null;
  entry_type: string;
  stake: number | null;
  status: string;
  placed_at: string | null;
  legs: number;
  pending: number;
  won: number;
  lost: number;
};

export async function slips(limit = 40): Promise<SlipSummary[]> {
  return q<SlipSummary>(
    `SELECT s.id, s.name, s.book, s.entry_type, s.stake, s.status, s.placed_at,
            count(p.id)::int AS legs,
            count(*) FILTER (WHERE p.status = 'pending')::int AS pending,
            count(*) FILTER (WHERE p.status = 'won')::int     AS won,
            count(*) FILTER (WHERE p.status = 'lost')::int    AS lost
     FROM slip s LEFT JOIN pick p ON p.slip_id = s.id
     WHERE s.status <> 'open'
     GROUP BY s.id
     ORDER BY s.placed_at DESC NULLS LAST, s.id DESC
     LIMIT $1`,
    [limit],
  );
}

export async function slipPicks(slipIds: number[]): Promise<Record<number, PickRow[]>> {
  if (slipIds.length === 0) return {};
  const rows = await q<PickRow & { slip_id: number }>(
    `SELECT d.id, d.slip_id, d.prop_id, d.side, d.line_at_pick, d.price_at_pick, d.book,
            d.handle, d.league, d.stat, d.map_start, d.map_end,
            d.match_title, d.scheduled_at, d.status, NULL::numeric AS current_line
     FROM pick_detail d WHERE d.slip_id = ANY($1) ORDER BY d.created_at`,
    [slipIds],
  );
  const out: Record<number, PickRow[]> = {};
  for (const r of rows) (out[r.slip_id] ??= []).push(r);
  return out;
}

export { pool };
