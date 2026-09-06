import { getJson, type FetchResult, type RawProp } from './types.js';
import { canonLeague, parseUnderdogStat, parseAmerican } from '../normalize.js';

const URL = 'https://api.underdogfantasy.com/beta/v6/over_under_lines';

/**
 * Underdog returns the whole board in one unauthenticated call (~15MB) as a set
 * of parallel arrays that must be stitched:
 *   over_under_line -> over_under.appearance_stat.appearance_id
 *                   -> appearance -> player_id / match_id / team_id
 * Prices live on the two `options` (higher/lower), each with American odds.
 */
export async function fetchUnderdog(leagues: string[]): Promise<FetchResult> {
  const want = new Set(leagues);
  const { status, body } = await getJson(URL, { timeoutMs: 60_000 });
  if (!body) return { bookCode: 'underdog', httpStatus: status, props: [] };

  const players = new Map<string, any>((body.players ?? []).map((p: any) => [p.id, p]));
  const appearances = new Map<string, any>((body.appearances ?? []).map((a: any) => [a.id, a]));
  const games = new Map<string, any>(
    [...(body.games ?? []), ...(body.solo_games ?? [])].map((g: any) => [String(g.id), g]),
  );
  const props: RawProp[] = [];

  for (const line of body.over_under_lines ?? []) {
    const ou = line.over_under ?? {};
    const stat = ou.appearance_stat;
    if (!stat?.appearance_id) continue;

    const app = appearances.get(stat.appearance_id);
    if (!app) continue;
    const player = players.get(app.player_id);
    if (!player) continue;

    const league = canonLeague(player.sport_id);
    if (!league || !want.has(league)) continue;

    const canon = parseUnderdogStat(String(stat.stat ?? ''));
    if (!canon) continue;

    // Underdog puts esports handles in last_name, occasionally space-padded.
    const handle = `${player.first_name ?? ''} ${player.last_name ?? ''}`.trim();
    if (!handle) continue;

    const value = Number(line.stat_value ?? ou.stat_value ?? line.line_value);
    const over = (line.options ?? []).find((o: any) => o.choice === 'higher');
    const under = (line.options ?? []).find((o: any) => o.choice === 'lower');

    // The numeric line is not always on the line object; the option subheader
    // ("Higher 32.5 Kills on Maps 1+2") always carries it, so fall back to that.
    let resolved = value;
    if (!Number.isFinite(resolved)) {
      const m = String(over?.selection_subheader ?? '').match(/(-?\d+(?:\.\d+)?)/);
      resolved = m ? Number(m[1]) : NaN;
    }
    if (!Number.isFinite(resolved)) continue;

    const game = games.get(String(app.match_id));
    // Underdog references teams by UUID only — it publishes no team roster in
    // this payload, so the name stays null and the matchup title carries the
    // human-readable version ("BetBoom vs BIG").
    const teamOf = (id: string | null) => (id ? { externalId: id, name: null, abbr: null } : null);

    props.push({
      externalId: String(line.id),
      league,
      player: { externalId: String(player.id), handle, team: teamOf(app.team_id ?? null) },
      match: game
        ? {
            externalId: String(game.id),
            league,
            title: game.title ?? game.full_team_names_title ?? null,
            scheduledAt: game.scheduled_at ?? null,
            status: game.status ?? null,
            home: teamOf(game.home_team_id ?? null),
            away: teamOf(game.away_team_id ?? null),
          }
        : null,
      stat: canon.stat,
      mapStart: canon.mapStart,
      mapEnd: canon.mapEnd,
      isCombo: false,
      variant: String(line.line_type ?? 'standard') === 'balanced' ? 'standard' : String(line.line_type),
      displayStat: String(stat.display_stat ?? stat.stat ?? ''),
      line: resolved,
      overPrice: parseAmerican(over?.american_price),
      underPrice: parseAmerican(under?.american_price),
      status: line.status ?? over?.status ?? null,
      isLive: Boolean(line.live_event),
      extra: {
        line_type: line.line_type ?? null,
        over_multiplier: over?.payout_multiplier ?? null,
        under_multiplier: under?.payout_multiplier ?? null,
        raw_stat: stat.stat ?? null,
        graded_by: stat.graded_by ?? null,
      },
    });
  }

  return { bookCode: 'underdog', httpStatus: status, props, raw: body };
}
