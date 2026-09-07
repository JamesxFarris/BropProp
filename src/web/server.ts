import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { movements, health, leagues } from './queries.js';
import { markets, propHistory, siblingProps } from './boardq.js';
import {
  openPicks, addPick, removePick, placeSlip, clearOpenSlip, slips, slipPicks,
  openSlipBook, WrongBookError, SideUnavailableError,
} from './picks.js';
import { boardPage, edgesPage, slipsPage, historyPage, buildPage } from './render.js';
import { buildEntries } from './optimize.js';
import { projectBoard } from './projection.js';

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

function authorized(req: IncomingMessage): boolean {
  if (!config.dashboardPassword) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const pass = rest.join(':');
  return safeEqual(user ?? '', config.dashboardUser) && safeEqual(pass, config.dashboardPassword);
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

    if (!authorized(req)) {
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
              return redirect(res, `${back}${sep}locked=${encodeURIComponent(err.locked)}`);
            }
            if (err instanceof SideUnavailableError) {
              const sep = back.includes('?') ? '&' : '?';
              return redirect(res, `${back}${sep}unavailable=${encodeURIComponent(err.side)}`);
            }
            throw err;
          }
        }
        return redirect(res, back);
      }
      if (url.pathname === '/pick/remove') {
        const id = Number(body.get('pick_id'));
        if (Number.isFinite(id)) await removePick(id);
        return redirect(res, back);
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
      book: bookParam === 'prizepicks' || bookParam === 'underdog' ? bookParam : null,
      matched: url.searchParams.get('matched') === '1',
      search: url.searchParams.get('q')?.trim() || null,
      // On by default once an app is chosen — the reason to narrow to one app
      // is to take the best number available on it. Explicit best=0 opts out.
      best: url.searchParams.get('best') !== '0',
    };

    // A slip already committed to an app narrows the board to that app: props
    // from the other one can't join this entry, so showing them as takeable
    // would be offering something that cannot be done.
    const lockedBook = await openSlipBook();
    if (lockedBook) filters.book = lockedBook;
    const blocked = url.searchParams.get('locked');

    const propMatch = url.pathname.match(/^\/prop\/(\d+)$/);
    if (propMatch) {
      const id = Number(propMatch[1]);
      const [hist, picks, h] = await Promise.all([propHistory(id), openPicks(), health(null)]);
      if (!hist) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('No such prop.');
        return;
      }
      const siblings = await siblingProps(id);
      return html(res, historyPage({ hist, siblings, picks, health: h }));
    }

    if (url.pathname === '/board') {
      const [rows, picks, h] = await Promise.all([
        markets({ ...filters, best: filters.best && Boolean(filters.book) }),
        openPicks(),
        health(filters.league),
      ]);
      // One projection lookup for the whole board rather than per row.
      const form = await projectBoard(
        rows.map((r) => ({
          canon_handle: r.canon_handle, league: r.league, stat: r.stat,
          map_start: r.map_start, map_end: r.map_end,
        })),
      );
      return html(res, boardPage({ rows, picks, health: h, leagues: known, filters, lockedBook, blocked, form }));
    }

    if (url.pathname === '/build') {
      const bookParam = url.searchParams.get('book');
      const book: 'prizepicks' | 'underdog' =
        (lockedBook as 'prizepicks' | 'underdog' | null) ??
        (bookParam === 'underdog' ? 'underdog' : 'prizepicks');
      const rows = await markets({ league: filters.league, book, matched: false, search: null });
      const form = await projectBoard(
        rows.map((r) => ({
          canon_handle: r.canon_handle, league: r.league, stat: r.stat,
          map_start: r.map_start, map_end: r.map_end,
        })),
      );
      const [picks, h] = await Promise.all([openPicks(), health(filters.league)]);
      const entries = buildEntries(rows, form, book);
      return html(res, buildPage({ entries, book, lockedBook, picks, health: h }));
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
      return html(res, edgesPage({ rows, mov, picks, health: h, leagues: known, filters, lockedBook, blocked }));
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
