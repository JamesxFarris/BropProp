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
  // The calibration check that justifies the whole mixture. 0.551 from our own
  // walk-forward convention, against 55.3% measured on 2,137 settled legs at
  // the books' closing lines — two independent measurements agreeing.
  near(underProbForTeam(0.5), 0.553, 0.003);
});

test('players on a heavy underdog are likelier to go under', () => {
  // A dog priced at 25% to win: 0.25*0.482 + 0.75*0.620.
  near(underProbForTeam(0.25), 0.5855, 1e-4);
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

test('the line shade keeps even a clear favourite on the under side', () => {
  // Written first as "an 80% favourite's under is below 50%", which was wrong:
  // 0.8*0.482 + 0.2*0.620 = 0.5096. The books' shade against the over is
  // strong enough that a team's players only flip to the over past
  // 0.62 - 0.138p = 0.5, i.e. about an 87% favourite.
  assert.ok(underProbForTeam(0.8) > 0.5, 'an 80% favourite is still an under');
  const flip = (UNDER_IF_TEAM_LOSES - 0.5) / (UNDER_IF_TEAM_LOSES - UNDER_IF_TEAM_WINS);
  near(flip, 0.8696, 1e-3);
  assert.ok(underProbForTeam(flip + 0.01) < 0.5, 'past the flip, the over is the side');
});

test('probabilities outside [0,1] are clamped rather than extrapolated', () => {
  near(underProbForTeam(1.4), UNDER_IF_TEAM_WINS, 1e-12);
  near(underProbForTeam(-0.2), UNDER_IF_TEAM_LOSES, 1e-12);
});
