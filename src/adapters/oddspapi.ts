import { q, pool } from '../db.js';
import { config } from '../config.js';

/**
 * Pinnacle's esports match odds, via OddsPapi — who wins, and how clearly.
 *
 * Why this exists: over 4,967 CS2 series a losing team's players went under
 * their lines 62.0% of the time against 48.2% for the winners, and 66.0% in a
 * blowout (p < 0.000001 over 4,180 independent series). That is measured after
 * the fact. Acting on it needs the market's view of who will lose BEFORE
 * kick-off, which is exactly a moneyline — and Pinnacle's is the sharpest there
 * is. See RUNBOOK, "The blowout effect".
 *
 * ## The budget is the design constraint
 *
 * The free tier is 250 requests a MONTH. Everything here is shaped by that:
 *
 * - Odds come from `odds-by-tournaments`, five tournaments per request. Only
 *   about 14 of 350 CS2 tournaments have fixtures at any moment, and the
 *   tournament list says which, so a whole board is ~3 requests.
 * - Team names cost a request of their own, so they are cached in
 *   `oddspapi_participant` and refetched only when an unknown id appears.
 * - Every call is written to `api_call` BEFORE it is made, so a crash mid-call
 *   still counts, and the monthly cap is checked against that ledger rather than
 *   against memory — a container restarts on every deploy and would otherwise
 *   believe it had spent nothing.
 *
 * ## Which price belongs to which team — got wrong once, now verified
 *
 * **Outcome `<market>` is participant1's price and `<market>+1` is
 * participant2's, always.** The `bookmakerOutcomeId` label ("home"/"away") is
 * NOT a team mapping: it is Pinnacle's own venue alignment of that participant,
 * and Pinnacle's home is frequently OddsPapi's participant2.
 *
 * This file first had it backwards. The first pull showed outcome 171 labelled
 * "away" on 2 of 13 fixtures; that was read as "the ids are unreliable, trust the
 * label", and the parser was switched to the label. Verified 2026-09-11 against
 * Pinnacle's own open matchup list, joined by matchup id (embedded in
 * `bookmakerMarketId`): on all 8 live fixtures, outcome 171 carried "home"
 * exactly when Pinnacle aligned participant1 as home (3 of 3), and "away"
 * exactly when it aligned participant1 as away (5 of 5). An independent
 * Polymarket check agreed: every fixture that disagreed with Polymarket was one
 * of the five the label-reading parser had inverted.
 *
 * The cost of the mistake: on 5 of 8 fixtures the win probability was attached
 * to the other team, so the stack builder would have stacked unders on the
 * FAVOURITE — the exact failure this data exists to prevent.
 *
 * In this schema `home` therefore means participant1, the team OddsPapi lists
 * first — not the venue, and not Pinnacle's home. `home_name`, `home_price` and
 * `p_home_win` all refer to that same team, which is the only consistency the
 * rest of the app needs.
 */

const BASE = 'https://api.oddspapi.io/v4';
const BOOKMAKER = 'pinnacle';
/** The endpoint refuses more than five tournament ids per request. */
const PER_CALL = 5;

/** OddsPapi's sport id, and the id of its match-winner market, per league. */
export const SPORT: Record<string, { sportId: number; winnerMarket: string }> = {
  CS2: { sportId: 17, winnerMarket: '171' },
  LOL: { sportId: 18, winnerMarket: '181' },
};

export class BudgetExhausted extends Error {}

/**
 * Minimum gap between two calls to OddsPapi.
 *
 * The first live pull failed on this. The docs give a 5000ms cooldown for
 * historical odds; odds-by-tournaments turned out to enforce one too — the
 * second bulk call went out 178ms after the first and came back 429, having
 * already been counted against the month. Half a second of margin on top of
 * the documented figure costs nothing on a job that runs once a day.
 */
export const COOLDOWN_MS = 5_500;
let lastCallAt = 0;

/** How long to wait before the next call may go out. Pure, for testing. */
export function waitNeeded(lastAt: number, now: number, cooldown = COOLDOWN_MS): number {
  return lastAt === 0 ? 0 : Math.max(0, lastAt + cooldown - now);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ParsedFixture = {
  fixtureId: string;
  startsAt: string;
  homeId: string;
  awayId: string;
  homePrice: number | null;
  awayPrice: number | null;
  /** Home win probability with Pinnacle's margin removed. Null without both sides. */
  pHomeWin: number | null;
  /** Every market on the fixture, verbatim, for parsing once each is understood. */
  markets: Record<string, unknown>;
};

/**
 * One fixture's prices. Pure: no network, no database.
 *
 * Returns null when the bookmaker has no markets on the fixture at all. A
 * fixture with markets but no usable moneyline still comes back — with a null
 * probability — because its handicaps and totals are worth keeping.
 */
export function parseFixture(
  f: any,
  winnerMarket: string,
  bookmaker = BOOKMAKER,
): ParsedFixture | null {
  const markets = f?.bookmakerOdds?.[bookmaker]?.markets;
  if (!markets || typeof markets !== 'object') return null;

  const ml = markets[winnerMarket];
  const priceOf = (outcomeId: string): number | null => {
    const price = Number(ml?.outcomes?.[outcomeId]?.players?.['0']?.price);
    return Number.isFinite(price) && price > 1 ? price : null;
  };
  // By outcome id, never by label — see the header. <market> is participant1,
  // <market>+1 participant2.
  const homePrice = priceOf(winnerMarket);
  const awayPrice = priceOf(String(Number(winnerMarket) + 1));

  return {
    fixtureId: String(f.fixtureId),
    startsAt: String(f.startTime),
    homeId: String(f.participant1Id),
    awayId: String(f.participant2Id),
    homePrice,
    awayPrice,
    pHomeWin: devigTwoWay(homePrice, awayPrice),
    markets,
  };
}

/**
 * Remove the margin from a two-way decimal market, multiplicatively.
 *
 * The same method `devig.ts` uses for Underdog's American odds, and for the same
 * reason: at the margins Pinnacle carries, multiplicative and Shin agree to well
 * inside any difference we could measure.
 */
export function devigTwoWay(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a <= 1 || b <= 1) return null;
  const ia = 1 / a;
  const ib = 1 / b;
  return ia / (ia + ib);
}

/** Calls made this calendar month, from the ledger. */
export async function callsThisMonth(api = 'oddspapi'): Promise<number> {
  const r = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM api_call
      WHERE api = $1 AND called_at >= date_trunc('month', now())`,
    [api],
  );
  return Number(r[0]?.n ?? 0);
}

/**
 * One metered request. Refuses when the month's cap is reached.
 *
 * The ledger row goes in first. A request that throws halfway has still been
 * counted by OddsPapi, so it has to be counted here too.
 */
async function call(
  endpoint: string,
  params: Record<string, string | number>,
  retried = false,
): Promise<any> {
  if (!config.oddspapiKey) throw new Error('ODDSPAPI_KEY is not set');
  const wait = waitNeeded(lastCallAt, Date.now());
  if (wait > 0) await sleep(wait);
  const used = await callsThisMonth();
  if (used >= config.oddspapiMonthlyCap) {
    throw new BudgetExhausted(
      `OddsPapi: ${used} calls this month, cap ${config.oddspapiMonthlyCap} — skipping`);
  }

  const row = await q<{ id: string }>(
    `INSERT INTO api_call (api, endpoint) VALUES ('oddspapi', $1) RETURNING id::text`,
    [endpoint],
  );
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('apiKey', config.oddspapiKey);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  lastCallAt = Date.now();
  await q(`UPDATE api_call SET status = $1 WHERE id = $2`, [res.status, row[0]!.id]);
  // Rate-limited: wait out a double cooldown and try once more. The retry goes
  // through call() again, so it takes its own ledger row — a refused request
  // may still have been counted by OddsPapi, and the budget must assume so.
  if (res.status === 429 && !retried) {
    await sleep(COOLDOWN_MS * 2);
    return call(endpoint, params, true);
  }
  if (!res.ok) {
    throw new Error(`OddsPapi ${endpoint} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return res.json();
}

const asArray = (b: any): any[] => {
  const d = b?.data ?? b;
  return Array.isArray(d) ? d : Object.values(d ?? {});
};

/**
 * OddsPapi's participant list, in whichever shape it arrives.
 *
 * The first live pull stored nothing because of this. The response maps id to
 * name — `{"1254885": "Bushido Wildcats", ...}` — and the adapter read it as an
 * array of objects, found neither an id nor a name on a bare string, and dropped
 * all 989 names. Every fixture then failed the name lookup and was skipped, so
 * a pull that spent four requests wrote zero rows. Both shapes are handled so a
 * change on their side cannot do this silently again.
 */
export function parseParticipants(body: any): Array<{ id: string; name: string }> {
  const d = body?.data ?? body;
  const out: Array<{ id: string; name: string }> = [];
  if (Array.isArray(d)) {
    for (const p of d) {
      const id = p?.participantId ?? p?.id;
      const name = p?.participantName ?? p?.name;
      if (id != null && name) out.push({ id: String(id), name: String(name) });
    }
  } else if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'string') {
        if (v) out.push({ id: k, name: v });
      } else if (v && typeof v === 'object') {
        const name = (v as any).participantName ?? (v as any).name;
        const id = (v as any).participantId ?? (v as any).id ?? k;
        if (name) out.push({ id: String(id), name: String(name) });
      }
    }
  }
  return out;
}

/** Names for these participant ids, fetching the list only if one is unknown. */
async function participantNames(sportId: number, ids: string[]): Promise<Map<string, string>> {
  const known = new Map(
    (await q<{ participant_id: string; name: string }>(
      `SELECT participant_id, name FROM oddspapi_participant WHERE sport_id = $1`,
      [sportId],
    )).map((r) => [r.participant_id, r.name]),
  );
  if (ids.every((id) => known.has(id))) return known;

  for (const { id, name } of parseParticipants(await call('participants', { sportId }))) {
    known.set(id, name);
    await q(
      `INSERT INTO oddspapi_participant (sport_id, participant_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (sport_id, participant_id) DO UPDATE SET name = EXCLUDED.name, fetched_at = now()`,
      [sportId, id, name],
    );
  }
  return known;
}

/**
 * Pull the upcoming fixtures for one league and store them.
 *
 * Returns how many fixtures were stored and how many requests it cost, so the
 * scheduler can log the spend next to the result.
 */
export async function pullMatchOdds(league: string): Promise<{ stored: number; calls: number }> {
  const sport = SPORT[league];
  if (!sport) return { stored: 0, calls: 0 };
  const before = await callsThisMonth();

  const tours = asArray(await call('tournaments', { sportId: sport.sportId }));
  const active = tours
    .filter((t) => Number(t.upcomingFixtures ?? 0) + Number(t.futureFixtures ?? 0) > 0)
    .map((t) => t.tournamentId);

  const now = Date.now();
  const fixtures: ParsedFixture[] = [];
  for (let i = 0; i < active.length; i += PER_CALL) {
    const body = await call('odds-by-tournaments', {
      bookmaker: BOOKMAKER,
      tournamentIds: active.slice(i, i + PER_CALL).join(','),
      oddsFormat: 'decimal',
    });
    for (const f of asArray(body)) {
      // The endpoint returns a tournament's past fixtures too. Only one of 16
      // in the first pull had not yet started.
      if (!(Date.parse(f.startTime) > now)) continue;
      const parsed = parseFixture(f, sport.winnerMarket);
      if (parsed) fixtures.push(parsed);
    }
  }

  const names = await participantNames(
    sport.sportId,
    [...new Set(fixtures.flatMap((f) => [f.homeId, f.awayId]))],
  );

  let stored = 0;
  for (const f of fixtures) {
    const home = names.get(f.homeId);
    const away = names.get(f.awayId);
    // A fixture we cannot name cannot be matched to a board, so there is
    // nothing it could be used for.
    if (!home || !away) continue;
    await q(
      `INSERT INTO match_odds
         (bookmaker, fixture_id, league, starts_at, home_name, away_name,
          home_price, away_price, p_home_win, markets)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [BOOKMAKER, f.fixtureId, league, f.startsAt, home, away,
       f.homePrice, f.awayPrice, f.pHomeWin, JSON.stringify(f.markets)],
    );
    stored++;
  }

  return { stored, calls: (await callsThisMonth()) - before };
}

if (process.argv[1]?.endsWith('oddspapi.ts')) {
  const leagues = process.argv.slice(2).length ? process.argv.slice(2) : ['CS2'];
  for (const lg of leagues) {
    const r = await pullMatchOdds(lg.toUpperCase());
    console.log(`${lg}: stored ${r.stored} fixtures for ${r.calls} requests; ` +
      `${await callsThisMonth()} used this month of ${config.oddspapiMonthlyCap}`);
  }
  await pool.end();
}
