import { q } from '../db.js';
import { getJson } from './types.js';

/**
 * Polymarket's CS2 moneylines — free, unauthenticated, and uncapped.
 *
 * The moneyline feeds one measured effect: a losing team's players go under
 * 57.2% of the time against 45.7% for the winners (paired p = 0.040), mixed by
 * the market's view of who wins. It was fed by Pinnacle through OddsPapi, whose
 * free tier allows one pull a day, and a pull only sees fixtures about fourteen
 * hours ahead. Measured on 2026-09-13 that covered 0 of the 12 CS2 matches on
 * the board. Polymarket priced 11 of them, and has no request budget to ration,
 * so it can be polled as often as the board itself.
 *
 * Two things about these prices decide how they are used.
 *
 * - **The spread, not the last price.** Tier-5 and BO1 markets can sit at a
 *   bid of 0.31 and an ask of 0.93; the "price" shown there is a last trade or a
 *   stale quote, not a probability. A market is priced at the midpoint of its
 *   best bid and ask, and only when the two are within MAX_SPREAD. Wider ones
 *   are still stored, unpriced, so it is visible how many there are — they
 *   usually tighten as the match approaches, and the next pull picks them up.
 * - **No margin to remove.** A prediction market's two prices sum to about one,
 *   so the midpoint is the probability. The decimal prices stored beside it are
 *   just its inverse, for a like-for-like column with the OddsPapi rows.
 *
 * Rows land in the same `match_odds` table the board already reads, under
 * source and bookmaker 'polymarket', with fixture ids of their own. Where
 * Pinnacle prices the same match too, `teamWinProbs` keeps the freshest quote
 * per match.
 */

const BASE = 'https://gamma-api.polymarket.com';
/** Widest bid/ask gap at which the midpoint is still read as a probability. */
export const MAX_SPREAD = 0.10;
const PAGE = 100;
const MAX_PAGES = 15;

export type PolyFixture = {
  fixtureId: string;
  startsAt: string;
  home: string;
  away: string;
  /** Midpoint of best bid and ask on the home team. Null when too wide to trust. */
  pHomeWin: number | null;
  homePrice: number | null;
  awayPrice: number | null;
  markets: Record<string, unknown>;
};

const jsonArray = (s: unknown): string[] => {
  if (Array.isArray(s)) return s.map(String);
  try {
    const v = JSON.parse(String(s ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** "2026-09-13 10:30:00+00" and "2026-09-13T10:30:00Z" both, to epoch ms. */
const startOf = (s: unknown): number => {
  const raw = String(s ?? '').trim();
  if (!raw) return NaN;
  return Date.parse((raw.includes('T') ? raw : raw.replace(' ', 'T')).replace(/\+00$/, 'Z'));
};

/**
 * The events payload, reduced to upcoming match moneylines. Pure: no network.
 *
 * Futures ("Will FaZe win a Tier 1 event?"), per-map winners and totals are
 * skipped by market type, not by guessing from titles. The first outcome is
 * home: Polymarket's best bid and ask quote that outcome's token.
 */
export function parsePolymarket(events: any[], now = Date.now()): PolyFixture[] {
  const out: PolyFixture[] = [];
  const seen = new Set<string>();
  for (const e of events ?? []) {
    const ml = (e?.markets ?? []).find((m: any) => m?.sportsMarketType === 'moneyline' && !m.closed);
    if (!ml) continue;
    const start = startOf(ml.gameStartTime ?? e.startTime);
    if (!(start > now)) continue;
    const [home, away, ...rest] = jsonArray(ml.outcomes);
    if (!home || !away || rest.length) continue;
    const id = e.gameId ?? e.eventMetadata?.pandascoreMatchId ?? e.id;
    if (id == null) continue;
    const fixtureId = `polymarket:${id}`;
    if (seen.has(fixtureId)) continue;
    seen.add(fixtureId);

    const bid = Number(ml.bestBid), ask = Number(ml.bestAsk);
    const spread = bid > 0 && ask > 0 && ask >= bid ? ask - bid : null;
    const mid = spread !== null && spread <= MAX_SPREAD ? (bid + ask) / 2 : null;
    const p = mid !== null && mid > 0 && mid < 1 ? Math.round(mid * 10_000) / 10_000 : null;

    out.push({
      fixtureId,
      startsAt: new Date(start).toISOString(),
      home,
      away,
      pHomeWin: p,
      homePrice: p === null ? null : Math.round((1 / p) * 1000) / 1000,
      awayPrice: p === null ? null : Math.round((1 / (1 - p)) * 1000) / 1000,
      markets: {
        title: e.title ?? null,
        bestBid: Number.isFinite(bid) ? bid : null,
        bestAsk: Number.isFinite(ask) ? ask : null,
        spread,
        liquidity: Number(ml.liquidityNum ?? ml.liquidity) || null,
        volume: Number(ml.volume) || null,
        league: e.eventMetadata?.league ?? null,
        leagueTier: e.eventMetadata?.leagueTier ?? null,
        pandascoreMatchId: e.eventMetadata?.pandascoreMatchId ?? null,
      },
    });
  }
  return out;
}

/** Fetch every open CS2 event and store its moneyline. */
export async function pullPolymarket(league = 'CS2'): Promise<{ fixtures: number; priced: number }> {
  const events: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { status, body } = await getJson(
      `${BASE}/events?tag_slug=counter-strike-2&closed=false&limit=${PAGE}&offset=${page * PAGE}`,
      { timeoutMs: 30_000 },
    );
    if (!Array.isArray(body)) {
      if (page === 0) throw new Error(`Polymarket events -> ${status}`);
      break;
    }
    events.push(...body);
    if (body.length < PAGE) break;
  }

  const fixtures = parsePolymarket(events);
  for (const f of fixtures) {
    await q(
      `INSERT INTO match_odds
         (source, bookmaker, fixture_id, league, starts_at, home_name, away_name,
          home_price, away_price, p_home_win, markets)
       VALUES ('polymarket', 'polymarket', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [f.fixtureId, league, f.startsAt, f.home, f.away,
       f.homePrice, f.awayPrice, f.pHomeWin, JSON.stringify(f.markets)],
    );
  }
  return { fixtures: fixtures.length, priced: fixtures.filter((f) => f.pHomeWin !== null).length };
}
