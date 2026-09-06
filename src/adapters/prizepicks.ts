import { getJson, sleep, type FetchResult, type RawProp } from './types.js';
import { canonLeague, parsePrizePicksStat } from '../normalize.js';

const BASE = 'https://partner-api.prizepicks.com/projections';

type LeagueRef = { league: string; externalId: string };

/**
 * The public api.prizepicks.com host sits behind DataDome and returns a captcha
 * challenge. partner-api.prizepicks.com serves the same JSON:API payload without
 * one, but it rate-limits hard — so we fetch per-league (218KB vs 23MB for the
 * unfiltered board) and pause between leagues.
 */
export async function fetchPrizePicks(leagues: LeagueRef[]): Promise<FetchResult> {
  const props: RawProp[] = [];
  const discovered: Record<string, { id: string; name: string }> = {};
  const statuses: Record<string, number> = {};
  const raw: Record<string, unknown> = {};

  for (const [idx, lg] of leagues.entries()) {
    if (idx > 0) await sleep(3000); // be a good citizen; 429s are easy to earn here
    const url = `${BASE}?league_id=${encodeURIComponent(lg.externalId)}&per_page=1000`;
    const { status, body } = await getJson(url);
    statuses[lg.league] = status;
    if (!body?.data) {
      // A single league failing (usually a 429) must be visible, not silently
      // absorbed into an empty result that looks like "no props today".
      console.warn(`  ! prizepicks ${lg.league}: HTTP ${status}, no data`);
      continue;
    }
    raw[lg.league] = body;

    // Index the JSON:API sidecar so relationships can be resolved.
    const inc = new Map<string, any>();
    for (const i of body.included ?? []) inc.set(`${i.type}:${i.id}`, i);

    for (const proj of body.data) {
      const a = proj.attributes ?? {};
      const rel = proj.relationships ?? {};

      const leagueNode = inc.get(`league:${rel.league?.data?.id}`);
      const leagueName = leagueNode?.attributes?.name ?? lg.league;
      const league = canonLeague(leagueName);
      if (!league) continue;
      if (rel.league?.data?.id) {
        discovered[league] = { id: String(rel.league.data.id), name: String(leagueName) };
      }

      const canon = parsePrizePicksStat(String(a.stat_type ?? ''));
      if (!canon) continue; // not a map-scoped market we can join on

      const playerNode = inc.get(`new_player:${rel.new_player?.data?.id}`);
      if (!playerNode) continue;
      const pa = playerNode.attributes ?? {};
      const handle = String(pa.display_name || pa.name || '').trim();
      if (!handle) continue;

      const gameNode = inc.get(`game:${rel.game?.data?.id}`);
      const ga = gameNode?.attributes ?? {};

      // `description` is "<opponent> MAPS 1-2"; strip the map qualifier to
      // recover the opponent name, which is the only matchup hint PP gives here.
      const opponent = String(a.description ?? '')
        .replace(/\s*maps?\s*\d+(\s*[-–]\s*\d+)?\s*$/i, '')
        .trim();
      const playerTeam = pa.team ? String(pa.team) : null;
      const title = playerTeam && opponent ? `${playerTeam} vs ${opponent}` : opponent || null;

      const line = Number(a.line_score);
      if (!Number.isFinite(line)) continue;

      props.push({
        externalId: String(proj.id),
        league,
        player: {
          externalId: String(playerNode.id),
          handle,
          team: playerTeam ? { externalId: playerTeam, name: playerTeam } : null,
        },
        match: rel.game?.data?.id
          ? {
              externalId: String(rel.game.data.id),
              league,
              title,
              scheduledAt: a.start_time ?? ga.start_time ?? null,
              status: a.status ?? ga.status ?? null,
            }
          : null,
        stat: canon.stat,
        mapStart: canon.mapStart,
        mapEnd: canon.mapEnd,
        isCombo: canon.isCombo || pa.combo === true,
        variant: String(a.odds_type ?? 'standard'),
        displayStat: String(a.stat_display_name ?? a.stat_type ?? ''),
        line,
        // PrizePicks pays a flat multiplier rather than per-side American odds;
        // the "price" is expressed by moving the line (goblin/demon).
        overPrice: null,
        underPrice: null,
        status: a.status ?? null,
        isLive: Boolean(a.is_live),
        extra: {
          odds_type: a.odds_type ?? null,
          allowed_wager_types: a.allowed_wager_types ?? null,
          is_promo: a.is_promo ?? null,
          flash_sale_line_score: a.flash_sale_line_score ?? null,
          opponent: opponent || null,
          player_team: playerTeam,
          board_time: a.board_time ?? null,
          rank: a.rank ?? null,
        },
      });
    }
  }

  // Report the aggregate honestly: 200 only if every league we asked for
  // answered, otherwise the first failing status.
  const failing = Object.values(statuses).find((s) => s !== 200);
  const httpStatus = failing ?? (Object.keys(statuses).length ? 200 : 0);
  return { bookCode: 'prizepicks', httpStatus, props, discoveredLeagueIds: discovered, raw };
}
