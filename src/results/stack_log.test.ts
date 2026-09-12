import test from 'node:test';
import assert from 'node:assert/strict';
import { legOutcome, stackOutcome, type LegState } from './stack_log.js';

test('a leg is judged at the line it was recommended at', () => {
  assert.equal(legOutcome(42, 41.5, 'over'), 'won');
  assert.equal(legOutcome(41, 41.5, 'over'), 'lost');
  assert.equal(legOutcome(41, 41.5, 'under'), 'won');
  assert.equal(legOutcome(42, 41.5, 'under'), 'lost');
  assert.equal(legOutcome(null, 41.5, 'over'), 'open', 'no stats yet is not a loss');
  assert.equal(legOutcome(20, 20, 'over'), 'push', 'landing on the number is a push');
});

test('all-must-win: one lost leg settles the entry, even with legs still open', () => {
  const legs: LegState[] = ['won', 'lost', 'open', 'open'];
  assert.equal(stackOutcome(legs), 'lost');
});

test('an entry waits while any leg is open, and wins only when every leg is in', () => {
  assert.equal(stackOutcome(['won', 'won', 'open']), 'pending');
  assert.equal(stackOutcome(['won', 'won', 'won']), 'won');
  assert.equal(stackOutcome([]), 'won', 'no legs is vacuously complete');
});

test('a push voids the entry rather than losing it', () => {
  assert.equal(stackOutcome(['won', 'push', 'won']), 'void');
  assert.equal(stackOutcome(['lost', 'push']), 'lost', 'a loss still settles first');
});
