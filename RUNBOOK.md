# Runbook

Things that are built but need running by hand, and the reasons behind how they
run. Written so it makes sense cold, with no memory of the session that built it.

## Backfill player history (do this when you get home)

Three sources, split by job and by game:

| | Source | Job | Rate limits |
|---|---|---|---|
| **LoL bulk history** | Oracle's Elixir | months/years of past games | none |
| **LoL today's results** | Leaguepedia | games that finished minutes ago | brutal |
| **CS2, both jobs** | bo3.gg | history *and* current, one adapter | none seen |

### 1. Oracle's Elixir — the main backfill (LoL)

```bash
npm run oe 2026            # current season
npm run oe 2025 2026       # two seasons
```

One CSV download per season from a public Google Drive folder. No rate limits,
no browser, takes a few minutes. It scans the whole season (~100k player rows)
and stores only the players currently on your board — a player you've never had
a prop for is weight the projection would never use.

**Already run once:** 2026 loaded, 3,894 stat lines across 335 series, Jan 12 →
Sep 6. Re-running is safe; rows upsert rather than duplicate.

If a new season is missing, its Drive file id needs adding to `FILES` in
`src/results/oracleselixir.ts`. The ids come from the folder linked at
oracleselixir.com/tools/downloads.

**The blocker is Drive's quota, and it does not clear overnight.** Drive
answers an exhausted quota with **HTTP 200 and an HTML page**, not an error
status, so the adapter checks `content-type` and re-reads the body — an
unguarded parse would have stored zero rows and called it success. Probe it
without running the import:

```bash
curl -s "https://drive.usercontent.google.com/download?id=<FILES id>&export=download&confirm=t" \
  | sed 's/<[^>]*>/ /g' | head -c 200
```

`Google Drive - Quota exceeded` means wait, and **the wait is unpredictable
rather than fixed**. On 2026-09-08 it was still exhausted more than a day
after first hitting it — and then cleared roughly half a day later, with all
five seasons downloadable. It is a per-file quota shared across everyone
pulling a popular public file, so it has nothing to do with our usage and no
schedule can be inferred from it. Probe before assuming either way; the check
above costs one request.

LoL used to be the starving half at 39 of 68 board players clearing the
projection threshold. After the 2022-2026 load on 2026-09-08 it is **19 of 19
on the live board, median 136 series**, against **250 of 270** for CS2. Keep
re-running it each season; the gap comes back as new players appear.

### 2. Leaguepedia backfill — only if you want gaps filled

```bash
npm run backfill 180       # last 180 days
```

Works, but **Fandom rate-limits hard and the penalty lasts hours**. During the
build session this IP got locked out by roughly fifteen exploratory queries, and
the backfill couldn't complete. Oracle's Elixir covers the same ground without
the fight, so reach for this only for something Oracle's Elixir lacks.

If it fails with "exceeded your rate limit", that's the cooldown — wait it out
or run it from somewhere else. Nothing is wrong with the code.

### 3. CS2 history — solved, and it is bo3.gg

```bash
npm run bo3                # last 30 days
npm run bo3 365            # a year
npm run bo3 30 --all-players
npm run bo3:rounds         # fill in round counts for history already stored
```

Free, no key, no browser, no rate limit. **This is the CS2 equivalent of
Oracle's Elixir** and it is wired into the scheduled runs, so the manual
command is for backfilling depth rather than for keeping current.

**For a deep backfill, use the resumable one.** `npm run bo3 730` is a single
indivisible walk: a deploy kills it and the next run starts over. On
2026-09-08 that cost five restarts and most of a day for about 4,000 rows.

```bash
npm run bo3:resume            # 730 days in 30-day windows
npm run bo3:resume 365 14     # 365 days in 14-day windows
```

It cuts the range into dated windows and records each one in
`backfill_chunk` as it finishes, so a restart skips everything already done.
Set **`BACKFILL_DAYS=730`** on the logger and it resumes itself on every boot
— which is the point, because a deploy replaces the container and *nothing*
running inside can survive one. A deploy then costs one window, not the walk.

Windows go newest-first, so an interrupted job has still done the part the
board prices. The consequence is that the oldest date in `map_stat` does not
move until the whole range is walked; that looks like a stall and is not. A
completed window is never revisited even if it wrote nothing, because an empty
window is a real answer — bo3.gg's archive thins going back.

`BACKFILL_CHUNK_DAYS` (default 30) trades granularity against overhead: each
window re-pays the match-list paging, so very small chunks waste requests.

**A deep backfill is a ~6 hour job, and must be detached.** Measured
2026-09-08 on `npm run bo3 730`: 20,000 matches found, 13,102 of them parsed
and worth fetching, and about 364 minutes projected from the first 200. Run it
in the ssh foreground and it dies with the session — three attempts, three
different stdout arrangements, two dead inside twenty minutes. `setsid` is
what works:

```bash
railway ssh --project <id> --environment production --service bropprop-logger \
  "cd /app && setsid nohup npm run bo3 730 > /tmp/bo3.log 2>&1 < /dev/null & sleep 3; echo launched"
```

Then `tail /tmp/bo3.log` from any later session. Expect **no output at all for
the first five minutes** — `finishedMatches()` pages the whole match list
before fetching anything, and prints nothing while it does. Expect `0 rows`
for a long while after that too: a re-run skips maps already stored, and there
were 15,371 of those.

**`maxMatches` caps how far back 730 days can actually reach.** The CLI passes
20,000, matches are fetched newest-first, and the list is then truncated to
that cap — so a two-year request that finds 20,000 matches is silently keeping
the 20,000 *newest* and cannot reach the far end of its own window. Raise the
cap in `bo3.ts` if genuine 2024 history is the goal; the run gets
proportionally longer.

`GET /games/{game_id}/players_stats` returns one row per player per map:
kills, deaths, assists, **headshots**, ADR, KAST, first kills, clutches.

**Round counts ride along for free.** The collector already asks for the game
objects with `with=games`, and `rounds_count` is a field on each one, so
`map_stat.rounds` fills itself on every normal run — there is no separate
command to remember. `npm run bo3:rounds` exists only to fill in history that
was collected before the column did, and it is resumable and a cheap no-op
once coverage is complete. It batches 100 game ids per request
(`filter[games.id][in]`), so the whole archive is about 135 requests.

Two things worth knowing about those numbers. A map reporting **fewer than 13
rounds did not finish** — CS2 is MR12, first to 13 — so those rows are
abandonments and forfeits, not short games; there are about 90 of them and any
model should exclude them. A map reporting **46 to 60 rounds is real deep
overtime**, not a parsing error: all 168 such rows are KAST-consistent, and
clamping them would be discarding real data because it looked surprising.
KAST is the cross-check throughout — it is a fraction whose denominator is the
round count, so `kast * rounds` must land on a whole number, and it does for
99.77% of stored rows.

Measured 2026-09-07, against this board:

| | bo3.gg | HLTV (what it replaced) |
|---|---|---|
| Maps with per-player stats | **665 of 672** | 1 of 30 results |
| Board handles matched in 14 days | **138 of 255** | 0 |
| Headshots | yes, plain column | no, `/stats/` 403s |
| Auth / browser | none | Playwright + Cloudflare fight |
| Rate limit | none seen in 40 rapid requests | 403 on any plain client |
| Archive | pages back to 2023 | first results page only |

Those 14 days alone would have written **1,238 map stat lines**.

The clinching number is in production. The HLTV accumulator ran daily on
Railway from the day it was deployed, and on 2026-09-07 `map_stat` held **3,894
rows, every one of them Oracle's Elixir LoL, and not a single CS2 row**. It was
not collecting slowly. It was collecting nothing.

**Three things to know before you touch `src/results/bo3.ts`:**

- **`parsed_status` is the gate.** Of 60 recent finished tier-C matches, every
  map of a `done` match had stats (74 of 75) and no map of an unparsed match
  had any (0 of 62). It is a clean binary — filter on it rather than fetching
  hopefully.
- **Stats lag the match by 7.5 to 33 hours** (median 13). Picks stay pending
  overnight. This is not something to fix by polling harder; the data does not
  exist yet. It is why the results run looks back three days and the daily
  sweep looks back fourteen.
- **Unknown filters are ignored, not rejected.** `filter[status]=finished`
  returns the *unfiltered* list with HTTP 200. The working shape is
  `filter[<table>.<column>][<op>]=<value>`, e.g.
  `filter[games.match_id][eq]=128851`. The adapter re-checks every filter on
  the response for exactly this reason. Watch for the same trap elsewhere on
  this API — `bo3.gg/api/demo/<id>` also returns **HTTP 200** with a body of
  `{"error":"Invalid API path"}`.

Depth going back is patchy and tracks how much of that era was ever parsed:
roughly 18–85% of maps by month, sampled across 2023–2026. Recent months are at
the top of that range.

**What this closed:** CS2 headshot props are now gradeable. They were
`ungradeable` by construction under HLTV, whose headshot numbers exist only in
the `/stats/` section that 403s even in a real browser.

### HLTV — kept, demoted, no longer on any schedule

```bash
npm run backfill:cs2       # one pass over HLTV's current results page
```

Still works and still needs Playwright. Nothing calls it automatically any
more and there is no reason to run it: bo3.gg covers strictly more, for less.
It stays in the tree because the rows it already wrote are real, and
`map_stat_source_rank` still ranks it (below `bo3`) so that history is not
silently demoted below some future source.

### CS2 stats — the ideas that are now moot

These were the ranked plan before bo3.gg's `players_stats` endpoint was found.
Recorded so nobody spends money or a verification queue on a solved problem.

- **FACEIT Data API** — free per-map stats, but blocked behind document upload
  and an anti-cheat install. Only worth revisiting if you specifically want
  ESEA/FACEIT-platform matches that bo3.gg does not cover.
- **BALLDONTLIE CS2** — has the right data shape but only on the **GOAT tier at
  $39.99/mo**, with undocumented coverage. Do not pay for this.
- **Parse the demos yourself** — `demo_url` is on every finished game
  (`demos/manually_uploaded/...`, a relative path), and `awpy 2.x` would parse
  it. The demo CDN base was never found: every guessed base 404s and the loaded
  JS bundles contain no URL construction for it. Moot regardless — the API
  hands over better stats than a demo parse would yield, for none of the
  compute, storage or effort.


## THE FIRST SIGNIFICANT FINDING: both books shade the line, and the under wins

Measured 2026-09-10 against the books' own closing lines, every settled prop.

```
settled legs 2137, pushed 24
over-rate  ALL                    44.7%   (2137)
           prizepicks CS2         44.8%    (973)
           underdog   CS2         44.8%    (975)
           prizepicks CS2 standard 45.0%   (800)
           prizepicks CS2 demon    43.9%    (98)
           prizepicks CS2 goblin   44.0%    (75)
           CS2 kills              44.1%   (1035)
           CS2 headshots          45.7%    (913)

INDEPENDENT SERIES 133
series leaning over  50-83
exact two-sided sign test  p = 0.0053
```

**This is the first result in this project to clear the series-level bar.**
Everything before it — the projection at AUC 0.495, opponent strength at
r = 0.018, the stale line at 41-41, the market anchor at p = 1.00 — failed. This
one does not, and it is the same test that failed them.

It is also remarkably uniform: both books, both stats, standard and demon and
goblin all land between 43.9% and 45.7%. That is the signature of a line shaded
against the over, which is what a DFS book does when its customers love overs.

### What it means for a stacked slip

The correlation work above says a concentrated all-must-win entry is worth far
more than the flat payout ladder assumes. Put the two together, and the
DIRECTION turns out to matter more than the structure:

| 6-pick, 5 on one team + 1 opponent, at a **measured** 22x | per leg | P(all 6) | needs | EV |
|---|---:|---:|---:|---:|
| **all overs** | 44.7% | 4.33% | 23.09x | **0.953** |
| **all unders** | 55.3% | 9.22% | 10.85x | **2.028** |

Same shape, same multiplier, same match. Overs lose 5%; unders roughly double.
The break-even per-leg rate at 22x is **45.32%**, and the measured over-rate of
44.7% sits just below it while the under rate clears it by **10 points**.

**So: stack unders on one team.** The correlation is the same either way — the
measured both-under lift is 1.209 against both-over 1.211 — so the structure
works identically and only the side changes.

### Before betting the house on it

- **133 series from a four-day window.** Logging began 2026-09-06. A single
  patch or meta could produce a league-wide dip in kills, and this would look
  exactly the same. The structural warning elsewhere in this file still holds:
  a line-shade finding can only be confirmed FORWARD.
- **1,848 legs are unsettled against 2,137 settled**, because the stat feed does
  not cover every match. No mechanism is obvious by which "we have the stats"
  would correlate with "the player went under", but it is unchecked.
- The correlation figure is measured against our own line convention (prior
  median + 0.5), not the books'. The physical driver — map count, pace — should
  carry across, but that is an argument rather than a measurement.
- `shrink()` and the projection are NOT involved in any of this. The claim is
  entirely about the book's line and the shape of the slip.

Re-run both as the sample grows:

```bash
npm run validate:correlation    # the teammate effect, on 8,923 series
npm run validate:calls          # includes the over/under baseline
```


### The blowout effect: the biggest number in the project

Measured 2026-09-10 over **4,967 CS2 series** with walk-forward lines
(`raw/blowout.mjs`). "Losing team" is inferred from team kill totals over the
range, so this is measured AFTER the fact — which is the whole point.

| | over | under | n |
|---|---:|---:|---:|
| **Losing team, blowout (≥20% kill margin)** | 34.0% | **66.0%** | 4,323 |
| Losing team, clear (10–20%) | 38.6% | 61.4% | 2,182 |
| Losing team, close (<10%) | 43.6% | 56.4% | 2,871 |
| **Losing team, all** | 38.0% | **62.0%** | 9,376 |
| Winning team, all | 51.8% | 48.2% | 15,296 |

**4,180 independent series, losing team mostly under 2613-1567, p < 0.000001.**

This dwarfs everything else measured here, and it also explains the teammate
correlation: teammates share the loss.

**But it is hindsight.** Knowing who got beaten requires the match to have been
played. To act on it you need the market's opinion about who will lose BEFORE
kick-off — which is exactly a moneyline or a maps handicap.

#### What a market price is worth here

```
6-pick, 5 unders on one team + 1 opponent, at a real quoted 22x

  blind unders (measured)          55.3% per leg   needs 10.85x   EV 2.03
  dog priced ~25% to win (est.)    58.6%           needs  8.79x   EV 2.50
  heavy dog ~15% (est.)            59.9%           needs  8.11x   EV 2.71
  team that DID lose (hindsight)   62.0%           needs  7.15x   EV 3.08
  team BLOWN OUT (hindsight)       66.0%           needs  5.67x   EV 3.88
```

The two middle rows are the realistic prize: a moneyline moves a leg from 55.3%
to roughly 58–60%, worth about 25% more EV on the slip. The **maps handicap**
is the better instrument, because the blowout band is where the effect lives and
a handicap prices margin rather than just the winner.

**We already have the key for this.** OddsPapi's free tier carries CS2
`marketId 171` (Winner) and `1717-1745` (Maps Handicap), sourced from Pinnacle
among others. 250 requests a month, so pull once per slate and cache. See the
aggregator section below.

#### The honest caveats

- The 62% / 66% figures are **not achievable**. They assume perfect foreknowledge
  of the result. Only the 58–60% band is real, and even that is an estimate
  derived by mixing the measured rates by an assumed win probability — it has
  not itself been measured.
- Kill differential is a proxy for "lost". It is a good one in CS2, where kills
  track rounds, but it is not the scoreboard.
- Everything here is CS2. LoL has too few completed 1-3 ranges in the archive.

### The moneyline pipeline: built, validated, not yet switched on

Built 2026-09-10. Pinnacle's CS2 moneylines come in through OddsPapi
(`src/adapters/oddspapi.ts`), get turned into an under probability per team
(`src/web/matchodds.ts`), and feed a Stacks section at the top of the Build page.

**Budget.** The free tier is 250 requests a month. A full CS2 pull is about four:
one tournament list, then the active tournaments five at a time. Only ~14 of 350
are live at once, and the list says which. Every call goes into `api_call`
*before* it is made, and the monthly cap (default 220) is checked against that
table. A deploy restarts the container, so a counter kept in memory would reset.
Team names are cached in `oddspapi_participant` and fetched only when an unknown
id appears. CS2 only by default, because the blowout effect was measured on CS2.

**The trap that nearly shipped.** OddsPapi's outcome ids do not always mean the
same side. In the first real pull, outcome `171` was the home price on 11
fixtures and the **away** price on 2 of 13. Keying off the id would have put the
moneyline on the wrong team about one fixture in seven, which means stacking
unders on the favourite. The parser reads only the `bookmakerOutcomeId` label
(`home` / `away`), and a test covers the flipped case.

**Assumed, not verified:** `home` is `participant1Id`. Nothing in one payload can
tell that apart from the reverse, because a swap would flip every market on the
fixture consistently.

**Team matching** is exact after normalising, never fuzzy (`src/adapters/teamname.ts`).
75 of 82 recent CS2 teams matched with plain lowercase-and-strip. Stripping
suffixes (Clan, CS, Espor) and one alias (NAVI → Natus Vincere) picks up the
rest that are in OddsPapi at all. Betclic and BET-M are not in their feed.

**The pricing.**

    P(under) = P(team wins) · 0.482  +  P(team loses) · 0.620

It is calibrated, not just plausible. At a coin-flip match it gives 0.551, and
the under rate measured directly against the books' own closing lines is 55.3%.
Those are two independent measurements agreeing to within a fifth of a point.

It also shows how strong the line shade is. A team's players stay on the under
side until the team is about an **87% favourite** (0.62 − 0.138p = 0.5). An 80%
favourite's players still go under 50.96% of the time. I wrote a test asserting
the opposite and it failed. The test was wrong, not the code.

**Kills and headshots only.** The first render of the Stacks card put "sh1ro
under deaths" into a stack on the team Pinnacle had losing. A beaten team dies
*more*, so that leg pointed backwards on exactly the teams this favours. Every
number behind the pricing was measured on kills and headshots. Deaths and
assists stay out until each has its own measurement.

**Validated against production** in rolled-back transactions: migrations 015,
016 and 017 all apply; side availability is unchanged for both existing books;
the board query returns one entry per book per row in 32ms; a real parsed
Pinnacle fixture round-trips through the adapter's own INSERTs (1.628 / 2.18 →
57.25% home). Each run was confirmed rolled back.

**To switch it on** (not done — it's a production change):

```bash
railway variables set ODDSPAPI_KEY=<key> --service bropprop-logger --environment production
# then deploy the branch; migrations 015-017 apply on boot
npx tsx src/adapters/oddspapi.ts CS2     # one manual pull, costs ~4 requests
```

## Consensus across books — the one signal that is not our projection

Built 2026-09-10, **and not yet measured**. Read this before trusting anything
the board's edge chip says.

### Why this exists

Everything the board used to rank on traced back to `recommend()` in
`src/web/projection.ts`, and that path has been graded: **AUC 0.495** over 323
calls. A call it rates 75% wins no more often than one it rates 56%. Ranking
legs by that is ranking them by noise, so slips built on it inherit the noise.

Every DFS comparison tool worth copying — OddsJam, and the LCS Larry style of
thing — solves this without a model. They cannot use sharp books either: no
sharp book prices esports player props at all (Bovada's esports feed is
moneyline, map spread and total maps, and Pinnacle's is the same). What they do
instead is price against **each other**: build a consensus line from many DFS
books, then find the book that is out of step with it. The direction comes from
the crowd rather than from a forecast.

### The arithmetic that makes three books the whole ballgame

**Two books cannot produce a consensus.** The median of two numbers is their
midpoint, and which of the two is the outlier is symmetric — if PrizePicks says
28.5 and Underdog says 30.5, nothing in those two numbers says which is wrong.

This is worth stating plainly because it **re-frames the 41-41 stale-line
result** further down this file. That measurement is often read as "line
disagreement was tested and does not pay". It is not. Unable to get a direction
out of a two-book disagreement, `stale.ts` used *movement* as a proxy for
direction — and movement was then measured to predict what the other book will
print, not what the player will do. The consensus question was never tested,
because at two books it was not testable.

At three books it becomes testable: 28.5 / 30.5 / 30.5 says the crowd is on
30.5 and PrizePicks is two full kills cheap on the over.

### What was built

- `src/books.ts` — one registry, replacing `'prizepicks' | 'underdog'` at a
  dozen type sites and `b === 'prizepicks' ? 'PP' : 'UD'` at a dozen more.
- `src/web/boardq.ts` — a market row now carries `books: BookLine[]` instead of
  pivoted `pp_`/`ud_` columns. `spread` replaces the signed `delta`.
- `src/web/consensus.ts` — the signal itself.
- `db/015_books_generic.sql` — side availability moved off hardcoded book codes
  onto a `prices_sides` flag per book.
- `npm run validate:consensus` — the measurement, which currently prints
  "nothing to measure".

Two bugs surfaced during the rewrite and are fixed:

- the old pivot took `max(line)` and `max(prop_id)` as **separate** aggregates,
  so a book listing one market twice could show one prop's line above another
  prop's take button. `DISTINCT ON` now keeps a whole row together.
- `WrongBookError` named the prop's book as "whichever one isn't the slip's",
  which stops being an answer at three books.

### The rules it follows, and why

**Median, not mean.** One book listing a stale or fat-fingered number is the
exact thing being detected; a mean would launder that outlier into the baseline
it is being measured against.

**Every book weighted equally.** These are all soft DFS apps pricing the same
recreational flow. There is no measurement here saying one is closer to true,
and inventing weights would be inventing the answer.

**Leave-one-out from four books up, all-books median at exactly three.**
Measuring a book against a median it sits inside understates its own gap. But
dropping one of three leaves a two-book midpoint — contaminated by the very
outlier being measured — which reported the two books that *agree with each
other* as each being 1.0 off the market. At three, self-inclusion is the lesser
error, and it errs by shrinking the gap: an edge that reads too small costs a
bet that was there, one that reads too large invents a bet that was not.

**Location from the market, shape from history.** Turning a gap in stat units
into a probability needs to know how widely the player swings. So the sample
comes from history and is then slid bodily along until its median sits on the
consensus line. The market decides where the middle is; history only says how
far from the middle this player lands. **Our own mean is never consulted** —
that is the number measured at AUC 0.495, and it over-projects by +0.65 units
on 61% of markets. Its estimate of *spread* faces no such problem.

**The optimiser prefers consensus and does not blend.** Where a consensus
exists the side comes from it; where none does, the projection decides and the
leg is labelled `projection only` on the Build page. Averaging a
measured-useless estimate into a measured-useful one only adds noise and makes
the result impossible to attribute when it is finally scored.

### What is NOT known

**Whether any of this wins.** It has never been measured, because it cannot be:
a consensus needs three books and only two have ever been logged. `npm run
validate:consensus` exists and currently reports "nothing to measure".

The bar when data arrives is **not** "is the hit rate above 55%". It is "does
this beat a coin flip across independent SERIES", tested with the exact sign
test that script prints. Legs inside a series share length, overtime and pace —
this project has been fooled by leg-level statistics three times now, most
memorably a z = 5.11 per leg that was p = 0.077 per series.

The measurement will also be slightly **optimistic**: reconstructing side
availability from snapshots is not possible, so it assumes every flagged side
was takeable when some were not.

**Until it clears that bar, the board must not present this as a proven edge.**
It is currently presented as what it is: a price that is out of step with the
market, with the direction that follows mechanically from that.

### The board, right now, shows nothing

With two books the edge chip never renders, `bookEdges()` returns `[]`, and the
optimiser falls back to the projection on every leg. That blankness is correct
and is the honest state of the system. It lights up the day a third book lands.

## More books, and what a sharp line is actually worth

Probed 2026-09-08. The short version: the sharp-sportsbook idea does not pay
off the way it should, and the reason is a fact about CS2 rather than about
any API.

**Opponent strength does not predict a player's kills.** Measured over 1,874
series and 4,403 walk-forward predictions, adding an opponent adjustment —
how many kills that opponent has been conceding, versus the league — made the
forecast *worse*: MAE 6.56 against 6.49 for the player's own history alone,
and the correlation between the opponent effect and the residual it was meant
to explain was **r = 0.018**. Nothing.

Kills are close to conserved in CS2, which is why. A map runs its rounds and
distributes its kills whoever is playing; a stronger opponent kills you more
but also trades more. The same thing shows in match tier, which is nearly flat
on kills per map: **14.88 (tier b), 14.88 (c), 14.67 (a), 14.29 (s)**.

So a sharp book's moneyline or handicap would not have helped, and neither
would the free team rankings bo3.gg publishes. **Do not build an opponent
adjustment for kills.** The one live version of the idea is narrower: a
market's *total maps* line prices whether a Bo3 goes to three, which is
exactly the void risk on a maps 1-3 prop. That was not tested and is worth
testing separately.

**What more books are actually worth** is line disagreement. Two books
pricing the same player differently is signal that does not depend on our
model being right — and our model is near its ceiling. That argues for more
DFS apps, which carry player props, over sharp sportsbooks, which do not.

**Re-examined 2026-09-09, and the second half of that needs qualifying.** It
is true that no sharp book prices player kills — Bovada's esports feed is
three market types wide (moneyline, map spread, total maps) and carries zero
player props, so the OddsJam model of "compare the DFS line to a sharp line
for the same market" has nothing to compare against. Pinnacle access would not
fix that; the market does not exist there either.

What sharp books DO price is the match, and that is not nothing. Total maps
2.5 is the market's probability that a third map happens — which decides
whether a maps-1-3 prop settles at all, and speaks directly to the map-3 over
bias measured at +3.13. Spread and moneyline measure how one-sided the series
is expected to be, and a blowout means fewer rounds and fewer kills for
everyone. Our own opponent-strength feature failed at r = 0.018, but it was
built from box scores; a market-implied mismatch is a different and much
better measurement, and it has never been tried.

### Book reachability, measured

| Book | State |
|---|---|
| **Bovada** | Open, no auth, real prices, and **77 live esports events** covering **61 of 61** of our upcoming CS2 matches (re-measured 2026-09-09). An earlier note here said "four esports events, total, not worth an adapter" — that was sampled at a dead hour and is wrong; it is why this avenue sat unused. Match markets only: moneyline, map spread, total maps. **No player props.** |
| **Pinnacle** | Matchup list open: **131 CS2 matchups**, right down to tier-C qualifiers. Prices return `401 No authorization token provided`. |
| **Sleeper** | **LIVE — the third CS2 book.** Ruled out on 2026-09-10 in error: `sport_info()` was asked for cs2/csgo/lol/val/dota, and Sleeper's code for Counter-Strike is **`cs`**. `GET api.sleeper.app/lines/available` answers with no auth; on 2026-09-11 it carried 222 CS2 props (117 kills, 105 headshots, maps 1-2), every one with a team and both prices, 191 of them joining a PrizePicks/Underdog market. **No LoL.** Adapter: `src/adapters/sleeper.ts`. |
| **ParlayPlay** | Cloudflare bot wall on every path. No unwalled host found (`partner-api`, `api-prod`, `backend` all fail DNS). |
| **Betr, Chalkboard** | No web API at all. `www.betr.app` is a **Webflow marketing site**; chalkboard.io's only call is Tinybird analytics. Mobile apps only. |
| **HotStreak, BetOnline** | Cloudflare wall. |
| **Dabble** | Open JSON, no auth — and still too thin. Re-probed 2026-09-10: **3 CS2 fixtures**, **0 Dota**, **0 Valorant**, and no LoL competition at all, against our 61-match board. A further 14 markets-path shapes tried (20 across two sessions), every one 404. Even if the markets path were found, three fixtures cannot supply a consensus. |
| **Boom, Vivid, Jock MKT, Fliff** | No reachable web API. `production-boom-dfs-backend.boomfantasy.com` does not resolve. |
| **Pick6 (DraftKings)** | Host answers, guessed paths 404. Real endpoint not found. |
| **Rebet** | `api.rebet.app` answers `403 Forbidden`. |
| **Stake** | Cloudflare interstitial on `/_api/graphql`. |
| **Thunderpick, Rivalry** | Re-probed 2026-09-10 on the Bovada precedent, and this time the dismissal holds. Thunderpick answers **403 with a 4.5KB HTML wall** on every path tried. Rivalry's `/api/v1/matches` returns valid JSON with `data: []` — genuinely empty, not a wall — and `/api/sports` is behind Cloudflare. |
| **The Odds API** | Free tier exists, needs a signup key. |

Pinnacle's own web client ships a fixed guest key. Using it to get past that
401 was deliberately **not** done — reading an open endpoint is one thing,
presenting a lifted credential to defeat an auth check is another.


### The third book does not exist — WRONG, corrected 2026-09-11

**This section's headline was false for CS2.** Sleeper was ruled out because
`sport_info()` came back null for the codes that were tried — cs2, csgo, lol,
val, dota. Sleeper calls Counter-Strike `cs`. A research agent found it the next
day, it was verified independently, and it is now polled
(`src/adapters/sleeper.ts`). Everything else below held up on a re-check, and LoL
genuinely still has only two books.

The lesson generalises beyond this one book: **a negative probe built on a
guessed identifier proves nothing.** Check the vendor's own vocabulary before
writing "settled".

Two things about Sleeper worth knowing before leaning on it:

- **Its prices track Underdog's closely.** Where both post the same line their
  devigged probabilities are within about a point; where the lines differ,
  Sleeper leans toward Underdog's number 29 times in 33. A three-book CS2
  consensus is closer to two opinions than three.
- **It names every player's team and prices both sides**, which Underdog does
  not. That is worth more to the stack builder than the extra line.

Full research: `docs/BOOKS.md`.


Settled 2026-09-10 after probing every remaining candidate. **There is no third
DFS book carrying esports player props that is reachable from a server.**

| Ruled out | How |
|---|---|
| Sleeper | Carries no esports. Its own `app_info` and `sport_info()` say so, unauthenticated. |
| Dabble | Open, but 3 CS2 fixtures and no LoL. 20 markets-path shapes tried, all 404. |
| Thunderpick, ParlayPlay, HotStreak, BetOnline, Stake | Cloudflare / 403 HTML wall. |
| Rivalry | Answers with a genuinely empty `data: []`. |
| Pick6 | Host answers, every guessed path 404s. |
| Betr, Chalkboard, Boom, Vivid, Jock MKT, Fliff | Mobile apps only; no web API, and some hosts do not resolve. |

One caveat on method: the probe used a plain browser user-agent and a JSON
accept header, and **the Underdog control came back 426 Upgrade Required** —
the shipped adapter reaches it fine, so the probe is a weak instrument for any
book needing specific headers. A 403 above is strong evidence of a wall; it is
not proof that no header set gets through.

**The one avenue never tried is a mobile app's own API.** Betr, Chalkboard,
Boom, Vivid and HotStreak all talk to some backend, and a phone app's endpoint
is often *more* open than the web one because it never meets a browser
challenge. Getting at it means proxying the phone once (HTTP Toolkit or
mitmproxy, CA installed on the device), reading the endpoint and auth shape,
then talking to it from the logger. Before spending that effort on any given
app, check it actually lists CS2 or LoL props — Sleeper looked promising for
weeks and carries none.

### What to do with two books instead

Since a three-book consensus cannot be assembled, the consensus module in
`src/web/consensus.ts` stays dark. It is correct and tested and it will light
up if a third book ever lands, but it is not a plan for now.

The two-book move that DOES work rests on an asymmetry already in the data:
**Underdog publishes genuine two-sided American odds and PrizePicks does not.**

Two books cannot vote, because a line difference is symmetric — nothing in
"28.5 versus 30.5" says which is wrong. But it stops being symmetric the moment
one of them states a probability. `devig()` already turns Underdog's -112/-112
into a fair chance for each side, and that is a *market* estimate rather than
one of ours. Anchoring to it and then asking what PrizePicks' different line is
worth gives a direction that never touches the projection.

Crucially, and unlike the three-book consensus, **this is backtestable on data
already logged** — both books' snapshots go back to the start of logging.

**One correction worth keeping.** I first assumed this only worked on the thin
slice where Underdog's two prices differ, since 397 of its 434 priced markets
sit at a flat -112/-112. That was wrong, and it nearly killed the idea. A
book's LINE is its own 50/50 point, so flat vig does not mean "no
information" — it means the information is entirely in where they put the
number. Underdog anchors all 434 markets; the price only refines the 37 where
it leans. Built 2026-09-10 as `consensus.fairLine`, which returns a crowd
consensus where one exists and falls back to the priced book otherwise, so a
third book would need no further rewrite.


### Aggregators: the OddsJam model, and what it can and cannot give us

Probed 2026-09-10. Every aggregator answers with a clean **401/403 auth gate,
not a wall** — these are signup-and-get-a-key services, which is how OddsJam
actually works. It does not scrape a hundred books one at a time; it consumes
feeds. Two are worth knowing about, and they answer different questions.

| | Esports? | Player props? | Access |
|---|---|---|---|
| **OddsPapi** | Yes — CS2, LoL, Dota | **No.** Match markets only | **Free tier**, key by signup |
| **PandaScore** | Yes, esports-native | **Yes** — CS:GO player markets | B2B, sales contact, paid |
| The Odds API | **No esports at all** | — | — |
| OpticOdds, SportsGameOdds, Abios | gated, unverified | unverified | key required |

**The Odds API is out.** Its own sports list covers NFL through lacrosse and
politics, and contains no esports title at all. Do not spend a signup on it.

**PandaScore is the only route to a genuine player-prop second opinion.** It is
esports-native, was one of the first to launch esports player props, and its
CS:GO player markets rank top-5. Note carefully *what it is*: PandaScore
**produces** odds with its own trading team and computer-vision models — it is
a pricing supplier to bookmakers, not an aggregator of their lines. For our
purpose that is arguably better than another soft DFS app, because it is a
professionally modelled price for the exact market we care about. It is also a
sales conversation and a real budget line.

**OddsPapi is free and reachable today**, but match markets only — no player
props. `https://api.oddspapi.io/v4`, key as an `apiKey` query parameter,
historical odds included on the free tier, and its book list includes
**Pinnacle** along with Bet365, Stake, 1xBet and Polymarket. Verified live:
every path returns a well-formed `MISSING_API_KEY` JSON error, so the service
exists and behaves.

#### What a free Pinnacle match line is actually worth here

Match markets do not price a player. They do price two things this project has
written down as untested and valuable:

1. **Total maps 2.5 is the market's probability that a third map happens** —
   which is exactly the void risk on a maps 1-3 prop, and the runbook has
   flagged that as "not tested and worth testing separately" since 2026-09-09.
   It also bears on the map-3 over bias measured at +3.13.
2. **Moneyline and handicap measure how one-sided a series is expected to be**,
   and a blowout means fewer rounds and fewer kills for everyone. Our own
   opponent-strength feature failed at r = 0.018 — but it was built from box
   scores, and a *market-implied* mismatch is a different and much better
   measurement that has never been tried.

So the free key buys two experiments that are already on the list, from a sharp
book rather than from our own history. It does not buy a consensus on kills.

**To use it:** sign up for a free key at oddspapi.io, put it on the logger as
`ODDSPAPI_KEY`, and the adapter can be written against the real payload. No
adapter has been written yet, deliberately — writing a parser for a payload
nobody has seen is how the Sleeper work nearly went wrong.

### Line movement: real information, but not a winning bet

Measured 2026-09-08 over 2,101 snapshots and 316 markets priced by both
books. Looked at every moment one book moved its line while the other had
not yet — 147 such events:

| What the lagging book did next (6h) | |
|---|---|
| **Followed the same direction** | 39 (26.5%) |
| Moved the opposite way | 6 (4.1%) |
| Never moved at all | 102 (69.4%) |

**When the lagging book responds at all, it agrees with the leader 39 to 6 —
about 6.5 to 1.** Line moves carry real directional information. And 69% of
the time the other book simply never catches up, leaving a median **1.0 stat
unit** gap standing.

Neither book clearly leads (PrizePicks moved first 63 times, Underdog 84), so
this is not "follow Underdog" — it is "follow whichever one moved."

This matters because it needs **no projection at all**. Four modelling ideas
have now failed to beat a player's flat average; this one sidesteps the model
entirely.

#### …but the stale side does not win. Measured 2026-09-08.

The obvious next question — does taking the stale line actually make money? —
now has settled outcomes behind it. Every moment one book moved while the
other sat on a number on the cheap side of that move, settled against what
the player actually did:

| | Record | |
|---|---|---|
| **Take the move's direction at the lagging book's stale line** | 41–41 | **50.0%** |
| Take the same direction at the mover's own new line | 35–49 | 41.7% |

149 events, 86 settled, across **49 independent player-matches**. Exactly a
coin flip. The standard error is 5.5 points on decided legs and nearer 7 on
independent matches, so this rules out a *large* edge, not a small one — but
there is nothing here to bet on.

So the 6.5-to-1 agreement figure above is real and it is about **book
behaviour**: a move predicts what the other book will print, not what the
player will do. Those are different claims and only the first survived.

**This does not close off consensus pricing** — see "Consensus across books"
near the top of this file. What failed here was *movement* as a proxy for
direction, which was the only direction available with two books. Where a book
sits relative to a CROWD is a different question and was never testable at two. The
board still shows the disagreement, because a standing 1.0-unit gap is worth
knowing when choosing where to place a bet you were making anyway — it is
labelled as an observation, and must not be dressed up as an edge.

Re-run it as outcomes accumulate — 49 matches is thin:

```bash
npm run validate:stale
```


### GRADED: the market-anchored edge does not win either

Run 2026-09-10 against production with `npm run validate:consensus`. This is
the fourth signal to be measured here and the fourth to fail.

```
markets 1715, priced by 2+ books 542, by 3+ books 0
settled legs 205 (7 pushed, 86 unsettled)
market side            106-99   51.7%

by gap        0.5-0.9   57-41   58.2%   (98 legs)
              1.0-1.9   48-57   45.7%   (105 legs)
              2.0-2.9    1-1    50.0%   (2 legs)
by league     CS2       95-89   51.6%   (184 legs)
              LOL       11-10   52.4%   (21 legs)
by what UD said   flat vig      73-57  56.2%   series 58-46, p = 0.281
                  stated lean   33-42  44.0%   series 30-37, p = 0.464

independent series 147
series the market side led  74-73
exact two-sided sign test   p = 1.000
```

**74-73 is as dead as a result gets.** But the two supporting numbers matter
more than the headline, because they say the idea is wrong rather than merely
unproven:

1. **A bigger gap does WORSE.** 58.2% at 0.5-0.9 units against 45.7% at 1.0-1.9.
   If being further from the market's fair line meant anything, this would run
   the other way. It is the strongest single piece of evidence against.
2. **The arm that should have been strongest was the worst.** Where Underdog
   states an actual lean rather than flat -112/-112, it went 30-37 by series —
   below even. Flat vig, where the "signal" reduces to "PrizePicks disagrees
   with Underdog", was the only arm above water at 58-46, p = 0.281, and that is
   the same disagreement the stale-line work already measured at 41-41.

Do not read the 58.2% or the flat-vig 56.2% as an edge hiding in a subgroup.
Both are leg-level, both are inside a null overall result, and the gap
direction contradicts them.

**Scoreboard so far — four measurements, four failures:**

| Signal | Result |
|---|---|
| The projection's own calls | 52.0%, **AUC 0.495** — no ordering to calibrate |
| Opponent strength | r = 0.018 — nothing |
| Stale line (one book moved) | 41-41, **50.0%** |
| Market-anchored edge | 74-73 series, **p = 1.00** |

The board keeps the cell, labelled with its measurement, for the same reason it
keeps the stale chip: knowing which app holds the cheaper number is worth
something when placing a bet you had already decided to make. It is not a
reason to make one.

### OddsPapi, with a key: no esports player props

Checked 2026-09-10 with a real free-tier key, five requests total, all cached
under `raw/oddspapi-cache/` so a re-run costs nothing.

Every market row carries a `playerProp` boolean, so this is exact rather than a
keyword guess:

| sportId | | markets | player props |
|---|---|---|---|
| 17 | ESport Counter-Strike | 28 | **0** |
| 18 | ESport League of Legends | 28 | **0** |
| 10 | Soccer (control) | 1122 | 80 |

Player props exist in this feed only for American Football (1243), Cricket
(672), Basketball (440), Ice Hockey (214), Baseball (122) and Soccer (80).
**None for any esport.** The `playerId` parameter on the historical-odds
endpoint is generic plumbing, not esports coverage — that is what made the
reference docs look more promising than the blog.

**The free tier is 250 requests a MONTH**, so this can never be a polling
source. Treat it as a research budget for one-off pulls, and cache everything.

What CS2 and LoL *do* have is exactly the two match-level markets this runbook
has had on the untested list since 2026-09-09:

- `marketId 173` — **Total Maps Over Under 2.5**. The market's probability that
  a third map happens, which is the void probability on a maps 1-3 prop.
- `marketId 1717-1745` — **Maps Handicap**, and `171` Winner. Market-implied
  mismatch, which is the version of opponent strength that has never been
  tried; the box-score version died at r = 0.018.
- `marketId 1747-1755` — per-map winners, including **Third Map Winner**, which
  bears directly on the map-3 over bias measured at +3.13.

A void is not a small effect on slip maths: it returns the stake and changes
what every other leg needs. That is worth the request budget in a way another
attempt at predicting kills is not.

### Does the board's own "Take" win? No — and the honest n is tiny

```bash
npm run validate:calls
```

Replays every market we logged a pre-match line for through the real
`evaluate()`, using only the stat history that existed before that match
started, then scores it against what happened. Run 2026-09-08 over 527
settled markets:

| | Record | |
|---|---|---|
| **The model's own picks** | 168/323 | **52.0%** |
| baseline: always take the over | 218/520 | 41.9% |
| baseline: always take the under | 302/520 | 58.1% |

It claimed an average of 60.3% and delivered 52.0% — **8.3 points of
overconfidence**, and claimed EV of 13.9% per bet against 1.1% realised.

**The decisive number is AUC 0.495.** That is the chance a winning call
carried a higher predicted probability than a losing one, and 0.500 is no
skill at all. This is not miscalibration — miscalibration is fixable by
shrinking every number toward 0.5. It says the ranking carries no information:
a call the model rates 75% wins no more often than one it rates 56%. The
calibration table shows the same thing from the other side, with the 75-80%
bucket realising 38%.

**But do not act on the 58% under baseline either.** Those 520 legs come from
**17 series across 3 days**. Every player in a series shares its length, its
overtime and its pace, so a single long map sends everyone over at once —
the legs are not independent trials and a leg-level z-score is meaningless
here. Asked once per series, the under lean is **12 of 16 series, two-sided
p = 0.077**: suggestive, not significant. The model's own calls led in **8 of
17 series, p = 1.000**.

This is the third time this project has been fooled by treating correlated
legs as a sample. Leg-level z-scores were removed from the script's output
for that reason; it prints the series count and an exact sign test instead.

The map-range split is worth keeping in view, because the shade is not one
direction:

| Map range | Under rate | mean(total − line) | Series behind it |
|---|---|---|---|
| maps 1-2 | 61.9% | −1.51 | 17 |
| map 3 only | 26.8% | **+3.13** | **3** |

Map 3 running hard over has an obvious mechanism — map 3 is only played when
the series is 1-1, and those maps ran a median 28 rounds against 19 for maps
1-2, so everyone's kill total inflates together. That also means the 56 legs
behind it are close to 3 observations. Do not build on it yet.

**A shade like this can never be backtested.** Book lines only exist in our
database from the day the logger started; there is no historical line data to
buy or scrape. Anything found here can only be confirmed *forward*, by
letting the logger accumulate more series. That is a structural constraint on
this whole line of work, not a temporary gap.

### The scorecard runs itself, daily

The replay above is not a thing to remember to run. It is on a schedule, and
one row per day lands in `model_score`:

```bash
npm run validate:calls           # print it
npm run validate:calls -- --store  # print it and store today's row
```

`SCORE_CRON` (default `47 5 * * *`) runs it in the logger, just after the
daily CS2 sweep so it scores against results the sweep has only just landed.
The Stats page reads the table rather than recomputing — the replay touches
every settled market and every stat row for the players in them, which is far
too slow for a page load.

The page leads with **AUC**, not the hit rate, and prints both no-model
baselines beside it, because a hit rate means nothing until you know what
doing nothing would have scored. Watch the gap between the dashed
"predicted" line and the solid "realised" one: that gap is the
overconfidence, and it is the thing that should shrink if the model ever
starts working.

To see the page without a database, render it from fixtures:

```bash
npx tsx raw/harness/genstats.ts    # writes raw/shots/stats*.html
npx tsx raw/harness/shootscore.ts  # screenshots, checks for overflow
```

That covers the two states production hides for weeks — the empty table, and
the single stored day where no polyline can be drawn.

### Modelling ideas that were measured and failed

All walk-forward over CS2 maps-1-2 series, scoring only on history that
existed before the series being predicted. Recorded so they are not retried.

| Idea | Result |
|---|---|
| **Opponent strength** | Worse. MAE 6.56 vs 6.49 flat; correlation between the opponent effect and the residual it should explain was **r = 0.018** over 4,403 predictions. Kills are close to conserved in CS2. |
| **Recency weighting** | Worse, and monotonically. Flat Brier 0.2415; half-life 20 → 0.2417, half-life 10 → 0.2428, half-life 5 → 0.2463, half-life 3 → **0.2523, worse than a coin flip**. Chasing recent form is fitting noise. |
| **Magnitude (kernel-smoothed CDF)** | Better, but by 0.0005 Brier, and the bandwidth is scale-dependent. Not shipped — see the note in `projection.ts`. |
| **More history (20 → 30 series)** | Shipped. Same Brier, better MAE on the total (6.37 vs 6.43). Past 40 the gain is gone. |

**No stat type is softer than another.** Every experiment above was CS2 kills,
so the same walk-forward was run per stat. On absolute offsets assists looked
far more predictable (Brier 0.2164 against kills' 0.2415) — but that was the
offsets, not the market: ±2.5 is 0.68 of a standard deviation on assists and
0.32 on kills, so the fixed number handed the tighter stat an easier question.
Scaled to each stat's own spread, they collapse into each other:

| | Brier (spread-relative) |
|---|---|
| kills | 0.2398 |
| headshots | 0.2394 |
| assists | 0.2389 |
| deaths | 0.2390 |

A range of 0.0009 across four markets. **Do not go hunting for a soft stat.**
Note the shape of that mistake — a fixed absolute threshold compared across
different variances — because it is the third time it has produced a false
signal here, after `MIN_EDGE` and the kernel bandwidth.

The pattern across all four: **a CS2 player's own flat long-run average is
hard to beat, and the book knows it too.** Every estimator tried lands
between Brier 0.2410 and 0.2427 against 0.25 for a coin flip. Projection is
not where an edge lives. Line disagreement between books is — which is the
argument for more books, and against more modelling.

### Dead ends — do not re-test

- **PandaScore free**: fixtures only; every stats endpoint 403s. Paid
  Historical tier is **€400/mo per game**, and their terms say stats plans are
  **only sold for non-betting use**. The token in `.env` as `PANDASCORE_TOKEN`
  is fine for fixtures and rosters if we ever want them.
- **Esportal**: fully open API, has the right tournaments (PGL Wallachia OQ SA
  / EEU / SEA), but every match returns `kills:0, deaths:0, headshots:0`. It
  only tracks brackets for events played on organizer servers.
- **Liquipedia**: no player stats anywhere in match wikitext — but it does
  carry `|stats=<HLTV mapstatsid>` per map, so it's a free tier-C *index*.
  Needs gzip + a descriptive User-Agent or it 406s.
- **csstats.gg, Esports Charts**: Cloudflare 403. **Leetify**: no public API.
  **HLTV community mirrors**: all dead against current Cloudflare.
  **SportDevs**: DNS doesn't resolve. **GRID Open Access**: free to apply but
  rights are per-tournament, so tier-1 only in practice.
  **Abios / Sportradar**: $2,000-10,000/mo, enterprise.
- **bo3.gg's per-round endpoints**: `game_rounds` really is per-**team** only.
  That earlier finding was right; the mistake was concluding from it that the
  whole site had no per-player stats. It does — under `players_stats`, which
  the match page calls and the round data does not lead you to.

## Grading

```bash
npm run grade              # fetch results, then grade anything gradeable
```

Runs automatically on the worker (`RESULTS_CRON`, twice an hour). Safe to run by
hand any time.

**CS2 grading no longer needs a browser.** It reads bo3.gg's JSON, so it runs
in the Railway container exactly as it does locally, and Chromium is no longer
a deployment decision anyone has to make. What remains is patience: stats
appear 7.5 to 33 hours after a match ends, so CS2 picks sit `pending`
overnight and grade on a later run. A pick with no stat line yet is left
pending rather than marked ungradeable, so nothing is lost by waiting.

## The logger

Runs itself on Railway every 15 minutes. Nothing to do.

```bash
railway logs --service bropprop-logger
railway ssh --service bropprop-logger npm run report
```

Run those from `C:\BropProp` so the project link resolves.

## Deploys

Push to `main` and Railway redeploys both services. Migrations run on boot and
are applied exactly once, so redeploys are safe.

## Where things live

- `map_stat` — every per-player, per-map stat line, from any source
- `pick` / `slip` — what was taken, at the line it was taken at
- `prop` / `prop_snapshot` — what the books offered, and every time it moved
- `result_run` / `poll_run` — audit of every fetch, so a job that quietly stopped
  is visible

## Payout tables — unset on purpose

The app quotes no slip payout, EV or break-even until someone tells it what the
books actually pay. That is deliberate. The tables used to be hardcoded —
PrizePicks `{2:3, 3:5, 4:10, 5:20, 6:37.5}`, Underdog `{2:3, 3:6, 4:10, 5:20}`,
plus power/flex/single for the slip panel — written when both books paid a flat
rate by leg count. Neither does now:

- **PrizePicks prices per prop.** Its live board is mostly demon and goblin
  (measured 2026-09-08: standard 4,721, demon 19,305, goblin 5,515) and the
  multiplier for those appears **nowhere in the API**. The payload carries
  `odds_type`, `is_promo`, `flash_sale_line_score`, `adjusted_odds` and
  `allowed_wager_types` — no payout figure at all. It is applied when the slip
  is built in their app.
- **Underdog prices per side**, and that one we do capture:
  `over_multiplier` / `under_multiplier` per prop, 670 of 720 upcoming markets
  at 1.0 and the rest spread 0.87–1.09. Those keep working regardless.

A stale table is worse than none, because every EV built on it is confidently
wrong rather than visibly missing — so the default is unknown and the Build
page says "payout not known for this book — read the multiplier off the app
before staking".

To switch it back on, set one env var on the logger and the dashboard:

```bash
railway variables set 'PAYOUT_TABLE={"prizepicks":{"2":3,"3":5},"underdog":{"2":3,"3":6},"power":{"3":5},"flex":{"3":2.25}}' \
  --service bropprop-dashboard --environment production
```

Keys are either a book (`prizepicks`, `underdog`) or a slip type (`power`,
`flex`, `single`); values are base payout by leg count. Malformed JSON logs a
warning and leaves everything unknown rather than half-configured. Underdog's
per-leg multipliers multiply on top of the base and need no configuration.

Check the numbers against the app before entering them, and re-check when a
book changes its table — nothing here can detect that it has gone stale.

### Why the Build page asks what a slip NEEDS

Researched 2026-09-08. PrizePicks publishes no payout multiplier anywhere
reachable:

- the projections payload has no payout attribute, no payout object in
  `included` (`new_player`, `stat_type`, `league`, `game`, `team`, `duration`,
  `projection_type`) and no payout relationship (`duration`, `game`, `league`,
  `new_player`, `projection_type`, `score`, `stat_type`)
- `adjusted_odds` is a boolean flag, not a value
- `/payout_tables`, `/multipliers`, `/payouts`, `/wager_types`, `/configs`,
  `/settings` and `/projection_types` all 404 on partner-api

It is applied client-side when the slip is built, per prop. So no table we
could store would stay correct, and entering one would only make the app
confidently wrong.

The question is therefore inverted. **`1 / P(all legs win)` is the multiplier
at which an entry breaks even.** It needs nothing from the book, cannot go
stale, and is the whole decision: compare it against the number the app is
showing and take the slip only if the app pays more.

Setting `PAYOUT_TABLE` still works and adds the EV reading back for books whose
table you trust — Underdog's per-side multipliers already ride on top of it.
But nothing needs it any more, which is why it stays empty by default.
