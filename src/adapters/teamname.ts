/**
 * Match a team as one source names it to the same team as another source does.
 *
 * PrizePicks puts "FaZe" on its players; OddsPapi calls the same side "Faze
 * Clan". PrizePicks says "DENDELE", OddsPapi "Dendele CS"; "PCIFIC" against
 * "Pcific Espor", which is "esports" with the tail cut off. Measured 2026-09-10
 * against the 82 CS2 teams on our board in the previous fortnight, a plain
 * lowercase-and-strip matched 75 of them. Stripping the suffixes teams bolt on
 * and one alias covers everything that is in both feeds; the remaining misses
 * (Betclic, BET-M) are simply absent from OddsPapi.
 *
 * Deliberately conservative. A false match is worse than a miss here: it would
 * attach one team's moneyline to a different team's players and send a stack of
 * unders onto the favourite. So there is no fuzzy distance, only exact equality
 * after normalising, plus a short list of aliases a person has checked.
 */

/** Words that decorate a name without identifying the team. */
const DECORATION = /\b(team|esports?|e-sports|espor|gaming|club|clan|academy|gg|cs|cs2)\b/g;

/**
 * Names that differ by more than decoration. Keys and values are both already
 * normalised. Add to this only after checking both sides are the same roster.
 */
const ALIASES: Record<string, string> = {
  navi: 'natusvincere',
  navijunior: 'natusvincerejunior',
};

export function normTeam(name: string | null | undefined): string {
  if (!name) return '';
  const n = String(name)
    .toLowerCase()
    .replace(DECORATION, '')
    .replace(/[^a-z0-9]/g, '');
  return ALIASES[n] ?? n;
}

/**
 * Build a lookup from one source's names, then resolve another's against it.
 *
 * Two different names in `candidates` that normalise to the same key are
 * ambiguous, and the key is dropped rather than resolved to whichever came
 * last. "Natus Vincere" and "Ex-Natus Vincere" must not collide into one.
 */
export function teamIndex<T>(candidates: T[], nameOf: (t: T) => string): (name: string | null | undefined) => T | null {
  const byKey = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const c of candidates) {
    const k = normTeam(nameOf(c));
    if (!k) continue;
    if (byKey.has(k) && nameOf(byKey.get(k)!) !== nameOf(c)) ambiguous.add(k);
    else byKey.set(k, c);
  }
  for (const k of ambiguous) byKey.delete(k);
  return (name) => {
    const k = normTeam(name);
    return k ? byKey.get(k) ?? null : null;
  };
}
