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
