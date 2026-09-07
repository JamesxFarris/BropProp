/** The single shape every book is flattened into before it touches the DB. */
export type RawTeam = { externalId: string; name?: string | null; abbr?: string | null };

export type RawMatch = {
  externalId: string;
  league: string;
  title?: string | null;
  scheduledAt?: string | null;
  status?: string | null;
  home?: RawTeam | null;
  away?: RawTeam | null;
};

export type RawProp = {
  externalId: string | null;
  league: string;
  player: { externalId: string; handle: string; team?: RawTeam | null };
  match: RawMatch | null;
  stat: string;
  mapStart: number;
  mapEnd: number;
  isCombo: boolean;
  variant: string;
  displayStat: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  status: string | null;
  isLive: boolean;
  extra?: Record<string, unknown>;
};

export type FetchResult = {
  bookCode: string;
  httpStatus: number;
  props: RawProp[];
  /** league code -> book's own league id, harvested for league_ref self-healing */
  discoveredLeagueIds?: Record<string, { id: string; name: string }>;
  raw?: unknown;
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * These are undocumented endpoints. They rate-limit, they go down, and they
 * reshape without notice. Retry with backoff and let the caller record the
 * failure rather than throwing the whole poll away.
 */
export async function getJson(
  url: string,
  {
    retries = 3,
    timeoutMs = 30_000,
    headers = {},
  }: { retries?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      });
      lastStatus = res.status;
      if (res.status === 429 || res.status >= 500) {
        // Backoff of 5s, 15s, 45s. Tuned to PrizePicks' limiter, which refills
        // slowly: retrying after 2s just burns the next token and earns another
        // 429. Being impatient here is what gets us refused in the first place.
        if (attempt < retries) {
          await sleep(5000 * 3 ** attempt);
          continue;
        }
        return { status: res.status, body: null };
      }
      if (!res.ok) return { status: res.status, body: null };
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(5000 * 3 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: lastStatus, body: null };
}
