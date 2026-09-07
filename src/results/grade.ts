import { q, one } from '../db.js';
import { SUPPORTED_STATS } from './types.js';
import { comboParts } from '../normalize.js';
import { comboRangeTotal, type ComboStatRow } from '../combo.js';

/**
 * Grading, and the rules it refuses to bend.
 *
 * A prop is "Kills on maps 1-2": the sum of that player's kills across maps 1
 * and 2 of the series they played. Three things decide whether it can be
 * graded at all:
 *
 *  1. Every map in the range must have been played. A Bo3 that ends 2-0 never
 *     plays map 3, so a "maps 1-3" prop is VOID, not a two-map total. Summing
 *     what happened to exist would invent a result the book would refund.
 *  2. The source must actually produce that stat. Leaguepedia has no headshots
 *     and no published fantasy-point formula, so those are `ungradeable` with
 *     a reason rather than scored from a guess.
 *  3. Combo props are several players added together, so their result is the
 *     sum of their members' totals over the range. That used to be refused
 *     outright for want of per-map stats; both games now have them, so a combo
 *     grades from the same rows as everything else — with rules 1 and 2
 *     applied member by member. See `src/combo.ts`. A combo whose handle can't
 *     be split into players is still refused rather than guessed at.
 */

export type GradeOutcome = {
  pickId: number;
  status: 'won' | 'lost' | 'push' | 'void' | 'ungradeable';
  actual: number | null;
  note: string;
  source: string | null;
  seriesKey: string | null;
};

type PendingPick = {
  id: number;
  canon_handle: string;
  handle: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
  is_combo: boolean;
  side: string;
  line_at_pick: number;
  scheduled_at: string | null;
  match_title: string | null;
};

const STAT_COLUMN: Record<string, string> = {
  kills: 'kills', headshots: 'headshots', assists: 'assists', deaths: 'deaths',
};

/**
 * Picks worth attempting: still pending, on a placed slip, and belonging to a
 * match that has had time to finish. The 90-minute floor keeps the grader from
 * calling a series void while it is still being played.
 */
export async function pendingPicks(): Promise<PendingPick[]> {
  return q<PendingPick>(
    `SELECT p.id, pl.canon_handle, pl.handle, pr.league, pr.stat,
            pr.map_start, pr.map_end, pr.is_combo,
            p.side, p.line_at_pick, m.scheduled_at, m.title AS match_title
     FROM pick p
     JOIN slip s    ON s.id = p.slip_id AND s.status <> 'open'
     JOIN prop pr   ON pr.id = p.prop_id
     JOIN player pl ON pl.id = pr.player_id
     LEFT JOIN match m ON m.id = pr.match_id
     WHERE p.status = 'pending'
       AND (m.scheduled_at IS NULL OR m.scheduled_at < now() - interval '90 minutes')
     ORDER BY m.scheduled_at NULLS LAST`,
  );
}

/**
 * Find the series this pick belongs to.
 *
 * Matching on player + time window rather than on match identity: our match
 * titles come from the books ("BetBoom vs BIG") and the sources name events
 * their own way, so title matching would be a fuzzy string fight. A player is
 * only in one series at a time, so the window is unambiguous — and when it
 * isn't, the closest series to the scheduled start wins.
 */
async function findSeries(p: PendingPick): Promise<string | null> {
  const anchor = p.scheduled_at;
  const row = await one<{ series_key: string }>(
    `SELECT series_key
     FROM map_stat
     WHERE canon_handle = $1 AND league = $2
       AND ($3::timestamptz IS NULL
            OR played_at BETWEEN $3::timestamptz - interval '3 hours'
                             AND $3::timestamptz + interval '12 hours')
     GROUP BY series_key
     ORDER BY min(abs(extract(epoch from (played_at - COALESCE($3::timestamptz, played_at)))))
     LIMIT 1`,
    [p.canon_handle, p.league, anchor],
  );
  return row?.series_key ?? null;
}

/**
 * The series a combo belongs to: the one where EVERY member has a stat line,
 * inside the same window a single-player pick uses.
 *
 * `HAVING count(DISTINCT canon_handle) = $n` is the weakest-link rule stated
 * once. A series where two of three members are recorded is not a combo
 * series, and picking it would send `comboRangeTotal` a set of rows it would
 * have to refuse anyway — better to say "no stat line found" than to void a
 * prop whose maps were all played.
 */
async function findComboSeries(p: PendingPick, parts: string[]): Promise<string | null> {
  const anchor = p.scheduled_at;
  const row = await one<{ series_key: string }>(
    `SELECT series_key
     FROM map_stat
     WHERE canon_handle = ANY($1::text[]) AND league = $2
       AND ($3::timestamptz IS NULL
            OR played_at BETWEEN $3::timestamptz - interval '3 hours'
                             AND $3::timestamptz + interval '12 hours')
     GROUP BY series_key
     HAVING count(DISTINCT canon_handle) = $4
     ORDER BY min(abs(extract(epoch from (played_at - COALESCE($3::timestamptz, played_at)))))
     LIMIT 1`,
    [parts, p.league, anchor, parts.length],
  );
  return row?.series_key ?? null;
}

async function gradeCombo(
  p: PendingPick,
  parts: string[],
  column: string,
): Promise<GradeOutcome> {
  const seriesKey = await findComboSeries(p, parts);
  if (!seriesKey) {
    return {
      pickId: p.id, status: 'ungradeable', actual: null, source: null, seriesKey: null,
      note: `No series found where all ${parts.length} players of ${p.handle} have stat lines.`,
    };
  }

  // Scoped to one series_key, which is a single source's own identifier, so
  // this can read map_stat directly without a second source's copy of the same
  // map doubling a member into the total.
  const rows = await q<ComboStatRow & { source: string }>(
    `SELECT series_key, map_number, canon_handle, played_at, source,
            ${column} AS value
     FROM map_stat
     WHERE series_key = $1 AND canon_handle = ANY($2::text[])
     ORDER BY map_number`,
    [seriesKey, parts],
  );
  const source = rows[0]?.source ?? null;

  const g = comboRangeTotal(parts, rows, p.map_start, p.map_end);
  if (g.kind === 'void') {
    return { pickId: p.id, status: 'void', actual: null, source, seriesKey, note: g.note };
  }
  if (g.kind === 'ungradeable') {
    return { pickId: p.id, status: 'ungradeable', actual: null, source, seriesKey, note: g.note };
  }

  const line = Number(p.line_at_pick);
  if (g.total === line) {
    return {
      pickId: p.id, status: 'push', actual: g.total, source, seriesKey,
      note: `Landed exactly on ${line}.`,
    };
  }
  const wentOver = g.total > line;
  const won = p.side === 'over' ? wentOver : !wentOver;
  return {
    pickId: p.id, status: won ? 'won' : 'lost', actual: g.total, source, seriesKey,
    note: `${parts.length} players totalled ${g.total} ${wentOver ? '>' : '<'} ${line} on maps ${p.map_start}-${p.map_end}.`,
  };
}

export async function gradePick(p: PendingPick): Promise<GradeOutcome> {
  const column = STAT_COLUMN[p.stat];

  // The handle decides, not the book's flag: PrizePicks sets `combo` on
  // single players too, and refusing those cost real markets a grade.
  const parts = comboParts(p.handle);
  if (parts.length > 1) {
    if (!column) {
      return {
        pickId: p.id, status: 'ungradeable', actual: null, source: null, seriesKey: null,
        note: `No result data maps to "${p.stat}". Fantasy points use a scoring formula the book doesn't publish.`,
      };
    }
    return gradeCombo(p, parts, column);
  }
  if (p.is_combo && /\+/.test(p.handle)) {
    // Flagged a combo, and the name has a separator we could not resolve into
    // distinct players. Guessing which players it means would grade money
    // against the wrong stat lines.
    return {
      pickId: p.id, status: 'ungradeable', actual: null, source: null, seriesKey: null,
      note: `Can't split "${p.handle}" into players, so there is nothing to add up.`,
    };
  }

  if (!column) {
    return {
      pickId: p.id, status: 'ungradeable', actual: null, source: null, seriesKey: null,
      note: `No result data maps to "${p.stat}". Fantasy points use a scoring formula the book doesn't publish.`,
    };
  }

  const seriesKey = await findSeries(p);
  if (!seriesKey) {
    return {
      pickId: p.id, status: 'ungradeable', actual: null, source: null, seriesKey: null,
      note: `No stat line found for ${p.handle} around this match.`,
    };
  }

  const maps = await q<{ map_number: number; value: number | null; source: string }>(
    `SELECT map_number, ${column} AS value, source
     FROM map_stat
     WHERE series_key = $1 AND canon_handle = $2
       AND map_number BETWEEN $3 AND $4
     ORDER BY map_number`,
    [seriesKey, p.canon_handle, p.map_start, p.map_end],
  );

  const source = maps[0]?.source ?? null;
  const wanted = p.map_end - p.map_start + 1;

  // Rule 1: the whole range must have been played.
  if (maps.length < wanted) {
    const played = maps.map((m) => m.map_number).join(', ') || 'none';
    return {
      pickId: p.id, status: 'void', actual: null, source, seriesKey,
      note: `Maps ${p.map_start}-${p.map_end} required, only ${played} played. Series ended early.`,
    };
  }

  // The source may know the map happened but not this stat for it.
  if (maps.some((m) => m.value === null)) {
    return {
      pickId: p.id, status: 'ungradeable', actual: null, source, seriesKey,
      note: `${source} has no ${p.stat} recorded for at least one map in the range.`,
    };
  }

  const actual = maps.reduce((sum, m) => sum + Number(m.value), 0);
  const line = Number(p.line_at_pick);

  if (actual === line) {
    return {
      pickId: p.id, status: 'push', actual, source, seriesKey,
      note: `Landed exactly on ${line}.`,
    };
  }
  const wentOver = actual > line;
  const won = p.side === 'over' ? wentOver : !wentOver;
  return {
    pickId: p.id, status: won ? 'won' : 'lost', actual, source, seriesKey,
    note: `${actual} ${wentOver ? '>' : '<'} ${line} on maps ${p.map_start}-${p.map_end}.`,
  };
}

export async function applyGrade(g: GradeOutcome): Promise<void> {
  await q(
    `UPDATE pick
        SET status = $2, actual_value = $3, grade_note = $4,
            grade_source = $5, series_key = $6, graded_at = now()
      WHERE id = $1`,
    [g.pickId, g.status, g.actual, g.note, g.source, g.seriesKey],
  );
}

/**
 * A slip settles once no leg is still pending. Void and ungradeable legs are
 * excluded from the win test rather than counted as losses — the books refund
 * them, so treating them as losses would understate results.
 */
export async function settleSlips(): Promise<number> {
  const rows = await q<{ id: number; status: string }>(
    `WITH agg AS (
       SELECT s.id,
              count(*) FILTER (WHERE p.status = 'pending')::int AS pending,
              count(*) FILTER (WHERE p.status = 'lost')::int    AS lost,
              count(*) FILTER (WHERE p.status = 'won')::int     AS won
       FROM slip s JOIN pick p ON p.slip_id = s.id
       WHERE s.status = 'placed'
       GROUP BY s.id
     )
     UPDATE slip s
        SET status = CASE WHEN agg.lost > 0 THEN 'lost'
                          WHEN agg.won > 0 THEN 'won'
                          ELSE 'void' END,
            settled_at = now()
       FROM agg
      WHERE s.id = agg.id AND agg.pending = 0
      RETURNING s.id, s.status`,
  );
  return rows.length;
}

export function statSupported(source: string, stat: string): boolean {
  return (SUPPORTED_STATS[source] ?? []).includes(stat);
}
