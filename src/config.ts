import 'dotenv/config';

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined ? dflt : /^(1|true|yes)$/i.test(v);

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://bropprop:bropprop@localhost:5433/bropprop',
  pollCron: process.env.POLL_CRON ?? '*/15 * * * *',
  // Results arrive well after lines settle, and the stat sources rate-limit
  // much harder than the books, so this runs far less often than polling.
  resultsCron: process.env.RESULTS_CRON ?? '17,47 * * * *',
  // A daily CS2 sweep wider than the results run's three-day window. Most
  // matches are parsed within a day and a half of finishing, but a minority
  // take far longer, and once the shorter window slides past them nothing
  // would look again. Cheap to repeat: the stat upsert makes overlap free.
  accumulateCron: process.env.ACCUMULATE_CRON ?? '23 5 * * *',
  // The model's own scorecard, recomputed daily and stored so its record is a
  // tracked series rather than a number re-derived by hand. It replays every
  // settled market through `evaluate()`, which is far too slow for a page
  // load, so it runs here and the Stats page reads the table. Scheduled after
  // the CS2 sweep, so it scores against results the sweep has just landed.
  scoreCron: process.env.SCORE_CRON ?? '47 5 * * *',

  // Deep CS2 backfill, resumed on boot. Off unless set.
  //
  // A deploy replaces the container, so a long backfill cannot survive one —
  // it can only resume. Setting this makes the logger pick the job back up
  // every time it starts, walking only the dated windows not yet recorded in
  // `backfill_chunk`. Set it to 730 and forget it; it costs one chunk per
  // deploy instead of the whole eight-hour walk, and does nothing once every
  // window is done.
  backfillDays: Number(process.env.BACKFILL_DAYS ?? 0),
  backfillChunkDays: Number(process.env.BACKFILL_CHUNK_DAYS ?? 30),
  leagues: (process.env.LEAGUES ?? 'CS2,LOL')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  // Defaults OFF: Underdog's payload is ~15MB and at a 15-minute cadence this
  // writes ~1.4GB/day, which fills an ephemeral container disk in about a day.
  // Turn it on locally when you want replayable payloads for a backfill.
  archiveRaw: bool(process.env.ARCHIVE_RAW, false),

  // The dashboard writes (it takes props), and on Railway it is reachable by
  // anyone who has the URL. When a password is set the whole app sits behind
  // HTTP basic auth; unset means open, which is fine locally and not in prod.
  dashboardUser: process.env.DASHBOARD_USER ?? 'brop',
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? null,
  rawDir: process.env.RAW_DIR ?? './raw',
};
