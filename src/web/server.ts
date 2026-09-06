import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { disagreements, movements, health, leagues } from './queries.js';
import { board, openPicks, addPick, removePick, placeSlip, clearOpenSlip, slips, slipPicks } from './picks.js';
import { page, boardPage, slipsPage } from './render.js';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = 'public';
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Constant-time compare so the password can't be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorized(req: IncomingMessage): boolean {
  if (!config.dashboardPassword) return true; // unset = open (local dev)
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

/** Post/Redirect/Get, so a refresh never re-submits a pick. */
function redirect(res: ServerResponse, to: string) {
  res.writeHead(303, { location: to, 'cache-control': 'no-store' });
  res.end();
}

const html = (res: ServerResponse, body: string) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/healthz') {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }

    // Static assets are public; everything else sits behind auth when set.
    if (req.method === 'GET' && url.pathname !== '/' && !url.pathname.startsWith('/board') &&
        !url.pathname.startsWith('/slips')) {
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
      res.end('Authentication required.');
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
          await addPick(propId, side);
        }
        return redirect(res, back);
      }
      if (url.pathname === '/pick/remove') {
        const id = Number(body.get('pick_id'));
        if (Number.isFinite(id)) await removePick(id);
        return redirect(res, back);
      }
      if (url.pathname === '/slip/clear') {
        await clearOpenSlip();
        return redirect(res, back);
      }
      if (url.pathname === '/slip/place') {
        const stakeRaw = body.get('stake');
        const stake = stakeRaw && stakeRaw.trim() !== '' ? Number(stakeRaw) : null;
        const id = await placeSlip({
          name: body.get('name')?.trim() || null,
          entryType: body.get('entry_type') || 'power',
          stake: Number.isFinite(stake as number) ? (stake as number) : null,
        });
        return redirect(res, id ? '/slips' : back);
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    // ---- reads ----
    const known = await leagues();
    const requested = url.searchParams.get('league');
    const league = requested && known.includes(requested) ? requested : null;

    if (url.pathname === '/board') {
      const bookParam = url.searchParams.get('book');
      const bookFilter = bookParam === 'prizepicks' || bookParam === 'underdog' ? bookParam : null;
      const [rows, picks, h] = await Promise.all([board(league, bookFilter), openPicks(), health(league)]);
      return html(res, boardPage({ league, leagues: known, book: bookFilter, rows, picks, health: h }));
    }

    if (url.pathname === '/slips') {
      const list = await slips();
      const byId = await slipPicks(list.map((s) => s.id));
      const [picks, h] = await Promise.all([openPicks(), health(null)]);
      return html(res, slipsPage({ leagues: known, list, byId, picks, health: h }));
    }

    if (url.pathname === '/') {
      const [dis, mov, h, picks] = await Promise.all([
        disagreements(league), movements(league), health(league), openPicks(),
      ]);
      return html(res, page({ league, leagues: known, dis, mov, health: h, picks }));
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    console.error('request failed:', (err as Error).message);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Dashboard failed to render. Check the logs.');
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
