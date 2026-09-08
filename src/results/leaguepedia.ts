import type { MapStat, FetchStatsResult } from './types.js';
import { getJson, sleep } from '../adapters/types.js';

const API = 'https://lol.fandom.com/api.php';

/**
 * Leaguepedia's Cargo API for pro League scoreboards.
 *
 * Fandom rate-limits hard and quickly, so this makes exactly ONE request per
 * run and pulls a whole window of games at once rather than querying per
 * match. A descriptive User-Agent is required by their API terms.
 */
const UA = 'BropProp/0.1 (personal esports prop research)';

/** Page titles carry disambiguation ("Sajed (Player)"); the handle does not. */
function handleFromLink(link: string): string {
  return link.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Which game of the series this row is.
 *
 * ScoreboardPlayers has no game-number column (asking for one throws), but it
 * carries both ids and GameId is literally MatchId + "_" + game number:
 *   MatchId  LCS/2026 Season/Summer Season_Week 7_4
 *   GameId   LCS/2026 Season/Summer Season_Week 7_4_2   -> game 2
 * Deriving it from the pair is exact. The bare trailing-number fallback only
 * runs if that relationship ever stops holding.
 */
function gameNumber(gameId: string, matchId: string): number | null {
  if (gameId.startsWith(`${matchId}_`)) {
    const n = Number(gameId.slice(matchId.length + 1));
    if (Number.isInteger(n) && n > 0) return n;
  }
  const tail = gameId.match(/_(\d+)$/);
  const n = tail ? Number(tail[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const PAGE = 500;      // Cargo's per-request maximum
const MAX_PAGES = 6;   // 3000 rows ≈ 300 games; far more than a day of pro play

export async function fetchLeaguepedia(sinceDays = 3): Promise<FetchStatsResult> {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10);
  const stats: MapStat[] = [];

  // Paginate: a single 500-row page silently truncates a busy day, which shows
  // up later as picks that can never be graded because their map is missing.
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(20_000); // stay well inside the rate limit
    const rows = await fetchPage(since, page * PAGE);
    stats.push(...rows);
    if (rows.length < PAGE) break;
  }

  return { source: 'leaguepedia', stats };
}

async function fetchPage(since: string, offset: number): Promise<MapStat[]> {
  const params = new URLSearchParams({
    action: 'cargoquery',
    tables: 'ScoreboardPlayers',
    fields: 'Link,Team,Kills,Deaths,Assists,GameId,MatchId,DateTime_UTC',
    where: `ScoreboardPlayers.DateTime_UTC >= '${since}'`,
    order_by: 'ScoreboardPlayers.DateTime_UTC DESC',
    limit: String(PAGE),
    offset: String(offset),
    format: 'json',
  });

  // Fandom reports rate limiting as HTTP 200 with an error body, so the
  // transport's 429 handling never sees it. Back off here instead, slowly:
  // the limit is per-IP and lasts minutes, not seconds.
  let body: any = null;
  let status = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    ({ status, body } = await getJson(`${API}?${params}`, { headers: { 'User-Agent': UA } }));
    if (body && !body.error) break;
    const code = body?.error?.code ?? `http_${status}`;
    if (code !== 'ratelimited' || attempt === 3) {
      const info = body?.error?.info ?? `HTTP ${status}`;
      throw new Error(`leaguepedia: ${String(info).slice(0, 120)}`);
    }
    await sleep(30_000 * (attempt + 1)); // 30s, 60s, 90s
  }

  const out: MapStat[] = [];
  for (const entry of body.cargoquery ?? []) {
    const t = entry.title as Record<string, string>;
    const link = t.Link;
    const seriesKey = t.MatchId;
    if (!link || !seriesKey || !t.GameId) continue;
    const map = gameNumber(t.GameId, seriesKey);
    if (map === null) continue;

    const int = (v: string | undefined) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    out.push({
      source: 'leaguepedia',
      league: 'LOL',
      seriesKey,
      mapNumber: map,
      handleRaw: handleFromLink(link),
      team: t.Team ?? null,
      kills: int(t.Kills),
      deaths: int(t.Deaths),
      assists: int(t.Assists),
      // League has no headshot statistic; null is the honest value, not 0.
      headshots: null,
      // League of Legends has no rounds.
      rounds: null,
      playedAt: t['DateTime UTC'] ? `${t['DateTime UTC']}Z`.replace(' ', 'T') : null,
      raw: { gameId: t.GameId },
    });
  }

  return out;
}
