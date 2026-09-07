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
npm run backfill:cs2 3     # crawl 3 pages of HLTV results (~300 matches)
```

Works, resumable, skips matches already stored. But **measure before you wait
on it**: of 30 recent HLTV results, exactly one carried per-map player stats,
and none of its players were on our board. HLTV publishes stats only for
matches whose demos it parsed, which skews to big events, while the props we
price are mostly tier-C qualifiers. Expect roughly a 3% hit rate.

Run it as an accumulator if you like — it is cheap on re-runs and catches what
does appear. It will not build a season of history.

**The honest fix is a stats API.** PandaScore has a free developer tier
covering CS2 with player match stats; it needs an account and a key. That is
the one outstanding decision for CS2 form.

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
