import { pathToFileURL } from 'node:url';
import { pool, q } from '../db.js';
import { canonHandle } from '../normalize.js';
import { extractMatch, sleep, UA } from './hltv.js';

/**
 * CS2 player history, crawled from HLTV match pages.
 *
 * There is no history endpoint to ask: HLTV's /stats/ section returns 403 even
 * to a real browser, and bo3.gg's public API exposes matches and maps but no
 * player lines at all. What does work is the results list plus the match pages
 * themselves, which is the same path live grading already uses.
 *
 * So this walks /results backwards and opens each match. That is a real page
 * load per match, so it paces itself and — more importantly — skips matches
 * already stored, which makes the crawl resumable and every later run cheap.
 *
 * TWO MEASURED LIMITS, which together mean this cannot backfill history:
 *
 *  1. Coverage. Of 30 recent results, exactly ONE carried per-map player
 *     stats, and none of its ten players were on our board. HLTV publishes
 *     stats only for matches whose demos it has parsed, which skews to bigger
 *     events, while the props we price are mostly tier-C qualifiers.
 *  2. Depth. Only the first results page is reachable at all — /results serves
 *     fine but /results?offset=100 returns a Cloudflare challenge. There is no
 *     way to walk backwards through the archive.
 *
 * So it is an accumulator, not a backfill: run it daily and it picks up the
 * matches that appeared and got parsed since yesterday, for the players we
 * price. Building a season of history needs a paid stats feed — PandaScore's
 * free tier serves fixtures and rosters but 403s every stats endpoint.
 */

const RESULTS = 'https://www.hltv.org/results';
const GAP_MS = 2500;      // one match page every 2.5s
const RESULTS_GAP_MS = 4000;

type Link = { href: string; id: string };

async function alreadyStored(matchIds: string[]): Promise<Set<string>> {
  if (matchIds.length === 0) return new Set();
  const rows = await q<{ series_key: string }>(
    `SELECT DISTINCT series_key FROM map_stat
      WHERE source = 'hltv' AND series_key = ANY($1)`,
    [matchIds.map((id) => `hltv:${id}`)],
  );
  return new Set(rows.map((r) => r.series_key.replace('hltv:', '')));
}

async function trackedHandles(): Promise<Set<string>> {
  const rows = await q<{ canon_handle: string }>(
    `SELECT DISTINCT canon_handle FROM player WHERE league = 'CS2'`,
  );
  return new Set(rows.map((r) => r.canon_handle));
}

export async function backfillCs2(resultPages = 1): Promise<number> {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('playwright is not installed — CS2 history needs a browser engine.');
  }

  const tracked = await trackedHandles();
  console.log(`crawling HLTV for ${tracked.size} tracked CS2 players`);

  const browser = await chromium.launch();
  let stored = 0;
  let opened = 0;

  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();

    for (let pageNo = 0; pageNo < resultPages; pageNo++) {
      if (pageNo > 0) await sleep(RESULTS_GAP_MS);
      const url = pageNo === 0 ? RESULTS : `${RESULTS}?offset=${pageNo * 100}`;
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

      // Cloudflare serves the first results page but challenges paginated ones,
      // so anything past the first page comes back as an interstitial. Say so
      // rather than reporting a page of zero matches as a quiet success.
      if (res && res.status() === 403) {
        console.warn(
          `  results page ${pageNo + 1}: blocked by Cloudflare (only the first page is reachable) — stopping`,
        );
        break;
      }

      const links: Link[] = await page.$$eval('.result-con a.a-reset', (els) =>
        els.map((e) => ({
          href: e.getAttribute('href') ?? '',
          id: (e.getAttribute('href') ?? '').split('/')[2] ?? '',
        })),
      );

      const fresh = links.filter((l) => l.id);
      const seen = await alreadyStored(fresh.map((l) => l.id));
      const todo = fresh.filter((l) => !seen.has(l.id));
      console.log(
        `  results page ${pageNo + 1}: ${fresh.length} matches, ${seen.size} already stored, ${todo.length} to open`,
      );

      for (const link of todo) {
        await sleep(GAP_MS);
        try {
          await page.goto(`https://www.hltv.org${link.href}`, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
          });
          const parsed = await extractMatch(page);
          const playedAt = parsed.played ? new Date(Number(parsed.played)).toISOString() : null;
          opened++;

          let wrote = 0;
          for (const [idx, m] of parsed.maps.entries()) {
            for (const row of m.rows) {
              const canon = canonHandle(row.handle);
              // Only players we price. A whole tier of pro CS2 goes past on
              // these pages and none of it is weight we would ever use.
              if (!tracked.has(canon)) continue;
              const parts = row.kd.split('-').map((n) => Number(n.trim()));
              const k = parts[0];
              const d = parts[1];
              if (!Number.isFinite(k)) continue;
              await q(
                `INSERT INTO map_stat (source, league, series_key, map_number, handle_raw,
                                       canon_handle, kills, deaths, assists, headshots, played_at, raw)
                 VALUES ('hltv','CS2',$1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8)
                 ON CONFLICT (source, series_key, map_number, canon_handle) DO UPDATE
                   SET kills = EXCLUDED.kills, deaths = EXCLUDED.deaths,
                       played_at = COALESCE(EXCLUDED.played_at, map_stat.played_at)`,
                [`hltv:${link.id}`, idx + 1, row.handle, canon, k,
                 Number.isFinite(d) ? d : null, playedAt,
                 JSON.stringify({ mapStatsId: m.id, kd: row.kd, backfill: true })],
              );
              wrote++;
              stored++;
            }
          }
          if (wrote > 0) console.log(`    ${link.id}: ${wrote} lines`);
        } catch (err) {
          // One bad match page shouldn't end a crawl that has already cost
          // real time; the next run picks it up because nothing was stored.
          console.warn(`    ${link.id}: skipped — ${(err as Error).message.slice(0, 60)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`done: opened ${opened} matches, stored ${stored} stat lines`);
  return stored;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pages = Number(process.argv[2] ?? 3);
  await backfillCs2(Number.isFinite(pages) ? pages : 3);
  await pool.end();
}
