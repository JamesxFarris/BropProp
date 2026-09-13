import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePolymarket, MAX_SPREAD } from './polymarket.js';

const NOW = Date.parse('2026-09-13T08:00:00Z');

/** Shaped on a real event from the gamma API, 2026-09-13. */
const event = (over: Record<string, unknown> = {}, ml: Record<string, unknown> = {}) => ({
  id: '99001',
  gameId: 1673410,
  title: 'Counter-Strike: Elite Klan vs Eternal Fire Academy (BO3) - United21 Group D',
  startTime: '2026-09-13T10:30:00Z',
  eventMetadata: { league: 'United21', leagueTier: '5', pandascoreMatchId: 1673410 },
  markets: [
    {
      sportsMarketType: 'moneyline', closed: false,
      outcomes: '["Elite Klan", "Eternal Fire Academy"]', outcomePrices: '["0.315", "0.685"]',
      bestBid: 0.31, bestAsk: 0.32, gameStartTime: '2026-09-13 10:30:00+00', liquidityNum: 4502.9,
      ...ml,
    },
    {
      sportsMarketType: 'child_moneyline', closed: false,
      outcomes: '["Elite Klan", "Eternal Fire Academy"]', bestBid: 0.2, bestAsk: 0.3,
      gameStartTime: '2026-09-13 10:30:00+00',
    },
  ],
  ...over,
});

test('an upcoming moneyline is priced at the midpoint of its bid and ask', () => {
  const [f, ...rest] = parsePolymarket([event()], NOW);
  assert.equal(rest.length, 0, 'the per-map winner market is not a second fixture');
  assert.equal(f!.fixtureId, 'polymarket:1673410');
  assert.equal(f!.home, 'Elite Klan');
  assert.equal(f!.away, 'Eternal Fire Academy');
  assert.equal(f!.startsAt, '2026-09-13T10:30:00.000Z');
  assert.equal(f!.pHomeWin, 0.315);
  assert.equal(f!.homePrice, Math.round((1 / 0.315) * 1000) / 1000);
});

test('a wide market is kept but not priced', () => {
  // A 0.31 bid against a 0.93 ask is a real board on a thin BO1. The midpoint
  // of that is not anybody's view of who wins.
  const [f] = parsePolymarket([event({}, { bestBid: 0.31, bestAsk: 0.93 })], NOW);
  assert.ok(f, 'still recorded, so the number of unpriced markets is visible');
  assert.equal(f!.pHomeWin, null);
  assert.equal(f!.homePrice, null);
  assert.ok((f!.markets.spread as number) > MAX_SPREAD);
});

test('an empty side of the book is not a price', () => {
  const [f] = parsePolymarket([event({}, { bestBid: 0, bestAsk: 0.5 })], NOW);
  assert.equal(f!.pHomeWin, null);
});

test('closed, started, futures and map markets are skipped', () => {
  const started = event({}, { gameStartTime: '2026-09-13 07:00:00+00' });
  const closed = event({ gameId: 2 }, { closed: true });
  const future = { id: 'f', title: 'Will FaZe win a Tier 1 event in 2026?', markets: [{ sportsMarketType: 'futures', outcomes: '["Yes","No"]' }] };
  assert.deepEqual(parsePolymarket([started, closed, future], NOW), []);
});

test('the same game listed twice is stored once', () => {
  assert.equal(parsePolymarket([event(), event({ id: '99002' })], NOW).length, 1);
});
