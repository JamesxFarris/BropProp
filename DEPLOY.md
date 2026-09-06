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
   `${{Postgres.DATABASE_URL}}` is a Railway reference variable — it resolves to
   the **private** `postgres.railway.internal` host, which keeps the database off
   the public internet and off your egress bill.
4. Deploy. `npm start` runs the migration and then the scheduler; migrations are
   idempotent, so redeploys are safe.

There's no `PORT` and no healthcheck because this service serves no HTTP. That's
expected for a worker — Railway won't hold it against you.

**Watch the first deploy for:** `poll start`, then a `prizepicks:` and an
`underdog:` line. If Postgres refuses TLS, set `DATABASE_SSL=false` (private
networking doesn't use TLS; `src/db.ts` infers this but the override is there).

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
- **Poll cadence vs. rate limits.** PrizePicks 429s readily. 15 minutes across
  two leagues is comfortable; don't drop below ~5 minutes without watching
  `poll_run.http_status`.

## Alternatives, briefly

| | Verdict |
|---|---|
| **Fly.io** | Cheaper for always-on and fine technically, but you manage Postgres yourself. Worth it only if the bill grows. |
| **Render** | Equivalent to Railway; its free tier sleeps, which silently destroys the history. Paid tier only. |
| **$5 VPS + `docker compose`** | Cheapest and most control — `docker-compose.yml` in this repo nearly does it already. Costs you ops time (backups, updates, TLS) that Railway absorbs. |
| **Vercel / serverless** | Wrong shape. No long-lived process, and cron invocations would need the scheduler rebuilt around them. |

Start on Railway. If it ever gets expensive, the container moves anywhere —
nothing here is Railway-specific except the reference variable.
