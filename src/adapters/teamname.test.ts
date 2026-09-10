import test from 'node:test';
import assert from 'node:assert/strict';
import { normTeam, teamIndex } from './teamname.js';

test('the misses from the 2026-09-10 match run all resolve', () => {
  // The seven names PrizePicks used that a plain lowercase-and-strip failed on,
  // against what OddsPapi actually calls them.
  assert.equal(normTeam('FaZe'), normTeam('Faze Clan'));
  assert.equal(normTeam('DENDELE'), normTeam('Dendele CS'));
  assert.equal(normTeam('PCIFIC'), normTeam('Pcific Espor'));
  assert.equal(normTeam('Navi Junior'), normTeam('Natus Vincere Junior'));
  assert.equal(normTeam('NAVI Junior'), normTeam('Natus Vincere Junior'));
});

test('decoration is stripped but the identifying part is kept', () => {
  assert.equal(normTeam('Team Vitality'), 'vitality');
  assert.equal(normTeam('Pain Gaming'), 'pain');
  assert.equal(normTeam('Team Gamerlegion'), 'gamerlegion');
  assert.equal(normTeam('Eternal Fire'), 'eternalfire');
});

test('a senior roster does not collide with its junior side', () => {
  // Matching the wrong one would put a moneyline on a different team's
  // players, which is the worst thing this can do.
  assert.notEqual(normTeam('Natus Vincere'), normTeam('Natus Vincere Junior'));
  assert.notEqual(normTeam('NAVI'), normTeam('NAVI Junior'));
});

test('empty and missing names resolve to nothing', () => {
  assert.equal(normTeam(null), '');
  assert.equal(normTeam(''), '');
  assert.equal(normTeam('   '), '');
});

test('the index resolves across naming conventions', () => {
  const find = teamIndex(
    [{ id: 1, name: 'Faze Clan' }, { id: 2, name: 'Natus Vincere' }, { id: 3, name: 'Heroic' }],
    (t) => t.name,
  );
  assert.equal(find('FaZe')?.id, 1);
  assert.equal(find('NAVI')?.id, 2);
  assert.equal(find('HEROIC')?.id, 3);
  assert.equal(find('Betclic'), null, 'a team the feed does not carry is a miss, not a guess');
});

test('an ambiguous key is dropped rather than resolved to whichever came last', () => {
  // Two DIFFERENT names normalising to the same key. Guessing between them
  // could attach a moneyline to the wrong roster.
  const find = teamIndex(
    [{ id: 1, name: 'Aurora' }, { id: 2, name: 'Aurora Gaming' }],
    (t) => t.name,
  );
  assert.equal(find('Aurora'), null);
});

test('the same name listed twice is not ambiguous', () => {
  const find = teamIndex(
    [{ id: 1, name: 'Heroic' }, { id: 1, name: 'Heroic' }],
    (t) => t.name,
  );
  assert.equal(find('Heroic')?.id, 1);
});
