import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { canonHandle } from '../normalize.js';

/**
 * Oracle's Elixir season CSVs — the bulk history source for pro League.
 *
 * Leaguepedia is the right source for *today's* results (it updates within
 * minutes of a game finishing) but it rate-limits hard, which makes it a poor
 * way to pull months of history. Oracle's Elixir publishes each season as a
 * single CSV with no rate limiting at all, so backfill comes from here and
 * live grading stays on Leaguepedia.
 *
 * Rows are filtered to players we actually price. A full season is well over a
 * hundred thousand player rows, and a player we have never seen a prop for is
 * weight the projection would never use.
 */

// Drive file ids, read from the public downloads folder. New seasons appear
// there each year; if a year is missing, list the folder and add it.
const FILES: Record<string, string> = {
  '2022': '1EHmptHyzY8owv0BAcNKtkQpMwfkURwRy',
  '2023': '1XXk2LO0CsNADBB1LRGOV5rUpyZdEZ8s2',
  '2024': '1IjIEhLc9n8eLKeY-yh_YigKVWbhgGBsN',
  '2025': '1v6LRphp2kYciU4SXp0PCjEMuev1bDejc',
  '2026': '1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm',
};

const url = (id: string) =>
  `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

/** Minimal RFC4180 splitter: fields may be quoted and contain commas. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

type Row = Record<string, string>;

/**
 * A series key from the two teams and the calendar day.
 *
 * The CSV identifies games, not series, and `game` alone is only a number
 * within an unnamed series. Two given teams play at most one series against
 * each other on a day, so team pair plus date identifies it — and that is what
 * "maps 1-2" has to be counted over.
 */
function seriesKeyFor(league: string, date: string, teams: string[]): string {
  const day = date.slice(0, 10);
  return `oe:${league}:${day}:${[...teams].sort().join('|')}`;
}

async function trackedHandles(): Promise<Set<string>> {
  const rows = await q<{ canon_handle: string }>(
    `SELECT DISTINCT canon_handle FROM player WHERE league = 'LOL'`,
  );
  return new Set(rows.map((r) => r.canon_handle));
}

async function storeBatch(batch: unknown[][]): Promise<number> {
  if (batch.length === 0) return 0;
  for (const p of batch) {
    await q(
      `INSERT INTO map_stat (source, league, series_key, map_number, handle_raw,
                             canon_handle, team, kills, deaths, assists, headshots,
                             played_at, raw, fetched_at)
       VALUES ('oracleselixir','LOL',$1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10, now())
       ON CONFLICT (source, series_key, map_number, canon_handle) DO UPDATE
         SET kills = EXCLUDED.kills, deaths = EXCLUDED.deaths,
             assists = EXCLUDED.assists,
             team = COALESCE(EXCLUDED.team, map_stat.team),
             played_at = COALESCE(EXCLUDED.played_at, map_stat.played_at)`,
      p,
    );
  }
  return batch.length;
}

export async function loadSeason(year: string): Promise<number> {
  const id = FILES[year];
  if (!id) throw new Error(`no Drive file id known for ${year}; add it to FILES`);

  const tracked = await trackedHandles();
  console.log(`loading ${year} for ${tracked.size} tracked LoL players`);

  const res = await fetch(url(id));
  if (!res.ok || !res.body) throw new Error(`oracleselixir ${year}: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let header: string[] | null = null;

  // Rows for one game are contiguous, so a game can be completed and flushed
  // without holding the whole season in memory.
  let curGame = '';
  let curRows: Row[] = [];
  let stored = 0;
  let seen = 0;

  const flush = async () => {
    if (curRows.length === 0) return;
    const teams = [...new Set(curRows.map((r) => r.teamname ?? '').filter((t) => t !== ''))];
    const first = curRows[0]!;
    if (teams.length === 2) {
      const key = seriesKeyFor(first.league ?? 'LOL', first.date ?? '', teams);
      const map = Number(first.game);
      const batch: unknown[][] = [];
      for (const r of curRows) {
        // participantid 100/200 are team summary rows, not players.
        if (r.position === 'team' || !r.playername) continue;
        const canon = canonHandle(r.playername ?? '');
        if (!tracked.has(canon)) continue;
        const int = (v: string | undefined) => (v === '' || v === undefined ? null : Number(v));
        batch.push([
          key, Number.isFinite(map) ? map : 1, r.playername, canon, r.teamname,
          int(r.kills), int(r.deaths), int(r.assists),
          r.date ? `${r.date.replace(' ', 'T')}Z` : null,
          JSON.stringify({ gameid: r.gameid, league: r.league, split: r.split }),
        ]);
      }
      stored += await storeBatch(batch);
    }
    curRows = [];
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      const cells = splitCsv(line);
      if (!header) { header = cells; continue; }
      const row: Row = {};
      header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
      seen++;
      if (row.gameid !== curGame) { await flush(); curGame = row.gameid ?? ''; }
      curRows.push(row);
    }
  }
  await flush();

  console.log(`  ${year}: ${seen} rows scanned, ${stored} stored for tracked players`);
  return stored;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const years = process.argv.slice(2);
  const list = years.length ? years : [String(new Date().getUTCFullYear())];
  let total = 0;
  for (const y of list) total += await loadSeason(y);
  console.log(`done: ${total} stat lines`);
  await pool.end();
}
