import type { MapStat, FetchStatsResult } from './types.js';
import { canonHandle } from '../normalize.js';

/**
 * HLTV, for CS2 per-map kills.
 *
 * HLTV returns 403 to any plain HTTP client but serves normally to a real
 * browser engine, so this drives Chromium rather than fetching. Playwright is
 * imported dynamically: if the browser isn't installed (as on a stock Railway
 * container) this throws a clear message and the run is recorded as failed,
 * instead of taking the whole worker down.
 *
 * Headshots are deliberately null. They live only under /stats/, which is 403
 * even in a browser, and the grader reports an unsupported stat honestly
 * rather than scoring it from a guess.
 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull every map's player lines out of an open HLTV match page.
 *
 * Shared with the history crawler so the two can't drift: the same page shape
 * feeds live grading and backfill, and a parsing fix should land in both.
 */
export async function extractMatch(page: {
  evaluate: (script: string) => Promise<unknown>;
}): Promise<{ played: string | null; maps: { id: string; rows: { handle: string; kd: string }[] }[] }> {
  return (await page.evaluate(`(() => {
    var el = document.querySelector('.timeAndEvent .date, .time');
    var played = el ? el.getAttribute('data-unix') : null;

    // Each played map has its own stats-content div keyed by HLTV's
    // mapstatsid; "all-content" is the series total and must be skipped or
    // it would double-count every map.
    var divs = Array.prototype.slice
      .call(document.querySelectorAll('.stats-content'))
      .filter(function (d) { return d.id && d.id !== 'all-content'; });

    return {
      played: played,
      maps: divs.map(function (d) {
        return {
          id: d.id.replace('-content', ''),
          // totalstats is the full map; ctstats/tstats are half-splits of it.
          rows: Array.prototype.slice.call(d.querySelectorAll('table.totalstats tr'))
            .map(function (tr) {
              var nameCell = tr.querySelector('td.players');
              var kdCell = tr.querySelector('td.kd.traditional-data') || tr.querySelector('td.kd');
              if (!nameCell || !kdCell) return null;
              // The nickname is the quoted part; the cell repeats it after
              // the full name, e.g. "Santiago 'rzk' Puchetarzk".
              var quoted = (nameCell.textContent || '').match(/'([^']+)'/);
              var handle = quoted ? quoted[1] : (nameCell.textContent || '').trim();
              return { handle: handle, kd: (kdCell.textContent || '').trim() };
            })
            .filter(Boolean),
        };
      }),
    };
  })()`)) as never;
}


type MatchLink = { href: string; id: string; text: string };

/** Match pages are heavy and HLTV is not a public API — take only what's needed. */
export type HltvOptions = {
  /** Only open matches whose title mentions one of these (lowercased) team words. */
  teamHints?: string[];
  maxMatches?: number;
};

export async function fetchHltv(opts: HltvOptions = {}): Promise<FetchStatsResult> {
  const { teamHints = [], maxMatches = 8 } = opts;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'playwright is not installed — CS2 results need a browser engine. Run "npm i -D playwright && npx playwright install chromium".',
    );
  }

  const browser = await chromium.launch();
  const stats: MapStat[] = [];
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();

    await page.goto('https://www.hltv.org/results', { waitUntil: 'domcontentloaded', timeout: 45_000 });

    const links: MatchLink[] = await page.$$eval('.result-con a.a-reset', (els) =>
      els.map((e) => ({
        href: e.getAttribute('href') ?? '',
        text: (e.textContent ?? '').toLowerCase(),
        id: (e.getAttribute('href') ?? '').split('/')[2] ?? '',
      })),
    );

    // Only matches we plausibly hold props for. Without hints this would open
    // every recent result, which is both slow and rude.
    const wanted = links
      .filter((l) => l.id && (teamHints.length === 0 || teamHints.some((t) => l.text.includes(t))))
      .slice(0, maxMatches);

    for (const [i, link] of wanted.entries()) {
      if (i > 0) await sleep(2500);
      await page.goto(`https://www.hltv.org${link.href}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });

      const parsed = await extractMatch(page);

      const playedAt = parsed.played ? new Date(Number(parsed.played)).toISOString() : null;

      parsed.maps.forEach((m: any, idx: number) => {
        for (const row of m.rows as { handle: string; kd: string }[]) {
          const parts = row.kd.split('-').map((n) => Number(n.trim()));
          const k = parts[0];
          const d = parts[1];
          if (!row.handle || k === undefined || !Number.isFinite(k)) continue;
          stats.push({
            source: 'hltv',
            league: 'CS2',
            seriesKey: `hltv:${link.id}`,
            // Map order on the page is the order played, which is what
            // "Maps 1-2" refers to.
            mapNumber: idx + 1,
            handleRaw: row.handle,
            team: null,
            kills: k,
            deaths: d !== undefined && Number.isFinite(d) ? d : null,
            assists: null,
            headshots: null, // only under /stats/, which is 403 even in a browser
            playedAt,
            raw: { mapStatsId: m.id, kd: row.kd },
          });
        }
      });
    }
  } finally {
    await browser.close();
  }

  return { source: 'hltv', stats };
}

/** Team words from matches we have ungraded picks on, to target the crawl. */
export function teamHintsFrom(titles: (string | null)[]): string[] {
  const words = new Set<string>();
  for (const t of titles) {
    for (const part of String(t ?? '').toLowerCase().split(/\s+vs\.?\s+|\s+/)) {
      const w = part.replace(/[^a-z0-9]/g, '');
      if (w.length >= 4) words.add(w);
    }
  }
  return [...words];
}

export { canonHandle };
