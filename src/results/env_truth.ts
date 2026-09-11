import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { pool, q } from '../db.js';

/**
 * Who actually won each map — the ground truth the rating study needs and the
 * database does not hold.
 *
 * `map_stat` stores only the players we price, so most maps carry one team or
 * a partial roster, and no winner column exists for either league. Deciding
 * the winner from "more team kills" would compare four players against two.
 * Both sources we already ingest from publish the real result, so this reads
 * it back — network reads only, cached as JSON in the container's /tmp. It
 * writes nothing to the database.
 *
 *  - CS2: bo3.gg `/matches?filter[matches.id][in]=…&with=games`, 100 matches a
 *    request, for every match id in the archive. Each game carries
 *    winner/loser clan names (the same `clan_name` our rows use) and the round
 *    score; the match carries its best-of. Checked by hand 2026-09-11 that the
 *    id filter is honoured (count 2 for 3 ids, one of which is not CS2).
 *  - LoL: Oracle's Elixir season CSVs, TEAM rows only (position = 'team'), for
 *    every game in every league — not only the tracked players' games, so the
 *    ratings see every opponent.
 *
 *   npx tsx src/results/env_truth.ts [cs2|lol|all]
 */

export const CS2_TRUTH = process.env.ENV_CS2_TRUTH ?? '/tmp/env_truth_cs2.json';
export const LOL_TRUTH = process.env.ENV_LOL_TRUTH ?? '/tmp/env_truth_lol.json';

export type Cs2Game = {
  id: number; n: number; w: string; l: string; ws: number; ls: number;
  rounds: number | null; at: string | null;
};
export type Cs2Match = { id: number; bo: number | null; tier: string | null; start: string | null; games: Cs2Game[] };
export type LolSide = { name: string; side: string; result: number; kills: number };
export type LolGame = {
  gameid: string; league: string; date: string; n: number; patch: string;
  len: number; t: LolSide[];
};

const API = 'https://api.bo3.gg/api/v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'BropProp/0.1 (prop research)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

type RawGame = {
  id: number; number: number | null; winner_clan_name: string | null; loser_clan_name: string | null;
  winner_clan_score: number | null; loser_clan_score: number | null; rounds_count: number | null;
  begin_at: string | null;
};
type RawMatch = {
  id: number; discipline_id: number; bo_type: number | null; tier: string | null;
  start_date: string | null; games?: RawGame[];
};

export async function fetchCs2(): Promise<void> {
  const rows = await q<{ id: string }>(
    `SELECT DISTINCT raw->>'match_id' AS id FROM map_stat_dedup WHERE league = 'CS2' AND raw->>'match_id' IS NOT NULL`);
  const ids = [...new Set(rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  console.log(`cs2: ${ids.length} match ids in the archive`);
  const out: Cs2Match[] = [];
  let failed = 0, returned = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const want = new Set(batch);
    const p = new URLSearchParams();
    p.set('filter[matches.id][in]', batch.join(','));
    p.set('page[limit]', '100');
    p.set('with', 'games');
    let page: { results?: RawMatch[] };
    try { page = await getJson(`${API}/matches?${p}`); } catch (e) {
      failed += batch.length; console.warn(`  batch at ${i}: ${(e as Error).message}`); continue;
    }
    for (const m of page.results ?? []) {
      // bo3.gg answers an unknown filter with the unfiltered list, so every
      // row is re-checked against what was asked for.
      if (!want.has(m.id) || m.discipline_id !== 1) continue;
      returned++;
      const games: Cs2Game[] = [];
      for (const g of m.games ?? []) {
        if (!g.winner_clan_name || !g.loser_clan_name) continue;
        if (typeof g.winner_clan_score !== 'number' || typeof g.loser_clan_score !== 'number') continue;
        games.push({
          id: g.id, n: g.number ?? 0, w: g.winner_clan_name, l: g.loser_clan_name,
          ws: g.winner_clan_score, ls: g.loser_clan_score,
          rounds: typeof g.rounds_count === 'number' && g.rounds_count > 0 ? g.rounds_count : null,
          at: g.begin_at,
        });
      }
      out.push({ id: m.id, bo: m.bo_type ?? null, tier: m.tier ?? null, start: m.start_date ?? null, games });
    }
    if ((i / 100) % 20 === 0) console.log(`  ${Math.min(i + 100, ids.length)}/${ids.length} requested, ${returned} returned`);
    await sleep(150);
  }
  writeFileSync(CS2_TRUTH, JSON.stringify(out));
  console.log(`cs2: wrote ${out.length} matches (${failed} ids in failed batches) to ${CS2_TRUTH}`);
}

const OE_FILES: Record<string, string> = {
  '2022': '1EHmptHyzY8owv0BAcNKtkQpMwfkURwRy',
  '2023': '1XXk2LO0CsNADBB1LRGOV5rUpyZdEZ8s2',
  '2024': '1IjIEhLc9n8eLKeY-yh_YigKVWbhgGBsN',
  '2025': '1v6LRphp2kYciU4SXp0PCjEMuev1bDejc',
  '2026': '1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm',
};
const oeUrl = (id: string) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

/** RFC4180 field splitter (same rule as oracleselixir.ts, which does not export it). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

export async function fetchLol(): Promise<void> {
  const games = new Map<string, LolGame>();
  for (const [year, id] of Object.entries(OE_FILES)) {
    const res = await fetch(oeUrl(id));
    const kind = res.headers.get('content-type') ?? '';
    if (!res.ok || !res.body || /text\/html/i.test(kind)) {
      console.warn(`lol ${year}: HTTP ${res.status} ${kind} — skipped (Drive quota?)`);
      continue;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let head: string[] | null = null;
    let col: Record<string, number> = {};
    let rowsSeen = 0;
    const take = (line: string) => {
      if (!head) {
        head = splitCsv(line);
        col = Object.fromEntries(head.map((h, i) => [h, i]));
        return;
      }
      if (!line.includes(',team,')) return;
      const f = splitCsv(line);
      if (f[col.position!] !== 'team') return;
      rowsSeen++;
      const gid = f[col.gameid!]!;
      const g = games.get(gid) ?? {
        gameid: gid, league: f[col.league!] ?? '', date: f[col.date!] ?? '', n: Number(f[col.game!]),
        patch: f[col.patch!] ?? '', len: Number(f[col.gamelength!]), t: [],
      };
      g.t.push({ name: f[col.teamname!] ?? '', side: f[col.side!] ?? '', result: Number(f[col.result!]), kills: Number(f[col.teamkills!] ?? f[col.kills!]) });
      games.set(gid, g);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) take(l.replace(/\r$/, ''));
    }
    if (buf) take(buf.replace(/\r$/, ''));
    console.log(`lol ${year}: ${rowsSeen} team rows, ${games.size} games so far`);
  }
  const out = [...games.values()].filter((g) =>
    g.t.length === 2 && g.t[0]!.name && g.t[1]!.name && g.t[0]!.result + g.t[1]!.result === 1);
  writeFileSync(LOL_TRUTH, JSON.stringify(out));
  console.log(`lol: wrote ${out.length} complete games (of ${games.size}) to ${LOL_TRUTH}`);
}

export async function main(which = process.argv[2] ?? 'all'): Promise<void> {
  if (which === 'cs2' || which === 'all') await fetchCs2();
  if (which === 'lol' || which === 'all') await fetchLol();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
