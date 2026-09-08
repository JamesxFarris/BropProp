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
