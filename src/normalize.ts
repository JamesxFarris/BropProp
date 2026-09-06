// Canonicalisation. Everything book-specific gets mapped into one vocabulary
// here so that the rest of the system never has to care which book a row
// came from. If a book changes its wording, this file is the only casualty.

export type Canon = {
  stat: string;
  mapStart: number;
  mapEnd: number;
  isCombo: boolean;
};

/** Books name the same league differently. Canonical codes: CS2, LOL, VAL, APEX. */
const LEAGUE_MAP: Record<string, string> = {
  CS2: 'CS2', CS: 'CS2', CSGO: 'CS2', 'COUNTER-STRIKE': 'CS2',
  LOL: 'LOL', LEAGUEOFLEGENDS: 'LOL',
  VAL: 'VAL', VALORANT: 'VAL',
  APEX: 'APEX',
  DOTA: 'DOTA2', DOTA2: 'DOTA2',
  RL: 'RL', ROCKETLEAGUE: 'RL',
  COD: 'COD',
};

export function canonLeague(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return LEAGUE_MAP[key] ?? null;
}

/**
 * Player handles are the join key between books AND between a book and a stats
 * source (HLTV/vlr). Underdog stores the handle in `last_name`, sometimes with
 * stray whitespace; PrizePicks uses a display name. Fold both to the same shape.
 */
export function canonHandle(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const STAT_WORDS: Array<[RegExp, string]> = [
  [/head\s*shots?/i, 'headshots'],
  [/fantasy\s*points?|fantasy_points/i, 'fantasy_points'],
  [/assists?/i, 'assists'],
  [/deaths?/i, 'deaths'],
  [/kills?/i, 'kills'],
];

function statWord(s: string): string | null {
  for (const [re, name] of STAT_WORDS) if (re.test(s)) return name;
  return null;
}

/** Turn a list of map numbers into a contiguous range, or null if it has gaps. */
function toRange(nums: number[]): [number, number] | null {
  if (nums.length === 0) return null;
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  // A gapped selection ("maps 1 and 3") is not a range and must not be
  // silently flattened into one — that would fabricate a market.
  if (last - first + 1 !== sorted.length) return null;
  return [first, last];
}

/**
 * PrizePicks: "MAPS 1-2 Kills", "MAP 3 Kills", "MAPS 1-3 Kills (Combo)".
 */
export function parsePrizePicksStat(statType: string): Canon | null {
  const stat = statWord(statType);
  if (!stat) return null;
  const isCombo = /\(combo\)/i.test(statType);

  let mapStart: number | null = null;
  let mapEnd: number | null = null;

  const range = statType.match(/maps?\s*(\d+)\s*[-–]\s*(\d+)/i);
  const single = statType.match(/map\s*(\d+)/i);
  if (range) {
    mapStart = Number(range[1]);
    mapEnd = Number(range[2]);
  } else if (single) {
    mapStart = mapEnd = Number(single[1]);
  } else {
    // No map qualifier at all — treat as the full series so it never
    // collides with an explicitly-scoped market.
    return null;
  }
  if (mapStart === null || mapEnd === null || mapEnd < mapStart) return null;
  return { stat, mapStart, mapEnd, isCombo };
}

/**
 * Underdog: "kills_on_maps_1_2", "assists_on_maps_1_2_3",
 * "period_1_2_3_fantasy_points". Underdog ENUMERATES maps where PrizePicks
 * uses a range, so 1_2_3 must collapse to 1-3 for the two to join.
 */
export function parseUnderdogStat(stat: string): Canon | null {
  const name = statWord(stat);
  if (!name) return null;

  let nums: number[] = [];
  const onMaps = stat.match(/on_maps?_([\d_]+)/i);
  const period = stat.match(/period_([\d_]+)/i);
  const src = onMaps?.[1] ?? period?.[1];
  if (!src) return null;
  nums = src.split('_').filter(Boolean).map(Number).filter((n) => Number.isFinite(n));

  const range = toRange(nums);
  if (!range) return null;
  return { stat: name, mapStart: range[0], mapEnd: range[1], isCombo: false };
}

/** American odds from Underdog arrive as strings like "-112" / "+140". */
export function parseAmerican(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace('+', ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}
