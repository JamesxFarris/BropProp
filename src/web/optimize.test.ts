import test from 'node:test';
import assert from 'node:assert/strict';
import { bestEntry, type Candidate } from './optimize.js';

/**
 * The rule that decides which legs an entry may hold.
 *
 * An entry pays only if EVERY leg wins, so what matters is P(all win) — and
 * correlated legs win together. Measured over 35,702 same-match pairs of real
 * CS2 series: two overs from one match hit 24.69% against the 21.30% that
 * independence predicts (1.159x), while an over and an under from the same
 * match hit 20.56% against 24.85% (0.828x). Same direction helps by a sixth;
 * mixing directions hurts by a sixth.
 *
 * These pin the constraint that follows from that. No database.
 */

let n = 0;
const cand = (o: {
  match: string; side: 'over' | 'under'; p?: number; player?: string; mult?: number;
}): Candidate => {
  const player = o.player ?? `p${++n}`;
  return {
    row: { handle: player } as never,
    play: { side: o.side, line: 20, hitRate: o.p ?? 0.6 } as never,
    propId: ++n,
    p: o.p ?? 0.6,
    mult: o.mult ?? 1,
    value: (o.p ?? 0.6) * (o.mult ?? 1),
    source: 'model',
    gap: null,
    matchKey: o.match,
    players: [player],
  } as Candidate;
};

test('two legs on the same side of one match are allowed to stack', () => {
  // The old rule capped a match at two legs to spread risk, which is right for
  // independent bets and backwards for an all-must-win entry.
  const e = bestEntry(
    [cand({ match: 'm1', side: 'over' }), cand({ match: 'm1', side: 'over' })],
    2, 'prizepicks',
  );
  assert.ok(e, 'a same-side stack should build');
  assert.equal(e!.legs.length, 2);
});

test('an over and an under from the same match are never both taken', () => {
  // They bet against each other: a long bloody series cashes every over on it
  // and busts every under.
  const e = bestEntry(
    [cand({ match: 'm1', side: 'over' }), cand({ match: 'm1', side: 'under' })],
    2, 'prizepicks',
  );
  assert.equal(e, null, 'the conflicting leg is refused, so a 2-leg entry cannot fill');
});

test('the opposite side is still fine on a DIFFERENT match', () => {
  const e = bestEntry(
    [cand({ match: 'm1', side: 'over' }), cand({ match: 'm2', side: 'under' })],
    2, 'prizepicks',
  );
  assert.ok(e);
  assert.equal(e!.legs.length, 2);
});

test('a mixed-side leg is skipped rather than ending the build', () => {
  // The conflicting candidate must not consume the slot — a later, legal leg
  // should still fill it.
  const e = bestEntry(
    [
      cand({ match: 'm1', side: 'over' }),
      cand({ match: 'm1', side: 'under' }),   // refused
      cand({ match: 'm2', side: 'over' }),    // should take the second slot
    ],
    2, 'prizepicks',
  );
  assert.ok(e);
  assert.equal(e!.legs.length, 2);
  assert.equal(e!.legs[1]!.matchKey, 'm2');
});

test('one player cannot appear twice, however well they price', () => {
  const e = bestEntry(
    [
      cand({ match: 'm1', side: 'over', player: 'donk' }),
      cand({ match: 'm1', side: 'over', player: 'donk' }),
    ],
    2, 'prizepicks',
  );
  assert.equal(e, null, 'the same player on both legs is the same bet twice');
});

test('concentration still has a ceiling', () => {
  // Direction is the real constraint, but an entry that is five legs of one
  // match lives or dies on a single server crash, so the count cap remains.
  const legs = Array.from({ length: 6 }, () => cand({ match: 'm1', side: 'over' }));
  const e = bestEntry(legs, 6, 'prizepicks');
  assert.equal(e, null, 'six legs from one match exceeds the per-match ceiling');
});

test('the payout is the book base times each leg multiplier', () => {
  // The table is injected rather than read from the environment. It used to be
  // a hardcoded constant, which made this test a test of that constant; both
  // books have since moved off a flat rate by leg count, so the default is now
  // empty and the arithmetic is pinned against a table supplied here.
  const e = bestEntry(
    [cand({ match: 'm1', side: 'over', mult: 0.5 }), cand({ match: 'm2', side: 'over' })],
    2, 'prizepicks', 4, { prizepicks: { 2: 3 } },
  );
  assert.ok(e);
  assert.ok(Math.abs(e!.payout! - 3 * 0.5) < 1e-9);
});

test('an unknown payout table yields legs but no payout or EV', () => {
  // The failure this guards against is inventing a multiplier. PrizePicks
  // prices per prop and publishes nothing usable in its API, so with no table
  // configured the entry must still pick its legs and must not quote a return.
  const e = bestEntry(
    [cand({ match: 'm1', side: 'over' }), cand({ match: 'm2', side: 'over' })],
    2, 'prizepicks', 4, {},
  );
  assert.ok(e, 'legs should still be chosen without a payout table');
  assert.equal(e!.payout, null);
  assert.equal(e!.evMultiple, null);
  assert.ok(e!.winProb > 0, 'the win probability does not depend on the payout');
  assert.equal(e!.legs.length, 2);
});

// ------------------------------------- where a leg's direction comes from --

import { candidatesFor } from './optimize.js';
import type { MarketRow, BookLine } from './boardq.js';
import type { FormStats } from './projection.js';

function line(book: string, l: number): BookLine {
  return {
    book, line: l, prop_id: Math.round(l * 100),
    over_price: null, under_price: null, over_ok: true, under_ok: true,
    over_mult: null, under_mult: null,
    moved: null, last_move: null, last_move_at: null, side: null,
  };
}

function market(books: BookLine[]): MarketRow {
  return {
    canon_handle: 'zywoo', handle: 'ZywOo', league: 'CS2', stat: 'kills',
    map_start: 1, map_end: 1, is_combo: false,
    books,
    spread: Math.max(...books.map((b) => b.line)) - Math.min(...books.map((b) => b.line)),
    match_title: 'Vitality vs G2', scheduled_at: null, confirmed_at: '2026-09-09T00:00:00Z',
  };
}

/** Enough real range totals for the probability path to use them directly. */
const history: Map<string, FormStats> = new Map([
  ['zywoo|kills|1|1', {
    series: 10, mean: 20, sd: null, perMap: 20,
    totals: [14, 16, 18, 20, 20, 22, 24, 26, 12, 28],
    mapValues: [14, 16, 18, 20, 20, 22, 24, 26, 12, 28],
  }],
]);

test('two books leave the direction to the model, because they cannot vote', () => {
  const rows = [market([line('prizepicks', 18.5), line('underdog', 20.5)])];
  const c = candidatesFor(rows, history, 'prizepicks');
  // Whatever it decides, it must not claim the crowd decided it.
  for (const x of c) assert.equal(x.source, 'model');
});

test('three books take the direction off the crowd instead of the projection', () => {
  // PrizePicks two kills below a crowd that agrees on 20.5, so its over is the
  // cheap side — regardless of what our own projection thinks of the player.
  const rows = [market([
    line('prizepicks', 18.5), line('underdog', 20.5), line('sleeper', 20.5),
  ])];
  const c = candidatesFor(rows, history, 'prizepicks');
  assert.equal(c.length, 1);
  assert.equal(c[0]!.source, 'consensus');
  assert.equal(c[0]!.play.side, 'over');
  assert.equal(c[0]!.gap, 2);
});

test('a consensus leg stakes the side it was scored on', () => {
  // The bug this guards: scoring the consensus side while the displayed play
  // still names the model's, so the slip panel and the take button disagree
  // about what was picked.
  const rows = [market([
    line('prizepicks', 24.5), line('underdog', 20.5), line('sleeper', 20.5),
  ])];
  const c = candidatesFor(rows, history, 'prizepicks');
  assert.equal(c[0]!.source, 'consensus');
  assert.equal(c[0]!.play.side, 'under', 'four above the crowd leaves room underneath');
  assert.equal(c[0]!.play.line, 24.5, 'staked at this book number, not the crowd number');
});

test('books that all agree produce no consensus leg', () => {
  // No gap means nothing is off the crowd, so there is no market-derived
  // direction and the model is all that is left.
  const rows = [market([
    line('prizepicks', 20.5), line('underdog', 20.5), line('sleeper', 20.5),
  ])];
  for (const x of candidatesFor(rows, history, 'prizepicks')) {
    assert.equal(x.source, 'model');
  }
});

test('a bigger gap outranks a smaller one', () => {
  const rows = [
    { ...market([line('prizepicks', 18.5), line('underdog', 20.5), line('sleeper', 20.5)]),
      canon_handle: 'zywoo', handle: 'ZywOo', match_title: 'A vs B' },
    { ...market([line('prizepicks', 20), line('underdog', 20.5), line('sleeper', 20.5)]),
      canon_handle: 'zywoo', handle: 'ZywOo', match_title: 'C vs D' },
  ];
  const c = candidatesFor(rows, history, 'prizepicks');
  assert.equal(c.length, 2);
  assert.ok(c[0]!.gap! > c[1]!.gap!, 'ranked by value, and a wider gap wins more often');
});
