import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consensusLine, bookEdges, bestEdge, betterSide, median, MIN_BOOKS } from './consensus.js';
import type { BookLine } from './boardq.js';

/** A book line with only the fields these functions read. */
function bl(book: string, line: number, over = true, under = true): BookLine {
  return {
    book, line, prop_id: line * 100,
    over_price: null, under_price: null,
    over_ok: over, under_ok: under,
    over_mult: null, under_mult: null,
    moved: null, last_move: null, last_move_at: null, side: null,
  };
}

test('median takes the middle of an odd list and the midpoint of an even one', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5]), 5);
});

test('two books are a disagreement, not a consensus', () => {
  // The whole reason for adding books. Nothing in 28.5 vs 30.5 says which is
  // the outlier, so no direction can be read out of it.
  assert.equal(consensusLine([bl('prizepicks', 28.5), bl('underdog', 30.5)]), 'need-three-books');
  assert.deepEqual(bookEdges([bl('prizepicks', 28.5), bl('underdog', 30.5)]), []);
  assert.equal(bestEdge([bl('prizepicks', 28.5), bl('underdog', 30.5)]), null);
});

test('one book is reported as such, not as a three-book shortfall', () => {
  assert.equal(consensusLine([bl('prizepicks', 28.5)]), 'one-book');
});

test('three books give a median with the majority behind it', () => {
  const c = consensusLine([bl('prizepicks', 28.5), bl('underdog', 30.5), bl('sleeper', 30.5)]);
  assert.deepEqual(c, { fair: 30.5, n: 3, spread: 2 });
});

test('the book below the crowd has its OVER flagged, and vice versa', () => {
  const books = [bl('prizepicks', 28.5), bl('underdog', 30.5), bl('sleeper', 30.5)];
  const edges = bookEdges(books);
  const pp = edges.find((e) => e.book === 'prizepicks')!;
  assert.equal(pp.side, 'over', 'a line easier to clear makes the over the cheap side');
  assert.equal(pp.gap, 2);
  assert.equal(pp.fair, 30.5);
});

test('a book above the crowd has its UNDER flagged', () => {
  const edges = bookEdges([bl('prizepicks', 22.5), bl('underdog', 22.5), bl('sleeper', 25.5)]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.book, 'sleeper');
  assert.equal(edges[0]!.side, 'under');
  assert.equal(edges[0]!.gap, 3);
});

test('leave-one-out applies from four books up', () => {
  // All-books median is 29.5. Measured against the OTHERS, the low book is 1.5
  // off rather than 1.0 — and 1.5 is what the rest of the market is offering.
  const edges = bookEdges([bl('a', 28.5), bl('b', 29), bl('c', 30), bl('d', 30.5)]);
  const low = edges.find((e) => e.book === 'a')!;
  assert.equal(low.fair, 30, 'median of 29, 30 and 30.5, with 28.5 left out');
  assert.equal(low.gap, 1.5);
  assert.equal(low.side, 'over');
  const high = edges.find((e) => e.book === 'd')!;
  assert.equal(high.fair, 29, 'median of 28.5, 29 and 30, with 30.5 left out');
  assert.equal(high.gap, 1.5);
  assert.equal(high.side, 'under');
});

test('at exactly three books, agreeing books are not flagged as outliers', () => {
  // The regression that leave-one-out caused here: dropping one of three
  // leaves a two-book midpoint dragged down by the outlier, which reported the
  // two books that agree with each other as each being 1.0 off the market.
  const edges = bookEdges([bl('prizepicks', 28.5), bl('underdog', 30.5), bl('sleeper', 30.5)]);
  assert.equal(edges.length, 1, 'only the outlier is off anything');
  assert.equal(edges[0]!.book, 'prizepicks');
});

test('at three books the self-inclusion bias shrinks the gap rather than growing it', () => {
  // 28.5 / 29.5 / 30.5 measured against the all-books median of 29.5. The low
  // book reads 1.0 off; leave-one-out would have said 1.5. Understating an
  // edge costs a bet that was there, overstating invents one that was not.
  const edges = bookEdges([bl('a', 28.5), bl('b', 29.5), bl('c', 30.5)]);
  const low = edges.find((e) => e.book === 'a')!;
  assert.equal(low.fair, 29.5);
  assert.equal(low.gap, 1);
});

test('every book agreeing produces no edges at all', () => {
  assert.deepEqual(bookEdges([bl('a', 30.5), bl('b', 30.5), bl('c', 30.5)]), []);
});

test('edges come back worst offender first', () => {
  const edges = bookEdges([bl('a', 20.5), bl('b', 26.5), bl('c', 27.5), bl('d', 27.5)]);
  assert.ok(edges.length >= 2);
  for (let i = 1; i < edges.length; i++) {
    assert.ok(edges[i - 1]!.gap >= edges[i]!.gap, 'sorted by gap descending');
  }
  assert.equal(edges[0]!.book, 'a');
});

test('bestEdge skips a gap whose side cannot be taken', () => {
  // The biggest gap is on a book that does not list the over. That is not a
  // smaller edge, it is not a bet — so the next takeable one wins.
  const books = [
    bl('a', 20.5, /* over */ false, true),
    bl('b', 25.5),
    bl('c', 27.5),
    bl('d', 27.5),
  ];
  const best = bestEdge(books)!;
  assert.notEqual(best.book, 'a');
  assert.equal(best.offered, true);
});

test('bestEdge returns null when no flagged side is offered', () => {
  // The only book off the crowd is 7 below it, and it does not list an over.
  const books = [bl('a', 20.5, false, true), bl('b', 27.5, true, false), bl('c', 27.5, true, false)];
  assert.equal(bestEdge(books), null);
});

test('betterSide works on two books, where consensus refuses to', () => {
  // The weaker, always-true question: not which side wins, but where to take a
  // side you had already chosen.
  const books = [bl('prizepicks', 28.5), bl('underdog', 30.5)];
  assert.equal(betterSide(books, 'prizepicks'), 'over', 'lowest line is the cheapest over');
  assert.equal(betterSide(books, 'underdog'), 'under', 'highest line has the most room under');
});

test('betterSide says both when the books agree', () => {
  const books = [bl('prizepicks', 30.5), bl('underdog', 30.5)];
  assert.equal(betterSide(books, 'prizepicks'), 'both');
  assert.equal(betterSide(books, 'underdog'), 'both');
});

test('betterSide says both for a book beaten on each side by someone else', () => {
  const books = [bl('a', 28.5), bl('b', 29.5), bl('c', 30.5)];
  assert.equal(betterSide(books, 'b'), 'both', 'a beats it on the over, c on the under');
  assert.equal(betterSide(books, 'a'), 'over');
  assert.equal(betterSide(books, 'c'), 'under');
});

test('betterSide on a book that does not price the market is not an opinion', () => {
  assert.equal(betterSide([bl('a', 28.5), bl('b', 30.5)], 'sleeper'), 'both');
});

test('MIN_BOOKS is three — the arithmetic minimum for a majority', () => {
  assert.equal(MIN_BOOKS, 3);
});
