import type { Disagreement, Movement, Health } from './queries.js';
import type { BoardRow, PickRow, SlipSummary } from './picks.js';

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
const bookAbbr = (b: string) => (b === 'prizepicks' ? 'PP' : b === 'underdog' ? 'UD' : b.toUpperCase());

function ago(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function startsIn(iso: string | null): string {
  if (!iso) return '—';
  const secs = (new Date(iso).getTime() - Date.now()) / 1000;
  if (secs < 0) return 'live';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

const bar = (v: number, max: number, cls: string) =>
  `<span class="${cls}" style="width:${Math.max(2, (Math.abs(v) / (max || 1)) * 84).toFixed(0)}px"></span>`;

/**
 * Over/under buttons. Plain forms rather than fetch: taking a prop must work
 * even if a script fails to load, and Post/Redirect/Get means a refresh never
 * double-adds a leg.
 */
function take(propId: number, back: string, picked: string | null): string {
  const btn = (side: 'over' | 'under', label: string) => `
    <form method="post" action="/pick" class="inline">
      <input type="hidden" name="prop_id" value="${propId}">
      <input type="hidden" name="side" value="${side}">
      <input type="hidden" name="back" value="${esc(back)}">
      <button class="take ${side}${picked === side ? ' on' : ''}" title="Take ${side}">${label}</button>
    </form>`;
  return `<div class="takes">${btn('over', 'O')}${btn('under', 'U')}</div>`;
}

/** The open slip: what you're about to take, and whether it has moved since. */
function slipPanel(picks: PickRow[], back: string): string {
  if (picks.length === 0) return '';
  const rows = picks
    .map((p) => {
      const cur = p.current_line === null ? null : Number(p.current_line);
      const taken = Number(p.line_at_pick);
      const drift = cur === null ? 0 : cur - taken;
      // A leg whose line moved after you took it is the single most useful
      // thing to see before locking: you may already have the better number,
      // or the market may have run away from you.
      const driftCell =
        cur === null || drift === 0
          ? '<span class="muted">—</span>'
          : `<span class="delta ${drift > 0 ? 'pos' : 'neg'}">${signed(drift)}</span>`;
      return `<tr>
        <td class="player">${esc(p.handle)}</td>
        <td><span class="tag">${bookAbbr(p.book)}</span></td>
        <td><span class="tag">${esc(stat(p.stat))}</span></td>
        <td class="muted hide-sm">${esc(maps(p.map_start, p.map_end))}</td>
        <td><span class="side ${p.side === 'over' ? 'pos' : 'neg'}">${p.side.toUpperCase()}</span></td>
        <td class="num">${num(p.line_at_pick)}</td>
        <td class="num">${driftCell}</td>
        <td class="dim hide-sm">${esc(p.match_title ?? '—')}</td>
        <td class="muted num hide-sm">${startsIn(p.scheduled_at)}</td>
        <td class="num">
          <form method="post" action="/pick/remove" class="inline">
            <input type="hidden" name="pick_id" value="${p.id}">
            <input type="hidden" name="back" value="${esc(back)}">
            <button class="x" title="Remove leg">×</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return `
  <section class="panel slip">
    <div class="panel-head">
      <h2>Open slip</h2>
      <span class="note">${picks.length} leg${picks.length === 1 ? '' : 's'} · line shown is the line taken</span>
    </div>
    <div class="scroll"><table><tbody>${rows}</tbody></table></div>
    <form method="post" action="/slip/place" class="slipform">
      <input name="name" placeholder="Label (optional)" maxlength="80">
      <select name="entry_type">
        <option value="power">Power</option>
        <option value="flex">Flex</option>
        <option value="single">Single</option>
      </select>
      <input name="stake" placeholder="Stake" inputmode="decimal" size="6">
      <button class="primary">Place slip</button>
      <span class="spacer"></span>
    </form>
    <form method="post" action="/slip/clear" class="inline">
      <input type="hidden" name="back" value="${esc(back)}">
      <button class="ghost">Discard slip</button>
    </form>
  </section>`;
}

function shell(opts: {
  title: string;
  active: 'signal' | 'board' | 'slips';
  league: string | null;
  leagues: string[];
  health: Health;
  extraRail?: string;
  body: string;
}): string {
  const { title, active, league, leagues, health, body, extraRail = '' } = opts;
  const pollAge = health.last_ok_poll
    ? (Date.now() - new Date(health.last_ok_poll).getTime()) / 1000
    : Infinity;
  const stale = pollAge > 1800;

  const nav = (href: string, label: string, on: boolean) =>
    `<a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  const q = league ? `?league=${encodeURIComponent(league)}` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BropProp — ${esc(title)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <h1 class="wordmark">BropProp <span>/ ${esc(title)}</span></h1>
    <div class="clock">
      <span class="pulse${stale ? ' stale' : ''}">${stale ? 'stale' : 'live'} · ${ago(health.last_ok_poll)} ago</span>
      <span>${new Date().toISOString().slice(11, 19)}Z</span>
    </div>
  </header>

  <nav class="rail">
    ${nav(`/${q}`, 'Signal', active === 'signal')}
    ${nav(`/board${q}`, 'Board', active === 'board')}
    ${nav('/slips', 'Slips', active === 'slips')}
    <span class="div"></span>
    ${extraRail}
    <span class="spacer"></span>
    <button type="button" id="theme">Theme</button>
  </nav>

  ${stale ? `<div class="warn">Last successful poll was ${ago(health.last_ok_poll)} ago — these lines may no longer be current.</div>` : ''}
  ${health.failing_books ? `<div class="warn">Poll failures in the last hour: ${esc(health.failing_books)}.</div>` : ''}

  ${body}

  <footer class="readout">
    <span>Matched <b>${health.matched}</b></span>
    <span>Props <b>${health.props_tracked}</b></span>
    <span>Snapshots <b>${health.snapshots}</b></span>
    <span>Since <b>${health.logging_since ? new Date(health.logging_since).toISOString().slice(0, 16).replace('T', ' ') : '—'}</b></span>
  </footer>

</div>
<script>
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
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- signal ----

function disagreementRows(rows: Disagreement[], back: string): string {
  if (rows.length === 0) {
    return `<div class="empty">No disagreements right now. Either the books agree on every
      matched market, or only one of them currently has a board up.</div>`;
  }
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.delta))));
  const body = rows
    .map((r) => {
      const d = Number(r.delta);
      const cls = d > 0 ? 'pos' : 'neg';
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
        <td><span class="tag">${bookAbbr(r.book)}</span></td>
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
  picks: PickRow[];
}): string {
  const { league, leagues, dis, mov, health, picks } = opts;
  const back = league ? `/?league=${encodeURIComponent(league)}` : '/';
  const spread = dis.length
    ? Math.max(...dis.map((d) => Math.abs(Number(d.delta)))).toFixed(1)
    : '0.0';

  const leagueTabs = [
    `<a href="/"${league === null ? ' aria-current="page"' : ''}>All</a>`,
    ...leagues.map(
      (l) => `<a href="/?league=${encodeURIComponent(l)}"${league === l ? ' aria-current="page"' : ''}>${esc(l)}</a>`,
    ),
  ].join('');

  return shell({
    title: 'cross-book', active: 'signal', league, leagues, health, extraRail: leagueTabs,
    body: `
  ${slipPanel(picks, back)}

  <section class="panel">
    <div class="panel-head">
      <h2>Disagreements</h2>
      <span class="note">${dis.length} of ${health.matched} matched · spread ±${spread}</span>
    </div>
    ${disagreementRows(dis, back)}
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Movement</h2>
      <span class="note">since first logged</span>
    </div>
    ${movementRows(mov)}
  </section>`,
  });
}

// ----------------------------------------------------------------- board ----

export function boardPage(opts: {
  league: string | null;
  leagues: string[];
  book: string | null;
  rows: BoardRow[];
  picks: PickRow[];
  health: Health;
}): string {
  const { league, leagues, book, rows, picks, health } = opts;
  const params = new URLSearchParams();
  if (league) params.set('league', league);
  if (book) params.set('book', book);
  const back = `/board${params.toString() ? `?${params}` : ''}`;

  const link = (l: string | null, b: string | null, label: string, on: boolean) => {
    const p = new URLSearchParams();
    if (l) p.set('league', l);
    if (b) p.set('book', b);
    return `<a href="/board${p.toString() ? `?${p}` : ''}"${on ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  };

  const tabs = [
    link(null, book, 'All', league === null),
    ...leagues.map((l) => link(l, book, l, league === l)),
    '<span class="div"></span>',
    link(league, null, 'Both', book === null),
    link(league, 'prizepicks', 'PP', book === 'prizepicks'),
    link(league, 'underdog', 'UD', book === 'underdog'),
  ].join('');

  const body =
    rows.length === 0
      ? `<div class="empty">No props on the board for this filter. Either the books have
         nothing up for these leagues right now, or every match has already started.</div>`
      : `<div class="scroll"><table>
    <thead><tr>
      <th>Player</th><th>Book</th><th>Stat</th><th class="hide-sm">Range</th>
      <th class="num">Line</th><th class="num">Other</th><th class="num">Δ</th>
      <th>Take</th>
      <th class="hide-sm">Match</th><th class="num hide-sm">Starts</th><th class="num hide-sm">Seen</th>
    </tr></thead><tbody>${rows
      .map((r) => {
        const other = r.other_line === null ? null : Number(r.other_line);
        const d = other === null ? null : Number(r.line) - other;
        const dCell =
          d === null || d === 0
            ? '<span class="muted">—</span>'
            : `<span class="delta ${d > 0 ? 'pos' : 'neg'}">${signed(d)}</span>`;
        return `<tr${r.picked_side ? ' class="picked"' : ''}>
        <td class="player">${esc(r.handle)}${r.is_combo ? ' <span class="tag combo" title="Combined stat line for multiple players">COMBO</span>' : ''}</td>
        <td><span class="tag">${bookAbbr(r.book)}</span></td>
        <td><span class="tag">${esc(stat(r.stat))}</span></td>
        <td class="muted hide-sm">${esc(maps(r.map_start, r.map_end))}</td>
        <td class="num strong">${num(r.line)}</td>
        <td class="num dim">${other === null ? '—' : num(other)}</td>
        <td class="num">${dCell}</td>
        <td>${take(r.prop_id, back, r.picked_side)}</td>
        <td class="dim hide-sm">${esc(r.match_title ?? '—')}</td>
        <td class="muted num hide-sm">${startsIn(r.scheduled_at)}</td>
        <td class="muted num hide-sm">${ago(r.confirmed_at)}</td>
      </tr>`;
      })
      .join('')}</tbody></table></div>`;

  return shell({
    title: 'board', active: 'board', league, leagues, health, extraRail: tabs,
    body: `
  ${slipPanel(picks, back)}
  <section class="panel">
    <div class="panel-head">
      <h2>Board</h2>
      <span class="note">${rows.length} markets · O/U adds a leg at the line shown</span>
    </div>
    ${body}
  </section>`,
  });
}

// ----------------------------------------------------------------- slips ----

export function slipsPage(opts: {
  leagues: string[];
  list: SlipSummary[];
  byId: Record<number, PickRow[]>;
  picks: PickRow[];
  health: Health;
}): string {
  const { leagues, list, byId, picks, health } = opts;

  const body =
    list.length === 0
      ? `<div class="empty">No slips placed yet. Take props on the <b>Board</b>, then place the
         slip — each leg records the line at the moment you took it, which is what makes
         results gradeable later.</div>`
      : list
          .map((s) => {
            const legs = byId[s.id] ?? [];
            const rows = legs
              .map(
                (p) => `<tr>
              <td class="player">${esc(p.handle)}</td>
              <td><span class="tag">${bookAbbr(p.book)}</span></td>
              <td><span class="tag">${esc(stat(p.stat))}</span></td>
              <td class="muted hide-sm">${esc(maps(p.map_start, p.map_end))}</td>
              <td><span class="side ${p.side === 'over' ? 'pos' : 'neg'}">${p.side.toUpperCase()}</span></td>
              <td class="num strong">${num(p.line_at_pick)}</td>
              <td><span class="tag">${esc(p.status.toUpperCase())}</span></td>
              <td class="dim hide-sm">${esc(p.match_title ?? '—')}</td>
            </tr>`,
              )
              .join('');
            const when = s.placed_at
              ? new Date(s.placed_at).toISOString().slice(0, 16).replace('T', ' ')
              : '—';
            return `<section class="panel">
        <div class="panel-head">
          <h2>${esc(s.name || `Slip #${s.id}`)}</h2>
          <span class="note">${esc(bookAbbr(s.book ?? 'mixed'))} · ${esc(s.entry_type)} ·
            ${s.legs} legs · ${s.stake === null ? 'no stake' : `stake ${Number(s.stake).toFixed(2)}`} ·
            ${s.pending} pending · ${when}</span>
        </div>
        <div class="scroll"><table><tbody>${rows}</tbody></table></div>
      </section>`;
          })
          .join('');

  return shell({
    title: 'slips', active: 'slips', league: null, leagues, health,
    body: `${slipPanel(picks, '/slips')}
    ${list.length === 0 ? `<section class="panel"><div class="panel-head"><h2>Placed slips</h2></div>${body}</section>` : body}
    <div class="note-block">Legs stay <b>PENDING</b> until results grading lands (phase 2).
      Nothing here is scored yet — the record is being kept so it <em>can</em> be.</div>`,
  });
}
