import { q } from '../db.js';
import { teamIndex } from '../adapters/teamname.js';

/**
 * Turn the market's view of who wins into a probability for each player's under.
 *
 * Re-measured 2026-09-11 against the BOOKS' OWN closing lines (`raw/blowfair.mjs`),
 * over ~2,360 settled CS2 kills/headshots legs, splitting each by whether the
 * player's team won the range:
 *
 *   losing team's players   under 57.2%   (1,116)
 *   winning team's players  under 45.7%   (1,247)
 *
 * Within series that had legs on both sides, the losers' under-rate beat the
 * winners' 39-22, p = 0.040. That paired comparison is the part that holds up;
 * neither side on its own is significant at the series level (42-32, 31-32).
 *
 * **These replaced 0.620 / 0.482, which were inflated by a circular definition.**
 * "Losing team" is inferred from kills, and the old measurement counted the
 * player's OWN kills in his team's total — so a player going under helped make
 * his own team the loser, and the split partly measured itself. Measured both
 * ways on the same legs:
 *
 *                         own kills counted   own kills left out
 *   losing, under              62.6%               57.2%
 *   winning, under             41.0%               45.7%
 *
 * About half of the old gap was the player grading himself. Team strength is
 * compared as kills PER PLAYER, so four teammates against five opponents is fair
 * (a first attempt summed them, and called the player's team the loser 3 times
 * in 4).
 *
 * The rates are CONDITIONAL on the result, which nobody knows in advance. A
 * moneyline gives the probability of each result, so the chance of an under is
 * the two rates mixed by it:
 *
 *   P(under) = P(team wins) · 0.457  +  P(team loses) · 0.572
 *
 * Calibration check: at a coin-flip match the mixture gives 0.5145, and the
 * blind under rate on the same real lines is 51.6%.
 *
 * What it is NOT: the blowout band. Even left-one-out, losers in a ≥20% kill
 * blowout went under 79%, but that is the margin, which is a handicap question
 * rather than a winner one. It stays out until the handicap outcomes are parsed
 * and checked the way the moneyline was.
 */
export const UNDER_IF_TEAM_WINS = 0.457;
export const UNDER_IF_TEAM_LOSES = 0.572;

/**
 * The under rate when there is no moneyline to go on.
 *
 * **This was 0.553, and the shade behind it has faded.** On 2026-09-10 the books'
 * own closing lines went under 55.3% of 2,137 legs, p = 0.0053 over 133 series.
 * Re-measured 2026-09-11 over every settled leg so far, it is 51.6%, series 46-32,
 * p = 0.14 — no longer significant. By day: 09-06 100% (20 legs), 09-07 59.3%,
 * 09-08 51.6%, 09-09 55.4%, 09-10 41.5%. The early days carried it.
 *
 * So a leg with no moneyline is priced as close to a coin flip, which it is. The
 * edge that is left lives in the team split above, not in the blind shade.
 */
export const MEASURED_UNDER_BASELINE = 0.516;

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
