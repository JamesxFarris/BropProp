import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../db.js';
import { gradePick } from './grade.js';

/**
 * Grading rules, tested against synthetic stat lines.
 *
 * These are the rules that decide money, so they're checked directly rather
 * than inferred from whatever a live scrape happened to return. Everything is
 * written under a source name of its own and removed afterwards, so a run
 * never touches real logged data.
 */

const SRC = 'test-fixture';
const SERIES = 'TEST/series-1';
const HANDLE = 'gradetestplayer';

const base = {
  id: -1,
  canon_handle: HANDLE,
  handle: 'GradeTestPlayer',
  league: 'CS2',
  stat: 'kills',
  map_start: 1,
  map_end: 2,
  is_combo: false,
  side: 'over',
  line_at_pick: 40,
  scheduled_at: new Date().toISOString(),
  match_title: 'Test vs Test',
};

before(async () => {
  await q(`DELETE FROM map_stat WHERE source = $1`, [SRC]);
  // Two maps played: 25 + 20 = 45 kills across maps 1-2.
  for (const [map, kills] of [[1, 25], [2, 20]] as const) {
    await q(
      `INSERT INTO map_stat (source, league, series_key, map_number, handle_raw,
                             canon_handle, kills, deaths, assists, headshots, played_at)
       VALUES ($1,'CS2',$2,$3,'GradeTestPlayer',$4,$5,10,3,$6, now())`,
      [SRC, SERIES, map, HANDLE, kills, Math.floor(kills / 2)],
    );
  }
});

after(async () => {
  await q(`DELETE FROM map_stat WHERE source = $1`, [SRC]);
  await pool.end();
});

test('over wins when the total clears the line', async () => {
  const g = await gradePick({ ...base, side: 'over', line_at_pick: 40 });
  assert.equal(g.actual, 45);
  assert.equal(g.status, 'won');
});

test('under loses on the same total', async () => {
  const g = await gradePick({ ...base, side: 'under', line_at_pick: 40 });
  assert.equal(g.status, 'lost');
});

test('a total landing exactly on the line is a push', async () => {
  const g = await gradePick({ ...base, side: 'over', line_at_pick: 45 });
  assert.equal(g.status, 'push');
});

test('only the maps in range are summed', async () => {
  const g = await gradePick({ ...base, map_start: 1, map_end: 1, line_at_pick: 20 });
  assert.equal(g.actual, 25); // map 1 alone, not 45
  assert.equal(g.status, 'won');
});

test('an unplayed map in the range voids rather than grading short', async () => {
  // Maps 1-3 requested, but the series ended 2-0 so map 3 never happened.
  // Summing the two that exist would invent a result the book refunds.
  const g = await gradePick({ ...base, map_start: 1, map_end: 3, line_at_pick: 40 });
  assert.equal(g.status, 'void');
  assert.equal(g.actual, null);
  assert.match(g.note, /only 1, 2 played/);
});

test('a stat the source cannot produce is ungradeable, not zero', async () => {
  const g = await gradePick({ ...base, stat: 'fantasy_points' });
  assert.equal(g.status, 'ungradeable');
  assert.equal(g.actual, null);
});

/**
 * Combos used to be refused outright. They are graded now — the arithmetic and
 * its refusals are pinned without a database in `src/combo.test.ts`. What is
 * left to check here is which props take that path, because the book's own
 * flag turned out not to be the answer.
 */
test("the book's combo flag does not make a single player ungradeable", async () => {
  // PrizePicks set combo:true on `eraa`, one CS2 player, on 2026-09-07, while
  // Underdog listed the same kills market as an ordinary player. Believing the
  // flag made that market ungradeable for no reason. The handle names one
  // player, so it grades as one player.
  const g = await gradePick({ ...base, is_combo: true });
  assert.equal(g.actual, 45);
  assert.equal(g.status, 'won');
});

test('a combo handle that cannot be split into players is refused, not guessed', async () => {
  // Two members with the same name means the split is wrong. Grading it as one
  // player, or as that player twice, are both guesses worth a whole player.
  const g = await gradePick({
    ...base, is_combo: true, handle: 'GradeTestPlayer + GradeTestPlayer',
  });
  assert.equal(g.status, 'ungradeable');
  assert.match(g.note, /split/);
});

test('a combo with a member we have no stat line for is ungradeable, never short', async () => {
  // Only GradeTestPlayer is in the fixture, so no series has both members.
  const g = await gradePick({ ...base, is_combo: true, handle: 'GradeTestPlayer + Nobody' });
  assert.equal(g.status, 'ungradeable');
  assert.equal(g.actual, null);
});

test('a player with no stat line is ungradeable', async () => {
  const g = await gradePick({ ...base, canon_handle: 'nobodyhere', handle: 'Nobody' });
  assert.equal(g.status, 'ungradeable');
  assert.match(g.note, /No stat line/);
});

test('headshots grade from their own column, not kills', async () => {
  const g = await gradePick({ ...base, stat: 'headshots', side: 'over', line_at_pick: 20 });
  assert.equal(g.actual, 22); // 12 + 10
  assert.equal(g.status, 'won');
});
