import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { canonHandle } from '../normalize.js';
import type { FetchStatsResult, MapStat } from './types.js';

/**
 * bo3.gg — free per-map, per-player CS2 stats.
 *
 * This replaces HLTV as the CS2 stat source, and it is not a close call.
 * Measured 2026-09-07:
 *
 *   * `GET /games/{id}/players_stats` returns one row per player per map with
 *     kills, deaths, assists and headshots. No auth, no key, no browser.
 *   * Of 60 recent finished tier-C matches (137 maps): every map of a match
 *     with `parsed_status === 'done'` had stats (74 of 75, 99%), and no map of
 *     an unparsed match had any (0 of 62). So parsed_status is a reliable gate
 *     rather than something to discover by fetching.
 *   * 40 rapid requests in a row, zero failures, no rate-limit headers. HLTV
 *     403s any plain client; PrizePicks serves ~2 requests a minute.
 *   * Over 14 days it matched 138 of the 255 CS2 handles on our board and
 *     would have written 1,238 map stat lines. The HLTV crawler, measured the
 *     same way, found per-map stats in one of thirty results and none of that
 *     match's players were on the board.
 *
 * Two things worth knowing before changing anything here:
 *
 * **Stats lag the match by hours.** Of matches that had stats, the youngest
 * had ended 7.5 hours earlier and the median 13 hours. Picks stay pending
 * overnight, which is what the grader already does with a late result. Do not
 * "fix" this by polling harder — the data is not there yet.
 *
 * **Unknown filters are ignored, not rejected.** `filter[status]=finished`
 * returns the unfiltered list with HTTP 200. The working shape is
 * `filter[<table>.<column>][<op>]=<value>` (`filter[games.match_id][eq]=…`).
 * Every filter this module sends is therefore re-checked on the response, so a
 * renamed filter degrades into extra work rather than silently importing
 * Valorant games as CS2.
 */

const API = 'https://api.bo3.gg/api/v1';

/** bo3.gg's id for Counter-Strike. Re-checked per match, never assumed. */
const CS2_DISCIPLINE = 1;

/** No rate limiting was observed. This is politeness, not a measured floor. */
export const GAP_MS = 90;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Bo3Game = {
  id: number;
  number: number | null;
  begin_at: string | null;
  /**
   * Rounds the map ran. Present on the embedded game objects we already
   * request with `with=games`, so reading it costs nothing extra.
   */
  rounds_count?: number | null;
};

export type Bo3Match = {
  id: number;
  slug: string;
  status: string;
  tier: string | null;
  discipline_id: number;
  parsed_status: string;
  start_date: string | null;
  end_date: string | null;
  games?: Bo3Game[];
};

export type Bo3PlayerStat = {
  game_id: number;
  clan_name: string | null;
  kills: number | null;
  death: number | null;
  assists: number | null;
  headshots: number | null;
  adr: number | null;
  kast: number | null;
  steam_profile?: {
    nickname?: string | null;
    player?: { nickname?: string | null; slug?: string | null } | null;
  } | null;
};

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BropProp/0.1 (prop research)' },
  });
  if (!res.ok) throw new Error(`bo3 ${res.status} ${url.slice(API.length)}`);
  return (await res.json()) as T;
}

/**
 * Finished CS2 matches that start on or after `since`, newest first.
 *
 * `with=games` folds the map list into the same response, which turns one
 * request per match into one per hundred — the difference between a season
 * backfill taking an hour and taking a day.
 */
async function finishedMatches(
  since: string, cap: number, until?: string,
): Promise<Bo3Match[]> {
  const out: Bo3Match[] = [];
  for (let offset = 0; out.length < cap; offset += 100) {
    const params = new URLSearchParams();
    params.set('sort', '-end_date');
    params.set('page[limit]', '100');
    params.set('page[offset]', String(offset));
    params.set('filter[matches.status][in]', 'finished');
    params.set('filter[matches.start_date][gt]', since);
    // An upper bound turns "the last N days" into a window, which is what
    // makes a backfill resumable: the work splits into chunks that can be
    // recorded as done. Server-side filtering is a request-count saving only
    // — the client-side check below is what actually enforces it, because
    // this API answers an unknown filter with the UNFILTERED list and a 200.
    if (until) params.set('filter[matches.start_date][lt]', until);
    params.set('filter[matches.discipline_id][eq]', String(CS2_DISCIPLINE));
    params.set('with', 'games');

    const page = await getJson<{ results?: Bo3Match[] }>(`${API}/matches?${params}`);
    const rows = page.results ?? [];
    if (rows.length === 0) break;

    // Re-check every filter: see the note about silently ignored filters.
    for (const m of rows) {
      if (m.status !== 'finished') continue;
      if (m.discipline_id !== CS2_DISCIPLINE) continue;
      if (m.start_date && m.start_date < since) continue;
      if (until && m.start_date && m.start_date >= until) continue;
      out.push(m);
    }
    if (rows.length < 100) break;
    // This loop is the longest silent stretch of a deep backfill — five
    // minutes of paging before a single stat is fetched, during which an
    // empty log looks exactly like a hang. One line per thousand is enough to
    // tell them apart without filling the scrollback.
    if (out.length % 1000 < 100) {
      console.log(`bo3: listing matches… ${out.length} so far, back to ${
        out[out.length - 1]?.start_date?.slice(0, 10) ?? '?'}`);
    }
    await sleep(GAP_MS);
  }
  // Silent truncation is how a two-year request quietly became a shorter one.
  // The loop stops AT the cap, so the true total is unknown — all we can say
  // is that we stopped because of the cap rather than because the archive ran
  // out, and that matches are newest-first so it is the old end being lost.
  if (out.length >= cap) {
    const oldest = out[cap - 1]?.start_date?.slice(0, 10) ?? '?';
    console.warn(
      `bo3: WARNING — hit the ${cap}-match cap, so this run reaches back only ` +
      `to ${oldest}, not the full ${since}. Matches are newest-first and the ` +
      `list is cut at the old end. Raise maxMatches to cover the window.`);
  }
  return out.slice(0, cap);
}

/**
 * The handles we price, as canonical keys.
 *
 * A player we have never had a prop for is weight the projection would never
 * use, so the whole board is the filter — the same rule as the Oracle's Elixir
 * loader. An empty set keeps everything, which is useful when exploring.
 */
async function trackedHandles(): Promise<Set<string>> {
  const rows = await q<{ canon_handle: string }>(
    `SELECT DISTINCT canon_handle FROM player WHERE league = 'CS2'`,
  );
  return new Set(rows.map((r) => r.canon_handle));
}

/**
 * Both names a row can carry.
 *
 * `steam_profile.nickname` is whatever the Steam account is called, which for
 * tier-C players is often decorated with clan tags (`GGPR*KmZ^BN`); the linked
 * `player.nickname` is the clean pro handle. Either may be the one a book
 * uses, so both are tried and the variant that actually matched is stored —
 * `handle_raw` has to fold back to the same `canon_handle` the join used.
 */
function handleCandidates(p: Bo3PlayerStat): string[] {
  const names = [p.steam_profile?.player?.nickname, p.steam_profile?.nickname];
  return names.filter((n): n is string => typeof n === 'string' && n.trim() !== '');
}

/** Exported for tests: this mapping decides what every CS2 pick grades against. */
export function toMapStats(
  match: Bo3Match,
  game: Bo3Game,
  rows: Bo3PlayerStat[],
  tracked: Set<string>,
): MapStat[] {
  const out: MapStat[] = [];
  for (const p of rows) {
    let raw: string | null = null;
    for (const cand of handleCandidates(p)) {
      if (tracked.size === 0 || tracked.has(canonHandle(cand))) { raw = cand; break; }
    }
    if (raw === null) continue;

    out.push({
      source: 'bo3',
      league: 'CS2',
      // The source's own series id, never parsed for meaning.
      seriesKey: `bo3:${match.id}`,
      mapNumber: game.number ?? 1,
      handleRaw: raw,
      team: p.clan_name,
      kills: p.kills,
      deaths: p.death, // bo3 spells it `death`
      assists: p.assists,
      // Verified headshot KILLS, not headshot hits: across 220 rows none
      // exceeded that player's kills, and the ratio to kills is 0.54 (a
      // plausible headshot rate) against 0.17 to hits.
      headshots: p.headshots,
      // Straight off the game object we already hold. A game that somehow
      // reports no round count writes null rather than a zero, which would
      // be an infinitely fast map rather than an unknown one.
      rounds: typeof game.rounds_count === 'number' && game.rounds_count > 0 ? game.rounds_count : null,
      playedAt: game.begin_at ?? match.end_date ?? match.start_date,
      raw: {
        match_id: match.id,
        game_id: game.id,
        slug: match.slug,
        tier: match.tier,
        map_number: game.number,
        adr: p.adr,
        kast: p.kast,
      },
    });
  }
  return out;
}

/**
 * Maps already stored, as `series_key#map_number`.
 *
 * The results run looks back three days twice an hour, so without this it
 * would re-fetch every recent map about 48 times over — roughly 9,000 requests
 * a day for rows already in the table. bo3.gg imposes no rate limit, which is
 * a reason to be careful rather than a licence not to be.
 *
 * Bounded by the same window being fetched, so this stays a small query rather
 * than growing with the history.
 */
async function storedMaps(since: string): Promise<Set<string>> {
  const rows = await q<{ series_key: string; map_number: number }>(
    `SELECT series_key, map_number FROM map_stat
      WHERE source = 'bo3' AND played_at >= $1::date - interval '2 days'`,
    [since],
  );
  return new Set(rows.map((r) => `${r.series_key}#${r.map_number}`));
}

export type Bo3Options = {
  /** How far back to look. */
  days?: number;
  /**
   * Explicit lower bound, ISO `yyyy-mm-dd`. Overrides `days`.
   *
   * A chunked backfill keys its ledger on the exact window boundaries, and
   * deriving them back from a day count rounds — half a day of drift renames
   * the chunk and it gets walked again on the next boot.
   */
  since?: string;
  /**
   * Upper bound on match start date, ISO `yyyy-mm-dd`, exclusive.
   *
   * Turns "the last N days" into a window. That is what makes a long backfill
   * resumable: the work splits into chunks that can be recorded as done, so a
   * deploy costs one chunk instead of the whole walk.
   */
  until?: string;
  /** Cap on matches examined, so one run cannot take an afternoon. */
  maxMatches?: number;
  /** Keep every player rather than only the board's. */
  allPlayers?: boolean;
  /** Re-fetch maps already stored. Off by default; on to repair bad rows. */
  refetch?: boolean;
  /**
   * Write rows as they arrive instead of at the end.
   *
   * A year is around 40,000 map requests and the better part of an hour. Held
   * in memory and written once at the end, an error in minute 55 throws away
   * everything, and there is nothing to watch while it runs. With a sink the
   * work is durable as it goes and the caller can report progress. Rows are
   * not accumulated when one is supplied, so memory stays flat.
   */
  sink?: (stats: MapStat[]) => Promise<number>;
  /** Called after each match, for progress reporting on long runs. */
  onProgress?: (p: {
    matchesDone: number; matchesTotal: number;
    maps: number; skipped: number; written: number; playedAt: string | null;
  }) => void;
};

export async function fetchBo3(opts: Bo3Options = {}): Promise<FetchStatsResult> {
  const days = opts.days ?? 3;
  const maxMatches = opts.maxMatches ?? 400;
  const since = opts.since ?? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

  const tracked = opts.allPlayers ? new Set<string>() : await trackedHandles();
  const done = opts.refetch ? new Set<string>() : await storedMaps(since);
  const matches = await finishedMatches(since, maxMatches, opts.until);

  // Only parsed matches carry stats — measured 99% against 0%. Skipping the
  // rest is the difference between 137 requests and 75 for the same data.
  const parsed = matches.filter((m) => m.parsed_status === 'done');
  console.log(
    `bo3: ${matches.length} finished CS2 matches since ${since}, ` +
      `${parsed.length} parsed, ${tracked.size || 'all'} handles tracked, ` +
      `${done.size} maps already stored`,
  );

  const stats: MapStat[] = [];
  let maps = 0;
  let empty = 0;
  let skipped = 0;
  let written = 0;
  let matchesDone = 0;
  for (const m of parsed) {
    const forMatch: MapStat[] = [];
    /** Whether this match cost a request at all — see the sleep guard below. */
    let fetched = false;
    for (const g of m.games ?? []) {
      // A map we already have. Note this only recognises maps that produced a
      // row, so a match where nobody was on our board is re-checked each run —
      // cheap, and it means a player joining the board backfills on the next
      // sweep instead of being invisible until they play again.
      if (done.has(`bo3:${m.id}#${g.number ?? 1}`)) { skipped++; continue; }
      maps++;
      let rows: Bo3PlayerStat[];
      fetched = true;
      try {
        rows = await getJson<Bo3PlayerStat[]>(`${API}/games/${g.id}/players_stats`);
      } catch (err) {
        // One unparsed map is normal operations, not a failed run.
        console.warn(`  game ${g.id}: ${(err as Error).message}`);
        await sleep(GAP_MS);
        continue;
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        empty++;
        await sleep(GAP_MS);
        continue;
      }
      forMatch.push(...toMapStats(m, g, rows, tracked));
      await sleep(GAP_MS);
    }

    // Durable as we go when a sink is supplied, buffered otherwise.
    if (opts.sink) {
      if (forMatch.length) written += await opts.sink(forMatch);
    } else {
      stats.push(...forMatch);
      written = stats.length;
    }
    matchesDone++;
    opts.onProgress?.({
      matchesDone, matchesTotal: parsed.length,
      maps, skipped, written, playedAt: m.end_date,
    });
    // Only pause if this match actually cost a request. A deep backfill
    // re-walks everything already stored, and being polite between matches we
    // never contacted is pure waiting — about seventeen minutes of it across a
    // two-year run. The gap exists to be kind to bo3.gg; a skipped match asks
    // it for nothing.
    if (fetched) await sleep(GAP_MS);
  }

  console.log(
    `bo3: ${maps} maps fetched (${empty} without stats, ${skipped} already stored), ` +
      `${stats.length} tracked stat lines`,
  );
  return { source: 'bo3', stats };
}

/**
 * Backfill entry point. `npm run bo3 [days]`, default 30.
 *
 * Unlike the HLTV crawler this really does build history: bo3.gg's archive
 * pages backwards without a Cloudflare challenge, and coverage reaches back to
 * 2023 — patchily, tracking how many matches of that era were ever parsed.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { storeStats } = await import('./store_stats.js');
  const days = Number(process.argv[2] ?? 30);
  const all = process.argv.includes('--all-players');
  const refetch = process.argv.includes('--refetch');

  const started = Date.now();
  let last = 0;
  await fetchBo3({
    days, allPlayers: all, refetch,
    // Scaled to the window, not a flat 20,000. Matches come back newest-first
    // and the list is then truncated to this cap, so a cap smaller than the
    // window holds silently keeps the NEWEST n and never reaches the far end
    // — a `bo3 730` that found exactly 20,000 was really a `bo3 ~400`. CS2
    // ran about 27 finished matches a day over the last two years; 60 is
    // headroom over that, and the floor keeps short runs unchanged.
    maxMatches: Math.max(20000, Math.ceil(days * 60)),
    sink: storeStats,
    onProgress: (p) => {
      // Every 25 matches, or the last one. Enough to watch an hour-long run
      // without turning the log into a scrollback problem.
      if (p.matchesDone - last < 25 && p.matchesDone !== p.matchesTotal) return;
      last = p.matchesDone;
      const mins = (Date.now() - started) / 60000;
      const pct = Math.round((100 * p.matchesDone) / p.matchesTotal);
      const eta = p.matchesDone ? (mins / p.matchesDone) * (p.matchesTotal - p.matchesDone) : 0;
      console.log(
        `  ${String(pct).padStart(3)}%  ${p.matchesDone}/${p.matchesTotal} matches  ` +
        `${p.maps} maps  ${p.written} rows  ${mins.toFixed(1)}m elapsed  ` +
        `~${eta.toFixed(0)}m left  at ${(p.playedAt ?? '').slice(0, 10)}`,
      );
    },
  });
  await pool.end();
}
