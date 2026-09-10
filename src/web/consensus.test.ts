import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consensusLine, bookEdges, bestEdge, betterSide, median, edgeProbability, MIN_BOOKS,
} from './consensus.js';
import type { BookLine } from './boardq.js';
import type { FormStats } from './projection.js';

/** A book line with only the fields these functions read. */
function bl(book: string, line: number, over = true, under = true): BookLine {
  return {
    book, line, prop_id: line * 100,
    over_price: null, under_price: null,
    over_ok: over, under_ok: under,
    over_mult: null, under_mult: null,
    moved: null, last_move: null, last_move_at: null, side: null, team: null,
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

// ------------------------------------------------------- gap to probability --

/** A player whose real range totals are known exactly. */
function form(totals: number[], mapValues: number[] = []): FormStats {
  const n = totals.length;
  const mean = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
  return { series: n, mean, sd: null, totals, mapValues, perMap: null };
}

const edge = (line: number, fair: number, side: 'over' | 'under' = 'over') => ({
  book: 'prizepicks', propId: 1, side, line, fair, gap: Math.abs(fair - line), offered: true,
});

test('with no history there is no probability, and that is not 50%', () => {
  // A market we cannot size is not a market known to be a coin flip.
  assert.equal(edgeProbability(edge(28.5, 30.5), undefined, 1, 's'), null);
  assert.equal(edgeProbability(edge(28.5, 30.5), form([], []), 1, 's'), null);
});

test('a line ON the consensus is a coin flip by construction', () => {
  // The sample is slid until its median sits on the fair line, so asking about
  // the fair line itself must come back at about half. This is the property the
  // whole method rests on.
  const f = form([20, 24, 28, 32, 36, 40]);
  const p = edgeProbability(edge(30, 30), f, 1, 's')!;
  assert.ok(Math.abs(p.p - 0.5) < 1e-9, `expected ~0.5, got ${p.p}`);
});

test('a cheaper line wins more often than the consensus line', () => {
  const f = form([20, 24, 28, 32, 36, 40]);
  const atFair = edgeProbability(edge(30, 30), f, 1, 's')!.p;
  const cheaper = edgeProbability(edge(26, 30), f, 1, 's')!.p;
  assert.ok(cheaper > atFair, 'an over four units below the crowd must be likelier');
});

test('our own mean cannot leak in — only the spread is used', () => {
  // Two players with identical spread but wildly different averages. Anchoring
  // to the market means the answer depends on the shape alone, so both must
  // give the same probability at the same gap. If the projection's location
  // estimate were involved these would differ, which is exactly the bias
  // (+0.65 units, 61% of markets projected over) being kept out.
  const low = form([10, 14, 18, 22, 26, 30]);
  const high = form([110, 114, 118, 122, 126, 130]);
  const a = edgeProbability(edge(28, 30), low, 1, 's')!.p;
  const b = edgeProbability(edge(28, 30), high, 1, 's')!.p;
  assert.equal(a, b, 'same spread and same gap must give the same probability');
});

test('a wider spread turns the same gap into a smaller edge', () => {
  // Two kills off the crowd is nearly certain for a metronome and close to
  // noise for a player who swings 30 either way. An absolute MIN_EDGE of 0.5
  // across every market cannot express this, which is the defect it fixes.
  const tight = form([29, 29.5, 30, 30, 30.5, 31]);
  const wide = form([0, 15, 30, 30, 45, 60]);
  const t = edgeProbability(edge(28, 30), tight, 1, 's')!.p;
  const w = edgeProbability(edge(28, 30), wide, 1, 's')!.p;
  assert.ok(t > w, `tight ${t} should beat wide ${w}`);
});

test('the under side is scored in the right direction', () => {
  const f = form([20, 24, 28, 32, 36, 40]);
  // A book 4 above the crowd leaves room underneath.
  const p = edgeProbability(edge(34, 30, 'under'), f, 1, 's')!;
  assert.ok(p.p > 0.5, 'an under four units above the crowd must be likelier than not');
});

test('pushes leave the denominator rather than counting as half a win', () => {
  // Six totals, two landing exactly on the line after the shift. Counting them
  // as half-wins would inflate every whole-numbered line.
  const f = form([28, 30, 30, 30, 32, 34]);
  const p = edgeProbability(edge(30, 30), f, 1, 's')!;
  // Median is 30, fair is 30, so no shift. Two of six are above, one below,
  // three push. Decided legs: 3 -> 2 over, 1 under.
  assert.ok(Math.abs(p.p - 2 / 3) < 1e-9, `expected 2/3, got ${p.p}`);
});

test('real totals are preferred, and thin totals fall back to resampling', () => {
  const plenty = form([20, 24, 28, 32, 36, 40], [10, 12, 14]);
  assert.equal(edgeProbability(edge(28, 30), plenty, 1, 's')!.method, 'totals');

  // Three totals is below the bar, so the single-map history is used instead.
  const thin = form([20, 24, 28], [10, 12, 14, 16, 18, 20, 22, 24]);
  const r = edgeProbability(edge(14, 16), thin, 1, 's')!;
  assert.equal(r.method, 'resampled');
});

test('resampled evidence is counted in maps, not in draws', () => {
  // 4,000 draws off twelve maps is twelve observations' worth of evidence for
  // a one-map range, and six for a two-map one. Reporting the draw count would
  // defeat every shrink the caller applies.
  const f = form([], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(edgeProbability(edge(5, 6), f, 1, 's')!.n, 12);
  assert.equal(edgeProbability(edge(11, 13), f, 2, 's')!.n, 6);
});

// ----------------------------------------- the fair line from a priced book --

import { fairLine, pricedEdges } from './consensus.js';

/** A book that publishes two-sided American odds, like Underdog. */
function priced(book: string, line: number, over: number, under: number): BookLine {
  return { ...bl(book, line), over_price: over, under_price: under };
}

const spread = form([14, 16, 18, 20, 20, 22, 24, 26, 12, 28]);

test('two unpriced books still cannot say which is wrong', () => {
  // PrizePicks-shaped on both sides: no odds anywhere, so no anchor exists.
  assert.equal(fairLine([bl('a', 28.5), bl('b', 30.5)], spread, 1, 's'), null);
  assert.deepEqual(pricedEdges([bl('a', 28.5), bl('b', 30.5)], spread, 1, 's'), []);
});

test('flat vig is an answer, not a missing one', () => {
  // -112/-112 devigs to exactly 0.500, so the book's own line IS its coin
  // flip. This is the common case — 397 of Underdog's 434 priced markets —
  // and treating it as "no information" would have thrown the signal away.
  const books = [bl('prizepicks', 28.5), priced('underdog', 30.5, -112, -112)];
  const fl = fairLine(books, spread, 1, 's')!;
  assert.equal(fl.method, 'priced-book');
  assert.equal(fl.from, 'underdog');
  assert.equal(fl.fair, 30.5, 'the priced book\'s line is the anchor');
});

test('the unpriced book is measured against the priced one', () => {
  const books = [bl('prizepicks', 28.5), priced('underdog', 30.5, -112, -112)];
  const edges = pricedEdges(books, spread, 1, 's');
  assert.equal(edges.length, 1, 'the anchor book is never measured against itself');
  assert.equal(edges[0]!.book, 'prizepicks');
  assert.equal(edges[0]!.side, 'over', 'two below the anchor makes the over cheap');
  assert.equal(edges[0]!.gap, 2);
});

test('a real lean moves the fair line off the book\'s own number', () => {
  // The over is the favourite here, so the book thinks the true middle sits
  // above the number it posted.
  const books = [bl('prizepicks', 20), priced('underdog', 20, -150, +120)];
  const fl = fairLine(books, spread, 1, 's')!;
  assert.ok(fl.fair > 20, `expected the fair line above 20, got ${fl.fair}`);
});

test('a lean the other way moves it the other way', () => {
  const books = [bl('prizepicks', 20), priced('underdog', 20, +120, -150)];
  const fl = fairLine(books, spread, 1, 's')!;
  assert.ok(fl.fair < 20, `expected the fair line below 20, got ${fl.fair}`);
});

test('a crowd outranks a priced book when both are available', () => {
  const books = [bl('a', 28.5), bl('b', 30.5), priced('c', 30.5, -150, +120)];
  const fl = fairLine(books, spread, 1, 's')!;
  assert.equal(fl.method, 'crowd', 'three books vote rather than deferring to one');
  assert.equal(fl.n, 3);
});

test('with no history a leaning price still anchors on the line', () => {
  // Converting a lean into a distance needs the player's spread. Without it,
  // falling back to the posted line is right — it is the book's own estimate,
  // just unrefined — and is far better than refusing to answer.
  const books = [bl('prizepicks', 28.5), priced('underdog', 30.5, -150, +120)];
  const fl = fairLine(books, undefined, 1, 's')!;
  assert.equal(fl.fair, 30.5);
});

test('the fair line feeds the same probability machinery as the crowd path', () => {
  const books = [bl('prizepicks', 26.5), priced('underdog', 30.5, -112, -112)];
  const edge = pricedEdges(books, spread, 1, 's')[0]!;
  const p = edgeProbability(edge, spread, 1, 's')!;
  assert.ok(p.p > 0.5, 'four units below the anchor should beat a coin flip');
});
