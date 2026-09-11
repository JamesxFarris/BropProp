import test from 'node:test';
import assert from 'node:assert/strict';
import { underProbForTeam, UNDER_IF_TEAM_WINS, UNDER_IF_TEAM_LOSES } from './matchodds.js';

const near = (got: number, want: number, tol: number) =>
  assert.ok(Math.abs(got - want) < tol, `expected ~${want}, got ${got}`);

test('the endpoints are the measured conditional rates', () => {
  near(underProbForTeam(1), UNDER_IF_TEAM_WINS, 1e-12);
  near(underProbForTeam(0), UNDER_IF_TEAM_LOSES, 1e-12);
});

test('a coin-flip match reproduces the under rate measured against real book lines', () => {
  // The calibration check on the mixture: 0.5145 at 50/50, against a blind
  // under rate of 51.6% on the books' closing lines (2026-09-11).
  near(underProbForTeam(0.5), 0.516, 0.003);
});

test('players on a heavy underdog are likelier to go under', () => {
  // A dog priced at 25% to win: 0.25*0.457 + 0.75*0.572.
  near(underProbForTeam(0.25), 0.54325, 1e-4);
  assert.ok(underProbForTeam(0.25) > underProbForTeam(0.5));
  assert.ok(underProbForTeam(0.75) < underProbForTeam(0.5));
});

test('the favourite side of a match is a worse under than the dog side', () => {
  // Same match, the two sides: they must move in opposite directions, or a
  // team-level stack would be pointed the wrong way.
  const fav = underProbForTeam(0.8);
  const dog = underProbForTeam(0.2);
  assert.ok(dog > fav);
});

test('a clear favourite flips to the over', () => {
  // With the old, circular constants (0.620 / 0.482) plus a strong blind shade,
  // players stayed on the under until about an 87% favourite. On the fair
  // real-line rates the flip is 0.572 - 0.115p = 0.5, about a 63% favourite —
  // so a favourite's OVERS are a real stack, not a curiosity.
  const flip = (UNDER_IF_TEAM_LOSES - 0.5) / (UNDER_IF_TEAM_LOSES - UNDER_IF_TEAM_WINS);
  near(flip, 0.6261, 1e-3);
  assert.ok(underProbForTeam(0.55) > 0.5, 'a slight favourite is still an under');
  assert.ok(underProbForTeam(0.8) < 0.5, 'an 80% favourite is an over');
  assert.ok(underProbForTeam(flip + 0.01) < 0.5, 'past the flip, the over is the side');
});

test('probabilities outside [0,1] are clamped rather than extrapolated', () => {
  near(underProbForTeam(1.4), UNDER_IF_TEAM_WINS, 1e-12);
  near(underProbForTeam(-0.2), UNDER_IF_TEAM_LOSES, 1e-12);
});
