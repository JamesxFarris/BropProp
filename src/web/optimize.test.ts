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
    team: null,
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
    moved: null, last_move: null, last_move_at: null, side: null, team: null,
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

// ------------------------------------------------- the stack search --------

import { findStacks } from './optimize.js';
import { probAllWin as pAll, partnerGivenCore } from './slip.js';

function stackCand(o: {
  player: string; team: string; match: string; p: number; side?: 'over' | 'under';
}): Candidate {
  return {
    row: { handle: o.player } as never,
    play: { side: o.side ?? 'under', line: 20, hitRate: o.p } as never,
    propId: Math.abs([...o.player].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 100000,
    p: o.p, mult: 1, value: o.p,
    source: 'model', gap: null,
    matchKey: o.match, team: o.team, players: [o.player],
  } as Candidate;
}

/** Five on one team plus one opponent, all pointed the same way. */
function oneMatchBoard(match: string, teamA: string, teamB: string, p = 0.553) {
  const out: Candidate[] = [];
  for (let i = 0; i < 5; i++) out.push(stackCand({ player: `${teamA}-${i}`, team: teamA, match, p }));
  for (let i = 0; i < 5; i++) out.push(stackCand({ player: `${teamB}-${i}`, team: teamB, match, p }));
  return out;
}

test('a stack needs a far lower multiplier than the same legs spread out', () => {
  // The whole point of the search. Six legs of identical strength: concentrated
  // on one team they win together, scattered they do not.
  const stacked = findStacks(oneMatchBoard('A vs B', 'A', 'B'), 6, 'prizepicks')[0]!;
  assert.ok(stacked, 'a six-leg stack should be findable on a ten-player match');

  const spread: Candidate[] = [];
  for (let i = 0; i < 6; i++) {
    spread.push(stackCand({ player: `p${i}`, team: `T${i}`, match: `M${i}`, p: 0.553 }));
  }
  const spreadProb = spread.reduce((acc, l) => acc * l.p, 1);

  assert.ok(stacked.winProb > spreadProb,
    `stack ${stacked.winProb} should beat spread ${spreadProb}`);
  assert.ok(stacked.requiredMultiplier < 1 / spreadProb);
});

test('the correlation lift is reported and is greater than one', () => {
  const s = findStacks(oneMatchBoard('A vs B', 'A', 'B'), 6, 'prizepicks')[0]!;
  assert.ok(s.lift > 1.2, `expected a real lift, got ${s.lift}`);
  assert.ok(Math.abs(s.winProb / s.winProbIndependent - s.lift) < 1e-9);
});

test('a stack never mixes sides', () => {
  // After five teammates all go over, an opponent's over hits ~87% and his
  // under ~13%. A mixed stack is fighting its own tail, so none is built —
  // even when the only way to fill a shape would be an opposite-side leg.
  const board = oneMatchBoard('A vs B', 'A', 'B');
  board[2] = stackCand({ player: 'A-2', team: 'A', match: 'A vs B', p: 0.553, side: 'over' });
  const stacks = findStacks(board, 6, 'prizepicks');
  assert.ok(stacks.length > 0);
  for (const s of stacks) {
    assert.ok(s.aligned);
    assert.ok(s.legs.every((l) => l.play.side === s.side), 'every leg on the stack side');
  }
});

test('stacks come back easiest-to-beat first', () => {
  const stacks = findStacks(oneMatchBoard('A vs B', 'A', 'B'), 6, 'prizepicks');
  for (let i = 1; i < stacks.length; i++) {
    assert.ok(stacks[i - 1]!.requiredMultiplier <= stacks[i]!.requiredMultiplier);
  }
});

test('one leg per player, even across a team', () => {
  const board = oneMatchBoard('A vs B', 'A', 'B');
  // A second market on a player already in the pool.
  board.push(stackCand({ player: 'A-0', team: 'A', match: 'A vs B', p: 0.99 }));
  for (const s of findStacks(board, 6, 'prizepicks')) {
    const names = s.legs.flatMap((l) => l.players);
    assert.equal(new Set(names).size, names.length, 'a player appears twice');
  }
});

test('legs with no team cannot be stacked', () => {
  // Grouping is the whole mechanism; without a team there is nothing to group.
  const board = oneMatchBoard('A vs B', 'A', 'B').map((c) => ({ ...c, team: null }));
  assert.deepEqual(findStacks(board, 6, 'prizepicks'), []);
});

test('a board with only one team in a match yields no buildable stack', () => {
  // PrizePicks requires two different teams in a lineup, so a partner must
  // exist or the shape cannot be entered.
  const solo: Candidate[] = [];
  for (let i = 0; i < 6; i++) solo.push(stackCand({ player: `A-${i}`, team: 'A', match: 'A vs B', p: 0.553 }));
  assert.deepEqual(findStacks(solo, 6, 'prizepicks'), []);
});

test('a 5+1 stack prices its core by the copula and its partner by the measured tail', () => {
  // The copula is calibrated for teammates (it matched the archive at every
  // core size) but has the opponent following at ~58% where the archive says
  // ~72% for unders. So the partner comes from the table, and the stack needs
  // less than the copula alone would say.
  const s = findStacks(oneMatchBoard('A vs B', 'A', 'B', 0.553), 6, 'prizepicks')[0]!;
  const core = s.legs.filter((l) => l.team === s.team)
    .map((l) => ({ p: l.p, matchKey: l.matchKey, side: l.play.side, team: l.team }));
  assert.equal(core.length, 5);
  const want = 1 / (pAll(core) * partnerGivenCore(0.553, 5, 'under'));
  assert.ok(Math.abs(s.requiredMultiplier - want) < 1e-9, `${s.requiredMultiplier} vs ${want}`);
  const copulaOnly = 1 / pAll(s.legs.map((l) => ({ p: l.p, matchKey: l.matchKey, side: l.play.side, team: l.team })));
  assert.ok(s.requiredMultiplier < copulaOnly, 'the tail makes the stack cheaper to beat');
});

// ------------------------------------------- legs priced by the team --------

import { marketCandidates } from './optimize.js';
import type { TeamOdds } from './matchodds.js';

function mline(book: string, l: number, team: string | null, id: number): BookLine {
  return {
    book, line: l, prop_id: id,
    over_price: null, under_price: null, over_ok: true, under_ok: true,
    over_mult: null, under_mult: null,
    moved: null, last_move: null, last_move_at: null, side: null, team,
  };
}

function mrow(handle: string, team: string | null, id: number, match = 'Dogs vs Favs', combo = false): MarketRow {
  return {
    canon_handle: handle.toLowerCase(), handle, league: 'CS2', stat: 'kills',
    map_start: 1, map_end: 2, is_combo: combo,
    books: [mline('prizepicks', 30.5, team, id)],
    spread: null, match_title: match, scheduled_at: null, confirmed_at: '2026-09-10T00:00:00Z',
  };
}

const odds = (pWin: number, opponent: string): TeamOdds =>
  ({ pWin, opponent, startsAt: '2026-09-11T00:00:00Z', observedAt: '2026-09-10T00:00:00Z' });

test('with no moneyline every leg is an under at the measured book baseline', () => {
  const c = marketCandidates([mrow('a', 'Dogs', 1), mrow('b', 'Favs', 2)], new Map(), 'prizepicks');
  assert.equal(c.length, 2);
  for (const x of c) {
    assert.equal(x.play.side, 'under');
    assert.ok(Math.abs(x.p - 0.516) < 1e-9, String(x.p));
    assert.equal(x.source, 'market');
  }
});

test('an underdog is a better under than its opponent', () => {
  const m = new Map([['Dogs', odds(0.25, 'Favs')], ['Favs', odds(0.75, 'Dogs')]]);
  const c = marketCandidates([mrow('a', 'Dogs', 1), mrow('b', 'Favs', 2)], m, 'prizepicks');
  const dog = c.find((x) => x.team === 'Dogs')!;
  const fav = c.find((x) => x.team === 'Favs')!;
  assert.ok(Math.abs(dog.p - 0.54325) < 1e-4, `dog under ${dog.p}`);
  assert.ok(dog.p > fav.p, 'the losing side must be the stronger under');
});

test('a heavy enough favourite flips to the over', () => {
  // At 80% to win: 0.8*0.457 + 0.2*0.572 = 0.480 under, so the over is 52.0%.
  const m = new Map([['Favs', odds(0.8, 'Dogs')]]);
  const [x] = marketCandidates([mrow('b', 'Favs', 2)], m, 'prizepicks');
  assert.equal(x!.play.side, 'over');
  assert.ok(Math.abs(x!.p - 0.520) < 1e-3, String(x!.p));
});

test('combos and teamless legs are left out', () => {
  // A combo can span both teams, and the mixture prices one team.
  const c = marketCandidates([
    mrow('a', null, 1),
    mrow('b+c', 'Dogs', 2, 'Dogs vs Favs', true),
  ], new Map(), 'prizepicks');
  assert.deepEqual(c, []);
});

test('an under that is not offered is not a leg', () => {
  const r = mrow('a', 'Dogs', 1);
  r.books[0]!.under_ok = false;
  assert.deepEqual(marketCandidates([r], new Map(), 'prizepicks'), []);
});

test('both sides are offered when asked, priced as complements', () => {
  const m = new Map([['Dogs', odds(0.25, 'Favs')]]);
  const c = marketCandidates([mrow('a', 'Dogs', 1)], m, 'prizepicks', { bothSides: true });
  assert.equal(c.length, 2);
  const u = c.find((x) => x.play.side === 'under')!, o = c.find((x) => x.play.side === 'over')!;
  assert.ok(Math.abs(u.p + o.p - 1) < 1e-12);
});

test('each team is stacked both ways, each with a same-side partner', () => {
  // Five on each side of one match, the dogs priced at 25%. The dogs' unders
  // (54.3%) pair with a favourite UNDER (48.6%) and the favourite's overs
  // (51.4%) with a dog OVER (45.7%): a sub-50% partner on the core's side,
  // because after the core hits it is the likely one.
  //
  // The favourite's overs come out on top. Their legs are weaker, but the over
  // tail is much the stronger — after five overs, the dog's over hits ~89%;
  // after five unders, the favourite's under ~64%.
  const rows: MarketRow[] = [];
  for (let i = 0; i < 5; i++) rows.push(mrow(`dog${i}`, 'Dogs', 100 + i));
  for (let i = 0; i < 5; i++) rows.push(mrow(`fav${i}`, 'Favs', 200 + i));
  const m = new Map([['Dogs', odds(0.25, 'Favs')], ['Favs', odds(0.75, 'Dogs')]]);
  const stacks = findStacks(marketCandidates(rows, m, 'prizepicks', { bothSides: true }), 6, 'prizepicks');

  const dogUnders = stacks.find((s) => s.team === 'Dogs' && s.side === 'under')!;
  const favOvers = stacks.find((s) => s.team === 'Favs' && s.side === 'over')!;
  assert.ok(dogUnders && favOvers);
  for (const s of [dogUnders, favOvers]) {
    assert.equal(s.legs.filter((l) => l.team === s.team).length, 5);
    assert.ok(s.legs.every((l) => l.play.side === s.side));
  }
  assert.equal(stacks[0], favOvers);
  // ~9.4x and ~11.1x: both well under the 22x a real six-pick was quoted at.
  assert.ok(favOvers.requiredMultiplier < 10, String(favOvers.requiredMultiplier));
  assert.ok(dogUnders.requiredMultiplier < 12, String(dogUnders.requiredMultiplier));
});

test('deaths and assists are never priced by the team', () => {
  // The bug the first Stacks screenshot showed: "under deaths" on the team
  // expected to LOSE. A beaten team dies more, so that leg points backwards
  // on exactly the teams the pricing favours. Assists were never measured.
  const r = (stat: string, id: number): MarketRow => ({ ...mrow(`p${id}`, 'Dogs', id), stat });
  const m = new Map([['Dogs', odds(0.2, 'Favs')]]);
  const c = marketCandidates([r('deaths', 1), r('assists', 2), r('kills', 3), r('headshots', 4)], m, 'prizepicks');
  assert.deepEqual(c.map((x) => x.row.stat).sort(), ['headshots', 'kills']);
});
