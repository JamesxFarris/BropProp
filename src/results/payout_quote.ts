import { q } from '../db.js';
import type { CalEntry } from '../web/calibrate.js';

/**
 * Quotes read off an app, and the discount curve fitted to them.
 *
 * See `db/022_payout_quote.sql` for why this table exists at all: the entry
 * multiplier is the one number in this project that cannot be computed or
 * fetched, and the stack's entire verdict rides on it.
 */

export async function recordPayoutQuote(o: {
  book: string;
  entry: CalEntry;
  quoted: number;
  note?: string | null;
}): Promise<void> {
  // A multiplier at or below 1 is a typo or an empty box, not a quote. Storing
  // it would put a fabricated point into a fit that only has a handful of real
  // ones.
  if (!(o.quoted > 1)) return;
  await q(
    `INSERT INTO payout_quote
       (book, size, matches, max_per_team, max_per_match, same_side, excess, quoted, legs, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      o.book, o.entry.size, o.entry.matches, o.entry.maxPerTeam, o.entry.maxPerMatch,
      o.entry.sameSide, o.entry.excess, o.quoted, JSON.stringify(o.entry.legs), o.note ?? null,
    ],
  );
}

export type QuoteRow = {
  book: string;
  size: number;
  excess: number;
  max_per_team: number;
  same_side: boolean | null;
  quoted: string;
  observed_at: string;
};

/** Every quote captured, newest first. */
export async function quotes(): Promise<QuoteRow[]> {
  return q<QuoteRow>(
    `SELECT book, size, excess, max_per_team, same_side, quoted::text, observed_at::text
       FROM payout_quote ORDER BY observed_at DESC LIMIT 200`,
  );
}

/**
 * The discount per excess same-match leg, fitted across quotes at one leg count.
 *
 * Deliberately reported per leg count rather than pooled. The discount is a
 * fraction of a list price that differs by size, so pooling sizes would fit a
 * line through points measured on different scales — and the list prices
 * themselves are partly assumption until the flat controls are quoted.
 *
 * Returns null rather than a fit when a size has fewer than three distinct
 * concentrations. Two points define a line exactly, which is not evidence of
 * one; this project has already been caught reading "exactly collinear" as
 * confirmation when the collinearity was guaranteed by the sample.
 */
export async function discountCurve(): Promise<{
  book: string; size: number; n: number; spanned: number;
  perExcess: number | null; points: { excess: number; quoted: number }[];
}[]> {
  const rows = await q<{ book: string; size: number; excess: number; quoted: string }>(
    `SELECT book, size, excess, avg(quoted)::float8::text AS quoted
       FROM payout_quote GROUP BY book, size, excess ORDER BY book, size, excess`,
  );
  const byKey = new Map<string, { excess: number; quoted: number }[]>();
  for (const r of rows) {
    const k = `${r.book}|${r.size}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push({ excess: Number(r.excess), quoted: Number(r.quoted) });
  }
  const out = [];
  for (const [k, points] of byKey) {
    const [book, size] = k.split('|') as [string, string];
    const base = points.find((p) => p.excess === 0);
    let perExcess: number | null = null;
    if (base && points.length >= 3) {
      // Least squares on ratio-to-base against excess, forced through (0, 1):
      // the zero-excess entry IS the list price, so the intercept is not free.
      let num = 0, den = 0;
      for (const p of points) {
        if (p.excess === 0) continue;
        num += p.excess * (1 - p.quoted / base.quoted);
        den += p.excess * p.excess;
      }
      perExcess = den > 0 ? num / den : null;
    }
    out.push({
      book, size: Number(size), n: points.length,
      spanned: Math.max(...points.map((p) => p.excess)),
      perExcess, points,
    });
  }
  return out;
}
