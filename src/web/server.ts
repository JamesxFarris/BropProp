import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { pool } from '../db.js';
import { disagreements, movements, health, leagues } from './queries.js';
import { page } from './render.js';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = 'public';
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(path: string) {
  // Reject traversal before touching the filesystem.
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  if (safe.includes('..')) return null;
  try {
    const body = await readFile(join(PUBLIC, safe));
    return { body, type: MIME[extname(safe)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/healthz') {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }

    if (url.pathname !== '/') {
      const file = await serveStatic(url.pathname);
      if (file) {
        res.writeHead(200, { 'content-type': file.type, 'cache-control': 'public, max-age=300' });
        res.end(file.body);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
      return;
    }

    const known = await leagues();
    const requested = url.searchParams.get('league');
    // Ignore an unknown league rather than rendering a confidently empty board.
    const league = requested && known.includes(requested) ? requested : null;

    const [dis, mov, h] = await Promise.all([
      disagreements(league),
      movements(league),
      health(league),
    ]);

    const html = page({ league, leagues: known, dis, mov, health: h });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (err) {
    console.error('request failed:', (err as Error).message);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Dashboard failed to render. Check the logs.');
  }
});

server.listen(PORT, () => console.log(`BropProp dashboard on http://localhost:${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
