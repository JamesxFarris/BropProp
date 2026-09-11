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

test('prices are read by outcome id; the label is only the bookmaker venue alignment', () => {
  // The real NAVI Junior vs Privateer fixture of 2026-09-11. Outcome 171 is
  // NAVI Junior (participant1) at 1.155 — and Pinnacle labels it "away",
  // because Pinnacle calls Privateer the home side. Reading the label put
  // 4.36 on NAVI Junior and turned the 79% favourite into a 21% dog.
  const f = parseFixture(fixture([
    { id: '171', label: 'away', price: 1.155 },
    { id: '172', label: 'home', price: 4.36 },
  ]), '171')!;
  assert.equal(f.homePrice, 1.155, 'participant1 takes outcome 171, whatever its label says');
  assert.equal(f.awayPrice, 4.36);
  assert.ok(f.pHomeWin! > 0.75, `participant1 is the favourite here, got ${f.pHomeWin}`);

  // And when the labels happen to line up, nothing changes.
  const g = parseFixture(fixture([
    { id: '171', label: 'home', price: 1.613 },
    { id: '172', label: 'away', price: 2.22 },
  ]), '171')!;
  assert.equal(g.homePrice, 1.613);
  assert.equal(g.awayPrice, 2.22);
});

test('LoL uses its own winner market with the same id convention', () => {
  const f = parseFixture(fixture([
    { id: '181', label: 'away', price: 1.5 },
    { id: '182', label: 'home', price: 2.6 },
  ], '181'), '181')!;
  assert.equal(f.homePrice, 1.5);
  assert.equal(f.awayPrice, 2.6);
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
