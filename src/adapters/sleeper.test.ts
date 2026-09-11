import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSleeper, parseWager, decimalToAmerican } from './sleeper.js';

/** One line in Sleeper's real shape, as captured 2026-09-11. */
function line(o: Partial<{
  sport: string; status: string; game_status: string; subject_type: string;
  wager_type: string; overStatus: string; overMult: string; underMult: string; value: number;
}> = {}) {
  return {
    status: o.status ?? 'active', sport: o.sport ?? 'cs', season: '2026',
    subject_id: '1083', subject_type: o.subject_type ?? 'player',
    game_id: 'match-2827992', game_status: o.game_status ?? 'pre_game',
    wager_type: o.wager_type ?? 'headshots_maps_1_2',
    market_type: 'headshots_maps_1_2_over_under_player_1083',
    pick_stats: { popularity: 0.528 },
    options: [
      { status: o.overStatus ?? 'active', outcome: 'over', outcome_value: o.value ?? 17.5,
        payout_multiplier: o.overMult ?? '1.86', subject_team: 'Alliance', line_id: 'L1' },
      { status: 'active', outcome: 'under', outcome_value: o.value ?? 17.5,
        payout_multiplier: o.underMult ?? '1.72', subject_team: 'Alliance', line_id: 'L2' },
    ],
  };
}

const PLAYERS = { 'cs:1083': { username: 'avid', first_name: 'Arvid', last_name: 'Åberg', team: 'Alliance' } };
const SCHEDULE = [{
  game_id: 'match-2827992', date: '2026-09-10', status: 'pre_game',
  home: { name: 'MiBR', team: 'MiBR' }, away: { name: 'Alliance', team: 'Alliance' },
}];
const CS = new Set(['CS2']);

test('a real CS line parses into our shape', () => {
  const [p] = parseSleeper([line()], PLAYERS, SCHEDULE, CS);
  assert.ok(p);
  assert.equal(p.league, 'CS2');
  assert.equal(p.player.handle, 'avid', 'the username, not the real name');
  assert.equal(p.player.team?.name, 'Alliance');
  assert.equal(p.stat, 'headshots');
  assert.equal(p.mapStart, 1);
  assert.equal(p.mapEnd, 2);
  assert.equal(p.line, 17.5);
  assert.equal(p.match?.title, 'MiBR vs Alliance');
  assert.equal(p.overPrice, -116, '1.86 decimal is -116 American');
  assert.equal(p.underPrice, -139, '1.72 decimal is -139 American');
});

test('the payout multipliers are kept, under keys the optimiser does not read as relative pay', () => {
  const [p] = parseSleeper([line()], PLAYERS, SCHEDULE, CS);
  assert.equal(p!.extra?.sleeper_over_mult, 1.86);
  assert.equal(p!.extra?.sleeper_under_mult, 1.72);
  assert.equal((p!.extra as any)?.over_multiplier, undefined,
    'over_multiplier means "relative to a standard leg" — a Sleeper 1.86 is not that');
});

test('a date with no kickoff time is stored as an end-of-day upper bound', () => {
  const [p] = parseSleeper([line()], PLAYERS, SCHEDULE, CS);
  assert.equal(p!.match?.scheduledAt, '2026-09-10T23:59:00.000Z');
});

test('only pre-game, active, player lines are taken', () => {
  assert.equal(parseSleeper([line({ game_status: 'in_progress' })], PLAYERS, SCHEDULE, CS).length, 0);
  assert.equal(parseSleeper([line({ status: 'inactive' })], PLAYERS, SCHEDULE, CS).length, 0);
  assert.equal(parseSleeper([line({ subject_type: 'team' })], PLAYERS, SCHEDULE, CS).length, 0);
});

test('other sports and unwanted leagues are ignored', () => {
  assert.equal(parseSleeper([line({ sport: 'mlb' })], PLAYERS, SCHEDULE, CS).length, 0);
  assert.equal(parseSleeper([line()], PLAYERS, SCHEDULE, new Set(['LOL'])).length, 0);
});

test('a player missing from the directory is skipped, not given a blank handle', () => {
  assert.equal(parseSleeper([line()], {}, SCHEDULE, CS).length, 0);
});

test('a suspended side leaves that price null rather than stale', () => {
  const [p] = parseSleeper([line({ overStatus: 'suspended' })], PLAYERS, SCHEDULE, CS);
  assert.ok(p, 'the under is still live, so the market is kept');
  assert.equal(p!.overPrice, null);
  assert.equal(p!.underPrice, -139);
});

test('wager types parse into ranges, and anything unknown is refused', () => {
  assert.deepEqual(parseWager('kills_maps_1_2'), { stat: 'kills', mapStart: 1, mapEnd: 2 });
  assert.deepEqual(parseWager('headshots_maps_1_2'), { stat: 'headshots', mapStart: 1, mapEnd: 2 });
  assert.deepEqual(parseWager('kills_map_3'), { stat: 'kills', mapStart: 3, mapEnd: 3 });
  assert.deepEqual(parseWager('kills_maps_1_3'), { stat: 'kills', mapStart: 1, mapEnd: 3 });
  assert.equal(parseWager('fantasy_points'), null);
  assert.equal(parseWager('kills_maps_2_1'), null, 'a reversed range is not a range');
  assert.equal(parseWager(''), null);
});

test('decimal to American', () => {
  assert.equal(decimalToAmerican(1.86), -116);
  assert.equal(decimalToAmerican(2.43), 143);
  assert.equal(decimalToAmerican(2), 100);
  assert.equal(decimalToAmerican(1), null, 'a price of 1.0 pays nothing');
  assert.equal(decimalToAmerican(NaN), null);
});
