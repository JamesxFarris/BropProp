import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  SESSION_COOKIE, SESSION_DAYS, mintSession, sessionValid, parseCookies, safeNext,
} from './session.js';
import { pool } from '../db.js';
import { config } from '../config.js';
import { movements, health, leagues } from './queries.js';
import { markets, propHistory, siblingProps, playerGames } from './boardq.js';
import {
  openPicks, addPick, removePick, placeSlip, clearOpenSlip, slips, slipPicks,
  openSlipBook, WrongBookError, SideUnavailableError,
} from './picks.js';
import { boardPage, edgesPage, slipsPage, historyPage, buildPage, loginPage, statsPage } from './render.js';
import { counters, historyByWeek, coverage, record, sources, scoreHistory, leadScores, stackRecord } from './statsq.js';
import { clv } from './clv.js';
import { buildEntries, findStacks, marketCandidates, STACK_SIZES } from './optimize.js';
import { teamWinProbs } from './matchodds.js';
import { recordStackQuote } from '../results/stack_log.js';
import { projectMarkets } from './projection.js';
import { KNOWN_BOOKS, type BookCode } from '../books.js';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = 'public';
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The session cookie, and why it is signed rather than stored.
 *
 * One user and one password, so a session table would be a table with one row
 * in it and a migration to maintain. Instead the cookie carries its own expiry
 * and an HMAC over it, keyed by the dashboard password — which means changing
 * the password invalidates every outstanding session for free, and a forged
 * cookie needs the password it was trying to avoid typing.
 *
 * Not a JWT: there are no claims to carry beyond "this browser typed the
 * password, until this time", and a library would be more surface than value.
 */
const secret = () => config.dashboardPassword ?? '';

/**
 * Basic auth still works alongside the cookie.
 *
 * The form is what a person should meet, but `curl -u` and
 * `railway ssh … npm run report`-style access predate it and are how this gets
 * debugged. Dropping the header would have broken those for no gain.
 */
function authorized(req: IncomingMessage): boolean {
  if (!config.dashboardPassword) return true;
  if (sessionValid(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret())) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const pass = rest.join(':');
  return safeEqual(user ?? '', config.dashboardUser) && safeEqual(pass, config.dashboardPassword);
}

function credentialsMatch(user: string, pass: string): boolean {
  if (!config.dashboardPassword) return true;
  return safeEqual(user, config.dashboardUser) && safeEqual(pass, config.dashboardPassword);
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(path: string) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  if (safe.includes('..')) return null;
  try {
    const body = await readFile(join(PUBLIC, safe));
    return { body, type: MIME[extname(safe)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { location: to, 'cache-control': 'no-store' });
  res.end();
};

const html = (res: ServerResponse, body: string) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

/**
 * Which markets the board keeps.
 *
 * Default is `all`: hiding by default would hide the reason the board is
 * quiet, and on 2026-09-07 that reason was 386 of 465 rows having no stat
 * history rather than no edge. `live` drops those and keeps everything the
 * model actually priced; `calls` keeps only what it has an opinion on.
 */
const showMode = (p: URLSearchParams): 'all' | 'live' | 'calls' => {
  const v = p.get('show');
  if (v === 'live' || v === 'calls' || v === 'all') return v;
  return p.get('calls') === '1' ? 'calls' : 'all';
};

const numOrNull = (v: string | null) => {
  if (!v || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/healthz') {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }

    if (req.method === 'GET' && /\.[a-z0-9]+$/i.test(url.pathname)) {
      const file = await serveStatic(url.pathname);
      if (file) {
        res.writeHead(200, { 'content-type': file.type, 'cache-control': 'public, max-age=300' });
        res.end(file.body);
        return;
      }
    }

    // Sign in and out. Both sit ahead of the auth gate for the obvious reason
    // that you cannot reach a login page you have to be logged in to see.
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const next = safeNext(body.get('next'));
        if (credentialsMatch(body.get('user') ?? '', body.get('password') ?? '')) {
          const secure = (req.headers['x-forwarded-proto'] ?? '') === 'https' ? '; Secure' : '';
          res.writeHead(303, {
            location: next,
            'set-cookie':
              `${SESSION_COOKIE}=${mintSession(secret())}; Path=/; HttpOnly; SameSite=Lax` +
              `; Max-Age=${SESSION_DAYS * 86400}${secure}`,
          });
          res.end();
          return;
        }
        // 401 rather than 200: a wrong password is a failed request, and
        // saying so keeps a password manager from storing what did not work.
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(loginPage({ next, error: 'That username and password did not match.' }));
        return;
      }
      if (authorized(req)) {
        res.writeHead(303, { location: '/board' });
        res.end();
        return;
      }
      return html(res, loginPage({ next: safeNext(url.searchParams.get('next')) }));
    }

    if (url.pathname === '/logout') {
      res.writeHead(303, {
        location: '/login',
        'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      res.end();
      return;
    }

    if (!authorized(req)) {
      // A browser gets the form; anything else keeps the header it expects.
      // Curl and the odd script have used basic auth here since before there
      // was a page, and a 303 to HTML would break both silently.
      const wantsHtml = (req.headers.accept ?? '').includes('text/html');
      if (wantsHtml && req.method === 'GET') {
        res.writeHead(303, { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
        res.end();
        return;
      }
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="BropProp", charset="UTF-8"',
        'content-type': 'text/plain',
      });
      res.end('Sign in to view the board.');
      return;
    }

    // ---- writes ----
    if (req.method === 'POST') {
      const body = await readBody(req);
      const back = body.get('back') || '/board';

      /**
       * Send the browser back to the row it was just on.
       *
       * Taking a prop is a plain form post and a redirect, which is what makes
       * it work with scripts blocked — but a redirect lands at the top of the
       * page, and on a board of hundreds of rows that means hunting for your
       * place after every single leg. A fragment costs nothing, needs no
       * script, and the browser does the scrolling itself.
       *
       * Any fragment already on `back` is dropped rather than appended to: two
       * hashes in one URL and the browser keeps the first, which would pin you
       * to whichever row you happened to take first.
       */
      const backTo = (anchor: string | null) => {
        const clean = back.split('#')[0]!;
        return anchor ? `${clean}#${anchor}` : clean;
      };

      if (url.pathname === '/pick') {
        const propId = Number(body.get('prop_id'));
        const side = body.get('side');
        if (Number.isFinite(propId) && (side === 'over' || side === 'under')) {
          try {
            await addPick(propId, side);
          } catch (err) {
            // Say why the pick didn't land rather than redirecting to a board
            // that silently looks unchanged.
            if (err instanceof WrongBookError) {
              const sep = back.includes('?') ? '&' : '?';
              return redirect(res, `${backTo(null)}${sep}locked=${encodeURIComponent(err.locked)}&on=${encodeURIComponent(err.attempted)}#m${propId}`);
            }
            if (err instanceof SideUnavailableError) {
              const sep = back.includes('?') ? '&' : '?';
              return redirect(res, `${backTo(null)}${sep}unavailable=${encodeURIComponent(err.side)}#m${propId}`);
            }
            throw err;
          }
          return redirect(res, backTo(`m${propId}`));
        }
        return redirect(res, backTo(null));
      }
      if (url.pathname === '/pick/remove') {
        const id = Number(body.get('pick_id'));
        const propId = Number(body.get('prop_id'));
        if (Number.isFinite(id)) await removePick(id);
        return redirect(res, backTo(Number.isFinite(propId) ? `m${propId}` : null));
      }
      // Stage a suggested entry as the open slip, in order, stopping at the
      // first leg the rules refuse rather than silently building a partial one.
      if (url.pathname === '/build/stage') {
        const ids = (body.get('prop_ids') ?? '').split(',').map(Number).filter(Number.isFinite);
        const sides = (body.get('sides') ?? '').split(',');
        await clearOpenSlip();
        for (const [i, id] of ids.entries()) {
          const side = sides[i];
          if (side !== 'over' && side !== 'under') continue;
          try {
            await addPick(id, side);
          } catch {
            break;
          }
        }
        return redirect(res, '/board');
      }
      // What the app quoted for a stack, recorded whether or not it is played.
      // Without it every EV here is half a calculation: we know what a stack
      // needs, never what it pays.
      if (url.pathname === '/stack/quote') {
        await recordStackQuote({
          book: body.get('book') ?? '',
          matchKey: body.get('match_key') ?? '',
          team: body.get('team') ?? '',
          side: body.get('side') === 'under' ? 'under' : 'over',
          size: Number(body.get('size')),
          propIds: (body.get('prop_ids') ?? '').split(',').map(Number).filter(Number.isFinite),
          sides: (body.get('sides') ?? '').split(','),
          winProb: numOrNull(body.get('win_prob')),
          indepProb: numOrNull(body.get('indep_prob')),
          requiredMult: numOrNull(body.get('required_mult')),
          quoted: Number(body.get('mult')),
        }).catch(() => {});
        return redirect(res, '/build');
      }
      if (url.pathname === '/slip/clear') {
        await clearOpenSlip();
        return redirect(res, back);
      }
      if (url.pathname === '/slip/place') {
        const id = await placeSlip({
          name: body.get('name')?.trim() || null,
          entryType: body.get('entry_type') || 'power',
          stake: numOrNull(body.get('stake')),
          multiplier: numOrNull(body.get('multiplier')),
        });
        return redirect(res, id ? '/slips' : back);
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }

    // ---- reads ----
    const known = await leagues();
    const wanted = url.searchParams.get('league');
    const bookParam = url.searchParams.get('book');
    const filters = {
      league: wanted && known.includes(wanted) ? wanted : null,
      /**
       * One app at a time, and PrizePicks unless told otherwise.
       *
       * Showing both put two lines and four O/U buttons on every row, when at
       * most one side of one app is ever the right take — a market where the
       * apps differ has exactly one best price, and the engine already knows
       * which. The second pair was never actionable; it was the thing making
       * the row hard to read. The other apps' numbers stay on the row as
       * read-only columns, because knowing your number is worse elsewhere is
       * the whole point — it is their buttons that go, not their lines.
       *
       * `book=all` (or the older `book=both`) makes every app takeable at once.
       */
      book:
        bookParam === 'both' || bookParam === 'all' ? null
          : bookParam && KNOWN_BOOKS.includes(bookParam) ? bookParam
            : 'prizepicks',
      matched: url.searchParams.get('matched') === '1',
      search: url.searchParams.get('q')?.trim() || null,
      // On by default once an app is chosen — the reason to narrow to one app
      // is to take the best number available on it. Explicit best=0 opts out.
      best: url.searchParams.get('best') !== '0',
      // How much of the quiet part of the board to keep. `calls=1` is the
      // older single toggle and still means the strictest setting, so a
      // bookmarked link keeps working.
      show: showMode(url.searchParams),
    };

    // A slip already committed to an app narrows the board to that app: props
    // from the other one can't join this entry, so showing them as takeable
    // would be offering something that cannot be done.
    const lockedBook = await openSlipBook();
    if (lockedBook) filters.book = lockedBook;
    const blocked = url.searchParams.get('locked');
    // Which book the refused prop was on. Carried separately because with more
    // than two books it cannot be inferred from the slip's own.
    const blockedOn = url.searchParams.get('on');

    const propMatch = url.pathname.match(/^\/prop\/(\d+)$/);
    if (propMatch) {
      const id = Number(propMatch[1]);
      const [hist, picks, h] = await Promise.all([propHistory(id), openPicks(), health(null)]);
      if (!hist) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('No such prop.');
        return;
      }
      const siblings = await siblingProps(id);
      const games = await playerGames({
        canonHandle: hist.canon_handle, league: hist.league, stat: hist.stat,
        mapStart: hist.map_start, mapEnd: hist.map_end,
      });
      // The line this market is currently offered at, for the hit column.
      const line = hist.points.length ? Number(hist.points[hist.points.length - 1]!.line) : null;
      return html(res, historyPage({ hist, siblings, games, line, picks, health: h }));
    }

    if (url.pathname === '/board') {
      const [rows, picks, h] = await Promise.all([
        markets({ ...filters, best: filters.best && Boolean(filters.book) }),
        openPicks(),
        health(filters.league),
      ]);
      // One projection lookup for the whole board rather than per row. The
      // handle goes along because a combo's members are only recorded there.
      const form = await projectMarkets(
        rows.map((r) => ({
          canon_handle: r.canon_handle, handle: r.handle, league: r.league, stat: r.stat,
          map_start: r.map_start, map_end: r.map_end,
        })),
      );
      return html(res, boardPage({ rows, picks, health: h, leagues: known, filters, lockedBook, blocked, blockedOn, form }));
    }

    if (url.pathname === '/build') {
      const bookParam = url.searchParams.get('book');
      // Any book with an adapter can be built against. Unknown codes fall back
      // to PrizePicks rather than querying for a book that does not exist.
      const book: BookCode =
        lockedBook ??
        (bookParam && KNOWN_BOOKS.includes(bookParam) ? bookParam : 'prizepicks');
      const rows = await markets({ league: filters.league, book, matched: false, search: null });
      const form = await projectMarkets(
        rows.map((r) => ({
          canon_handle: r.canon_handle, handle: r.handle, league: r.league, stat: r.stat,
          map_start: r.map_start, map_end: r.map_end,
        })),
      );
      const [picks, h] = await Promise.all([openPicks(), health(filters.league)]);
      const entries = buildEntries(rows, form, book);

      // Pinnacle's view of who wins, for every team on the board. Empty until
      // the odds job has run — and until migration 017 exists at all, which is
      // why a failure here is swallowed rather than taking the page down.
      const teams = [...new Set(rows.flatMap((r) => r.books.map((b) => b.team))
        .filter((t): t is string => Boolean(t)))];
      const teamOdds = await teamWinProbs(teams).catch(() => new Map());
      // Both sides of every leg: the search builds each team's unders and its
      // overs, and pairs each with an opponent on the SAME side, which the
      // measured tail makes far stronger than the opponent's own better side.
      const pool = marketCandidates(rows, teamOdds, book, { bothSides: true });
      const stacks = STACK_SIZES.flatMap((n) => findStacks(pool, n, book).slice(0, 3));

      return html(res, buildPage({ entries, stacks, teamOdds, book, lockedBook, picks, health: h }));
    }

    if (url.pathname === '/stats') {
      const [h, ctr, weeks, cov, rec, src, value, scores, leads, stacks] = await Promise.all([
        health(null), counters(), historyByWeek(), coverage(), record(), sources(), clv(), scoreHistory(),
        // Empty until migrations 018/019 exist and the jobs have run once.
        leadScores().catch(() => []),
        stackRecord().catch(() => null),
      ]);
      return html(res, statsPage({
        health: h, counters: ctr, weeks, coverage: cov, record: rec, sources: src, clv: value,
        scores, leads, stacks,
      }));
    }

    if (url.pathname === '/slips') {
      const list = await slips();
      const byId = await slipPicks(list.map((s) => s.id));
      const [picks, h] = await Promise.all([openPicks(), health(null)]);
      return html(res, slipsPage({ list, byId, picks, health: h }));
    }

    if (url.pathname === '/') {
      // Edges only ever concerns markets both apps list, so force that filter.
      const [rows, mov, picks, h] = await Promise.all([
        markets({ ...filters, matched: true, best: false }),
        movements(filters.league),
        openPicks(),
        health(filters.league),
      ]);
      return html(res, edgesPage({ rows, mov, picks, health: h, leagues: known, filters, lockedBook, blocked, blockedOn }));
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  } catch (err) {
    console.error('request failed:', (err as Error).message);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Something broke rendering this page. Check the server logs.');
  }
});

server.listen(PORT, () => {
  console.log(`BropProp dashboard on http://localhost:${PORT}`);
  if (!config.dashboardPassword) {
    console.warn('  ! DASHBOARD_PASSWORD is unset — the dashboard is open and accepts writes');
  }
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
