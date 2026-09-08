import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { canonHandle } from '../normalize.js';
import { getJson, sleep } from '../adapters/types.js';
import type { MapStat } from './types.js';

/**
 * Historical per-map stat lines for the players we actually track.
 *
 * Form data can be backfilled; lines cannot. Nobody sells what PrizePicks
 * offered last Tuesday, but every source keeps match history, so a player's
 * recent output is available immediately rather than accumulating from today.
 *
 * Scoped to players on our own board instead of all of pro play: it is a small
 * fraction of the requests, and a player we have never seen a prop for is
 * weight we would never use.
 */

const API = 'https://lol.fandom.com/api.php';
const UA = 'BropProp/0.1 (personal esports prop research)';
const PAGE = 500;
const CHUNK = 45;          // players per query; keeps the URL well inside limits
const GAP_MS = 20_000;     // Fandom rate-limits hard; this stays comfortably under

/** Escape a value for a Cargo SQL string literal. */
const lit = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

async function cargo(where: string, offset: number): Promise<any> {
  const params = new URLSearchParams({
    action: 'cargoquery',
    tables: 'ScoreboardPlayers',
    fields: 'Link,Team,Kills,Deaths,Assists,GameId,MatchId,DateTime_UTC',
    where,
    order_by: 'ScoreboardPlayers.DateTime_UTC DESC',
    limit: String(PAGE),
    offset: String(offset),
    format: 'json',
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    const { status, body } = await getJson(`${API}?${params}`, { headers: { 'User-Agent': UA } });
    if (body && !body.error) return body;
    const code = body?.error?.code ?? `http_${status}`;
    if (code !== 'ratelimited' || attempt === 3) {
      throw new Error(`leaguepedia: ${String(body?.error?.info ?? status).slice(0, 110)}`);
    }
    await sleep(45_000 * (attempt + 1));
  }
  throw new Error('leaguepedia: exhausted retries');
}

function toStats(body: any): MapStat[] {
  const out: MapStat[] = [];
  for (const entry of body.cargoquery ?? []) {
    const t = entry.title as Record<string, string>;
    if (!t.Link || !t.MatchId || !t.GameId) continue;
    let map: number | null = null;
    if (t.GameId.startsWith(`${t.MatchId}_`)) {
      const n = Number(t.GameId.slice(t.MatchId.length + 1));
      if (Number.isInteger(n) && n > 0) map = n;
    }
    if (map === null) continue;
    const int = (v: string | undefined) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    out.push({
      source: 'leaguepedia',
      league: 'LOL',
      seriesKey: t.MatchId,
      mapNumber: map,
      handleRaw: t.Link.replace(/\s*\([^)]*\)\s*$/, '').trim(),
      team: t.Team ?? null,
      kills: int(t.Kills),
      deaths: int(t.Deaths),
      assists: int(t.Assists),
      headshots: null,
      // League of Legends has no rounds.
      rounds: null,
      playedAt: t['DateTime UTC'] ? `${t['DateTime UTC']}Z`.replace(' ', 'T') : null,
      raw: { gameId: t.GameId, backfill: true },
    });
  }
  return out;
}

async function store(stats: MapStat[]): Promise<number> {
  let n = 0;
  for (const s of stats) {
    await q(
      `INSERT INTO map_stat (source, league, series_key, map_number, handle_raw,
                             canon_handle, team, kills, deaths, assists, headshots,
                             played_at, raw, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (source, series_key, map_number, canon_handle) DO UPDATE
         SET kills = EXCLUDED.kills, deaths = EXCLUDED.deaths,
             assists = EXCLUDED.assists,
             team = COALESCE(EXCLUDED.team, map_stat.team),
             played_at = COALESCE(EXCLUDED.played_at, map_stat.played_at)`,
      [s.source, s.league, s.seriesKey, s.mapNumber, s.handleRaw, canonHandle(s.handleRaw),
       s.team, s.kills, s.deaths, s.assists, s.headshots, s.playedAt, s.raw ?? {}],
    );
    n++;
  }
  return n;
}

export async function backfillLol(days = 180): Promise<void> {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  // The books' handle is the Leaguepedia page name for these players — already
  // verified by the live join — so it can be used directly in the query.
  const players = await q<{ handle: string }>(
    `SELECT DISTINCT handle FROM player WHERE league = 'LOL' AND handle <> '' ORDER BY handle`,
  );
  console.log(`backfilling ${players.length} LoL players since ${since}`);

  let total = 0;
  for (let i = 0; i < players.length; i += CHUNK) {
    const chunk = players.slice(i, i + CHUNK);
    const inList = chunk.map((p) => lit(p.handle)).join(',');
    const where = `ScoreboardPlayers.Link IN (${inList}) AND ScoreboardPlayers.DateTime_UTC >= '${since}'`;

    for (let page = 0; ; page++) {
      if (i > 0 || page > 0) await sleep(GAP_MS);
      const body = await cargo(where, page * PAGE);
      const rows = body.cargoquery ?? [];
      const stored = await store(toStats(body));
      total += stored;
      console.log(
        `  players ${i + 1}-${i + chunk.length}, page ${page + 1}: ${rows.length} rows, ${stored} stored`,
      );
      if (rows.length < PAGE) break;
    }
  }
  console.log(`backfill done: ${total} stat lines`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const days = Number(process.argv[2] ?? 180);
  await backfillLol(Number.isFinite(days) ? days : 180);
  await pool.end();
}
