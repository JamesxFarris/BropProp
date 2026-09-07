# Rounds Normalisation and Market Probability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project CS2 kills from kills-per-round scaled by expected round count instead of from raw per-map totals, and show Underdog's devigged market probability beside our own hit rate.

**Architecture:** Two independent halves. Part B (devig, Tasks 1-2) is pure computation over columns already in the database and ships first as a self-contained change. Part A (Tasks 3-9) adds a `rounds` column, captures it from a response the bo3 collector already holds, backfills it, measures whether kills-per-round and round count are correlated, and only then changes the projection — behind a held-out validation that can reject the whole thing.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 20+, `tsx`, `node:test` + `node:assert/strict`, Postgres 16 via `pg`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-rounds-and-devig-design.md`

## Global Constraints

- **Never invent a number the source didn't give.** A missing round count stays `NULL`; a one-sided market returns no probability. This matches how grading already refuses (`ungradeable` rather than zero).
- **LoL is untouched.** It has no rounds. Branch on league; do not invent an analogue.
- **Underdog's devigged probability must not feed `strength`, `score`, or any sort order.** It is displayed only. This is the decision recorded in the spec.
- **bo3.gg ignores unknown filters** — `filter[status]=finished` returns the *unfiltered* list with HTTP 200. Every filter must be re-checked against the response. Working shape is `filter[<table>.<column>][<op>]=<value>`.
- **Tests use literal inputs and no database**, matching `src/web/projection.test.ts`. Run with `npm test`.
- **Migrations are numbered and idempotent**; they run on boot and must be safe to re-run. Next number is `010`.
- **Commit style:** sentence-case summary describing the behaviour change, body explaining why, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Devig module

**Files:**
- Create: `src/devig.ts`
- Test: `src/devig.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `americanToProb(odds: number): number`, `devig(overPrice: number | null, underPrice: number | null): FairOdds | null`, and `type FairOdds = { over: number; under: number; overround: number; method: 'multiplicative' }`.

- [ ] **Step 1: Write the failing test**

Create `src/devig.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { americanToProb, devig } from './devig.js';

/**
 * Turning Underdog's two-sided prices into a probability.
 *
 * Underdog is the only book on the board that publishes real odds —
 * PrizePicks expresses price by moving the line instead — so this is the only
 * market probability available to us. It is shown beside our own hit rate and
 * deliberately kept out of the score.
 *
 * No database: every input is a literal.
 */

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('american odds convert to implied probability', () => {
  close(americanToProb(-110), 110 / 210);
  close(americanToProb(110), 100 / 210);
  // The boundary: +100 and -100 are both an even-money bet.
  close(americanToProb(100), 0.5);
  close(americanToProb(-100), 0.5);
});

test('a symmetric market devigs to an even split', () => {
  const f = devig(-110, -110);
  assert.ok(f);
  close(f.over, 0.5);
  close(f.under, 0.5);
});

test('the two sides always sum to one', () => {
  for (const [o, u] of [[-110, -110], [-139, 113], [-250, 200], [150, -175]] as const) {
    const f = devig(o, u);
    assert.ok(f, `${o}/${u} should devig`);
    close(f.over + f.under, 1);
  }
});

test('the overround reported is the overround removed', () => {
  const f = devig(-139, 113);
  assert.ok(f);
  // -139 -> 139/239, +113 -> 100/213. They sum to more than 1; the excess is
  // the book's margin, and it is reported rather than silently discarded.
  const raw = 139 / 239 + 100 / 213;
  close(f.overround, raw - 1);
  assert.ok(f.overround > 0, 'a real market has a positive overround');
});

test('devigging preserves which side is favoured', () => {
  const f = devig(-139, 113);
  assert.ok(f);
  assert.ok(f.over > f.under, 'the -139 side is the favourite and must stay so');
});

test('a one-sided market yields no probability, not a guess', () => {
  // Every Underdog LoL assists market is higher-only. A single price cannot be
  // devigged, and inventing the other side would be the same error as grading
  // a stat the source cannot produce.
  assert.equal(devig(-110, null), null);
  assert.equal(devig(null, -110), null);
  assert.equal(devig(null, null), null);
});

test('the method is named in the result so it can be changed and compared', () => {
  const f = devig(-110, -110);
  assert.ok(f);
  assert.equal(f.method, 'multiplicative');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/devig.test.ts`
Expected: FAIL — cannot find module `./devig.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/devig.ts`:

```ts
/**
 * Underdog's price, with the book's margin taken back out.
 *
 * Underdog publishes genuine two-sided American odds; PrizePicks cannot,
 * because it prices with a flat multiplier and expresses price by moving the
 * line. So this is the only real market probability available on the board.
 *
 * Multiplicative, deliberately. At the -112/-112 that most of these markets
 * carry, the margin is small and near-symmetric, which is exactly where
 * multiplicative and Shin agree; the extra machinery would buy nothing we
 * could measure. The method is named in the result so it can be swapped for
 * Shin or power later and the two compared on real graded picks, rather than
 * being silently baked in here.
 */

export type FairOdds = {
  /** Probability the over hits, margin removed. 0..1. */
  over: number;
  under: number;
  /** The margin that was removed: 0.05 is a 5% overround. */
  overround: number;
  method: 'multiplicative';
};

/**
 * American odds to the probability they imply, margin still in.
 *
 * Negative odds are a favourite (-110 risks 110 to win 100); positive odds an
 * underdog (+110 risks 100 to win 110). At ±100 the two formulas meet at 0.5.
 */
export function americanToProb(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

/**
 * Both sides' fair probabilities, or null when there is no two-sided market.
 *
 * A market the book lists one way only cannot be devigged: there is no second
 * price to measure the margin against. It returns null rather than assuming
 * the missing side is the complement, which would be reporting the book's
 * margin as though it were the player's chance.
 */
export function devig(
  overPrice: number | null | undefined,
  underPrice: number | null | undefined,
): FairOdds | null {
  if (overPrice === null || overPrice === undefined) return null;
  if (underPrice === null || underPrice === undefined) return null;
  if (!Number.isFinite(overPrice) || !Number.isFinite(underPrice)) return null;

  const o = americanToProb(overPrice);
  const u = americanToProb(underPrice);
  const total = o + u;
  if (!(total > 0)) return null;

  return { over: o / total, under: u / total, overround: total - 1, method: 'multiplicative' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/devig.test.ts` — Expected: 7 passing.
Run: `npm test` — Expected: all pre-existing tests still pass.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/devig.ts src/devig.test.ts
git commit -m "Take the book's margin back out of Underdog's prices

Underdog publishes real two-sided American odds and we had never read
them. Devigging turns them into the only genuine market probability on
the board — PrizePicks cannot offer one, since it prices with a flat
multiplier and moves the line instead.

Multiplicative, because at -112/-112 the margin is small and symmetric
and Shin would agree to more decimal places than we can measure. The
method is named in the result so it can be swapped and compared later.

A one-sided market returns null rather than assuming the missing side is
the complement, which would report the book's margin as the player's
chance.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Show the market probability on the board

**Files:**
- Modify: `src/web/render.ts` (board row rendering; `boardPage`)
- Test: `src/web/render.test.ts` (append)

**Interfaces:**
- Consumes: `devig`, `FairOdds` from Task 1. `MarketRow.ud_over_price` and `MarketRow.ud_under_price` already exist in `src/web/boardq.ts` and are already selected by the board query — no query change needed.
- Produces: `marketDisagreement(hitRate: number | null, marketProb: number | null): number | null` exported from `render.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/render.test.ts`:

```ts
import { marketDisagreement } from './render.js';

/**
 * How far our own hit rate sits from what Underdog's price implies.
 *
 * Shown, never scored. Our hit rate is an empirical frequency over a dozen-odd
 * series and Underdog is a DFS operator rather than a sharp book, so the gap
 * between them is a prompt to look, not an edge to rank on.
 */

test('no market price means no disagreement to report', () => {
  assert.equal(marketDisagreement(0.7, null), null);
});

test('no hit rate of our own means no disagreement to report', () => {
  assert.equal(marketDisagreement(null, 0.5), null);
});

test('disagreement is our number minus the market, signed', () => {
  // We think it hits 70% of the time; the market prices it at 50%.
  assert.ok(Math.abs(marketDisagreement(0.7, 0.5)! - 0.2) < 1e-9);
  // And the other way round, so the sign says who is higher.
  assert.ok(Math.abs(marketDisagreement(0.4, 0.6)! - -0.2) < 1e-9);
});

test('agreement is zero, not absent', () => {
  // A market we agree with is a real answer and must be distinguishable from
  // one we could not price at all.
  assert.equal(marketDisagreement(0.55, 0.55), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/web/render.test.ts`
Expected: FAIL — `marketDisagreement` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/web/render.ts`, next to `offeredSides`:

```ts
/**
 * Our hit rate minus the probability Underdog's price implies.
 *
 * Positive means we are more optimistic than the market. Null means one of the
 * two numbers does not exist — a market Underdog lists one way only cannot be
 * devigged, and a player with no history has no hit rate. Zero means they
 * agree, which is a different fact from either being missing and is kept
 * distinguishable from it.
 *
 * Deliberately not folded into `strength`. Ranking on this would present the
 * product of an uncalibrated frequency and a DFS book's risk management as an
 * edge. It is shown so the rows where the two disagree can be looked at.
 */
export function marketDisagreement(
  hitRate: number | null,
  marketProb: number | null,
): number | null {
  if (hitRate === null || marketProb === null) return null;
  return hitRate - marketProb;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/web/render.test.ts` — Expected: all passing.

- [ ] **Step 5: Render the column**

In `boardPage`, inside the row `.map(...)`, compute the market probability for the side actually being called and render it in a new cell. Add the `<th>` to the board table header immediately after the existing `Averages` column:

```ts
// Underdog's own price for the side we are calling, margin removed. Only
// Underdog publishes odds, so this column is blank for a market it does not
// list — which is honest: there is no market probability, rather than a
// market that thinks the chance is zero.
const fair = devig(r.ud_over_price, r.ud_under_price);
const marketProb = fair === null ? null : call.play?.side === 'under' ? fair.under : fair.over;
const gapToMarket = marketDisagreement(call.play?.hitRate ?? null, marketProb);
```

Render as a right-aligned figure cell, matching the existing `class="n"` figure treatment, showing `—` when null and a percentage otherwise. Mark the cell when `Math.abs(gapToMarket) >= MARKET_GAP`, with:

```ts
/**
 * How far apart our number and the market's must be before the row is worth a
 * second look. Twenty points is wide enough that small-sample noise in our own
 * hit rate does not light up half the board.
 */
const MARKET_GAP = 0.20;
```

Import at the top of `render.ts`: `import { devig } from '../devig.js';`

Do not add it to any sort comparator.

**This shifts the board's column indices, and `public/app.css` depends on
them.** The stylesheet caps the width of the left-aligned columns by position:

```css
@media (min-width: 860px) {
  .board-table th:nth-child(2), .board-table td:nth-child(2) { width: 25%; }  /* Player */
  .board-table th:nth-child(3), .board-table td:nth-child(3) { width: 11%; }  /* Market */
  .board-table th:nth-child(5), .board-table td:nth-child(5) { width: 15%; }  /* Take */
}
```

The header is currently `Score, Player, Market, Averages, Take, …`. Inserting
a market-probability column after `Averages` moves `Take` from position 5 to 6,
so the `nth-child(5)` rule would silently start sizing the wrong column — the
new one — and `Take` would lose its cap. Update that selector to match the new
position in the same commit, and re-check the board at 1440px and 1920px
afterwards. Positional selectors and a column insertion are exactly the kind of
coupling that breaks quietly and looks like a rendering bug days later.

- [ ] **Step 6: Verify in the running app**

Run: `npm run web`, open `http://localhost:3000/board`.
Expected: a market probability column populated for Underdog-listed markets and `—` for PrizePicks-only ones. Confirm the board's sort order is byte-identical to before by comparing the rendered player order against `git stash`-ed output.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/web/render.ts src/web/render.test.ts
git commit -m "Show what Underdog's price thinks, beside what we think

The board now carries the devigged probability for the side it is
calling, and marks the rows where our number and the market's are more
than twenty points apart.

It does not sort on it and it does not enter the score. Our hit rate is
an empirical frequency over a dozen-odd series, not a calibrated
probability, and Underdog is a DFS operator rather than a sharp book.
Multiplying the two would dress an unvalidated number as an edge and
rank the board on it. Showing the disagreement costs nothing if it turns
out to be noise; scoring on it waits for graded picks to say whether
either number is calibrated.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Store a round count

**Files:**
- Create: `db/010_map_stat_rounds.sql`
- Modify: `src/results/types.ts` (the `MapStat` type)
- Modify: `src/results/store_stats.ts` (insert and upsert)

**Interfaces:**
- Consumes: nothing.
- Produces: `MapStat.rounds: number | null`; `map_stat.rounds` column.

- [ ] **Step 1: Write the migration**

Create `db/010_map_stat_rounds.sql`:

```sql
-- How many rounds a map actually ran.
--
-- Without it every map is one observation of "kills" and a 13-4 stomp counts
-- the same as a 16-14 grinder — 17 rounds against 30. A player's projected
-- mean then inherits the round-length mix of whatever sample they happen to
-- have, so ten blowouts in a row projects them low for a reason that says
-- nothing about the player, and the model cannot tell that apart from a real
-- decline.
--
-- Nullable on purpose, and it must stay that way. League of Legends has no
-- rounds and never will, and a CS2 map whose count could not be established
-- has to stay empty rather than carry a guess — the same rule grading uses
-- when a source cannot produce a stat.
--
-- Its own column rather than another key in `raw`: this is a modelling input
-- now, read on every board render, and burying it in JSON would make every
-- query that needs it pay to dig it out.

ALTER TABLE map_stat ADD COLUMN IF NOT EXISTS rounds smallint;

-- The projection draws a round-length distribution per league. Partial, since
-- every LoL row and every un-backfilled CS2 row is null and none of them are
-- ever selected by that query.
CREATE INDEX IF NOT EXISTS map_stat_rounds_idx
  ON map_stat (league, rounds) WHERE rounds IS NOT NULL;
```

- [ ] **Step 2: Run the migration and verify the column exists**

Run: `npm run db:migrate`
Run: `docker exec bropprop-db psql -U bropprop -d bropprop -c "\d map_stat"`
Expected: a `rounds | smallint` row in the output.

- [ ] **Step 3: Add `rounds` to the MapStat type**

In `src/results/types.ts`, add to `MapStat` after `headshots`:

```ts
  /**
   * Rounds the map ran. CS2 only — LoL has no such thing, and a source that
   * did not report it leaves this null rather than guessing.
   */
  rounds: number | null;
```

- [ ] **Step 4: Persist it**

In `src/results/store_stats.ts`, add `rounds` to the column list, add `$14` to the `VALUES` clause (moving `fetched_at`'s `now()` after it), add to the `DO UPDATE SET` clause as:

```sql
             rounds = COALESCE(EXCLUDED.rounds, map_stat.rounds),
```

and add `s.rounds` to the parameter array in the matching position.

`COALESCE` on update, not plain assignment: a later source that reports the same map without a round count must not erase one we already have. This mirrors how `team` and `played_at` are already handled in this same statement.

- [ ] **Step 5: Verify nothing regressed**

Run: `npm run typecheck`
Expected: errors in `src/results/bo3.ts`, `hltv.ts`, `leaguepedia.ts`, `oracleselixir.ts` — each constructs a `MapStat` and now lacks `rounds`. Add `rounds: null` to every one of them except bo3, which Task 4 fills in properly.
Run: `npm run typecheck` again — Expected: clean.
Run: `npm test` — Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add db/010_map_stat_rounds.sql src/results/types.ts src/results/store_stats.ts src/results/hltv.ts src/results/leaguepedia.ts src/results/oracleselixir.ts
git commit -m "Give a map stat line somewhere to record how long the map ran

A 13-4 stomp is 17 rounds and a 16-14 grinder is 30, and the model has
been averaging them as equals. This is the column that lets it stop.

Nullable, and staying that way: LoL has no rounds, and a CS2 map whose
count could not be established must read as unknown rather than as a
number somebody made up. The upsert coalesces rather than assigns, so a
later report that omits the count cannot erase one already stored.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Capture the round count during collection

**Files:**
- Modify: `src/results/bo3.ts` (the `Bo3Game` type; the game loop around line 268)

**Interfaces:**
- Consumes: `MapStat.rounds` from Task 3.
- Produces: bo3-sourced `MapStat` rows carrying `rounds`.

This costs **zero additional API requests**. `src/results/bo3.ts` already sets `params.set('with', 'games')` and iterates `m.games ?? []`, so the game objects are already in hand and `rounds_count` is a field on each. Verified 2026-09-07 against match 127571: games 182458 and 182459 returned `rounds_count` 17 and 15.

- [ ] **Step 1: Add the field to the Bo3Game type**

In `src/results/bo3.ts`, add to the `Bo3Game` type:

```ts
  /**
   * Rounds the map ran. Present on the embedded game objects we already
   * request with `with=games`, so reading it costs nothing extra.
   */
  rounds_count?: number | null;
```

- [ ] **Step 2: Pass it through to the stat row**

In the loop that builds `MapStat` rows from `players_stats`, set:

```ts
        // Straight off the game object we already hold. A game that somehow
        // reports no round count writes null rather than a zero, which would
        // be an infinitely fast map rather than an unknown one.
        rounds: typeof g.rounds_count === 'number' && g.rounds_count > 0 ? g.rounds_count : null,
```

- [ ] **Step 3: Verify against a live fetch**

Run: `npx tsx -e "import('./src/results/bo3.js').then(async m => { const r = await m.fetchBo3({ days: 2 }); const withRounds = r.stats.filter(s => s.rounds !== null); console.log('stats:', r.stats.length, 'with rounds:', withRounds.length); console.log(JSON.stringify(withRounds.slice(0,3), null, 1)); })"`

Adjust the call to match `bo3.ts`'s actual exported entry point and its argument shape — read the file's exports first.

Expected: a high proportion of rows carry a plausible round count (CS2 is MR12, so 13 to roughly 30 with overtime). If any row shows a round count below 13 for a completed map, stop and investigate before writing anything.

- [ ] **Step 4: Cross-check the count against KAST**

KAST is the fraction of rounds in which a player got a kill, assist, survived or was traded — a ratio whose denominator is the round count. So `kast * rounds` must land on an integer.

Run a one-off check over the freshly fetched rows asserting `Math.abs(kast * rounds - Math.round(kast * rounds)) < 0.02` for every row that has both.

Expected: passes for essentially every row. Verified by hand: game 182458 stored `kast` `0.7647058823529411`, which is exactly 13/17, matching its `rounds_count: 17`.

This is a check, not a fallback. KAST alone cannot *produce* a round count — 0.75 is 12/16 and 15/20 alike — so it may confirm a fetched number and must never generate one.

- [ ] **Step 5: Commit**

```bash
git add src/results/bo3.ts
git commit -m "Record how many rounds each map ran, for free

The collector already asks for the game objects with \`with=games\` and
already loops over them, so \`rounds_count\` was sitting in a response we
had in hand and were throwing away. No new request, no new endpoint.

Cross-checked against KAST, which is a fraction whose denominator is the
round count: 0.7647 stored against a reported 17 rounds is exactly 13/17.
That check runs against the fetched number and never produces one — KAST
alone is ambiguous, since 0.75 is 12/16 and 15/20 alike.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Backfill the round count for 13,517 stored games

**Files:**
- Create: `src/results/bo3_rounds.ts`
- Modify: `package.json` (add `"bo3:rounds": "tsx src/results/bo3_rounds.ts"`)

**Interfaces:**
- Consumes: `map_stat.rounds` from Task 3; `raw->>'game_id'` already stored on every bo3 row.
- Produces: a populated `rounds` column for historical rows. No exported API.

The table holds 47,449 bo3 rows across **13,517 distinct games** and 5,875 matches, spanning 2025-09-07 to 2026-09-07.

- [ ] **Step 1: Establish a bulk filter that is actually honoured**

bo3.gg **ignores unknown filters and returns the unfiltered list with HTTP 200**, so a filter must be verified rather than trusted.

Run:

```bash
curl -s -G "https://api.bo3.gg/api/v1/games" \
  --data-urlencode "filter[games.match_id][eq]=127571" \
  --data-urlencode "page[limit]=100" | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('count',j.total.count);console.log('all match the filter:',(j.results||[]).every(g=>g.match_id===127571));})"
```

Expected: `count 2` and `all match the filter: true`. This shape is verified working.

Then try the cheaper bulk form and verify it the same way:

```bash
curl -s -G "https://api.bo3.gg/api/v1/games" \
  --data-urlencode "filter[games.id][in]=182458,182459" \
  --data-urlencode "page[limit]=100" | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('count',j.total.count);console.log('ids',(j.results||[]).map(g=>g.id));})"
```

If it returns exactly those two games, use the `in` form and batch game ids 100 at a time — roughly 135 requests. **If it returns anything else — more games, all games, an error body with HTTP 200 — discard it and use the verified `match_id` form**, iterating the 5,875 distinct match ids instead. Record which form was used in a comment at the top of the file.

- [ ] **Step 2: Write the backfill**

Create `src/results/bo3_rounds.ts`. It must:

- Select distinct `raw->>'game_id'` from `map_stat` where `source = 'bo3'` and `rounds IS NULL`, so re-runs are cheap and resumable — the same property `bo3.ts` already has.
- Fetch in batches using whichever filter form Step 1 verified, re-checking on every response that the returned rows are the ones asked for.
- `UPDATE map_stat SET rounds = $1 WHERE source = 'bo3' AND raw->>'game_id' = $2 AND rounds IS NULL`.
- Reuse the existing politeness delay constant from `bo3.ts` rather than inventing a new one.
- Log progress as it goes and write rows as it goes, not at the end — matching the behaviour commit `fa082ab` added for the same reason.
- Take an optional argument limiting how many games to process, so it can be tried small first.

- [ ] **Step 3: Run it on a small slice and verify**

Run: `npm run bo3:rounds -- 200`

Then verify the KAST relationship holds across what it wrote:

```bash
docker exec bropprop-db psql -U bropprop -d bropprop -c "
  SELECT count(*) AS checked,
         count(*) FILTER (
           WHERE abs((raw->>'kast')::float * rounds
                     - round((raw->>'kast')::float * rounds)) < 0.02
         ) AS consistent,
         min(rounds) AS min_rounds, max(rounds) AS max_rounds
  FROM map_stat
  WHERE source='bo3' AND rounds IS NOT NULL AND raw->>'kast' IS NOT NULL;"
```

Expected: `consistent` essentially equal to `checked`, `min_rounds` at least 13 (CS2 is MR12), `max_rounds` plausible for overtime.

**If `consistent` is materially below `checked`, stop.** The round counts are not what they claim to be, and nothing further in this plan should be built on them.

- [ ] **Step 4: Run the full backfill**

Run: `npm run bo3:rounds`

Then confirm coverage:

```bash
docker exec bropprop-db psql -U bropprop -d bropprop -c "
  SELECT league, count(*) AS rows, count(rounds) AS with_rounds,
         round(100.0*count(rounds)/count(*), 1) AS pct
  FROM map_stat WHERE source='bo3' GROUP BY league;"
```

Expected: a high percentage. Some games will have been removed or never parsed upstream; those stay null, which is correct.

- [ ] **Step 5: Commit**

```bash
git add src/results/bo3_rounds.ts package.json
git commit -m "Backfill round counts for the CS2 history we already have

13,517 stored games had no round count because we were not reading the
field. Resumable and cheap on re-runs: it selects only rows still null,
so an interrupted pass costs nothing to repeat.

Verified rather than trusted, twice. bo3.gg ignores unknown filters and
returns the unfiltered list with HTTP 200, so the batch filter is
re-checked against every response. And KAST is a fraction whose
denominator is the round count, so kast * rounds must be an integer —
which is asserted across everything written before the full pass runs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Measure whether kills-per-round and round count are correlated

**Files:**
- Create: `src/results/measure_rounds.ts` (a one-off measurement, kept for re-running)
- Modify: `DESIGN.md` (record the number)

**Interfaces:**
- Consumes: `map_stat.rounds` from Task 5.
- Produces: a number that decides Task 8's resampling strategy. No code depends on its return type.

This exists because `src/combo.ts` faced the same trap and measured rather than assumed — teammates' kills turned out to move together at 1.06x to 1.18x what independence implied, which would have inflated every combo's spread. The same question applies here: a player who wins 13-4 has a high kills-per-round over few rounds, so drawing the two independently may misstate the spread.

- [ ] **Step 1: Write the measurement**

Create `src/results/measure_rounds.ts` computing, over `map_stat_dedup` where `league='CS2'` and `rounds IS NOT NULL` and `kills IS NOT NULL`:

- Pearson correlation between `kills::float / rounds` and `rounds`.
- Mean KPR bucketed by round count (13-15, 16-19, 20-24, 25+), so the *shape* is visible and not just a single coefficient.
- The count in each bucket, so a bucket too thin to believe is obvious.

Print a table. No database writes.

- [ ] **Step 2: Run it**

Run: `npx tsx src/results/measure_rounds.ts`
Expected: a correlation coefficient and a bucket table.

- [ ] **Step 3: Record the finding in DESIGN.md**

Add a dated entry to the `## Log` section stating the measured correlation and which resampling strategy it selects, in the same voice as the existing combo entry. Write the number down whichever way it came out — a null result is a finding and stops the next person re-measuring it.

- [ ] **Step 4: Commit**

```bash
git add src/results/measure_rounds.ts DESIGN.md
git commit -m "Measure whether kills-per-round moves with round length

Combos taught this lesson once already: teammates' kills move together
at 1.06x to 1.18x what independence implies, and assuming otherwise
would have inflated every combo's spread. The same question applies to
drawing a kill rate and a round count independently — a player who wins
13-4 has a high rate over few rounds.

So it is measured before it is assumed, and the number is written down
either way. A null result is a finding, and recording it stops the next
person measuring it again.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: A round-length distribution to draw from

**Files:**
- Modify: `src/web/projection.ts`

**Interfaces:**
- Consumes: `map_stat.rounds` from Task 5.
- Produces: `roundLengthPool(league: string): Promise<number[]>` — the observed round counts to resample from, most recent first.

- [ ] **Step 1: Write the failing test**

Append to `src/web/projection.test.ts`:

```ts
test('a round pool of one value produces that value every draw', () => {
  // Degenerate but load-bearing: it proves the pool is being sampled at all,
  // rather than a mean being taken behind the scenes.
  const totals = resampleFromRates([0.8], [20], 1, 'seed');
  assert.ok(totals.every((t) => Math.abs(t - 16) < 1e-9));
});

test('a range of n maps draws n round counts, not one scaled by n', () => {
  // Two maps of 20 rounds at 0.8 kills per round is 32 kills. If the
  // implementation drew one round count and multiplied, a pool with spread
  // would produce a narrower distribution than reality.
  const totals = resampleFromRates([0.8], [10, 30], 2, 'seed');
  const distinct = new Set(totals.map((t) => t.toFixed(4)));
  // 10+10, 10+30, 30+10, 30+30 -> three distinct sums (8, 16, 24 kills).
  assert.ok(distinct.size >= 3, `expected several distinct totals, got ${distinct.size}`);
});

test('rates and rounds are drawn independently of each other', () => {
  const totals = resampleFromRates([0.5, 1.0], [10, 20], 1, 'seed');
  const sums = new Set(totals.map((t) => t.toFixed(4)));
  // 0.5*10, 0.5*20, 1.0*10, 1.0*20 -> 5, 10, 10, 20 -> three distinct values.
  assert.ok(sums.size >= 3, `expected the cross product, got ${[...sums].join(',')}`);
});

test('the same seed gives the same draws', () => {
  const a = resampleFromRates([0.5, 1.0], [10, 20], 2, 'fixed');
  const b = resampleFromRates([0.5, 1.0], [10, 20], 2, 'fixed');
  assert.deepEqual(a, b);
});
```

Import `resampleFromRates` at the top of the file alongside the existing imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/web/projection.test.ts`
Expected: FAIL — `resampleFromRates` is not exported.

- [ ] **Step 3: Implement the resampler**

Add to `src/web/projection.ts`, next to the existing `resampleTotals`:

```ts
/**
 * Totals for an n-map range, drawn from a rate and a length separately.
 *
 * The existing resampler draws whole per-map kill totals, which bakes in the
 * round lengths that happened to occur in the player's sample. This draws the
 * two apart: a kills-per-round from the player, and a round count from the
 * matches.
 *
 * Rounds come from the match pool and never from the player. Round count is a
 * property of how a match went, not of who was in it, and drawing a player's
 * own past round counts would put back exactly the sample-mix bias this
 * exists to remove.
 *
 * One round count is drawn per map rather than one for the range, because a
 * three-map series is three separate lengths and collapsing them would
 * understate the spread.
 */
export function resampleFromRates(
  rates: number[],
  roundPool: number[],
  maps: number,
  seed: string,
): number[] {
  if (rates.length === 0 || roundPool.length === 0) return [];
  const rand = rng(seedFrom(seed));
  const out: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    let sum = 0;
    for (let m = 0; m < maps; m++) {
      sum += rates[Math.floor(rand() * rates.length)]!
           * roundPool[Math.floor(rand() * roundPool.length)]!;
    }
    out.push(sum);
  }
  return out;
}
```

**If Task 6 found a material correlation**, change the body to draw whole observed `(kills, rounds)` pairs re-weighted to the expected round mix instead, and update these tests to match. The independence tests above then become wrong and must be replaced, not deleted silently — record why in the commit.

- [ ] **Step 4: Add the pool query**

Add to `src/web/projection.ts`:

```ts
/**
 * Round counts actually observed, to draw a match length from.
 *
 * Pooled across the league rather than conditioned on the upcoming match's
 * tier. Props come from PrizePicks and Underdog, neither of which publishes a
 * tier, and an upcoming match is not necessarily linked to a bo3 match yet —
 * so conditioning would refuse far more often than it would sharpen. Round
 * length varies much less between tiers than between a stomp and a grinder,
 * which is the difference this is here to capture.
 */
export async function roundLengthPool(league: string, limit = 5000): Promise<number[]> {
  const rows = await q<{ rounds: number }>(
    `SELECT rounds FROM map_stat_dedup
      WHERE league = $1 AND rounds IS NOT NULL
      ORDER BY played_at DESC NULLS LAST
      LIMIT $2`,
    [league, limit],
  );
  return rows.map((r) => r.rounds);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/web/projection.test.ts` — Expected: all passing.
Run: `npm test` — Expected: all passing.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/projection.ts src/web/projection.test.ts
git commit -m "Draw a kill rate and a map length separately

The existing resampler draws whole per-map kill totals, which bakes the
round lengths of a player's sample into their projection. This draws the
two apart.

Rounds are drawn from the match pool, never from the player: round count
is a property of how a match went rather than of who was in it, and
using a player's own past lengths would put back exactly the bias this
removes. One length per map rather than one per range, because a
three-map series is three separate lengths.

Pooled across the league rather than by tier, since neither book
publishes one and an upcoming match may not be linked to a bo3 match at
all — conditioning would refuse far more often than it would sharpen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Project CS2 from kills per round

**Files:**
- Modify: `src/web/projection.ts` (`FormStats`, `Play`, `Evaluation`, `evaluate`, `projectBoard`)
- Modify: `src/web/render.ts` (display the new method)
- Test: `src/web/projection.test.ts`

**Interfaces:**
- Consumes: `resampleFromRates`, `roundLengthPool` from Task 7.
- Produces: `FormStats.kpr: number[]`, `FormStats.roundsSeen: number`; `Play.method` gains `'kpr'`; `Evaluation.league?: string`; `Evaluation.roundPool?: number[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/projection.test.ts`:

```ts
test('a blowout-heavy sample is not projected low for a normal-length match', () => {
  // The defect, stated directly. Both players average 0.8 kills per round.
  // One happened to play short maps, the other long ones. Today the first is
  // projected far lower purely because of the maps they drew.
  const shortMaps = form({
    kpr: Array(20).fill(0.8),
    roundsSeen: 20,
    mapValues: Array(20).fill(0.8 * 16),  // 12.8 kills a map
    series: 0,
  });
  const longMaps = form({
    kpr: Array(20).fill(0.8),
    roundsSeen: 20,
    mapValues: Array(20).fill(0.8 * 26),  // 20.8 kills a map
    series: 0,
  });
  const pool = [16, 20, 26];
  const opts: LineOption[] = [
    { book: 'underdog', line: 16.5, overOk: true, underOk: true },
  ];
  const a = evaluate({ form: shortMaps, options: opts, maps: 1, league: 'CS2', roundPool: pool, seed: 'a' });
  const b = evaluate({ form: longMaps, options: opts, maps: 1, league: 'CS2', roundPool: pool, seed: 'a' });
  assert.ok(a.play, 'short-map player should still be evaluated');
  assert.ok(b.play, 'long-map player should still be evaluated');
  // Identical rate and identical round pool must give an identical call.
  assert.equal(a.play.side, b.play.side);
  assert.ok(
    Math.abs(a.play.edge - b.play.edge) < 0.01,
    `same rate should project the same: ${a.play.edge} vs ${b.play.edge}`,
  );
});

test('a CS2 call built from rates says so', () => {
  const f = form({ kpr: Array(20).fill(0.8), roundsSeen: 20, series: 0, mapValues: [] });
  const r = evaluate({
    form: f, options: [{ book: 'underdog', line: 10.5, overOk: true, underOk: true }],
    maps: 1, league: 'CS2', roundPool: [20], seed: 's',
  });
  assert.equal(r.play?.method, 'kpr');
});

test('LoL never uses the rate path, even with rates present', () => {
  // Rounds do not exist in League. If a stray value ever reached this field,
  // it must be ignored rather than quietly modelled.
  const f = form({ kpr: [0.5], roundsSeen: 1, series: 8, totals: Array(8).fill(12) });
  const r = evaluate({
    form: f, options: [{ book: 'underdog', line: 8.5, overOk: true, underOk: true }],
    maps: 1, league: 'LOL', roundPool: [20], seed: 's',
  });
  assert.notEqual(r.play?.method, 'kpr');
});

test('too few rounds-bearing maps falls back rather than pretending', () => {
  const f = form({
    kpr: [0.8, 0.9], roundsSeen: 2,
    mapValues: Array(20).fill(16), series: 0,
  });
  const r = evaluate({
    form: f, options: [{ book: 'underdog', line: 10.5, overOk: true, underOk: true }],
    maps: 1, league: 'CS2', roundPool: [20], seed: 's',
  });
  assert.notEqual(r.play?.method, 'kpr');
});

test('an empty round pool falls back rather than dividing by nothing', () => {
  const f = form({ kpr: Array(20).fill(0.8), roundsSeen: 20, mapValues: Array(20).fill(16), series: 0 });
  const r = evaluate({
    form: f, options: [{ book: 'underdog', line: 10.5, overOk: true, underOk: true }],
    maps: 1, league: 'CS2', roundPool: [], seed: 's',
  });
  assert.notEqual(r.play?.method, 'kpr');
});
```

Extend the existing `form()` helper in that file with `kpr: []` and `roundsSeen: 0` defaults.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/web/projection.test.ts`
Expected: FAIL — `kpr` is not a property of `FormStats`.

- [ ] **Step 3: Extend the types**

In `src/web/projection.ts`:

```ts
// on FormStats, after perMap:
  /**
   * Kills per round, most recent first. CS2 only, and only from maps that
   * carried a round count — a map without one is left out rather than
   * assumed, so this array is often shorter than mapValues.
   */
  kpr: number[];
  /** How many maps contributed a rate. The threshold for trusting them. */
  roundsSeen: number;
```

```ts
// on Play.method:
  method: 'series' | 'maps' | 'kpr';
```

```ts
// on Evaluation:
  /** Canonical league. Only CS2 has rounds; every other league skips the rate path. */
  league?: string;
  /** Observed round counts to draw a map length from. */
  roundPool?: number[];
```

```ts
/** Rounds-bearing maps needed before a rate is worth more than the totals. */
const MIN_KPR_MAPS = 12;
```

- [ ] **Step 4: Branch in `evaluate`**

Ahead of the existing `useSeries` logic, prefer the rate path when it is available:

```ts
  // Kills per round, scaled by how long maps actually run, beats a mean of
  // per-map totals whenever we have enough rated maps — the totals carry the
  // round lengths of whatever sample the player happens to have. CS2 only:
  // League has no rounds and must not be modelled as though it did.
  const pool = o.roundPool ?? [];
  const useKpr =
    o.league === 'CS2' && form.kpr.length >= MIN_KPR_MAPS && pool.length > 0;
```

Then select the sample:

```ts
  const sample = useKpr
    ? resampleFromRates(form.kpr, pool, maps, `${seed}|kpr|${maps}`)
    : useSeries
      ? form.totals
      : form.mapValues.length >= MIN_MAPS
        ? resampleTotals(form.mapValues, maps, `${seed}|${maps}`)
        : null;
```

Set `method` and `sample` on the returned `Play` accordingly: `useKpr ? 'kpr' : useSeries ? 'series' : 'maps'`, with the sample size being `form.kpr.length` in the `kpr` case.

Give the `kpr` path its own `evidence` term. It rests on one assumption fewer than the `maps` path — real observed rates rather than interchangeable map totals — but more than a measured whole-range total:

```ts
  const evidence = useKpr
    ? 0.9 * Math.min(1, form.kpr.length / 24)
    : useSeries
      ? Math.min(1, form.series / 12)
      : 0.75 * Math.min(1, form.mapValues.length / 30);
```

- [ ] **Step 5: Populate `kpr` in `projectBoard`**

Extend the `projectBoard` query to also aggregate, per market, the per-map `kills::float / rounds` for rows where `rounds IS NOT NULL`, ordered most recent first, and set `kpr` and `roundsSeen` on the returned `FormStats`. Only the `kills` stat column is meaningful as a per-round rate; for `headshots`, `assists` and `deaths` set `kpr: []` and let those markets keep the existing path. Do the same in `projectFor`.

- [ ] **Step 6: Pass league and pool from the board route**

In `src/web/server.ts`, fetch `roundLengthPool('CS2')` once per board render alongside the existing `projectMarkets` call, and thread it plus each row's league into `evaluate` wherever `render.ts` calls it. One pool for the whole board, not one per row.

- [ ] **Step 7: Show the method**

In `src/web/render.ts`, wherever `method` is already surfaced, give `'kpr'` its own label — "per round" — so a call built from rates is distinguishable from one built from totals. Follow whatever the existing treatment of `'series'` and `'maps'` is rather than inventing a new one.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test` — Expected: all passing, including the pre-existing 67.
Run: `npm run typecheck` — Expected: clean.
Run: `npm run web` and load `/board` — Expected: CS2 kills markets show the new method label; LoL markets unchanged; the header's call/fair/waiting counts still add up to the row count.

- [ ] **Step 9: Commit**

```bash
git add src/web/projection.ts src/web/projection.test.ts src/web/render.ts src/web/server.ts
git commit -m "Project CS2 kills from a rate, not from a pile of map totals

A mean of per-map totals inherits the round lengths of whatever sample a
player happens to have, so ten blowouts projects them low for a reason
that says nothing about them. Kills per round, scaled by how long maps
actually run, does not.

CS2 kills only. League has no rounds and is untouched; headshots,
assists and deaths keep the existing path. Below twelve rounds-bearing
maps, or with no round pool at all, it falls back and marks the call
'per round' versus the old bases, so the board never implies a precision
it does not have.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Validate on held-out data, and be willing to revert

**Files:**
- Create: `src/results/validate_kpr.ts`
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a decision. No runtime code depends on it.

This is the kill switch. Rounds normalisation is a claim about accuracy, and a claim that can be checked should be checked rather than admired.

- [ ] **Step 1: Write the validation**

Create `src/results/validate_kpr.ts`:

- Split `map_stat_dedup` CS2 rows by time: everything before a cutoff is training, everything after is the held-out test. **Time-based, never random** — rosters churn, and a random split on this data will lie, as the README already warns.
- For each held-out series with a complete map range, project it two ways from training data only: the old per-map path and the new rate path.
- Report mean absolute error and median absolute error for both, and the count of series scored.

- [ ] **Step 2: Run it**

Run: `npx tsx src/results/validate_kpr.ts`
Expected: two error numbers and a sample count.

- [ ] **Step 3: Decide, honestly**

- **If the rate path's error is lower**, record both numbers in `DESIGN.md` with the sample size and keep the change.
- **If it is not lower**, say so plainly and revert Task 8's projection change, keeping the `rounds` column, the collection, and the backfill — those are useful regardless and cost nothing to hold. Record the negative result in `DESIGN.md` so nobody rebuilds it on the same reasoning.

A held-out test that only ever confirms the thing it tests is not a test. Report whichever way it comes out.

- [ ] **Step 4: Commit**

```bash
git add src/results/validate_kpr.ts DESIGN.md
git commit -m "Check the rate model against held-out games before believing it

Rounds normalisation is a claim about accuracy, so it gets measured on
data it never saw rather than argued for. Time-based split, never
random: rosters churn and a random split on this data will lie.

The result is recorded whichever way it came out, and if the rate path
does not beat per-map totals the projection reverts while the rounds
column stays — the data is worth having either way, and a negative
result written down stops the idea being rebuilt from the same
reasoning.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Update the documentation

**Files:**
- Modify: `README.md`, `RUNBOOK.md`, `DESIGN.md`

- [ ] **Step 1: RUNBOOK**

Add `npm run bo3:rounds` to the CS2 section with what it does, that it is resumable, and the KAST cross-check. Note that ongoing collection needs no separate command because `rounds_count` rides along with the normal bo3 run.

- [ ] **Step 2: README**

Update the Phase 2 / Phase 4 description to say CS2 kills project from a rate rather than from map totals, and add the devigged market probability to the dashboard section — including that it is shown and not scored, and why.

- [ ] **Step 3: DESIGN.md**

Add a dated log entry covering both halves: the round-length bias and what the measured correlation was, and the decision to show the market probability without ranking on it.

- [ ] **Step 4: Commit**

```bash
git add README.md RUNBOOK.md DESIGN.md
git commit -m "Write down what the rate model and the market column do

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the `rounds` column and its nullability (Task 3); free collection (Task 4); the ~135-request backfill and KAST cross-check (Task 5); the correlation measurement that the spec insists be measured not assumed (Task 6); rounds drawn from the match and not the player, and the pooled-vs-tier fallback (Task 7); the KPR projection, the LoL refusal, the fallback and the `'kpr'` method marker (Task 8); the devig module, multiplicative choice, one-sided refusal and 478-of-529 coverage (Task 1); shown-not-scored (Task 2); the held-out time-based validation and its willingness to revert (Task 9); documentation (Task 10).

**Type consistency.** `FormStats.kpr` / `roundsSeen`, `Play.method` including `'kpr'`, `Evaluation.league` / `roundPool`, `resampleFromRates(rates, roundPool, maps, seed)`, `roundLengthPool(league, limit)`, `devig(overPrice, underPrice)`, `americanToProb(odds)`, `marketDisagreement(hitRate, marketProb)` and `MapStat.rounds` are each defined once and referenced with the same names and shapes throughout.

**Known conditional.** Task 7's resampler assumes independence between rate and round length. Task 6 measures whether that holds and Task 7 Step 3 states what to change if it does not. This is deliberate — the spec requires the measurement to come first — and it is the one place where a later task may rewrite an earlier one's tests.
