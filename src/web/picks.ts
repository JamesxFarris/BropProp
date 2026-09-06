import { q, one, pool } from '../db.js';


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
  match_id: number | null;
};

/** Open picks, each showing whether the line has moved since it was taken. */
export async function openPicks(): Promise<PickRow[]> {
  return q<PickRow>(
    `SELECT d.id, d.prop_id, d.side, d.line_at_pick, d.price_at_pick, d.book,
            d.handle, d.league, d.stat, d.map_start, d.map_end,
            d.match_title, d.scheduled_at, d.status,
            cl.line AS current_line,
            pr.match_id
     FROM pick_detail d
     JOIN prop pr ON pr.id = d.prop_id
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
  multiplier: number | null;
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
                     name = $2, entry_type = $3, stake = $4, book = $5,
                     payout_multiplier = $6
      WHERE id = $1`,
    [slip.id, opts.name, opts.entryType, opts.stake, book, opts.multiplier],
  );
  return slip.id;
}

export type SlipSummary = {
  id: number;
  name: string | null;
  book: string | null;
  entry_type: string;
  stake: number | null;
  payout_multiplier: number | null;
  status: string;
  placed_at: string | null;
  legs: number;
  pending: number;
  won: number;
  lost: number;
};

export async function slips(limit = 40): Promise<SlipSummary[]> {
  return q<SlipSummary>(
    `SELECT s.id, s.name, s.book, s.entry_type, s.stake, s.payout_multiplier, s.status, s.placed_at,
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
            d.match_title, d.scheduled_at, d.status, NULL::numeric AS current_line,
            NULL::integer AS match_id
     FROM pick_detail d WHERE d.slip_id = ANY($1) ORDER BY d.created_at`,
    [slipIds],
  );
  const out: Record<number, PickRow[]> = {};
  for (const r of rows) (out[r.slip_id] ??= []).push(r);
  return out;
}

export { pool };
