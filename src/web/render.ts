import type { Disagreement, Movement, Health } from './queries.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1);
const num = (n: unknown) => (n === null || n === undefined ? '—' : Number(n).toFixed(1));
const maps = (a: number, b: number) => (a === b ? `MAP ${a}` : `MAPS ${a}–${b}`);

const STAT_ABBR: Record<string, string> = {
  kills: 'KILLS', headshots: 'HS', assists: 'AST', fantasy_points: 'FP', deaths: 'DEA',
};
const stat = (s: string) => STAT_ABBR[s] ?? s.toUpperCase();

function ago(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** Scale a magnitude bar against the largest gap on screen. */
const bar = (v: number, max: number, cls: string) =>
  `<span class="${cls}" style="width:${Math.max(2, (Math.abs(v) / (max || 1)) * 84).toFixed(0)}px"></span>`;

function disagreementRows(rows: Disagreement[]): string {
  if (rows.length === 0) {
    return `<div class="empty">No disagreements right now. Either the books agree on every
      matched market, or only one of them currently has a board up.</div>`;
  }
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.delta))));
  const body = rows
    .map((r) => {
      const d = Number(r.delta);
      const cls = d > 0 ? 'pos' : 'neg';
      // A lower line is the cheaper side of the same market: if PrizePicks posts
      // 28.0 where Underdog posts 30.5, the over is cheaper on PP and the under
      // is cheaper on UD. Name the play rather than making him derive it.
      const play = d < 0 ? 'OVER PP' : 'OVER UD';
      const playCls = d < 0 ? 'neg' : 'pos';
      return `<tr>
        <td class="player">${esc(r.handle)}</td>
        <td><span class="tag">${esc(stat(r.stat))}</span></td>
        <td class="muted hide-sm">${esc(maps(r.map_start, r.map_end))}</td>
        <td class="num">${num(r.pp_line)}</td>
        <td class="num">${num(r.ud_line)}</td>
        <td class="delta ${cls}">${signed(d)}</td>
        <td class="bar">${bar(d, max, cls)}</td>
        <td><span class="side ${playCls}">${play}</span></td>
        <td class="dim hide-sm">${esc(r.match_title ?? '—')}</td>
        <td class="muted num hide-sm">${ago(r.confirmed_at)}</td>
      </tr>`;
    })
    .join('');
  return `<div class="scroll"><table>
    <thead><tr>
      <th>Player</th><th>Stat</th><th class="hide-sm">Range</th>
      <th class="num">PrizePicks</th><th class="num">Underdog</th>
      <th class="num">Delta</th><th></th><th>Play</th>
      <th class="hide-sm">Match</th><th class="num hide-sm">Seen</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

function movementRows(rows: Movement[]): string {
  if (rows.length === 0) {
    return `<div class="empty">Nothing has moved yet. Movement only exists once a line has been
      observed at two different values, so this fills in as the logger runs.
      <b>Give it a few hours.</b></div>`;
  }
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.move))));
  const body = rows
    .map((r) => {
      const mv = Number(r.move);
      const cls = mv > 0 ? 'pos' : 'neg';
      return `<tr>
        <td class="player">${esc(r.handle)}</td>
        <td><span class="tag">${esc(r.book === 'prizepicks' ? 'PP' : 'UD')}</span></td>
        <td><span class="tag">${esc(stat(r.stat))}</span></td>
        <td class="muted hide-sm">${esc(maps(r.map_start, r.map_end))}</td>
        <td class="num dim">${num(r.opened)}</td>
        <td class="num">${num(r.latest)}</td>
        <td class="delta ${cls}">${signed(mv)}</td>
        <td class="bar">${bar(mv, max, cls)}</td>
        <td class="muted num">${r.observations}</td>
        <td class="dim hide-sm">${esc(r.match_title ?? '—')}</td>
        <td class="muted num hide-sm">${ago(r.last_at)}</td>
      </tr>`;
    })
    .join('');
  return `<div class="scroll"><table>
    <thead><tr>
      <th>Player</th><th>Book</th><th>Stat</th><th class="hide-sm">Range</th>
      <th class="num">Open</th><th class="num">Now</th><th class="num">Move</th><th></th>
      <th class="num">Obs</th><th class="hide-sm">Match</th><th class="num hide-sm">Moved</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

export function page(opts: {
  league: string | null;
  leagues: string[];
  dis: Disagreement[];
  mov: Movement[];
  health: Health;
}): string {
  const { league, leagues, dis, mov, health } = opts;
  const pollAge = health.last_ok_poll
    ? (Date.now() - new Date(health.last_ok_poll).getTime()) / 1000
    : Infinity;
  // Two missed polls at the default cadence: what's on screen is no longer
  // something to bet off, and the page should say so rather than look calm.
  const stale = pollAge > 1800;

  const tab = (href: string, label: string, active: boolean) =>
    `<a href="${href}"${active ? ' aria-current="page"' : ''}>${esc(label)}</a>`;

  const spread = dis.length
    ? Math.max(...dis.map((d) => Math.abs(Number(d.delta)))).toFixed(1)
    : '0.0';

  const since = health.logging_since
    ? new Date(health.logging_since).toISOString().slice(0, 16).replace('T', ' ')
    : '—';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BropProp — ${esc(league ?? 'All')} board</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <h1 class="wordmark">BropProp <span>/ cross-book</span></h1>
    <div class="clock">
      <span class="pulse${stale ? ' stale' : ''}">${stale ? 'stale' : 'live'} · ${ago(health.last_ok_poll)} ago</span>
      <span>${new Date().toISOString().slice(11, 19)}Z</span>
    </div>
  </header>

  <nav class="rail">
    ${tab('/', 'All', league === null)}
    ${leagues.map((l) => tab(`/?league=${encodeURIComponent(l)}`, l, league === l)).join('')}
    <span class="spacer"></span>
    <button type="button" id="theme">Theme</button>
  </nav>

  ${stale ? `<div class="warn">Last successful poll was ${ago(health.last_ok_poll)} ago — these lines may no longer be current. Check the logger.</div>` : ''}
  ${health.failing_books ? `<div class="warn">Poll failures in the last hour: ${esc(health.failing_books)}.</div>` : ''}

  <section class="panel">
    <div class="panel-head">
      <h2>Disagreements</h2>
      <span class="note">${dis.length} of ${health.matched} matched markets</span>
    </div>
    ${disagreementRows(dis)}
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Movement</h2>
      <span class="note">since first logged</span>
    </div>
    ${movementRows(mov)}
  </section>

  <footer class="readout">
    <span>Matched <b>${health.matched}</b></span>
    <span>Disagree <b>${dis.length}</b></span>
    <span>Spread <b>±${spread}</b></span>
    <span>Moved <b>${mov.length}</b></span>
    <span>Props <b>${health.props_tracked}</b></span>
    <span>Snapshots <b>${health.snapshots}</b></span>
    <span>Since <b>${since}</b></span>
  </footer>

</div>
<script>
  // Theme is a per-viewer convenience; storage throws in some private modes.
  try {
    var t = localStorage.getItem('bp-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
  document.getElementById('theme').addEventListener('click', function () {
    var el = document.documentElement;
    var cur = el.getAttribute('data-theme');
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (dark ? 'light' : 'dark');
    el.setAttribute('data-theme', next);
    try { localStorage.setItem('bp-theme', next); } catch (e) {}
  });
  // Refresh on roughly the poll cadence, but never mid-selection: reloading
  // would yank a line out from under someone who is reading it.
  setInterval(function () {
    if (String(window.getSelection() || '').length === 0) location.reload();
  }, 60000);
</script>
</body>
</html>`;
}
