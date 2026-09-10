import { q } from '../db.js';
import { teamIndex } from '../adapters/teamname.js';

/**
 * Turn the market's view of who wins into a probability for each player's under.
 *
 * Measured 2026-09-10 over 4,967 CS2 series with walk-forward lines
 * (`raw/blowout.mjs`), splitting every player-series by whether his team went
 * on to win or lose:
 *
 *   losing team's players   under 62.0%   (9,376)
 *   winning team's players  under 48.2%   (15,296)
 *
 * 4,180 independent series, 2613-1567, p < 0.000001.
 *
 * Those are rates CONDITIONAL on the result, which nobody knows in advance. A
 * moneyline gives the probability of each result, so the unconditional chance
 * of an under is the two rates mixed by that probability:
 *
 *   P(under) = P(team wins) · 0.482  +  P(team loses) · 0.620
 *
 * **A check that this is calibrated, not just plausible:** at a coin-flip match
 * the mixture gives 0.551. Measured directly against the books' own closing
 * lines, across 2,137 settled legs, the under won 55.3%. Two independent
 * measurements, one built from our line convention and one from theirs, agree
 * to within a fifth of a point. That is the strongest reason to trust the
 * mixture away from 50/50.
 *
 * What it is NOT: the 66% blowout figure. That band needs the margin, which is a
 * handicap question rather than a winner one, and it is left out until the
 * handicap outcomes have been parsed and checked the way the moneyline was.
 */
export const UNDER_IF_TEAM_WINS = 0.482;
export const UNDER_IF_TEAM_LOSES = 0.620;

/**
 * The under rate when there is no moneyline to go on.
 *
 * Measured against the books' OWN closing lines, 2,137 settled legs, 44.7%
 * over — 133 independent series, p = 0.0053. Both books, both stats, standard,
 * demon and goblin all between 43.9% and 45.7%. This is the line shade, and it
 * is the one number here that needs no model and no market to stand on.
 */
export const MEASURED_UNDER_BASELINE = 0.553;

/** P(a player on this team goes under), given P(this team wins the match). */
export function underProbForTeam(pTeamWins: number): number {
  const p = Math.min(1, Math.max(0, pTeamWins));
  return p * UNDER_IF_TEAM_WINS + (1 - p) * UNDER_IF_TEAM_LOSES;
}

export type TeamOdds = {
  /** P(this team wins), margin removed. */
  pWin: number;
  opponent: string;
  startsAt: string;
  /** How old the quote is, so a stale price can be shown as stale. */
  observedAt: string;
};

/**
 * The latest win probability for every team with an upcoming fixture.
 *
 * Keyed by OUR team name, as PrizePicks spells it, resolved through
 * `teamIndex` — exact after normalisation, never fuzzy, because attaching one
 * team's moneyline to another team's players would send a stack of unders onto
 * the favourite.
 */
export async function teamWinProbs(ourTeams: string[]): Promise<Map<string, TeamOdds>> {
  const rows = await q<{
    home_name: string; away_name: string; p_home_win: string | null;
    starts_at: string; observed_at: string;
  }>(`SELECT home_name, away_name, p_home_win::text, starts_at, observed_at
        FROM current_match_odds
       WHERE p_home_win IS NOT NULL
         AND starts_at > now() - interval '6 hours'`);

  // One entry per side, so a team resolves whether it was home or away.
  const sides: Array<{ name: string } & TeamOdds> = [];
  for (const r of rows) {
    const ph = Number(r.p_home_win);
    sides.push({ name: r.home_name, pWin: ph, opponent: r.away_name, startsAt: r.starts_at, observedAt: r.observed_at });
    sides.push({ name: r.away_name, pWin: 1 - ph, opponent: r.home_name, startsAt: r.starts_at, observedAt: r.observed_at });
  }

  const find = teamIndex(sides, (s) => s.name);
  const out = new Map<string, TeamOdds>();
  for (const t of ourTeams) {
    const hit = find(t);
    if (hit) out.set(t, { pWin: hit.pWin, opponent: hit.opponent, startsAt: hit.startsAt, observedAt: hit.observedAt });
  }
  return out;
}
