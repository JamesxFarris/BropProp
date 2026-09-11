# Deploying the logger

The logger needs to run **continuously** — it's a long-lived worker with an
in-process scheduler (`node-cron`), not a serverless function. Its value is the
unbroken history it accumulates, so uptime matters more than anything else here.

## Railway — yes, it's the right call

For this shape of workload (one always-on worker + one small Postgres, adding a
dashboard service later) Railway is the least-friction option that doesn't
compromise anything. Postgres is one click, services on the same project talk
over private networking for free, and deploys come straight off GitHub pushes.
~$5/month covers all of it; our data volume is trivial because snapshots are
change-detected.

**Setup**

1. railway.app → **New Project** → *Deploy from GitHub repo* → `BropProp`.
2. In the project: **New** → *Database* → **PostgreSQL**.
3. On the app service, **Variables**:
   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   LEAGUES      = CS2,LOL
   POLL_CRON    = */15 * * * *
   ARCHIVE_RAW  = false
   ```
   Also on the logger today: `ODDSPAPI_KEY` (Pinnacle moneylines, pulled daily
   on `ODDS_CRON`, default `31 11 * * *`, capped at `ODDSPAPI_MONTHLY_CAP`,
   default 220) and, optionally, `BACKFILL_DAYS` for the resumable bo3
   backfill. The dashboard is a second service, `bropprop-dashboard`, built
   from the same repo and told apart by `SERVICE_ROLE` (`web`); it needs
   `DASHBOARD_PASSWORD`. Never print these — `railway variables` shows every
   secret in plaintext.
   `${{Postgres.DATABASE_URL}}` is a Railway reference variable — it resolves to
   the **private** `postgres.railway.internal` host, which keeps the database off
   the public internet and off your egress bill.
4. Deploy. `npm start` runs the migration and then the scheduler; migrations are
   idempotent, so redeploys are safe.

There's no `PORT` and no healthcheck because this service serves no HTTP. That's
expected for a worker — Railway won't hold it against you.

**Watch the first deploy for:** `poll start`, then a line per book —
`prizepicks`, `underdog` and `sleeper`. If Postgres refuses TLS, set `DATABASE_SSL=false` (private
networking doesn't use TLS; `src/db.ts` infers this but the override is there).

## Deploying a change

Railway builds both services from `main`. Work happens on a branch, so a deploy
is `git checkout main && git merge --ff-only <branch> && git push origin main`
(allow-listed; no need to ask). Migrations apply on boot. A deploy restarts the
container and kills any job running in it. Reach the container with
`railway ssh --project 707463d9-4970-480f-abec-35397aecbd88 --environment
production --service bropprop-logger` — pass the flags, since the CLI's
per-directory link breaks on a path case flip. More in RUNBOOK, "The logger"
and "Deploys".

## Things that will bite you

- **Raw archiving must stay off.** Underdog's payload is ~15MB; at a 15-minute
  cadence that's ~1.4GB/day onto an ephemeral disk that's wiped every redeploy
  anyway. It now defaults to `false`. If you ever want replayable payloads in
  production, they belong in object storage, not the container.
- **Ephemeral filesystem.** Nothing on disk survives a deploy. All state is in
  Postgres by design — keep it that way.
- **Back up the database.** The whole point of this project is history you
  can't re-fetch. A dropped volume is unrecoverable: you cannot go back and ask
  PrizePicks what a line was last Tuesday. Turn on Railway's backups, or run a
  weekly `pg_dump` somewhere else.
- **Poll cadence vs. rate limits.** Measured: PrizePicks serves roughly **two
  requests per minute** before refusing, and its limiter refills slowly — a 2s
  retry just burns the next token and earns another 429. The adapter waits 10s
  between leagues and backs off 5s/15s/45s. At a 15-minute cadence over CS2 and
  LoL that's three requests an hour, comfortably inside the bucket. Don't drop
  below ~5 minutes without watching `poll_run.http_status`.

## Alternatives, briefly

| | Verdict |
|---|---|
| **Fly.io** | Cheaper for always-on and fine technically, but you manage Postgres yourself. Worth it only if the bill grows. |
| **Render** | Equivalent to Railway; its free tier sleeps, which silently destroys the history. Paid tier only. |
| **$5 VPS + `docker compose`** | Cheapest and most control — `docker-compose.yml` in this repo nearly does it already. Costs you ops time (backups, updates, TLS) that Railway absorbs. |
| **Vercel / serverless** | Wrong shape. No long-lived process, and cron invocations would need the scheduler rebuilt around them. |

Start on Railway. If it ever gets expensive, the container moves anywhere —
nothing here is Railway-specific except the reference variable.
