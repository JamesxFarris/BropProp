import type { MarketRow } from './boardq.js';
import type { BookCode } from '../books.js';

/**
 * A deliberate sweep to measure what an app charges for concentration.
 *
 * The apps discount an entry whose legs share a match. Measured against the
 * three quotes this project owned, that discount is about 7.5% of the list
 * price for each leg beyond the first in the same MATCH — and it keys on the
 * match rather than the team, which is why a stack's opponent leg is charged
 * exactly like another teammate. But those three quotes only span 0, 1 and 2
 * excess legs, and the shape actually recommended here is six legs in one
 * match: five excess. Everything about whether a stack is worth taking rides on
 * an extrapolation three times past the data.
 *
 * So this builds a fixed ladder of entries to quote, from real legs on the live
 * board, holding everything constant except the one variable at a time:
 *
 *  - **Entries 1-6** hold the leg count at six and walk concentration from 0 to
 *    5 excess, by moving one leg at a time into a single target match. Six
 *    numbers from one leg count is what fits a curve honestly.
 *  - **Entries 7-8** are three and five legs, all different matches. These are
 *    the control the existing three-point reading lacks: they verify the list
 *    prices the whole calculation assumes. If the three-pick base is not 5x,
 *    the earlier reading of a 4.25x quote collapses.
 *  - **Entries 9-10** hold concentration at the maximum and vary the TEAM split
 *    instead — 4+2 and 3+3 against the 5+1 in entry 6. One entry per cell
 *    cannot separate "same match" from "same team"; these can.
 *  - **Entry 11** holds the shape and flips one leg's side. Every discounted
 *    entry on record is also same-side, so side and concentration are currently
 *    confounded.
 *
 * Nothing is staked. A quote is worth recording whether or not the entry is
 * placed, and requiring a stake is what left this project with three data
 * points in a month.
 */

export type CalLeg = {
  propId: number;
  handle: string;
  team: string | null;
  stat: string;
  maps: string;
  line: number;
  side: 'over' | 'under';
  matchKey: string;
};

export type CalEntry = {
  /** Stable within one render, so the form knows which entry was filled. */
  id: string;
  label: string;
  /** What this entry isolates — shown so the sweep is not a list of chores. */
  goal: string;
  size: number;
  matches: number;
  /** size - matches: the variable the discount was measured against. */
  excess: number;
  maxPerTeam: number;
  maxPerMatch: number;
  sameSide: boolean;
  legs: CalLeg[];
};

/** Shapes the live board could not supply, and why — never silently dropped. */
export type CalGap = { label: string; why: string };

export type CalPlan = { entries: CalEntry[]; gaps: CalGap[]; targetMatch: string | null };

const mapLabel = (a: number, b: number) => (a === b ? `Map ${a}` : `Maps ${a}-${b}`);

function shape(id: string, label: string, goal: string, legs: CalLeg[], sameSide = true): CalEntry {
  const perMatch = new Map<string, number>();
  const perTeam = new Map<string, number>();
  for (const l of legs) {
    perMatch.set(l.matchKey, (perMatch.get(l.matchKey) ?? 0) + 1);
    if (l.team) perTeam.set(`${l.matchKey}|${l.team}`, (perTeam.get(`${l.matchKey}|${l.team}`) ?? 0) + 1);
  }
  return {
    id, label, goal,
    size: legs.length,
    matches: perMatch.size,
    excess: legs.length - perMatch.size,
    maxPerTeam: perTeam.size ? Math.max(...perTeam.values()) : 0,
    maxPerMatch: perMatch.size ? Math.max(...perMatch.values()) : 0,
    sameSide,
    legs,
  };
}

/**
 * Build the sweep from whatever the board is offering right now.
 *
 * Deliberately tolerant: a board that cannot supply a shape reports it as a gap
 * rather than producing a shorter entry that looks like the real thing. An
 * entry quoted at the wrong concentration is worse than a missing one, because
 * it enters the fit as a real point.
 */
export function calibrationPlan(rows: MarketRow[], book: BookCode): CalPlan {
  const now = Date.now();
  const legs: CalLeg[] = [];
  const seenPlayer = new Set<string>();

  for (const r of rows) {
    if (r.is_combo) continue;
    if (r.scheduled_at && new Date(r.scheduled_at).getTime() < now) continue;
    if (!r.match_title) continue;
    const mine = r.books.find((b) => b.book === book);
    if (!mine || !mine.over_ok || !mine.under_ok) continue;
    // One leg per player across the whole sweep: two markets on one player are
    // the same bet twice, and the apps mostly refuse them anyway.
    if (seenPlayer.has(r.canon_handle)) continue;
    seenPlayer.add(r.canon_handle);
    legs.push({
      propId: mine.prop_id,
      handle: r.handle,
      team: mine.team ?? r.books.find((b) => b.team)?.team ?? null,
      stat: r.stat,
      maps: mapLabel(r.map_start, r.map_end),
      line: Number(mine.line),
      side: 'over',
      matchKey: r.match_title,
    });
  }

  const byMatch = new Map<string, CalLeg[]>();
  for (const l of legs) (byMatch.get(l.matchKey) ?? byMatch.set(l.matchKey, []).get(l.matchKey)!).push(l);

  const gaps: CalGap[] = [];
  const entries: CalEntry[] = [];

  // The target match needs six legs across two teams — the concentrated end of
  // the sweep is the whole point, and PrizePicks refuses a single-team lineup.
  const ranked = [...byMatch.entries()].sort((a, b) => b[1].length - a[1].length);
  const target = ranked.find(([, ls]) => ls.length >= 6 && new Set(ls.map((l) => l.team)).size >= 2);
  const others = ranked.filter(([k]) => k !== target?.[0]).map(([, ls]) => ls[0]!);

  if (!target) {
    gaps.push({
      label: 'The whole sweep',
      why: 'No match on the board has six legs across two teams right now. '
        + 'The concentrated entries cannot be built; try again when a fuller card is up.',
    });
    return { entries, gaps, targetMatch: null };
  }

  // Order the target's legs so the biggest team block comes first: that makes
  // entry 6 a 5+1, the exact shape the Stacks card recommends.
  const tLegs = target[1];
  const byTeam = new Map<string, CalLeg[]>();
  for (const l of tLegs) (byTeam.get(l.team ?? '?') ?? byTeam.set(l.team ?? '?', []).get(l.team ?? '?')!).push(l);
  const blocks = [...byTeam.values()].sort((a, b) => b.length - a.length);
  const ordered = blocks.flat();

  if (others.length < 5) {
    gaps.push({
      label: 'Entries 1-5',
      why: `Only ${others.length} other matches are listed, and the low-concentration `
        + 'entries need five. The concentrated entries below are still valid.',
    });
  }

  // 1-6: six legs throughout, concentration 0 -> 5.
  for (let k = 0; k <= 5; k++) {
    const fromTarget = ordered.slice(0, k + 1);
    const fromOthers = others.slice(0, 5 - k);
    if (fromTarget.length < k + 1 || fromOthers.length < 5 - k) continue;
    entries.push(shape(
      `six-x${k}`,
      `Six legs, ${k === 0 ? 'all different matches' : `${k + 1} from ${target[0]}`}`,
      k === 0
        ? 'The list price at six legs, with nothing concentrated. Everything below is measured against this.'
        : `${k} excess leg${k === 1 ? '' : 's'} in one match. This is the curve.`,
      [...fromTarget, ...fromOthers],
    ));
  }

  // 7-8: the list-price controls at other leg counts.
  for (const n of [3, 5]) {
    const spread = others.slice(0, n);
    if (spread.length < n) {
      gaps.push({ label: `${n}-leg control`, why: `Needs ${n} separate matches; only ${others.length} available.` });
      continue;
    }
    entries.push(shape(
      `flat-${n}`,
      `${n} legs, all different matches`,
      `Verifies the ${n}-pick list price. The existing reading of the discount assumes it, and has never checked it.`,
      spread,
    ));
  }

  // 9-10: concentration held at maximum, team split varied.
  const [big, small] = blocks;
  for (const [a, b, id] of [[4, 2, 'split-4-2'], [3, 3, 'split-3-3']] as const) {
    if (!big || !small || big.length < a || small.length < b) {
      gaps.push({ label: `${a}+${b} split`, why: `Needs ${a} and ${b} players on the two teams; board has ${big?.length ?? 0} and ${small?.length ?? 0}.` });
      continue;
    }
    entries.push(shape(
      id,
      `Six legs from ${target[0]}, ${a}+${b} across the teams`,
      'Same concentration as entry 6, different team split. Separates "same match" from "same team".',
      [...big.slice(0, a), ...small.slice(0, b)],
    ));
  }

  // 11: same shape, one leg flipped. Side and concentration are confounded in
  // every quote on record.
  const six = ordered.slice(0, 6);
  if (six.length === 6) {
    const flipped = six.map((l, i) => (i === 5 ? { ...l, side: 'under' as const } : l));
    entries.push(shape(
      'mixed-side',
      `Six legs from ${target[0]}, one taken the other way`,
      'Same legs as entry 6 with the last flipped to under. Tells us whether the discount is about direction or only about concentration.',
      flipped,
      false,
    ));
  }

  return { entries, gaps, targetMatch: target[0] };
}
