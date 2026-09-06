import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonLeague, canonHandle, parsePrizePicksStat, parseUnderdogStat, parseAmerican,
} from './normalize.js';

test('leagues fold to canonical codes across books', () => {
  assert.equal(canonLeague('CS2'), 'CS2');      // PrizePicks
  assert.equal(canonLeague('CS'), 'CS2');       // Underdog
  assert.equal(canonLeague('LoL'), 'LOL');
  assert.equal(canonLeague('LOL'), 'LOL');
  assert.equal(canonLeague('VALORANT'), 'VAL');
  assert.equal(canonLeague('NFL'), null);
});

test('handles fold to a shared join key', () => {
  // Underdog ships esports handles space-padded in last_name.
  assert.equal(canonHandle(' gr1ks'), 'gr1ks');
  assert.equal(canonHandle('gr1ks'), 'gr1ks');
  assert.equal(canonHandle('s1mple'), 's1mple');
  assert.equal(canonHandle('Zyw0o'), 'zyw0o');
  assert.equal(canonHandle('m0NESY'), 'm0nesy');
});

test('PrizePicks stat strings parse', () => {
  assert.deepEqual(parsePrizePicksStat('MAPS 1-2 Kills'),
    { stat: 'kills', mapStart: 1, mapEnd: 2, isCombo: false });
  assert.deepEqual(parsePrizePicksStat('MAPS 1-2 Headshots'),
    { stat: 'headshots', mapStart: 1, mapEnd: 2, isCombo: false });
  assert.deepEqual(parsePrizePicksStat('MAP 3 Kills'),
    { stat: 'kills', mapStart: 3, mapEnd: 3, isCombo: false });
  assert.deepEqual(parsePrizePicksStat('MAPS 1-3 Kills (Combo)'),
    { stat: 'kills', mapStart: 1, mapEnd: 3, isCombo: true });
  assert.deepEqual(parsePrizePicksStat('MAPS 1-6 Kills'),
    { stat: 'kills', mapStart: 1, mapEnd: 6, isCombo: false });
  // Unscoped markets have no map range to join on and must be rejected.
  assert.equal(parsePrizePicksStat('Pass Yards'), null);
});

test('Underdog stat strings parse, collapsing enumerated maps to a range', () => {
  assert.deepEqual(parseUnderdogStat('kills_on_maps_1_2'),
    { stat: 'kills', mapStart: 1, mapEnd: 2, isCombo: false });
  assert.deepEqual(parseUnderdogStat('assists_on_maps_1_2_3'),
    { stat: 'assists', mapStart: 1, mapEnd: 3, isCombo: false });
  assert.deepEqual(parseUnderdogStat('period_1_2_3_fantasy_points'),
    { stat: 'fantasy_points', mapStart: 1, mapEnd: 3, isCombo: false });
  assert.deepEqual(parseUnderdogStat('headshots_on_maps_1_2'),
    { stat: 'headshots', mapStart: 1, mapEnd: 2, isCombo: false });
});

test('the two books agree on the same market', () => {
  const pp = parsePrizePicksStat('MAPS 1-3 Kills');
  const ud = parseUnderdogStat('kills_on_maps_1_2_3');
  assert.deepEqual(pp, ud); // this equality IS the cross-book join
});

test('a gapped map selection is refused, not flattened', () => {
  // "maps 1 and 3" is not the same market as "maps 1-3"; silently widening it
  // would fabricate a line that neither book is actually offering.
  assert.equal(parseUnderdogStat('kills_on_maps_1_3'), null);
});

test('american prices parse', () => {
  assert.equal(parseAmerican('-112'), -112);
  assert.equal(parseAmerican('+140'), 140);
  assert.equal(parseAmerican(null), null);
});
