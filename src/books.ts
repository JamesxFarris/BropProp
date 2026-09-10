/**
 * Every book the app knows about, in one place.
 *
 * This used to be a union type — `'prizepicks' | 'underdog'` — repeated at a
 * dozen sites, plus a ternary per display string: `b === 'prizepicks' ? 'PP' :
 * 'UD'`. That shape encodes "there are exactly two books" into the type system
 * and into every else-branch, and the whole value of a DFS comparison is that
 * there are more than two. A ternary cannot grow a third arm without every
 * caller being found and edited.
 *
 * So a book is a string, and this is the registry that gives it a name. An
 * unknown code renders as itself rather than throwing: an adapter can start
 * returning rows before anyone teaches this file what to call it, and a board
 * that says "sleeper" is far better than a board that 500s.
 */
export type BookCode = string;

export type BookMeta = {
  code: BookCode;
  /** Full name, for headers and prose. */
  name: string;
  /** Two-letter tag, for cells too narrow for the full name. */
  short: string;
  /**
   * Whether the book publishes real two-sided odds.
   *
   * Underdog does. PrizePicks cannot — it prices with a flat multiplier and
   * expresses price by moving the line instead, so `over_price` is always
   * null there and `devig()` has nothing to work with. Consensus code needs to
   * know the difference: a book with no prices still contributes a LINE to the
   * consensus, which is the thing being agreed on.
   */
  pricesSides: boolean;
};

const REGISTRY: Record<string, BookMeta> = {
  prizepicks: { code: 'prizepicks', name: 'PrizePicks', short: 'PP', pricesSides: false },
  underdog:   { code: 'underdog',   name: 'Underdog',   short: 'UD', pricesSides: true },
  sleeper:    { code: 'sleeper',    name: 'Sleeper',    short: 'SL', pricesSides: false },
};

/**
 * Display order, so the board's columns don't reshuffle between requests.
 *
 * Postgres `json_agg` has no ordering guarantee we want to depend on, and a
 * board whose columns swap places on refresh is unreadable. Books outside this
 * list sort alphabetically after it — a new adapter appears at the right-hand
 * end rather than jumping into the middle of a layout the user has learnt.
 */
const ORDER = ['prizepicks', 'underdog', 'sleeper'];

export function bookMeta(code: BookCode): BookMeta {
  return REGISTRY[code] ?? { code, name: code, short: code.slice(0, 2).toUpperCase(), pricesSides: false };
}

export const bookName = (code: BookCode): string => bookMeta(code).name;
export const bookShort = (code: BookCode): string => bookMeta(code).short;

/** Sort book codes into a stable display order. */
export function orderBooks<T>(items: T[], code: (t: T) => BookCode): T[] {
  const rank = (c: BookCode) => {
    const i = ORDER.indexOf(c);
    return i === -1 ? ORDER.length : i;
  };
  return [...items].sort((a, b) => {
    const d = rank(code(a)) - rank(code(b));
    return d !== 0 ? d : code(a).localeCompare(code(b));
  });
}

/** Codes of every book with an adapter wired into the poller. */
export const KNOWN_BOOKS: BookCode[] = ['prizepicks', 'underdog'];
