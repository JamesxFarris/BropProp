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

### Book reachability, measured

| Book | State |
|---|---|
| **Bovada** | Open, no auth, real prices — but **four esports events, total**. Not worth an adapter. |
| **Pinnacle** | Matchup list open: **131 CS2 matchups**, right down to tier-C qualifiers. Prices return `401 No authorization token provided`. |
| **Sleeper** | `sleeper.app/graphql` open, introspection ON, 240 query fields. The DFS board is `my_picks_init` and needs a session. **A login away, not a wall away.** |
| **ParlayPlay** | Cloudflare bot wall on every path. No unwalled host found (`partner-api`, `api-prod`, `backend` all fail DNS). |
| **Betr, Chalkboard** | No web API at all. `www.betr.app` is a **Webflow marketing site**; chalkboard.io's only call is Tinybird analytics. Mobile apps only. |
| **HotStreak, BetOnline** | Cloudflare wall. |
| **Dabble, Boom, Vivid, Jock MKT, Fliff** | No reachable web API. |
| **Thunderpick, Rivalry** | Answer, but returned empty. |
| **The Odds API** | Free tier exists, needs a signup key. |

Pinnacle's own web client ships a fixed guest key. Using it to get past that
401 was deliberately **not** done — reading an open endpoint is one thing,
presenting a lifted credential to defeat an auth check is another.

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
player will do. Those are different claims and only the first survived. The
board still shows the disagreement, because a standing 1.0-unit gap is worth
knowing when choosing where to place a bet you were making anyway — it is
labelled as an observation, and must not be dressed up as an edge.

Re-run it as outcomes accumulate — 49 matches is thin:

```bash
npm run validate:stale
```

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
