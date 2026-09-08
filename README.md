# BropProp

Esports prop research for PrizePicks and Underdog (CS2, LoL, Apex).

**Phase 1 — the line logger — is built and running.** It records every esports
prop on both books, every 15 minutes, with full line-movement history. Nothing
is modelled yet, by design: the point of Phase 1 is to accumulate the ground
truth that Phases 2-5 need and that nobody will sell you.

## Quick start

```bash
cp .env.example .env
npm install
npm run db:up        # Postgres 16 in Docker on :5433
npm run db:migrate
npm run poll         # one-shot poll of both books
npm run report       # human-readable view of what's been logged
npm start            # run continuously on the POLL_CRON schedule
```

```bash
npm run web          # dashboard on http://localhost:3000
```

`npm test` runs the normalisation tests. `npm run db:reset` wipes and rebuilds.

## The dashboard

Answers two questions and deliberately nothing else:

- **Disagreements** — same player, same stat, same map range, priced differently
  by the two books, sorted by gap. Each row names the actionable side (the
  lower line is the cheaper over), so you aren't deriving it in your head.
  Compared against PrizePicks' `standard` variant only: goblin and demon lines
  are deliberately shifted, so including them would report a "disagreement"
  that's really just a different product.
- **Movement** — lines that aren't where they opened, largest move first. This
  fills in as the logger runs.

A results/hit-rate panel is *not* here yet. It would be an empty placeholder
until Phase 2 grading exists, and an empty panel that implies a working model
is worse than no panel.

The header shows how long ago the last successful poll was, and the page warns
when that exceeds two intervals. **Seen** means *last confirmed on the board*,
not *last changed* — and a cross-book pair is only as fresh as its staler side,
so a book that failed its poll drags the number down honestly rather than
letting a stale line look current.

**Board** (`/board`) is the full market list with O/U buttons — taking a prop
adds a leg to the open slip at the line currently shown. **Slips** (`/slips`)
is the record of what was placed. Every pick stores the line it was taken at,
which is what makes results gradeable once phase 2 lands.

Combo props (`Dhokla + Inspired + Saint`) are tagged `COMBO`: they look like
single-player lines and are never cross-book matched against one. They are
projected and graded, though — from the series their members actually played
*together*, so whatever correlation exists between teammates is inside the
sample rather than assumed away. See `src/combo.ts` for why summing per-player
distributions was rejected and what was measured to decide it.

A prop is a combo when its *handle* names more than one player. PrizePicks also
publishes a `combo` flag and it over-fires — it was set on a single CS2 player
whom Underdog listed normally on the same market, which split that market in
two and hid a 4.0 gap between the books.

**Fair %** is what Underdog's own price implies, with the bookmaker's margin
taken back out. Underdog publishes real two-sided American odds; PrizePicks
cannot, because it prices with a flat multiplier and expresses price by moving
the line instead — so this is the only genuine market probability on the board.
It sits beside our own hit rate and is marked where the two disagree by more
than twenty points.

It is shown and **never scored on**. Our hit rate is an empirical frequency
over a dozen-odd series, not a calibrated probability, and Underdog is a DFS
operator rather than a sharp book. Multiplying the two would dress an
unvalidated number up as an edge and sort the board on it. A market Underdog
lists one way only shows nothing rather than a guess — a single price cannot be
devigged. See `src/devig.ts`.

Set `DASHBOARD_PASSWORD` in production — the dashboard accepts writes.

See `DESIGN.md` for the visual direction and the rules behind it.

## What the recon actually found

These endpoints were probed live before any code was written; the results
shaped the design.

| | PrizePicks | Underdog |
|---|---|---|
| Host | `partner-api.prizepicks.com` | `api.underdogfantasy.com/beta/v6/over_under_lines` |
| Auth | none | none |
| `api.prizepicks.com` | **403** — DataDome captcha wall | n/a |
| Payload | 23MB unfiltered, **218KB** per league | ~15MB, whole board in one call |
| Rate limits | **~2 requests/minute**, slow refill | none observed |
| Prices | flat multiplier; price is expressed by moving the line (goblin/demon) | explicit American odds per side (`-112`) |

- The public PrizePicks API is captcha-walled; `partner-api` is not. Fetch
  **per-league** (`?league_id=`) — it is a 100x payload reduction and much
  gentler on the rate limiter. Known ids: CS2 `265`, LoL `121`, Apex `268`.
  These are stored in `league_ref` and self-heal from each poll's response.
- Underdog publishes **no team roster** in this payload — teams are UUIDs only.
  Human-readable matchups come from the game title (`BetBoom vs BIG`).
- Underdog stores esports handles in `last_name`, sometimes space-padded.

### The thing that makes this workable

Both books scope esports props to a **map range**, and they mean the same thing:

```
PrizePicks  "MAPS 1-3 Kills"      →  kills, maps 1-3
Underdog    "kills_on_maps_1_2_3" →  kills, maps 1-3
```

PrizePicks writes a *range*, Underdog *enumerates*. Collapsing both into
`(stat, map_start, map_end)` in `src/normalize.ts` turns cross-book comparison
into an exact join rather than fuzzy matching. That plus a folded player handle
(`canon_handle`) is the whole basis of the `cross_book_diff` view — and it's
the same key that joins to the stat sources in Phase 2. It holds up there too:
138 of the board's 255 CS2 handles matched bo3.gg's player names over a single
fortnight, with no fuzzy matching.

A gapped selection (`maps 1 and 3`) is deliberately **rejected**, not flattened
into `1-3` — silently widening it would fabricate a market neither book offers.

## Design decisions worth knowing

**Snapshots are change-detected, not per-poll.** A poll where nothing moved
writes zero snapshot rows and only bumps `last_seen_at`. At a 15-minute cadence
naive logging would write ~67k dead rows a day; this writes only real movement,
timestamped to the second. Verified live: two consecutive polls 100s apart went
from 701 snapshots to 703 — the two genuine line moves in that window.

**A prop's identity is semantic, not the book's id.** The unique key is
`(book, player, match, stat, map range, variant, is_combo)`, so if a book mints
a fresh id for the same market the history *appends* instead of forking. The
constraint uses `NULLS NOT DISTINCT` because `match_id` is nullable and default
Postgres NULL semantics would otherwise insert a duplicate prop on every poll.

**A failing book is normal operations, not a crash.** Each book's poll is
recorded in `poll_run` with its HTTP status and error; one book failing never
takes down the other. Per-league failures are logged rather than silently
absorbed into an empty result that looks like "no props today".

**Raw payloads are archived** to `RAW_DIR` so the DB can be rebuilt or
backfilled without re-fetching — important when the endpoint shape changes.

## Schema

```
book ── player ── prop ── prop_snapshot     poll_run    league_ref
        team      match                     (audit)     (self-healing ids)
```

Views: `current_line` (latest line per prop), `cross_book_diff` (same player,
same stat, same map range, different number).

## Roadmap

- **Phase 1 — line logger.** *Done.* Both books, change-detected history.
- **Phase 2 — result grader.** *Done for both games.*
  Per-map stat lines land in `map_stat`, and grading reads them separately so a
  grading fix can be re-run without re-scraping. `npm run grade` runs it; the
  worker also runs it on `RESULTS_CRON`.

  Sources, probed before building: **Leaguepedia**'s Cargo API serves per-game
  K/D/A for pro League and joins to book handles exactly (`Berserker`,
  `Dhokla`, `Inspired` all match with no fuzzy matching). It has no
  game-number column, but `GameId` is `MatchId + "_" + game number`, so the map
  number is derived rather than guessed. Fandom rate-limits hard and reports it
  as HTTP 200 with an error body, so the adapter backs off on that specifically
  and paginates with long gaps.

  CS2 comes from **bo3.gg**, whose `/games/{id}/players_stats` serves per-map,
  per-player kills, deaths, assists and headshots with no key, no browser and
  no rate limit. It replaced an HLTV crawler that needed Playwright and lost a
  fight with Cloudflare past the first results page: of thirty recent HLTV
  results exactly one carried per-map player stats, where bo3.gg covered 665 of
  672 maps. `parsed_status` tells you in advance which matches carry stats, and
  the only real cost is latency: stats land 7.5 to 33 hours after a match ends,
  so CS2 picks grade the next day rather than the same night.

  The rules that decide money are tested directly: an unplayed map in the range
  voids the prop rather than grading it short, a stat the source can't produce
  is `ungradeable` rather than zero, and a pick with no stat line yet stays
  pending so a late result still grades it. Combos apply those same two rules
  member by member — a map missing one member is a hole, not a smaller total —
  and are refused only when the handle can't be split into players.
- **Phase 3 — dumb baselines.** Score naive strategies (always under, fade the
  move, take the Underdog side on disagreement) before modelling anything.
  Anything beating 54% here is real signal.
- **Phase 4 — features and model.** Rolling per-map averages, opponent
  strength, series format. Logistic regression / gradient boosting, not a net.

  **Round counts are already collected** (`map_stat.rounds`, free from the
  bo3 payload, backfilled across 13,564 games) and are available as a feature.
  One specific use of them has already been tried and rejected: projecting CS2
  kills as a per-round rate scaled by a resampled map length. It was sound in
  theory, it was built, and on a time-split held-out test it scored MAE 6.8831
  against per-map's 6.8778 — a coin flip (t = 0.39). The reason is worth
  knowing before anyone tries it again: the bias it corrects is washed out by
  the sample sizes of every player who qualifies to use it. See `DESIGN.md`
  and `src/results/validate_kpr.ts`, which still runs and still reproduces it.
- **Discord tracker** — wanted, deliberately deferred until grading exists;
  the thing worth posting is graded results, not raw lines.
- **Phase 5 — the learning loop.** Nightly grade → retrain → log hit rate and
  calibration by segment. Track whether lines move *toward* your picks; that's
  the strongest validation there is.

Validate on **time-based splits** (train past, test future), never random —
random splits on this data will lie to you.

## Caveats

These are undocumented endpoints. Treat every adapter as disposable: the day a
payload reshapes, the logger breaks and the history gets a gap. `poll_run` is
there so you notice the same day instead of a month later.
