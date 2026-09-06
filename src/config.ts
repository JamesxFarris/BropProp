import 'dotenv/config';

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined ? dflt : /^(1|true|yes)$/i.test(v);

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://bropprop:bropprop@localhost:5433/bropprop',
  pollCron: process.env.POLL_CRON ?? '*/15 * * * *',
  leagues: (process.env.LEAGUES ?? 'CS2,LOL,APEX,VAL')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  archiveRaw: bool(process.env.ARCHIVE_RAW, true),
  rawDir: process.env.RAW_DIR ?? './raw',
};
