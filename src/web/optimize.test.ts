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
  const e = bestEntry(
    [cand({ match: 'm1', side: 'over', mult: 0.5 }), cand({ match: 'm2', side: 'over' })],
    2, 'prizepicks',
  );
  assert.ok(e);
  // PrizePicks pays 3x on two legs; a demoted leg halves it.
  assert.ok(Math.abs(e!.payout - 3 * 0.5) < 1e-9);
});
