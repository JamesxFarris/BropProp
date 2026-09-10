import type pg from 'pg';
import type { RawProp, RawTeam, RawMatch } from './adapters/types.js';
import { canonHandle } from './normalize.js';
import { bookMeta } from './books.js';

/**
 * The book's row id, creating the row the first time an adapter reports it.
 *
 * `prices_sides` comes from the registry in `books.ts` rather than from the
 * column default, and that matters more than it looks. `current_line` decides
 * which sides are takeable from that flag: a book that publishes odds says what
 * it offers by omitting a price, and a book that does not says so in its
 * payload. Defaulting a new book to false reads it through PrizePicks' payload
 * shape, and a book whose `allowed_wager_types` key simply does not exist would
 * then have both sides marked takeable — offering a bet that cannot be placed,
 * which is the exact bug migration 006 was written to stop.
 *
 * A book absent from the registry still gets false, which is right: a pick'em
 * app that quotes no odds is the common case, and the registry is where the
 * exception gets recorded.
 */
export async function bookId(c: pg.PoolClient, code: string): Promise<number> {
  const r = await c.query('SELECT id FROM book WHERE code = $1', [code]);
  if (r.rows[0]) return r.rows[0].id;
  const ins = await c.query(
    'INSERT INTO book (code, prices_sides) VALUES ($1, $2) RETURNING id',
    [code, bookMeta(code).pricesSides],
  );
  return ins.rows[0].id;
}

async function upsertTeam(c: pg.PoolClient, bid: number, t: RawTeam | null | undefined) {
  if (!t?.externalId) return null;
  const r = await c.query(
    `INSERT INTO team (book_id, external_id, name, abbr) VALUES ($1,$2,$3,$4)
     ON CONFLICT (book_id, external_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, team.name),
           abbr = COALESCE(EXCLUDED.abbr, team.abbr)
     RETURNING id`,
    [bid, t.externalId, t.name ?? null, t.abbr ?? null],
  );
  return r.rows[0].id as number;
}

async function upsertPlayer(c: pg.PoolClient, bid: number, p: RawProp['player'], league: string) {
  const teamId = await upsertTeam(c, bid, p.team);
  const r = await c.query(
    `INSERT INTO player (book_id, external_id, handle, canon_handle, league, team_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (book_id, external_id) DO UPDATE
       SET handle = EXCLUDED.handle,
           canon_handle = EXCLUDED.canon_handle,
           team_id = COALESCE(EXCLUDED.team_id, player.team_id)
     RETURNING id`,
    [bid, p.externalId, p.handle, canonHandle(p.handle), league, teamId],
  );
  return r.rows[0].id as number;
}

async function upsertMatch(c: pg.PoolClient, bid: number, m: RawMatch | null) {
  if (!m?.externalId) return null;
  const home = await upsertTeam(c, bid, m.home);
  const away = await upsertTeam(c, bid, m.away);
  const r = await c.query(
    `INSERT INTO match (book_id, external_id, league, title, home_team_id, away_team_id, scheduled_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (book_id, external_id) DO UPDATE
       SET title        = COALESCE(EXCLUDED.title, match.title),
           scheduled_at = COALESCE(EXCLUDED.scheduled_at, match.scheduled_at),
           status       = COALESCE(EXCLUDED.status, match.status),
           home_team_id = COALESCE(EXCLUDED.home_team_id, match.home_team_id),
           away_team_id = COALESCE(EXCLUDED.away_team_id, match.away_team_id)
     RETURNING id`,
    [bid, m.externalId, m.league, m.title ?? null, home, away, m.scheduledAt ?? null, m.status ?? null],
  );
  return r.rows[0].id as number;
}

/**
 * Persist one poll's worth of props.
 *
 * Snapshots are written only when something actually moved. A poll where the
 * board is unchanged costs one last_seen_at bump per prop and zero snapshot
 * rows, which is what keeps a 15-minute cadence from writing ~46k dead rows a
 * day while still recording every real line movement to the second.
 */
export async function persistProps(
  c: pg.PoolClient,
  bookCode: string,
  props: RawProp[],
  pollRunId: number,
): Promise<{ propsSeen: number; snapsWritten: number }> {
  const bid = await bookId(c, bookCode);
  let snaps = 0;

  for (const p of props) {
    const playerId = await upsertPlayer(c, bid, p.player, p.league);
    const matchId = await upsertMatch(c, bid, p.match);

    const propRow = await c.query(
      `INSERT INTO prop (book_id, external_id, player_id, match_id, league, stat,
                         map_start, map_end, is_combo, variant, display_stat, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (book_id, player_id, match_id, stat, map_start, map_end, variant, is_combo)
       DO UPDATE SET last_seen_at = now(),
                     external_id  = EXCLUDED.external_id,
                     display_stat = EXCLUDED.display_stat
       RETURNING id`,
      [bid, p.externalId, playerId, matchId, p.league, p.stat, p.mapStart, p.mapEnd,
       p.isCombo, p.variant, p.displayStat],
    );
    const propId = propRow.rows[0].id as number;

    const prev = await c.query(
      `SELECT line, over_price, under_price, status
         FROM prop_snapshot WHERE prop_id = $1 ORDER BY observed_at DESC LIMIT 1`,
      [propId],
    );
    const last = prev.rows[0];
    const changed =
      !last ||
      Number(last.line) !== Number(p.line) ||
      (last.over_price ?? null) !== (p.overPrice ?? null) ||
      (last.under_price ?? null) !== (p.underPrice ?? null) ||
      (last.status ?? null) !== (p.status ?? null);

    if (changed) {
      await c.query(
        `INSERT INTO prop_snapshot (prop_id, poll_run_id, line, over_price, under_price, status, is_live, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [propId, pollRunId, p.line, p.overPrice, p.underPrice, p.status, p.isLive, p.extra ?? {}],
      );
      snaps++;
    }
  }

  return { propsSeen: props.length, snapsWritten: snaps };
}

export async function getLeagueRefs(c: pg.PoolClient, bookCode: string, leagues: string[]) {
  const r = await c.query(
    `SELECT league, external_id FROM league_ref WHERE book_code = $1 AND league = ANY($2)`,
    [bookCode, leagues],
  );
  return r.rows.map((x) => ({ league: x.league as string, externalId: x.external_id as string }));
}

export async function saveLeagueRefs(
  c: pg.PoolClient,
  bookCode: string,
  found: Record<string, { id: string; name: string }>,
) {
  for (const [league, v] of Object.entries(found)) {
    await c.query(
      `INSERT INTO league_ref (book_code, league, external_id, external_name, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (book_code, league) DO UPDATE
         SET external_id = EXCLUDED.external_id,
             external_name = EXCLUDED.external_name,
             updated_at = now()`,
      [bookCode, league, v.id, v.name],
    );
  }
}
