import { q } from '../db.js';
import { markets } from '../web/boardq.js';
import { marketCandidates, findStacks, DEFAULT_SIZES } from '../web/optimize.js';
import { teamWinProbs } from '../web/matchodds.js';
import { KNOWN_BOOKS, type BookCode } from '../books.js';

/**
 * The forward record of the one shape this project thinks is +EV.
 *
 * Stacks are priced from measured correlation and a measured tail, not from a
 * projection: teammates' results move together (rho 0.324 over 8,923 series),
 * and after five teammates all clear their lines the opponent follows 87% of
 * the time. That says a five-plus-one hits roughly 8-11%, against a 22x quote
 * needing 4.5%. It rests on 60 series and one screenshot of a payout, which is
 * not enough to bet the house on — so every stack the Build page recommends is
 * written down here and graded when its matches finish.
 *
 * Two jobs:
 *  - `logStacks()` rebuilds exactly what Build shows and upserts today's row
 *    per stack. Unplayed recommendations count: the shape is what is being
 *    tested, and waiting only for placed slips would take months to say
 *    anything. Re-running in the same day corrects that day's row rather than
 *    adding a second opinion.
 *  - `gradeStacks()` settles each leg from the stat archive and applies the
 *    all-must-win rule, then links any placed slip so the app's own quoted
 *    multiplier — the half of the EV this project cannot compute — is stored
 *    beside the result.
 */

type LoggedLeg = {
  prop_id: number;
  canon: string;
  handle: string;
  stat: string;
  ms: number;
  me: number;
  line: number;
  side: 'over' | 'under';
  /** Kick-off in epoch ms, for the settlement window. Null when unknown. */
  sched: number | null;
};

/** Result of one leg once the stats are in. `open` means not settled yet. */
export type LegState = 'won' | 'lost' | 'push' | 'open';

/** Did this leg win at the line it was recommended at? */
export function legOutcome(total: number | null, line: number, side: 'over' | 'under'): LegState {
  if (total === null) return 'open';
  if (total === line) return 'push';
  const over = total > line;
  return (side === 'over' ? over : !over) ? 'won' : 'lost';
}

/**
 * The entry's outcome from its legs. All-must-win, so:
 *  - any lost leg settles the whole entry as lost, even with legs still open;
 *  - a push voids it (the apps refund or shrink the entry, so it is not a loss
 *    the shape should be judged on);
 *  - otherwise it waits until every leg is in.
 */
export function stackOutcome(legs: LegState[]): 'won' | 'lost' | 'void' | 'pending' {
  if (legs.some((l) => l === 'lost')) return 'lost';
  if (legs.some((l) => l === 'push')) return 'void';
  if (legs.some((l) => l === 'open')) return 'pending';
  return 'won';
}

const STAT_COLUMN: Record<string, string> = {
  kills: 'kills', headshots: 'headshots', assists: 'assists', deaths: 'deaths',
};

/** Rebuild the board's stacks and write today's row for each. */
export async function logStacks(): Promise<number> {
  const rows = await markets({ league: null, book: null, matched: false, search: null, best: false });
  if (rows.length === 0) return 0;

  const teams = [...new Set(rows.flatMap((r) => r.books.map((b) => b.team)).filter((t): t is string => Boolean(t)))];
  const teamOdds = await teamWinProbs(teams).catch(() => new Map());

  let written = 0;
  for (const book of KNOWN_BOOKS as readonly BookCode[]) {
    // Exactly what Build builds: both sides offered, same-side partners, the
    // measured tail doing the pricing.
    const pool = marketCandidates(rows, teamOdds, book, { bothSides: true });
    if (pool.length === 0) continue;
    for (const size of DEFAULT_SIZES) {
      for (const s of findStacks(pool, size, book).slice(0, 3)) {
        const legs: LoggedLeg[] = s.legs.map((l) => ({
          prop_id: l.propId,
          canon: l.row.canon_handle,
          handle: l.row.handle,
          stat: l.row.stat,
          ms: l.row.map_start,
          me: l.row.map_end,
          line: Number(l.play.line),
          side: l.play.side,
          sched: l.row.scheduled_at ? new Date(l.row.scheduled_at).getTime() : null,
        }));
        await q(
          `INSERT INTO stack_log (book, league, match_key, team, side, size, legs,
                                  win_prob, indep_prob, required_mult)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
           ON CONFLICT (day, book, match_key, team, side, size) DO UPDATE SET
             logged_at = now(), legs = EXCLUDED.legs, win_prob = EXCLUDED.win_prob,
             indep_prob = EXCLUDED.indep_prob, required_mult = EXCLUDED.required_mult
           WHERE stack_log.status = 'pending'`,
          [book, s.legs[0]?.row.league ?? null, s.matchKey, s.team, s.side, s.legs.length,
           JSON.stringify(legs), s.winProb, s.winProbIndependent, s.requiredMultiplier],
        );
        written++;
      }
    }
  }
  return written;
}

/**
 * Record what the app actually quoted for a stack.
 *
 * The multiplier is the half of the EV this project cannot compute: the apps
 * discount a correlated slip (a 6-pick spread across six teams paid the full
 * 37.5x, while five on one team was quoted 22x), and how steeply they discount
 * it decides whether a stack is a good bet. So a quote is worth storing even
 * when the slip is not placed — that is the only way the discount curve gets
 * learned.
 *
 * The row is keyed like the daily job's, so a quote lands on today's row for
 * that stack if the job already wrote one, and creates it otherwise. Legs are
 * rebuilt from the props themselves rather than trusted from the form, so a
 * captured row grades exactly like a logged one.
 */
export async function recordStackQuote(o: {
  book: string; matchKey: string; team: string; side: string; size: number;
  propIds: number[]; sides: string[];
  winProb: number | null; indepProb: number | null; requiredMult: number | null;
  quoted: number;
}): Promise<void> {
  if (!(o.quoted > 1) || o.propIds.length === 0) return;
  const props = await q<{
    prop_id: number; canon: string; handle: string; league: string; stat: string;
    ms: number; me: number; line: string | null; sched: string | null;
  }>(
    `SELECT p.id AS prop_id, pl.canon_handle AS canon, pl.handle, p.league, p.stat,
            p.map_start AS ms, p.map_end AS me,
            (SELECT ps.line::text FROM prop_snapshot ps
              WHERE ps.prop_id = p.id ORDER BY ps.observed_at DESC LIMIT 1) AS line,
            extract(epoch from m.scheduled_at) * 1000 AS sched
       FROM prop p
       JOIN player pl ON pl.id = p.player_id
       LEFT JOIN match m ON m.id = p.match_id
      WHERE p.id = ANY($1::int[])`,
    [o.propIds],
  );
  if (props.length === 0) return;
  const sideOf = new Map(o.propIds.map((id, i) => [id, o.sides[i] === 'under' ? 'under' : 'over']));
  const legs = props.map((p) => ({
    prop_id: p.prop_id, canon: p.canon, handle: p.handle, stat: p.stat,
    ms: p.ms, me: p.me, line: p.line === null ? 0 : Number(p.line),
    side: sideOf.get(p.prop_id) ?? 'over',
    sched: p.sched === null ? null : Number(p.sched),
  }));
  await q(
    `INSERT INTO stack_log (book, league, match_key, team, side, size, legs,
                            win_prob, indep_prob, required_mult, quoted_mult)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     ON CONFLICT (day, book, match_key, team, side, size) DO UPDATE SET
       quoted_mult = EXCLUDED.quoted_mult, logged_at = now()`,
    [o.book, props[0]!.league, o.matchKey, o.team, o.side, o.size, JSON.stringify(legs),
     o.winProb, o.indepProb, o.requiredMult, o.quoted],
  );
}

const H = 3600e3;

/** Settle every stack whose matches have finished, and link any placed slip. */
export async function gradeStacks(): Promise<{ graded: number; pending: number }> {
  const pending = await q<{ id: number; league: string | null; legs: LoggedLeg[]; logged_at: string }>(
    `SELECT id, league, legs, logged_at FROM stack_log WHERE status = 'pending' ORDER BY id`,
  );
  let graded = 0;
  for (const row of pending) {
    const legs = row.legs;
    // A match needs time to finish and its stats time to land.
    const last = Math.max(...legs.map((l) => l.sched ?? 0));
    if (!Number.isFinite(last) || last === 0 || Date.now() - last < 6 * H) continue;

    const states: LegState[] = [];
    for (const leg of legs) {
      const col = STAT_COLUMN[leg.stat];
      if (!col || leg.sched === null) { states.push('open'); continue; }
      // The same window the rest of the project settles legs in, and the same
      // refusal: every map of the range must be present, or the leg is open.
      // `col` comes from the whitelist above, never from the row.
      const maps = await q<{ n: string; total: string | null }>(
        `SELECT count(*)::text AS n, sum(${col})::text AS total
           FROM map_stat_dedup
          WHERE canon_handle = $1
            AND ($2::text IS NULL OR league = $2)
            AND map_number BETWEEN $3 AND $4
            AND played_at BETWEEN to_timestamp($5 / 1000.0) - interval '3 hours'
                              AND to_timestamp($5 / 1000.0) + interval '12 hours'`,
        [leg.canon, row.league, leg.ms, leg.me, leg.sched],
      ).catch(() => []);
      // Every map of the range must be present, or the leg is still open: a
      // partial range is the difference between a loss and a void.
      const want = leg.me - leg.ms + 1;
      const got = maps[0] ? Number(maps[0].n) : 0;
      const total = maps[0]?.total == null ? null : Number(maps[0].total);
      states.push(got === want && total !== null ? legOutcome(total, leg.line, leg.side) : 'open');
    }

    const outcome = stackOutcome(states);
    // Stats can arrive late; give a stack a week before calling it unreadable.
    const stale = Date.now() - new Date(row.logged_at).getTime() > 7 * 24 * H;
    if (outcome === 'pending' && !stale) continue;

    await q(
      `UPDATE stack_log
          SET status = $2, legs_settled = $3, legs_won = $4, graded_at = now()
        WHERE id = $1`,
      [row.id, outcome === 'pending' ? 'ungradeable' : outcome,
       states.filter((s) => s !== 'open').length, states.filter((s) => s === 'won').length],
    );
    graded++;
  }

  await linkPlacedSlips();
  return { graded, pending: pending.length };
}

/**
 * Attach the multiplier the app actually quoted, where a slip was placed on
 * exactly a logged stack's legs.
 *
 * Matched on the set of props, not on the order they were taken in: the same
 * six legs are the same entry however they were added.
 */
async function linkPlacedSlips(): Promise<void> {
  await q(
    `UPDATE stack_log sl
        SET slip_id = m.slip_id, quoted_mult = m.payout_multiplier
       FROM (
         SELECT s.id AS slip_id, s.payout_multiplier,
                array_agg(p.prop_id ORDER BY p.prop_id) AS props
           FROM slip s JOIN pick p ON p.slip_id = s.id
          WHERE s.status <> 'open'
          GROUP BY s.id
       ) m
      WHERE sl.slip_id IS NULL
        AND m.props = (SELECT array_agg((l->>'prop_id')::int ORDER BY (l->>'prop_id')::int)
                         FROM jsonb_array_elements(sl.legs) l)`,
  );
}
