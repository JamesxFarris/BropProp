import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationPlan } from './calibrate.js';
import type { MarketRow, BookLine } from './boardq.js';

const bl = (line: number, id: number, team: string | null): BookLine => ({
  book: 'prizepicks', line, prop_id: id,
  over_price: null, under_price: null, over_ok: true, under_ok: true,
  over_mult: null, under_mult: null,
  moved: null, last_move: null, last_move_at: null, side: null, team,
} as BookLine);

let id = 0;
const row = (handle: string, match: string, team: string | null): MarketRow => ({
  canon_handle: handle.toLowerCase(), handle, league: 'CS2', stat: 'kills',
  map_start: 1, map_end: 2, is_combo: false,
  books: [bl(20.5, ++id, team)],
  spread: 0, match_title: match, scheduled_at: null,
  confirmed_at: '2026-09-12T00:00:00Z',
} as MarketRow);

/** One fat match (5 v 5) plus six thin ones — a normal CS2 board. */
function board(): MarketRow[] {
  const rows: MarketRow[] = [];
  for (let i = 0; i < 5; i++) rows.push(row(`A${i}`, 'Fat vs Match', 'Fat'));
  for (let i = 0; i < 5; i++) rows.push(row(`B${i}`, 'Fat vs Match', 'Match'));
  for (let i = 0; i < 6; i++) rows.push(row(`C${i}`, `Thin${i} vs Other${i}`, `Thin${i}`));
  return rows;
}

test('the six-leg ladder walks concentration from 0 to 5', () => {
  const plan = calibrationPlan(board(), 'prizepicks');
  const six = plan.entries.filter((e) => e.size === 6 && e.id.startsWith('six-'));
  assert.equal(six.length, 6, 'one entry per concentration');
  assert.deepEqual(six.map((e) => e.excess), [0, 1, 2, 3, 4, 5]);
  // Excess is size minus distinct matches, which is the variable the discount
  // was measured against. If this drifts, every quote is filed at the wrong x.
  for (const e of six) assert.equal(e.excess, e.size - e.matches);
});

test('the concentrated entry is a 5+1, the shape the Stacks card recommends', () => {
  const plan = calibrationPlan(board(), 'prizepicks');
  const last = plan.entries.find((e) => e.id === 'six-x5')!;
  assert.equal(last.matches, 1, 'all six legs in one match');
  assert.equal(last.maxPerTeam, 5, 'five on one team');
  // PrizePicks refuses a single-team lineup, so a sweep that produced one would
  // be unbuildable exactly where it matters most.
  assert.ok(new Set(last.legs.map((l) => l.team)).size >= 2, 'two teams present');
});

test('the team-split entries hold concentration and vary only the split', () => {
  const plan = calibrationPlan(board(), 'prizepicks');
  const a = plan.entries.find((e) => e.id === 'split-4-2');
  const b = plan.entries.find((e) => e.id === 'split-3-3');
  assert.ok(a && b, 'both splits buildable on a 5v5 match');
  for (const e of [a!, b!]) {
    assert.equal(e.size, 6);
    assert.equal(e.matches, 1, 'same concentration as the 5+1');
  }
  assert.equal(a!.maxPerTeam, 4);
  assert.equal(b!.maxPerTeam, 3);
});

test('the mixed-side entry changes the side and nothing else', () => {
  const plan = calibrationPlan(board(), 'prizepicks');
  const five = plan.entries.find((e) => e.id === 'six-x5')!;
  const mixed = plan.entries.find((e) => e.id === 'mixed-side')!;
  assert.equal(mixed.sameSide, false);
  assert.equal(five.sameSide, true);
  assert.equal(mixed.excess, five.excess, 'concentration held constant');
  assert.deepEqual(
    mixed.legs.map((l) => l.propId), five.legs.map((l) => l.propId),
    'the same legs, so side is the only thing that moved',
  );
  assert.equal(mixed.legs.filter((l) => l.side === 'under').length, 1);
});

test('the flat controls are one leg per match', () => {
  const plan = calibrationPlan(board(), 'prizepicks');
  for (const n of [3, 5]) {
    const e = plan.entries.find((x) => x.id === `flat-${n}`)!;
    assert.equal(e.size, n);
    assert.equal(e.excess, 0, 'nothing concentrated — this is the list price');
    assert.equal(e.matches, n);
  }
});

test('one leg per player across the whole sweep', () => {
  // Two markets on one player are the same bet twice, and the apps mostly
  // refuse them. A sweep that quietly used both would measure a shape nobody
  // can build.
  const rows = board();
  rows.push({ ...row('A0', 'Fat vs Match', 'Fat'), stat: 'headshots' } as MarketRow);
  const plan = calibrationPlan(rows, 'prizepicks');
  for (const e of plan.entries) {
    const names = e.legs.map((l) => l.handle);
    assert.equal(new Set(names).size, names.length, `${e.id} repeats a player`);
  }
});

test('a board that cannot supply the shapes reports gaps instead of short entries', () => {
  // Three players, one match: nothing here can be built, and a four-leg entry
  // labelled as six would enter the fit as a real point.
  const thin = [row('x', 'One vs Two', 'One'), row('y', 'One vs Two', 'Two'), row('z', 'One vs Two', 'One')];
  const plan = calibrationPlan(thin, 'prizepicks');
  assert.equal(plan.entries.length, 0);
  assert.ok(plan.gaps.length > 0, 'says why rather than going quiet');
  assert.equal(plan.targetMatch, null);
});

test('markets the book does not list, or that have started, are not offered', () => {
  const started = board().map((r) => ({ ...r, scheduled_at: '2020-01-01T00:00:00Z' } as MarketRow));
  assert.equal(calibrationPlan(started, 'prizepicks').entries.length, 0);
  assert.equal(calibrationPlan(board(), 'underdog').entries.length, 0, 'no Underdog lines on this board');
});
