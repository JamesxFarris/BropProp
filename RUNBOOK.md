# Runbook

Things that are built but need running by hand, and the reasons behind how they
run. Written so it makes sense cold, with no memory of the session that built it.

## Backfill player history (do this when you get home)

Two sources, deliberately split by job:

| | Source | Job | Rate limits |
|---|---|---|---|
| **Bulk history** | Oracle's Elixir | months/years of past games | none |
| **Today's results** | Leaguepedia | games that finished minutes ago | brutal |

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

### 3. CS2 history — measured, and HLTV is not the answer

```bash
npm run backfill:cs2       # one pass over HLTV's current results page
```

Resumable and cheap on re-runs, but it is an **accumulator, not a backfill**.
Two measured limits:

- **Coverage.** Of 30 recent results, one carried per-map player stats, and
  none of its players were on our board. HLTV publishes stats only for matches
  whose demos it parsed, which skews to big events; our props are mostly
  tier-C qualifiers.
- **Depth.** Only the first results page is reachable. `/results` serves fine,
  `/results?offset=100` returns a Cloudflare challenge, so the archive can't be
  walked backwards.

Run it daily and it collects what appeared since yesterday. It will not build
a season.

**PandaScore's free tier does not solve this** — tested 2026-09-07 with a real
token. List endpoints work (matches, players, teams, both CS2 and LoL, 1000
requests/hour) but every stats endpoint is 403: `/games/{id}`,
`/matches/{id}`, `/players/{id}/stats`. Per-map player stats are a paid
feature. The token is in `.env` as `PANDASCORE_TOKEN` and is fine for
fixtures and rosters if we ever want them.

**So CS2 form needs either a paid feed or patience** — the accumulator plus
grading builds history for the teams we actually bet, just slowly.

## CS2 stats — the open ideas, ranked

Nothing here is started. Everything below was tested or priced on 2026-09-07;
pick one up when you have time and don't re-test the dead ends.

### 1. FACEIT Data API — free, blocked on identity verification

Free per-map player stats including headshots, via
`GET /matches/{id}/stats` → `rounds[]` (one per map) → `teams[] → players[] →
player_stats`. Covers matches played **on the FACEIT platform**: ESEA League
(Advanced/Main), organizer championships, open qualifiers — genuine tier-C
depth HLTV never parses. Won't cover South American or CIS qualifiers run off
platform.

**Blocked on:** FACEIT requires document upload and their anti-cheat installed
before issuing a key. Key comes from developers.faceit.com → create an app →
API Keys → **server-side** key.

**Do when:** you're at home and willing to do the verification. Cheapest real
win available.

### 2. BALLDONTLIE CS2 — $39.99/mo, 48-hour free trial

Has a literal `player_match_map_stats` endpoint: kills, deaths, assists, adr,
kast, rating, headshot_percentage, first_kills, clutches, keyed by
`match_map_id`. Base `https://api.balldontlie.io/cs/v1/`.

Free and $9.99 tiers do **not** include matches or player stats — only the
**GOAT tier at $39.99/mo** does. Ten times cheaper than PandaScore for the same
data shape.

**Coverage is undocumented**, which is the whole risk. **Do this first, it's
free:** take the 48-hour GOAT trial, query `/tournaments` for a tier-C or
regional qualifier, then `player_match_map_stats` for one of its maps. That one
test answers whether $40/mo solves the problem. Card required for the trial.

### 3. Parse the demos yourself — free, full control, real build

The route nobody can revoke. `api.bo3.gg/api/v1/games/{id}` returns a
**`demo_url`** on finished games, and matches carry **`tier: "c"`** — so tier-C
matches can be enumerated straight from their free API and joined to games.
Verified present continuously from 2023 to now, on exactly our tier of teams
(Sinners, Quazar, Omega, zwaw).

Parse with **awpy 2.x** (wraps `demoparser2`); it computes ADR and KAST
natively. Everything else we need is per-round events.

**Unresolved:** the demo CDN base. `bo3.gg/api/demo/...` returns "Invalid API
path", and cdn/static/s3 guesses all 404. **Five-minute job:** open a bo3.gg
match page, click the demo download button with devtools open, and read the
real URL (it may be a signed-URL endpoint).

**Cost:** compute and storage, not licensing. Highest ceiling, highest effort.

### 4. Keep accumulating — already running

`npm run backfill:cs2` runs daily on Railway at 05:23 and collects whatever
HLTV parsed since yesterday for players we price. It cannot build history but
it is free and already automatic. Grading also stores stats for every CS2 match
you actually bet, so history builds fastest for the teams you care about.

### Dead ends — do not re-test

- **PandaScore free**: fixtures only; every stats endpoint 403s. Paid
  Historical tier is **€400/mo per game**, and their terms say stats plans are
  **only sold for non-betting use**.
- **Esportal**: fully open API, has the right tournaments (PGL Wallachia OQ SA
  / EEU / SEA), but every match returns `kills:0, deaths:0, headshots:0`. It
  only tracks brackets for events played on organizer servers.
- **bo3.gg for stats**: per-round per-**team** only, never per-player. Its
  value is `demo_url` and `tier`.
- **Liquipedia**: no player stats anywhere in match wikitext — but it does
  carry `|stats=<HLTV mapstatsid>` per map, so it's a free tier-C *index*.
  Needs gzip + a descriptive User-Agent or it 406s.
- **csstats.gg, Esports Charts**: Cloudflare 403. **Leetify**: no public API.
  **HLTV community mirrors**: all dead against current Cloudflare.
  **SportDevs**: DNS doesn't resolve. **GRID Open Access**: free to apply but
  rights are per-tournament, so tier-1 only in practice.
  **Abios / Sportradar**: $2,000-10,000/mo, enterprise.

### Older notes on CS2 history

HLTV serves per-map kills to a real browser, and `npm run grade` already uses
that for matches you hold picks on. But **player history is another matter**:
HLTV's `/stats/` section returns 403 even in a browser, so there's no per-player
history endpoint to crawl. Options if you want CS2 form:

- crawl match pages for teams you care about and accumulate over time (slow but
  free, and the grader is already doing a little of this)
- a paid API with CS2 player stats (PandaScore has a free dev tier)

CS2 **headshot** props can't be graded at all for the same reason — headshots
only exist under `/stats/`. Those report `ungradeable` with that reason rather
than being scored from a guess.

## Grading

```bash
npm run grade              # fetch results, then grade anything gradeable
```

Runs automatically on the worker (`RESULTS_CRON`, twice an hour). Safe to run by
hand any time.

**CS2 grading needs a browser.** It works locally because Playwright is
installed here; on Railway it fails with a clear message and the run is recorded
in `result_run` as failed. To turn it on in production, the container needs
Chromium — that's an unmade deployment decision, not a bug.

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
