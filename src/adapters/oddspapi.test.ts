import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFixture, devigTwoWay } from './oddspapi.js';

/** A fixture in OddsPapi's real shape, trimmed to what the parser reads. */
function fixture(outcomes: Array<{ id: string; label: string; price: number }>, market = '171') {
  const out: Record<string, unknown> = {};
  for (const o of outcomes) {
    out[o.id] = { players: { '0': { bookmakerOutcomeId: o.label, price: o.price } } };
  }
  return {
    fixtureId: 'id1', startTime: '2026-09-11T14:00:00.000Z',
    participant1Id: 111, participant2Id: 222,
    bookmakerOdds: { pinnacle: { markets: { [market]: { outcomes: out } } } },
  };
}

test('prices are read by label, not by outcome id', () => {
  // The trap from the first real pull: outcome 171 was the AWAY price on 2 of
  // 13 fixtures. Keying off the id would put the moneyline on the wrong team.
  const normal = parseFixture(fixture([
    { id: '171', label: 'home', price: 1.628 },
    { id: '172', label: 'away', price: 2.18 },
  ]), '171')!;
  const flipped = parseFixture(fixture([
    { id: '171', label: 'away', price: 2.18 },
    { id: '172', label: 'home', price: 1.628 },
  ]), '171')!;
  assert.equal(normal.homePrice, 1.628);
  assert.equal(flipped.homePrice, 1.628, 'the label decides, whichever id carries it');
  assert.equal(flipped.awayPrice, 2.18);
  assert.equal(normal.pHomeWin, flipped.pHomeWin);
});

test('the margin is removed from the moneyline', () => {
  const f = parseFixture(fixture([
    { id: '171', label: 'home', price: 1.628 },
    { id: '172', label: 'away', price: 2.18 },
  ]), '171')!;
  // 1/1.628 = 0.6143, 1/2.18 = 0.4587, sum 1.0730 -> 0.5725.
  assert.ok(Math.abs(f.pHomeWin! - 0.5725) < 1e-3, String(f.pHomeWin));
});

test('devig gives complementary probabilities and refuses nonsense prices', () => {
  const h = devigTwoWay(1.9, 1.9)!;
  assert.ok(Math.abs(h - 0.5) < 1e-12);
  assert.ok(Math.abs(devigTwoWay(1.5, 2.8)! + devigTwoWay(2.8, 1.5)! - 1) < 1e-12);
  assert.equal(devigTwoWay(null, 2), null);
  assert.equal(devigTwoWay(1, 2), null, 'a price of 1.0 pays nothing and implies certainty');
});

test('a missing side leaves the probability null rather than guessed', () => {
  const f = parseFixture(fixture([{ id: '171', label: 'home', price: 1.6 }]), '171')!;
  assert.equal(f.homePrice, 1.6);
  assert.equal(f.awayPrice, null);
  assert.equal(f.pHomeWin, null);
});

test('participants map to home and away in order', () => {
  const f = parseFixture(fixture([
    { id: '171', label: 'home', price: 1.6 },
    { id: '172', label: 'away', price: 2.4 },
  ]), '171')!;
  assert.equal(f.homeId, '111');
  assert.equal(f.awayId, '222');
});

test('a fixture with no bookmaker markets is skipped', () => {
  assert.equal(parseFixture({ fixtureId: 'x', bookmakerOdds: {} }, '171'), null);
  assert.equal(parseFixture({ fixtureId: 'x' }, '171'), null);
});

test('a fixture with markets but no moneyline is kept for its other markets', () => {
  const f = parseFixture(fixture([{ id: '173', label: '2.5/over', price: 2 }], '173'), '171')!;
  assert.ok(f, 'kept');
  assert.equal(f.pHomeWin, null);
  assert.ok('173' in f.markets);
});

// ------------------------------------------------------------- pacing ------

import { waitNeeded, COOLDOWN_MS } from './oddspapi.js';

test('a call right behind another waits out the rest of the cooldown', () => {
  // The first live pull: the second bulk call went out 178ms after the first
  // and was refused with a 429.
  assert.equal(waitNeeded(1000, 1178), COOLDOWN_MS - 178);
});

test('no wait once the cooldown has passed', () => {
  assert.equal(waitNeeded(1000, 1000 + COOLDOWN_MS + 1), 0);
});

test('the first call of a process never waits', () => {
  assert.equal(waitNeeded(0, Date.now()), 0);
});

test('the cooldown is above the documented 5000ms, not at it', () => {
  assert.ok(COOLDOWN_MS > 5000);
});
