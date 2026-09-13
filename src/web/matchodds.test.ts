import test from 'node:test';
import assert from 'node:assert/strict';
import { underProbForTeam, resolveTeamOdds, UNDER_IF_TEAM_WINS, UNDER_IF_TEAM_LOSES, type OddsRow } from './matchodds.js';

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

const NOW = Date.parse('2026-09-13T08:00:00Z');
const fx = (home: string, away: string, pHome: number, startsAt: string, observedAt = '2026-09-13T07:30:00Z'): OddsRow =>
  ({ home_name: home, away_name: away, p_home_win: String(pHome), starts_at: startsAt, observed_at: observedAt });

test('a team with several fixtures is priced off its next one', () => {
  // The production bug of 2026-09-13: M80 tonight against Luminosity at 50%,
  // then four fixtures on 09-17. The last row won, and M80 + Luminosity came to 87%.
  const rows = [
    fx('M80', 'Luminosity', 0.5, '2026-09-13T10:00:00Z'),
    fx('M80', 'GamerLegion', 0.5, '2026-09-17T10:00:00Z'),
    fx('Metizport', 'M80', 0.44, '2026-09-17T13:00:00Z'),
    fx('B8', 'M80', 0.61, '2026-09-17T16:00:00Z'),
  ];
  const out = resolveTeamOdds(rows, ['M80', 'Luminosity'], NOW);
  assert.equal(out.get('M80')!.opponent, 'Luminosity');
  assert.equal(out.get('Luminosity')!.opponent, 'M80');
  near(out.get('M80')!.pWin + out.get('Luminosity')!.pWin, 1, 1e-12);
});

test('the order rows arrive in does not change the fixture chosen', () => {
  const rows = [
    fx('B8', 'M80', 0.61, '2026-09-17T16:00:00Z'),
    fx('M80', 'Luminosity', 0.4, '2026-09-13T10:00:00Z'),
    fx('M80', 'GamerLegion', 0.5, '2026-09-17T10:00:00Z'),
  ];
  for (const order of [rows, [...rows].reverse()]) {
    near(resolveTeamOdds(order, ['M80'], NOW).get('M80')!.pWin, 0.4, 1e-12);
  }
});

test('a late start still counts as next; an old one gives way to anything ahead', () => {
  const late = [fx('M80', 'Luminosity', 0.3, '2026-09-13T07:45:00Z'), fx('M80', 'B8', 0.7, '2026-09-14T10:00:00Z')];
  near(resolveTeamOdds(late, ['M80'], NOW).get('M80')!.pWin, 0.3, 1e-12);
  const old = [fx('M80', 'Luminosity', 0.3, '2026-09-13T04:00:00Z'), fx('M80', 'B8', 0.7, '2026-09-14T10:00:00Z')];
  near(resolveTeamOdds(old, ['M80'], NOW).get('M80')!.pWin, 0.7, 1e-12);
  // Nothing ahead: the most recent past fixture, not the oldest.
  const past = [fx('M80', 'Luminosity', 0.3, '2026-09-13T03:00:00Z'), fx('M80', 'B8', 0.7, '2026-09-13T06:00:00Z')];
  near(resolveTeamOdds(past, ['M80'], NOW).get('M80')!.pWin, 0.7, 1e-12);
});

test('the same match priced by two sources keeps the freshest quote', () => {
  const rows = [
    fx('Faze Clan', 'Vitality', 0.4, '2026-09-13T10:00:00Z', '2026-09-13T06:00:00Z'),
    fx('Vitality', 'FaZe', 0.55, '2026-09-13T10:05:00Z', '2026-09-13T07:45:00Z'),
  ];
  near(resolveTeamOdds(rows, ['FaZe'], NOW).get('FaZe')!.pWin, 0.45, 1e-12);
});

test('two different names that normalise alike stay ambiguous', () => {
  const rows = [
    fx('Aurora', 'Vitality', 0.3, '2026-09-13T10:00:00Z'),
    fx('Aurora Gaming', 'MOUZ', 0.6, '2026-09-14T10:00:00Z'),
  ];
  assert.equal(resolveTeamOdds(rows, ['Aurora'], NOW).has('Aurora'), false);
});
