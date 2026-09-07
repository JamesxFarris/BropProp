/**
 * Combining several players into one line.
 *
 * A combo prop ("Bin + Xun + knight, kills, maps 1-3") is the SUM of its
 * members' totals over the range. Its result is therefore knowable from the
 * same per-player, per-map stat lines everything else here reads — but its
 * *distribution* is not simply the sum of theirs, and that is the whole
 * difficulty.
 *
 * ## Why this doesn't sum distributions
 *
 * The obvious approach is to project each player separately and add: means add,
 * variances add. Means do add — E[X+Y] = E[X]+E[Y] holds under any dependence,
 * so the projected total and hence the EDGE are correct either way. Variances
 * only add when the players are independent, and every combo on this board is
 * several players in ONE match. They are not independent, and the direction of
 * the error was measured rather than assumed.
 *
 * Measured 2026-09-07 over the eight LoL combos then on the board, across each
 * one's FULL joint history (22 to 169 maps): the observed per-map standard
 * deviation of the real combo total, divided by the sqrt-of-summed-variances
 * an independence assumption implies.
 *
 *   Bin + Xun + knight        1.064      Theshy + Wei + Rookie     1.158
 *   knight + Viper            1.072      Shanks + Hope             1.149
 *   Breathe + Tarzan + Shanks 1.115      Burdol + Heng + Tangyuan  1.145
 *   Tangyuan + Shaoye         1.118      Rookie + JiaQi            1.177
 *
 * Every one is above 1: teammates' kills are POSITIVELY correlated. A long,
 * bloody game feeds everyone, and that common factor outweighs the players
 * competing with each other for the same kills. Independence understates the
 * real spread by 6-18%. Over shorter windows the ratio moves around — on the
 * most recent 60 maps of each, one of the eight came out at 0.95 — which is
 * the second reason not to model this: the correction is not a constant to be
 * applied, it is a property of the particular players in the particular split.
 *
 * That error does not move the edge, but it corrupts everything ranking is
 * built from. A too-small sd inflates `edgeSd` (edge relative to how much this
 * line actually swings) and pushes the hit rate toward 0 or 1, so combos would
 * systematically outrank the single-player markets they compete with — an
 * artefact of the assumption, not of the market.
 *
 * ## What it does instead
 *
 * Exactly what `projection.ts` does for one player, one level up: it observes
 * the thing being bet on. A combo total is recomputed for every series the
 * members actually played TOGETHER, and those observed totals are the sample.
 * Whatever the correlation between the members is, it is already inside those
 * numbers — no coefficient is estimated, and no distribution is fitted. There
 * is enough of this history to insist on it: the eight board combos carry 7 to
 * 60 joint series each.
 *
 * ## The rules the fold enforces
 *
 * These are the same two refusals grading makes, applied one level up:
 *
 *  - **A map counts only when every member has a stat line for it.** A map
 *    where two of three players are recorded is not a two-thirds combo total,
 *    it is a missing number. Summing what happens to exist would report a
 *    total the prop could never have produced — the exact mistake the
 *    single-player code avoids by refusing to sum a 2-0 sweep into a
 *    three-map range.
 *  - **A series counts only when the whole map range was played.** Same rule,
 *    same reason.
 *
 * Both mean the WEAKEST MEMBER governs the sample size, which is the honest
 * minimum-evidence rule for a combo: a projection is only as good as the least
 * observed player in it, and a joint observation requires all of them.
 */

/** One player's line for one map, as stored. `value` is null when the source knew the map happened but not this stat. */
export type ComboStatRow = {
  series_key: string;
  map_number: number;
  canon_handle: string;
  value: number | null;
  played_at: string | Date | null;
};

const at = (v: string | Date | null): number =>
  v === null ? 0 : v instanceof Date ? v.getTime() : new Date(v).getTime();

/**
 * Combo totals per map and per series, from raw per-player rows.
 *
 * `totals` are real observed combo totals over the exact map range, most
 * recent first. `mapValues` are single-map combo totals from every series
 * regardless of length — more data, and the input `projection.ts` resamples
 * when there aren't enough whole-range series. Resampling those preserves the
 * correlation BETWEEN members (it is already baked into each map total) while
 * making the same maps-are-interchangeable assumption the single-player path
 * already makes and already marks.
 */
export function foldCombo(
  parts: string[],
  rows: ComboStatRow[],
  mapStart: number,
  mapEnd: number,
  limit = 20,
): { totals: number[]; mapValues: number[] } {
  if (parts.length < 2) return { totals: [], mapValues: [] };
  const need = new Set(parts);
  const want = mapEnd - mapStart + 1;

  // series -> map -> handle -> value
  const series = new Map<string, { at: number; maps: Map<number, Map<string, number>> }>();
  for (const r of rows) {
    if (!need.has(r.canon_handle)) continue;
    if (r.value === null || !Number.isFinite(Number(r.value))) continue;
    let s = series.get(r.series_key);
    if (!s) {
      s = { at: 0, maps: new Map() };
      series.set(r.series_key, s);
    }
    s.at = Math.max(s.at, at(r.played_at));
    let m = s.maps.get(r.map_number);
    if (!m) {
      m = new Map();
      s.maps.set(r.map_number, m);
    }
    // Same player twice on one map can only be two sources for one real map;
    // keeping both would double a member. Last write wins, never a sum.
    m.set(r.canon_handle, Number(r.value));
  }

  const ordered = [...series.values()].sort((a, b) => b.at - a.at);

  const mapValues: number[] = [];
  const totals: number[] = [];
  for (const s of ordered) {
    // Only maps where EVERY member is present are combo totals at all.
    const complete = new Map<number, number>();
    for (const [mapNo, byHandle] of s.maps) {
      if (byHandle.size !== need.size) continue;
      let sum = 0;
      for (const h of need) sum += byHandle.get(h)!;
      complete.set(mapNo, sum);
    }
    // Most recent first, and within a series by map order so a partial page of
    // map values is still the latest maps rather than an arbitrary set.
    for (const mapNo of [...complete.keys()].sort((a, b) => a - b)) {
      mapValues.push(complete.get(mapNo)!);
    }

    let rangeTotal = 0;
    let covered = 0;
    for (let m = mapStart; m <= mapEnd; m++) {
      const v = complete.get(m);
      if (v === undefined) break;
      rangeTotal += v;
      covered++;
    }
    if (covered === want) totals.push(rangeTotal);
  }

  return { totals: totals.slice(0, limit), mapValues: mapValues.slice(0, limit * 3) };
}

export type ComboGrade =
  | { kind: 'total'; total: number }
  | { kind: 'void'; note: string }
  | { kind: 'ungradeable'; note: string };

/**
 * The graded result of a combo over one map range: every member's stat, summed
 * across every map in the range.
 *
 * Combos used to be refused outright, on the reasoning that they "have no
 * per-player stat line". They have several, which is the point — with per-map
 * stats for CS2 and LoL both flowing, the sum is a fact rather than a model.
 * The two refusals that decide money are unchanged and are applied member by
 * member rather than once:
 *
 *  - An unplayed map in the range VOIDS, exactly as for a single player. A map
 *    nobody has a line for is a map the series never reached; the book refunds
 *    it and so do we.
 *  - A map that WAS played but is missing one member's line is UNGRADEABLE,
 *    never zero and never a short sum. A player subbed out after map 2 is the
 *    common cause, and calling that a 0 would hand the under a free win.
 *
 * Void is checked across the whole range before any missing line is, because a
 * range containing an unplayed map is refunded whatever else is wrong with it.
 */
export function comboRangeTotal(
  parts: string[],
  rows: ComboStatRow[],
  mapStart: number,
  mapEnd: number,
): ComboGrade {
  if (parts.length < 2) {
    return { kind: 'ungradeable', note: 'Combo handle does not name more than one player.' };
  }
  const need = new Set(parts);
  const byMap = new Map<number, Map<string, number | null>>();
  for (const r of rows) {
    if (!need.has(r.canon_handle)) continue;
    if (r.map_number < mapStart || r.map_number > mapEnd) continue;
    let m = byMap.get(r.map_number);
    if (!m) {
      m = new Map();
      byMap.set(r.map_number, m);
    }
    m.set(r.canon_handle, r.value === null ? null : Number(r.value));
  }

  // Rule 1, first: any map in the range that nobody played voids the prop.
  const unplayed: number[] = [];
  for (let m = mapStart; m <= mapEnd; m++) {
    if ((byMap.get(m)?.size ?? 0) === 0) unplayed.push(m);
  }
  if (unplayed.length > 0) {
    const played = [...byMap.keys()].sort((a, b) => a - b).join(', ') || 'none';
    return {
      kind: 'void',
      note: `Maps ${mapStart}-${mapEnd} required, only ${played} played. Series ended early.`,
    };
  }

  // Rule 2: a map that was played but is missing a member, or a member whose
  // stat the source didn't record, is a hole — not a zero and not a short sum.
  let total = 0;
  for (let m = mapStart; m <= mapEnd; m++) {
    const row = byMap.get(m)!;
    for (const h of need) {
      if (!row.has(h)) {
        return {
          kind: 'ungradeable',
          note: `No stat line for ${h} on map ${m}; a combo needs every player on every map in the range.`,
        };
      }
      const v = row.get(h)!;
      if (v === null || !Number.isFinite(v)) {
        return {
          kind: 'ungradeable',
          note: `Source has no value recorded for ${h} on map ${m}.`,
        };
      }
      total += v;
    }
  }
  return { kind: 'total', total };
}
