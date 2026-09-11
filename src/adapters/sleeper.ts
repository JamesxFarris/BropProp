import { getJson, type FetchResult, type RawProp } from './types.js';

/**
 * Sleeper Picks — the third CS2 book, and one this project wrongly ruled out.
 *
 * On 2026-09-10 this repo recorded "Sleeper carries no esports, settled", on the
 * strength of `sport_info()` returning null for cs2, csgo, lol, val and dota.
 * Sleeper's code for Counter-Strike is `cs`. A books-research agent found it the
 * next day and it was verified independently: the board at `lines/available`
 * answers with no auth and carried 223 CS2 lines — 118 kills and 105 headshots,
 * maps 1-2 — across 14 matches, with about 150 markets also priced by both
 * PrizePicks and Underdog at the same moment.
 *
 * Three endpoints, all unauthenticated:
 *
 *   lines/available              the whole pick'em board, every sport (~5.8MB)
 *   players/{sport}              player directory keyed by id (~2.2MB for cs)
 *   schedule/{sport}/regular/Y   fixtures, with home and away team names
 *
 * Two things here are better than either existing book:
 *
 * - **Every line names the player's team** (`subject_team`). Underdog publishes
 *   no team at all, and the stack builder — whose whole edge is the teammate
 *   correlation — could only build on PrizePicks until now.
 * - **Every side carries its own payout multiplier.** Sleeper is a priced book,
 *   like Underdog. The multipliers are decimal odds (1.78 / 1.78 is even money
 *   with roughly a 12% margin) and are stored as American prices so `devig()`
 *   and the rest of the app treat Sleeper exactly as they treat Underdog.
 *
 * And one caveat worth carrying: Sleeper's prices track Underdog's closely —
 * same-line probabilities within about a point, and where the lines differ
 * Sleeper leans toward Underdog's number 29 times in 33. A three-book consensus
 * is closer to two opinions than three. See docs/BOOKS.md.
 */

const BASE = 'https://api.sleeper.app';

/**
 * Sleeper's sport codes, mapped to ours. Only sports listed here are read.
 *
 * `cs`, not `cs2`. That one guessed identifier is why this book sat unused.
 * Sleeper lists no LoL pick'em lines, so there is no entry for it.
 */
const SPORTS: Record<string, string> = { cs: 'CS2' };

/**
 * `kills_maps_1_2` → kills over maps 1-2. `headshots_map_3` → map 3 only.
 *
 * Anything else — fantasy points, combined-player markets — returns null and is
 * skipped rather than guessed at. A market parsed into the wrong range would
 * join the wrong market on another book.
 */
export function parseWager(w: string): { stat: string; mapStart: number; mapEnd: number } | null {
  const m = /^(kills|headshots|assists|deaths)_maps?_(\d+)(?:_(\d+))?$/.exec(String(w ?? ''));
  if (!m) return null;
  const a = Number(m[2]);
  const b = m[3] ? Number(m[3]) : a;
  if (!(a >= 1) || b < a) return null;
  return { stat: m[1]!, mapStart: a, mapEnd: b };
}

/** Decimal odds to American. 1.86 → -116, 2.43 → +143. Null below evens-plus-nothing. */
export function decimalToAmerican(d: number): number | null {
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

type SleeperOption = {
  status?: string;
  outcome?: string;
  outcome_value?: number | string;
  payout_multiplier?: number | string;
  subject_team?: string | null;
  line_id?: string;
};

type SleeperLine = {
  status?: string;
  sport?: string;
  season?: string;
  subject_id?: string;
  subject_type?: string;
  game_id?: string;
  game_status?: string;
  wager_type?: string;
  market_type?: string;
  options?: SleeperOption[];
  pick_stats?: { popularity?: number };
};

type SleeperGame = {
  game_id?: string;
  date?: string;
  status?: string;
  home?: { name?: string; team?: string };
  away?: { name?: string; team?: string };
};

/**
 * The board, stitched into our shape. Pure: no network.
 *
 * `players` is keyed `${sport}:${player_id}`, because Sleeper's player ids are
 * per sport and nothing guarantees they are unique across sports.
 */
export function parseSleeper(
  lines: SleeperLine[],
  players: Record<string, any>,
  schedule: SleeperGame[],
  leagues: Set<string>,
): RawProp[] {
  const games = new Map(schedule.map((g) => [String(g.game_id), g]));
  const out: RawProp[] = [];

  for (const l of lines) {
    const league = SPORTS[String(l.sport)];
    if (!league || !leagues.has(league)) continue;
    // Pre-game only. Sleeper keeps a line on the board briefly as the game
    // starts, and a leg that can no longer be entered is not a leg.
    if (l.status !== 'active' || l.game_status !== 'pre_game') continue;
    if (l.subject_type !== 'player') continue;

    const wager = parseWager(String(l.wager_type));
    if (!wager) continue;

    const player = players[`${l.sport}:${l.subject_id}`];
    // The username is the handle every other book and stat source uses
    // ("avid", "donk"); first and last name are the person, not the player.
    const handle = String(player?.username ?? player?.metadata?.username ?? '').trim();
    if (!handle) continue;

    const opts = (l.options ?? []).filter((o) => o.status === 'active');
    const over = opts.find((o) => o.outcome === 'over');
    const under = opts.find((o) => o.outcome === 'under');
    const value = Number(over?.outcome_value ?? under?.outcome_value);
    if (!Number.isFinite(value)) continue;

    const overMult = over ? Number(over.payout_multiplier) : NaN;
    const underMult = under ? Number(under.payout_multiplier) : NaN;
    const team = over?.subject_team ?? under?.subject_team ?? player?.team ?? null;

    const g = games.get(String(l.game_id));
    const home = g?.home?.team ?? g?.home?.name ?? null;
    const away = g?.away?.team ?? g?.away?.name ?? null;

    out.push({
      externalId: String(l.market_type ?? `${l.game_id}:${l.subject_id}:${l.wager_type}`),
      league,
      player: {
        externalId: String(l.subject_id),
        handle,
        // A team's name is its identity on Sleeper — the same string appears
        // on the player, the line and both sides of the schedule — so it doubles
        // as the external id and every row lands on one team record.
        team: team ? { externalId: String(team), name: String(team), abbr: null } : null,
      },
      match: l.game_id
        ? {
            externalId: String(l.game_id),
            league,
            title: home && away ? `${home} vs ${away}` : null,
            /**
             * Sleeper gives a DATE, never a kickoff time. Storing the end of that
             * day is an upper bound, chosen on purpose: the board keeps markets
             * until six hours past their start, so a null would never drop off,
             * and an early guess would hide a market that is still live. Where
             * PrizePicks or Underdog price the same market — about 150 of ~204 —
             * the board takes the earliest time across books, so their real
             * kickoff wins.
             */
            scheduledAt: g?.date ? `${g.date}T23:59:00.000Z` : null,
            status: l.game_status ?? g?.status ?? null,
            home: home ? { externalId: home, name: home, abbr: null } : null,
            away: away ? { externalId: away, name: away, abbr: null } : null,
          }
        : null,
      stat: wager.stat,
      mapStart: wager.mapStart,
      mapEnd: wager.mapEnd,
      isCombo: false,
      variant: 'standard',
      displayStat: String(l.wager_type),
      line: value,
      overPrice: decimalToAmerican(overMult),
      underPrice: decimalToAmerican(underMult),
      status: 'active',
      isLive: false,
      extra: {
        // Kept under Sleeper-specific keys, NOT `over_multiplier`: that column
        // means "pays relative to a standard leg" (Underdog's 0.87-1.09), and
        // Sleeper's figure is the whole per-pick payout. Mixing the two would
        // tell the optimiser a Sleeper leg pays 1.86 standard legs.
        sleeper_over_mult: Number.isFinite(overMult) ? overMult : null,
        sleeper_under_mult: Number.isFinite(underMult) ? underMult : null,
        sleeper_line_id: over?.line_id ?? under?.line_id ?? null,
        sleeper_popularity: l.pick_stats?.popularity ?? null,
        sleeper_date: g?.date ?? null,
      },
    });
  }
  return out;
}

/**
 * The directory and schedule barely move within an hour, and together they are
 * ~2.5MB. The board itself is fetched every poll; these are reused.
 */
const CACHE_MS = 60 * 60e3;
const cache = new Map<string, { at: number; body: any }>();
async function cached(url: string): Promise<any> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const { body } = await getJson(url, { timeoutMs: 60_000 });
  if (body) cache.set(url, { at: Date.now(), body });
  return body ?? hit?.body ?? null;
}

export async function fetchSleeper(leagues: string[]): Promise<FetchResult> {
  const want = new Set(leagues);
  const { status, body } = await getJson(`${BASE}/lines/available`, { timeoutMs: 60_000 });
  if (!body) return { bookCode: 'sleeper', httpStatus: status, props: [] };

  const all: SleeperLine[] = Array.isArray(body) ? body : Object.values(body);
  const sports = [...new Set(all.map((l) => String(l.sport)))]
    .filter((s) => SPORTS[s] && want.has(SPORTS[s]!));
  if (sports.length === 0) return { bookCode: 'sleeper', httpStatus: status, props: [] };

  const players: Record<string, any> = {};
  const schedule: SleeperGame[] = [];
  for (const sport of sports) {
    const dir = (await cached(`${BASE}/players/${sport}`)) ?? {};
    for (const [id, p] of Object.entries(dir)) players[`${sport}:${id}`] = p;
    const seasons = [...new Set(all.filter((l) => l.sport === sport).map((l) => String(l.season)))];
    for (const season of seasons) {
      const games = await cached(`${BASE}/schedule/${sport}/regular/${season}`);
      if (Array.isArray(games)) schedule.push(...games);
    }
  }

  return { bookCode: 'sleeper', httpStatus: status, props: parseSleeper(all, players, schedule, want) };
}
