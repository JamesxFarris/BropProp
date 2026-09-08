import test from 'node:test';
import assert from 'node:assert/strict';
import { toMapStats, type Bo3Game, type Bo3Match, type Bo3PlayerStat } from './bo3.js';

/**
 * The bo3.gg row shape is close enough to ours to be dangerous. `death` is
 * singular, `headshots` could plausibly have meant headshot *hits*, and a
 * player carries two different names either of which a book might use. Each of
 * those silently mis-maps into a number that grading treats as truth, so they
 * are pinned here rather than eyeballed once.
 */

const match: Bo3Match = {
  id: 128851,
  slug: 'team-villainous-vs-straight2killin-06-09-2026',
  status: 'finished',
  tier: 'c',
  discipline_id: 1,
  parsed_status: 'done',
  start_date: '2026-09-06T20:00:00.000+00:00',
  end_date: '2026-09-06T21:53:10.000+00:00',
};

const game: Bo3Game = { id: 184251, number: 2, begin_at: '2026-09-06T21:00:00.000+00:00' };

function row(over: Partial<Bo3PlayerStat> = {}): Bo3PlayerStat {
  return {
    game_id: 184251,
    clan_name: 'Villainous',
    kills: 19, death: 16, assists: 2, headshots: 11,
    adr: 98, kast: 0.7,
    steam_profile: { nickname: 'DYLAN', player: { nickname: 'DYLAN', slug: 'dylan' } },
    ...over,
  };
}

test('bo3 `death` becomes our `deaths`, and every stat lands in its own column', () => {
  const [s] = toMapStats(match, game, [row()], new Set());
  assert.ok(s);
  assert.equal(s.kills, 19);
  assert.equal(s.deaths, 16);      // from `death`, not `deaths`
  assert.equal(s.assists, 2);
  assert.equal(s.headshots, 11);   // headshot kills, never copied from kills
  assert.notEqual(s.headshots, s.kills);
});

test('a map keeps the series and map number grading joins on', () => {
  const [s] = toMapStats(match, game, [row()], new Set());
  assert.equal(s!.seriesKey, 'bo3:128851');
  assert.equal(s!.mapNumber, 2);
  assert.equal(s!.league, 'CS2');
  assert.equal(s!.source, 'bo3');
});

test('a map with no number is map 1, not map 0', () => {
  // map_number is 1-based because "Maps 1-2" is; a 0 here would silently fall
  // outside every range a prop can ask for.
  const [s] = toMapStats(match, { ...game, number: null }, [row()], new Set());
  assert.equal(s!.mapNumber, 1);
});

test('played_at falls back down the chain rather than going null', () => {
  // findSeries() matches a pick to a series on a time window, so a null here
  // makes the row unreachable even though its numbers are fine.
  const noBegin = { ...game, begin_at: null };
  const [s] = toMapStats(match, noBegin, [row()], new Set());
  assert.equal(s!.playedAt, match.end_date);

  const [t] = toMapStats({ ...match, end_date: null }, noBegin, [row()], new Set());
  assert.equal(t!.playedAt, match.start_date);
});

test('only tracked players are kept, and an empty set keeps everyone', () => {
  const rows = [row(), row({ steam_profile: { nickname: 'beakie', player: { nickname: 'beakie' } } })];
  assert.equal(toMapStats(match, game, rows, new Set()).length, 2);
  assert.equal(toMapStats(match, game, rows, new Set(['beakie'])).length, 1);
  assert.equal(toMapStats(match, game, rows, new Set(['beakie']))[0]!.handleRaw, 'beakie');
  assert.equal(toMapStats(match, game, rows, new Set(['nobody'])).length, 0);
});

test('the stored handle is the variant that matched, not whichever came first', () => {
  // Steam nicknames carry clan tags; the linked player nickname is the clean
  // pro handle. `handle_raw` has to fold back to the canon_handle that matched,
  // or the row is written under a key nothing will ever look up.
  const decorated = row({
    steam_profile: { nickname: 'GGPR*KmZ^BN', player: { nickname: 'KmZ' } },
  });

  const byPro = toMapStats(match, game, [decorated], new Set(['kmz']));
  assert.equal(byPro[0]!.handleRaw, 'KmZ');

  const bySteam = toMapStats(match, game, [decorated], new Set(['ggprkmzbn']));
  assert.equal(bySteam[0]!.handleRaw, 'GGPR*KmZ^BN');
});

test('a player with no usable name is skipped, not stored blank', () => {
  const nameless = row({ steam_profile: { nickname: '  ', player: null } });
  assert.equal(toMapStats(match, game, [nameless], new Set()).length, 0);
  assert.equal(toMapStats(match, game, [row({ steam_profile: null })], new Set()).length, 0);
});

test('a bad rounds_count writes null, never 0', () => {
  // 0 would claim a map that ran no rounds, which is a stronger and false
  // claim than "we don't know" — the same distinction grading already draws
  // between an ungradeable stat and a zero one.
  const zero = { ...game, rounds_count: 0 };
  assert.equal(toMapStats(match, zero, [row()], new Set())[0]!.rounds, null);

  const negative = { ...game, rounds_count: -3 };
  assert.equal(toMapStats(match, negative, [row()], new Set())[0]!.rounds, null);

  // The API is not typechecked at the wire; a string slipping through the
  // `number` guard must not become a number, coerced or otherwise.
  const nonNumeric = { ...game, rounds_count: '16' as unknown as number };
  assert.equal(toMapStats(match, nonNumeric, [row()], new Set())[0]!.rounds, null);

  const missing = { ...game, rounds_count: undefined };
  assert.equal(toMapStats(match, missing, [row()], new Set())[0]!.rounds, null);

  const valid = { ...game, rounds_count: 16 };
  assert.equal(toMapStats(match, valid, [row()], new Set())[0]!.rounds, 16);
});
