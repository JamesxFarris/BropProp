import type { Movement, Health } from './queries.js';
import type { PickRow, SlipSummary } from './picks.js';
import type { MarketRow, PropHistory } from './boardq.js';
import type { Projection } from './projection.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1);
const num = (n: unknown) => (n === null || n === undefined ? '—' : Number(n).toFixed(1));
const maps = (a: number, b: number) => (a === b ? `Map ${a}` : `Maps ${a}–${b}`);

const STAT_LABEL: Record<string, string> = {
  kills: 'Kills', headshots: 'Headshots', assists: 'Assists',
  fantasy_points: 'Fantasy', deaths: 'Deaths',
};
const statLabel = (s: string) => STAT_LABEL[s] ?? s.replace(/_/g, ' ');

const bookName = (b: string) => (b === 'prizepicks' ? 'PrizePicks' : 'Underdog');
const otherBook = (b: string) => (b === 'prizepicks' ? 'underdog' : 'prizepicks');

const LEAGUE_CLASS: Record<string, string> = { CS2: 'cs2', LOL: 'lol' };
const leagueBadge = (l: string) =>
  `<span class="lg ${LEAGUE_CLASS[l] ?? 'other'}">${esc(l)}</span>`;

function ago(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function starts(iso: string | null): string {
  if (!iso) return '—';
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s < 0) return 'Started';
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Leg-count payouts are a starting point, not a quote.
 *
 * PrizePicks pays correlated legs differently and demotes individual props, so
 * a flat rate per leg count is wrong often enough that prefilling it as fact
 * would be misleading. The field is left empty and these are offered as a hint
 * only; whatever gets typed is what is stored on the slip.
 */
const BASE_PAYOUTS: Record<string, Record<number, number>> = {
  power:  { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 },
  flex:   { 3: 2.25, 4: 5, 5: 10, 6: 25 },
  single: { 1: 1.9 },
};
const basePayout = (type: string, legs: number) => BASE_PAYOUTS[type]?.[legs] ?? null;

/**
 * Legs from the same match on the same app. PrizePicks reprices these rather
 * than paying the standard rate, which is the most common reason the real
 * payout differs from the leg-count table.
 */
function correlatedGroups(picks: PickRow[]): number {
  const seen = new Map<string, number>();
  for (const p of picks) {
    if (p.match_id === null) continue;
    const key = `${p.book}:${p.match_id}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).length;
}

// ------------------------------------------------------------------ shell --

type Filters = {
  league: string | null; book: string | null; matched: boolean;
  search: string | null; best: boolean;
};

function qs(f: Partial<Filters>, base: Filters): string {
  const merged = { ...base, ...f };
  const p = new URLSearchParams();
  if (merged.league) p.set('league', merged.league);
  if (merged.book) p.set('book', merged.book);
  if (merged.matched) p.set('matched', '1');
  if (merged.search) p.set('q', merged.search);
  if (merged.best === false) p.set('best', '0');
  return p.toString() ? `?${p}` : '';
}

function filterBar(path: string, f: Filters, leagues: string[], locked: string | null = null): string {
  const a = (href: string, label: string, on: boolean, cls = '') =>
    `<a class="${cls}" href="${esc(path + href)}"${on ? ' aria-current="page"' : ''}>${label}</a>`;

  const leagueBtns = [
    a(qs({ league: null }, f), 'All', f.league === null),
    ...leagues.map((l) =>
      a(
        qs({ league: l }, f),
        `<span class="swatch"></span>${esc(l)}`,
        f.league === l,
        LEAGUE_CLASS[l] ?? '',
      ),
    ),
  ].join('');

  // While a slip is open the app is decided by its first leg, so the control
  // reports that state rather than offering a switch that would be refused.
  const bookBtns = locked
    ? `<span class="seg-locked" aria-current="page">${bookName(locked)}</span>`
    : [
        a(qs({ book: null }, f), 'Both', f.book === null),
        a(qs({ book: 'prizepicks' }, f), 'PrizePicks', f.book === 'prizepicks'),
        a(qs({ book: 'underdog' }, f), 'Underdog', f.book === 'underdog'),
      ].join('');

  return `
  <div class="filters">
    <div class="group"><span class="lab">League</span><nav class="seg">${leagueBtns}</nav></div>
    <div class="group"><span class="lab">App</span><nav class="seg">${bookBtns}</nav>${
      locked ? '<span class="lab">set by your slip</span>' : ''
    }</div>
    <div class="group"><nav class="seg">
      ${
        f.book
          ? a(qs({ best: !f.best }, f), 'Best price only', f.best)
          : a(qs({ matched: !f.matched }, f), 'On both apps', f.matched)
      }
    </nav></div>
    <form class="search" method="get" action="${esc(path)}">
      ${f.league ? `<input type="hidden" name="league" value="${esc(f.league)}">` : ''}
      ${f.book ? `<input type="hidden" name="book" value="${esc(f.book)}">` : ''}
      ${f.matched ? '<input type="hidden" name="matched" value="1">' : ''}
      <input name="q" value="${esc(f.search ?? '')}" placeholder="Player or match" aria-label="Search players or matches">
    </form>
  </div>`;
}

function shell(o: {
  title: string;
  active: 'board' | 'signal' | 'slips' | 'none';
  health: Health;
  filters?: string;
  rail?: string;
  body: string;
}): string {
  const stale = o.health.last_ok_poll
    ? (Date.now() - new Date(o.health.last_ok_poll).getTime()) / 1000 > 1800
    : true;

  const tab = (href: string, label: string, on: boolean) =>
    `<a href="${href}"${on ? ' aria-current="page"' : ''}>${label}</a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BropProp — ${esc(o.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/app.css">
</head>
<body>

<header class="top">
  <div class="top-in">
    <h1 class="brand">BropProp <em>${esc(o.title)}</em></h1>
    <nav class="tabs">
      ${tab('/board', 'Board', o.active === 'board')}
      ${tab('/', 'Edges', o.active === 'signal')}
      ${tab('/slips', 'Slips', o.active === 'slips')}
    </nav>
    <span class="grow"></span>
    <span class="status${stale ? ' stale' : ''}"><span class="dot"></span>${
      stale ? `Lines ${ago(o.health.last_ok_poll)}` : `Updated ${ago(o.health.last_ok_poll)}`
    }</span>
    <button type="button" class="icon-btn" id="theme">Theme</button>
  </div>
</header>

${o.filters ?? ''}

${
  o.health.failing_books
    ? `<div class="banner-wrap"><div class="banner">Polling failed for ${esc(o.health.failing_books)} in the last hour. Lines may be out of date.</div></div>`
    : ''
}

<main class="page${o.rail ? ' with-rail' : ''}">
  <div>${o.body}</div>
  ${o.rail ? `<aside class="rail">${o.rail}</aside>` : ''}
</main>

<footer class="foot">
  <span>Markets on both apps <b>${o.health.matched}</b></span>
  <span>Props tracked <b>${o.health.props_tracked}</b></span>
  <span>Line changes recorded <b>${o.health.snapshots}</b></span>
  <span>Logging since <b>${
    o.health.logging_since
      ? new Date(o.health.logging_since).toISOString().slice(0, 16).replace('T', ' ')
      : '—'
  }</b></span>
</footer>

<script>
  try {
    var t = localStorage.getItem('bp-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
  // Payout preview updates as the stake or multiplier is typed.
  (function () {
    var f = document.getElementById('slipform');
    if (!f) return;
    var stake = document.getElementById('stake');
    var mult = document.getElementById('multiplier');
    var out = document.getElementById('towin');
    function calc() {
      var s = parseFloat(stake.value), m = parseFloat(mult.value);
      out.textContent = (isFinite(s) && isFinite(m)) ? (s * m).toFixed(2) : '—';
    }
    stake.addEventListener('input', calc);
    mult.addEventListener('input', calc);
    calc();
  })();
  document.getElementById('theme').addEventListener('click', function () {
    var el = document.documentElement, cur = el.getAttribute('data-theme');
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (dark ? 'light' : 'dark');
    el.setAttribute('data-theme', next);
    try { localStorage.setItem('bp-theme', next); } catch (e) {}
  });
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------- slip --

function slipRail(picks: PickRow[], back: string): string {
  if (picks.length === 0) {
    return `<div class="card">
      <div class="card-head"><h2>Your slip</h2></div>
      <div class="empty">No legs yet. Press <strong>O</strong> or <strong>U</strong> on any
        market to add one. Each leg records the line at the moment you take it.</div>
    </div>`;
  }

  const legs = picks
    .map((p) => {
      const cur = p.current_line === null ? null : Number(p.current_line);
      const drift = cur === null ? 0 : cur - Number(p.line_at_pick);
      return `<div class="leg">
        <div style="min-width:0">
          <div class="l1">
            ${leagueBadge(p.league)}
            <span class="nm">${esc(p.handle)}</span>
          </div>
          <div class="l2">${esc(statLabel(p.stat))} · ${esc(maps(p.map_start, p.map_end))} · ${esc(
            p.book === 'prizepicks' ? 'PrizePicks' : 'Underdog',
          )}</div>
        </div>
        <div style="text-align:right">
          <span class="pickside ${p.side === 'over' ? 'o' : 'u'}">${p.side === 'over' ? 'Over' : 'Under'}</span>
          <div class="fig sm">${num(p.line_at_pick)}${
            drift !== 0
              ? ` <span class="move ${drift > 0 ? 'up' : 'down'}">${signed(drift)}</span>`
              : ''
          }</div>
        </div>
        <form method="post" action="/pick/remove" class="inline">
          <input type="hidden" name="pick_id" value="${p.id}">
          <input type="hidden" name="back" value="${esc(back)}">
          <button class="rm" aria-label="Remove ${esc(p.handle)}">×</button>
        </form>
      </div>`;
    })
    .join('');

  const n = picks.length;
  const base = basePayout('power', n);
  const correlated = correlatedGroups(picks);

  return `<div class="card">
    <div class="card-head">
      <h2>Your slip</h2>
      <span class="sub">${n} leg${n === 1 ? '' : 's'}</span>
    </div>
    <div class="slip-legs">${legs}</div>
    <form method="post" action="/slip/place" class="payout" id="slipform">
      <div class="row">
        <div class="field">
          <label for="entry_type">Entry</label>
          <select name="entry_type" id="entry_type">
            <option value="power">Power play</option>
            <option value="flex">Flex play</option>
            <option value="single">Single</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="stake">Stake</label>
          <input name="stake" id="stake" inputmode="decimal" placeholder="0.00">
        </div>
        <div class="field">
          <label for="multiplier">Multiplier</label>
          <input name="multiplier" id="multiplier" inputmode="decimal"
                 placeholder="${base ?? ''}" aria-describedby="multhint">
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="slipname">Label</label>
          <input name="name" id="slipname" maxlength="80" placeholder="Optional">
        </div>
      </div>
      <p class="hint" id="multhint">${
        correlated > 0
          ? `Legs from the same match are on this slip, so PrizePicks will likely reprice it. Copy the multiplier from your app.`
          : base === null
            ? `Copy the multiplier from your app.`
            : `Standard is ${base}× for ${n} legs, but demoted or correlated props pay differently — copy what your app shows.`
      }</p>
      <div class="towin">
        <span class="k">To win</span>
        <span class="big" id="towin">—</span>
      </div>
      <button class="go">Place slip</button>
    </form>
    <form method="post" action="/slip/clear" style="padding:0 14px 12px">
      <input type="hidden" name="back" value="${esc(back)}">
      <button class="link">Clear all legs</button>
    </form>
  </div>`;
}

/**
 * PrizePicks and Underdog are separate books — a single entry cannot draw legs
 * from both. Once a slip has its first leg the board narrows to that app, and
 * this says so, because otherwise the missing column just looks like a bug.
 */
function lockNotice(locked: string | null, blocked: string | null): string {
  if (blocked) {
    return `<div class="notice warn-notice">
      That prop is on ${esc(bookName(blocked === 'prizepicks' ? 'underdog' : 'prizepicks'))},
      but your slip is on ${esc(bookName(blocked))}. Entries can't mix the two apps —
      clear the slip to switch.</div>`;
  }
  if (locked) {
    return `<div class="notice">
      Showing ${esc(bookName(locked))} only, because your slip started there, and only the
      markets where it prices better than ${esc(bookName(otherBook(locked)))}. A lower line is
      the better over and a higher line the better under, so just one side of each market is
      offered. Turn off <strong>Best price only</strong> to see everything, or clear the slip
      to switch apps.</div>`;
  }
  return '';
}

/**
 * Recent form: what this player has actually totalled over the same map range.
 *
 * Sample size is shown next to the number and never hidden. Six series is a
 * different claim from twenty, and a projection presented without its sample
 * invites exactly the confidence it hasn't earned.
 */
function formCell(p: Projection | undefined): string {
  if (!p) return '<span class="meta">—</span>';
  return `<div class="fig sm">${p.mean.toFixed(1)}</div>
    <div class="meta">${p.series} series${
      p.hitRate !== null && p.series >= 4
        ? ` · ${Math.round(p.hitRate * 100)}% over`
        : ''
    }</div>`;
}

/**
 * How far this book's line sits from the player's average. Shown small and
 * beside the line rather than as a verdict: it's one input, and with these
 * sample sizes it is not yet a reason on its own.
 */
function leanMark(p: Projection | undefined): string {
  if (!p || p.edge === null || p.series < 4) return '';
  if (Math.abs(p.edge) < 0.5) return '';
  return ` <span class="lean ${p.edge > 0 ? 'up' : 'down'}">${signed(p.edge)}</span>`;
}

// ------------------------------------------------------------------ board --

/**
 * `offer` limits which sides are takeable. A lower line is the better over and
 * a higher line the better under, so on any market where the two apps differ,
 * exactly one side is the best available price on this app — offering the
 * other one is offering a worse number than you could get.
 */
function ouButtons(
  propId: number | null,
  back: string,
  picked: string | null,
  offer: 'both' | 'over' | 'under' = 'both',
  better: 'both' | 'over' | 'under' = 'both',
): string {
  if (propId === null) {
    return `<div class="ou"><button disabled>O</button><button disabled>U</button></div>`;
  }
  const b = (side: 'over' | 'under', label: string, cls: string) => {
    if (offer !== 'both' && offer !== side) {
      return `<button class="${cls}" disabled
        title="The ${side} is a better number on the other app">${label}</button>`;
    }
    // Marked, not filled: "this is the side this app prices better" is a
    // different statement from "you have taken this", so they can't look alike.
    const mark = better === side ? ' best' : '';
    const why = better === side ? ` (better price than the other app)` : '';
    return `<form method="post" action="/pick" class="inline">
      <input type="hidden" name="prop_id" value="${propId}">
      <input type="hidden" name="side" value="${side}">
      <input type="hidden" name="back" value="${esc(back)}">
      <button class="${cls}${mark}${picked === side ? ' on' : ''}"
        title="Take ${side}${why}">${label}</button>
    </form>`;
  };
  return `<div class="ou">${b('over', 'O', 'o')}${b('under', 'U', 'u')}</div>`;
}

/** Which side of a market is the better price on `book`. */
function bestSide(book: string, delta: number | null): 'both' | 'over' | 'under' {
  if (delta === null || delta === 0) return 'both';
  const ppCheaper = delta < 0;
  if (book === 'prizepicks') return ppCheaper ? 'over' : 'under';
  return ppCheaper ? 'under' : 'over';
}

export function boardPage(o: {
  rows: MarketRow[];
  picks: PickRow[];
  health: Health;
  leagues: string[];
  filters: Filters;
  lockedBook: string | null;
  blocked: string | null;
  form?: Map<string, Projection>;
}): string {
  const back = `/board${qs({}, o.filters)}`;
  const proj = (r: MarketRow, line: number | null) =>
    line === null
      ? undefined
      : o.form?.get(`${r.canon_handle}|${r.stat}|${r.map_start}|${r.map_end}|${line}`);

  // One app selected (by filter or by an open slip) means one column. Showing
  // the other app's line with live take buttons offered a pick that cannot
  // join this entry.
  const only = o.lockedBook ?? o.filters.book;
  const showPP = only === null || only === 'prizepicks';
  const showUD = only === null || only === 'underdog';
  const gapLabel = only ? `vs ${bookName(otherBook(only))}` : 'Gap';
  // Restrict sides only when an app is selected and best-price filtering is on.
  const restrict = Boolean(only) && o.filters.best;

  const body =
    o.rows.length === 0
      ? `<div class="card"><div class="empty">Nothing matches these filters.
         Try clearing the search, or switching back to <strong>Both</strong> apps — many
         markets are only listed on one of them.</div></div>`
      : `<div class="card">
      <div class="card-head">
        <h2>Board</h2>
        <span class="sub">${o.rows.length} markets${
          restrict
            ? ' · showing only the side each app prices better'
            : ' · the outlined side is the better price on that app'
        }</span>
      </div>
      <div class="scroll"><table>
        <thead><tr>
          <th>Player</th>
          <th>Market</th>
          <th class="n">Form</th>
          ${showPP ? '<th class="n">PrizePicks</th>' : ''}
          <th class="c">${gapLabel}</th>
          ${showUD ? '<th class="n">Underdog</th>' : ''}
          <th class="hide-sm">Match</th>
          <th class="n hide-md">Starts</th>
        </tr></thead>
        <tbody>${o.rows
          .map((r) => {
            const d = r.delta === null ? null : Number(r.delta);
            const gap =
              d === null
                ? `<span class="gap-chip flat">—</span>`
                : d === 0
                  ? `<span class="gap-chip flat">same</span>`
                  : `<span class="gap-chip ${d > 0 ? 'up' : 'down'}">${signed(d)}</span>`;
            const moved = r.moved === null ? null : Number(r.moved);
            const histId = r.pp_prop_id ?? r.ud_prop_id;
            return `<tr>
            <td>
              <div class="who">
                ${leagueBadge(r.league)}
                <div>
                  <div class="name">${
                    histId ? `<a href="/prop/${histId}">${esc(r.handle)}</a>` : esc(r.handle)
                  }</div>
                  ${
                    moved !== null && moved !== 0
                      ? `<div class="meta">moved <span class="move ${moved > 0 ? 'up' : 'down'}">${signed(moved)}</span> since open</div>`
                      : ''
                  }
                </div>
                ${r.is_combo ? '<span class="chip warn">Combo</span>' : ''}
              </div>
            </td>
            <td>
              <div class="sub2">${esc(statLabel(r.stat))}</div>
              <div class="meta">${esc(maps(r.map_start, r.map_end))}</div>
            </td>
            <td class="n">${formCell(proj(r, r.pp_line) ?? proj(r, r.ud_line))}</td>
            ${
              showPP
                ? `<td class="n"><div class="bookcell">
                <span class="fig${r.pp_line === null ? ' muted' : ''}">${num(r.pp_line)}${leanMark(proj(r, r.pp_line))}</span>
                ${ouButtons(r.pp_prop_id, back, r.pp_side,
                  restrict ? bestSide('prizepicks', r.delta === null ? null : Number(r.delta)) : 'both',
                  bestSide('prizepicks', r.delta === null ? null : Number(r.delta)))}
              </div></td>`
                : ''
            }
            <td class="c">${gap}</td>
            ${
              showUD
                ? `<td class="n"><div class="bookcell">
                <span class="fig${r.ud_line === null ? ' muted' : ''}">${num(r.ud_line)}${leanMark(proj(r, r.ud_line))}</span>
                ${ouButtons(r.ud_prop_id, back, r.ud_side,
                  restrict ? bestSide('underdog', r.delta === null ? null : Number(r.delta)) : 'both',
                  bestSide('underdog', r.delta === null ? null : Number(r.delta)))}
              </div></td>`
                : ''
            }
            <td class="match hide-sm"><span class="sub2" title="${esc(r.match_title ?? '')}">${esc(r.match_title ?? '—')}</span></td>
            <td class="n hide-md"><span class="meta">${starts(r.scheduled_at)}</span></td>
          </tr>`;
          })
          .join('')}</tbody>
      </table></div>
    </div>`;

  return shell({
    title: 'Board',
    active: 'board',
    health: o.health,
    filters: filterBar('/board', o.filters, o.leagues, o.lockedBook),
    rail: slipRail(o.picks, back),
    body: lockNotice(o.lockedBook, o.blocked) + body,
  });
}

// ------------------------------------------------------------------ edges --

export function edgesPage(o: {
  rows: MarketRow[];
  mov: Movement[];
  picks: PickRow[];
  health: Health;
  leagues: string[];
  filters: Filters;
  lockedBook: string | null;
  blocked: string | null;
}): string {
  const back = `/${qs({}, o.filters)}`;
  const gaps = o.rows.filter((r) => r.delta !== null && Number(r.delta) !== 0);

  const gapsCard =
    gaps.length === 0
      ? `<div class="card"><div class="card-head"><h2>Where the apps disagree</h2></div>
         <div class="empty">The apps agree on every market they both list right now.
         Disagreements appear here as soon as one of them moves.</div></div>`
      : `<div class="card">
      <div class="card-head">
        <h2>Where the apps disagree</h2>
        <span class="sub">${gaps.length} of ${o.health.matched} shared markets</span>
      </div>
      <div class="scroll"><table>
        <thead><tr>
          <th>Player</th><th>Market</th>
          <th class="n">PrizePicks</th><th class="c">Gap</th><th class="n">Underdog</th>
          <th>Better side</th><th class="hide-sm">Match</th>
        </tr></thead>
        <tbody>${gaps
          .map((r) => {
            const d = Number(r.delta);
            // The lower of two lines is the cheaper over; name the side rather
            // than leaving it to be worked out per row.
            const cheaper = d < 0 ? 'Over on PrizePicks' : 'Over on Underdog';
            const cls = d < 0 ? 'o' : 'u';
            const histId = r.pp_prop_id ?? r.ud_prop_id;
            return `<tr>
            <td><div class="who">${leagueBadge(r.league)}
              <div class="name">${histId ? `<a href="/prop/${histId}">${esc(r.handle)}</a>` : esc(r.handle)}</div>
              ${r.is_combo ? '<span class="chip warn">Combo</span>' : ''}</div></td>
            <td><div class="sub2">${esc(statLabel(r.stat))}</div>
                <div class="meta">${esc(maps(r.map_start, r.map_end))}</div></td>
            <td class="n"><div class="bookcell"><span class="fig">${num(r.pp_line)}</span>
              ${
                o.lockedBook === 'underdog'
                  ? ''
                  : ouButtons(r.pp_prop_id, back, r.pp_side, 'both',
                      bestSide('prizepicks', r.delta === null ? null : Number(r.delta)))
              }</div></td>
            <td class="c"><span class="gap-chip ${d > 0 ? 'up' : 'down'}">${signed(d)}</span></td>
            <td class="n"><div class="bookcell"><span class="fig">${num(r.ud_line)}</span>
              ${
                o.lockedBook === 'prizepicks'
                  ? ''
                  : ouButtons(r.ud_prop_id, back, r.ud_side, 'both',
                      bestSide('underdog', r.delta === null ? null : Number(r.delta)))
              }</div></td>
            <td><span class="pickside ${cls}" style="padding:4px 9px;border-radius:4px;font-size:13px;font-weight:600">${cheaper}</span></td>
            <td class="match hide-sm"><span class="sub2" title="${esc(r.match_title ?? '')}">${esc(r.match_title ?? '—')}</span></td>
          </tr>`;
          })
          .join('')}</tbody></table></div>
    </div>`;

  const movCard =
    o.mov.length === 0
      ? `<div class="card"><div class="card-head"><h2>Lines on the move</h2></div>
         <div class="empty">Nothing has moved yet. A line only counts as moved once it has been
         seen at two different values, so this fills in as the logger runs.</div></div>`
      : `<div class="card">
      <div class="card-head"><h2>Lines on the move</h2>
        <span class="sub">largest move first</span></div>
      <div class="scroll"><table>
        <thead><tr><th>Player</th><th>Market</th><th>App</th>
          <th class="n">Opened</th><th class="n">Now</th><th class="c">Move</th>
          <th class="n">Changes</th><th class="hide-sm">Match</th></tr></thead>
        <tbody>${o.mov
          .map((r) => {
            const mv = Number(r.move);
            return `<tr>
            <td><div class="who">${leagueBadge(r.league)}
              <div class="name"><a href="/prop/${r.prop_id ?? ''}">${esc(r.handle)}</a></div></div></td>
            <td><div class="sub2">${esc(statLabel(r.stat))}</div>
                <div class="meta">${esc(maps(r.map_start, r.map_end))}</div></td>
            <td><span class="chip">${r.book === 'prizepicks' ? 'PrizePicks' : 'Underdog'}</span></td>
            <td class="n"><span class="fig sm muted">${num(r.opened)}</span></td>
            <td class="n"><span class="fig sm">${num(r.latest)}</span></td>
            <td class="c"><span class="gap-chip ${mv > 0 ? 'up' : 'down'}">${signed(mv)}</span></td>
            <td class="n"><span class="meta">${r.observations}</span></td>
            <td class="hide-sm"><span class="sub2">${esc(r.match_title ?? '—')}</span></td>
          </tr>`;
          })
          .join('')}</tbody></table></div>
    </div>`;

  return shell({
    title: 'Edges',
    active: 'signal',
    health: o.health,
    filters: filterBar('/', o.filters, o.leagues, o.lockedBook),
    rail: slipRail(o.picks, back),
    body: lockNotice(o.lockedBook, o.blocked) + gapsCard + movCard,
  });
}

// ---------------------------------------------------------------- history --

/**
 * Line movement as an area chart. Every point is a real observed change —
 * snapshots are only written when a value moves — so the steps are the actual
 * shape of the market, not a resampling of it.
 */
function chart(points: { observed_at: string; line: number }[]): string {
  const W = 720, H = 240, L = 46, R = 14, T = 16, B = 30;
  if (points.length < 2) return '';

  const xs = points.map((p) => new Date(p.observed_at).getTime());
  const ys = points.map((p) => Number(p.line));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (lo === hi) { lo -= 1; hi += 1; }        // a flat line still needs a band
  const pad = (hi - lo) * 0.18;
  lo -= pad; hi += pad;

  const px = (t: number) => L + ((t - x0) / (x1 - x0 || 1)) * (W - L - R);
  const py = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // Step path: the line held its value until the moment it changed.
  let d = `M ${px(xs[0]!).toFixed(1)} ${py(ys[0]!).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${px(xs[i]!).toFixed(1)} ${py(ys[i - 1]!).toFixed(1)}`;
    d += ` L ${px(xs[i]!).toFixed(1)} ${py(ys[i]!).toFixed(1)}`;
  }
  const area = `${d} L ${px(xs[xs.length - 1]!).toFixed(1)} ${py(lo).toFixed(1)} L ${px(xs[0]!).toFixed(1)} ${py(lo).toFixed(1)} Z`;

  const ticks = [hi - pad, (hi + lo) / 2, lo + pad];
  const grid = ticks
    .map(
      (v) =>
        `<line x1="${L}" y1="${py(v).toFixed(1)}" x2="${W - R}" y2="${py(v).toFixed(1)}"
              stroke="currentColor" stroke-opacity=".12"/>
         <text x="${L - 8}" y="${(py(v) + 4).toFixed(1)}" text-anchor="end"
               font-size="12" fill="currentColor" fill-opacity=".55"
               font-family="IBM Plex Mono, monospace">${v.toFixed(1)}</text>`,
    )
    .join('');

  const lastX = px(xs[xs.length - 1]!), lastY = py(ys[ys.length - 1]!);

  return `<svg viewBox="0 0 ${W} ${H}" role="img"
       aria-label="Line movement from ${ys[0]!.toFixed(1)} to ${ys[ys.length - 1]!.toFixed(1)}">
    ${grid}
    <path d="${area}" fill="currentColor" fill-opacity=".08"/>
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linejoin="round" stroke-opacity=".85"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4.5" fill="currentColor"/>
    <text x="${L}" y="${H - 8}" font-size="12" fill="currentColor" fill-opacity=".55"
          font-family="IBM Plex Mono, monospace">${clock(points[0]!.observed_at)}</text>
    <text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="12" fill="currentColor"
          fill-opacity=".55" font-family="IBM Plex Mono, monospace">${clock(points[points.length - 1]!.observed_at)}</text>
  </svg>`;
}

export function historyPage(o: {
  hist: PropHistory;
  siblings: { prop_id: number; book: string; line: number }[];
  picks: PickRow[];
  health: Health;
}): string {
  const pts = o.hist.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const move = first && last ? Number(last.line) - Number(first.line) : 0;

  const fact = (k: string, v: string, cls = '') =>
    `<div class="fact"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;

  const body = `<div class="card">
    <div class="hist-head">
      ${leagueBadge(o.hist.league)}
      <span class="name">${esc(o.hist.handle)}</span>
      <span class="chip">${esc(statLabel(o.hist.stat))}</span>
      <span class="chip">${esc(maps(o.hist.map_start, o.hist.map_end))}</span>
      <span class="chip">${o.hist.book === 'prizepicks' ? 'PrizePicks' : 'Underdog'}</span>
      <span class="grow"></span>
    </div>
    <div class="facts">
      ${fact('Match', esc(o.hist.match_title ?? '—'), 'txt')}
      ${fact('Starts', starts(o.hist.scheduled_at), 'txt')}
      ${first ? fact('Opened at', Number(first.line).toFixed(1)) : ''}
      ${last ? fact('Now', Number(last.line).toFixed(1)) : ''}
      ${fact('Move', signed(move), move > 0 ? 'move up' : move < 0 ? 'move down' : '')}
      ${fact('Changes recorded', String(pts.length))}
    </div>
    ${
      pts.length < 2
        ? `<div class="empty">This line hasn't moved since it was first recorded
           ${first ? `at ${clock(first.observed_at)}` : ''}. A chart appears once there are
           two different values. Only movement since logging began on this app is shown —
           nothing before that exists.</div>`
        : `<div class="chart">${chart(pts)}</div>`
    }
  </div>

  ${
    o.siblings.length > 1
      ? `<div class="card">
    <div class="card-head"><h2>Same market on both apps</h2></div>
    <div class="scroll"><table><tbody>${o.siblings
      .map(
        (s) => `<tr>
        <td><span class="chip">${s.book === 'prizepicks' ? 'PrizePicks' : 'Underdog'}</span></td>
        <td class="n"><span class="fig">${Number(s.line).toFixed(1)}</span></td>
        <td class="n"><a class="meta" href="/prop/${s.prop_id}">View history</a></td>
      </tr>`,
      )
      .join('')}</tbody></table></div></div>`
      : ''
  }

  <div class="card">
    <div class="card-head"><h2>Player results</h2></div>
    <div class="empty">Hit rate and recent performance need match results, which aren't being
      collected yet. This is the next thing being built — until then, only line movement is
      real and nothing here is estimated.</div>
  </div>`;

  return shell({
    title: 'Line history',
    active: 'none',
    health: o.health,
    rail: slipRail(o.picks, `/prop/${o.hist.prop_id}`),
    body,
  });
}

// ------------------------------------------------------------------ slips --

export function slipsPage(o: {
  list: SlipSummary[];
  byId: Record<number, PickRow[]>;
  picks: PickRow[];
  health: Health;
}): string {
  const body =
    o.list.length === 0
      ? `<div class="card"><div class="card-head"><h2>Placed slips</h2></div>
         <div class="empty">No slips yet. Take props on the <strong>Board</strong>, then place the
         slip. Each leg keeps the line you took it at, which is what makes results
         checkable later.</div></div>`
      : o.list
          .map((s) => {
            const legs = o.byId[s.id] ?? [];
            const stake = s.stake === null ? null : Number(s.stake);
            const mult = s.payout_multiplier === null ? null : Number(s.payout_multiplier);
            return `<div class="card">
        <div class="card-head">
          <h2>${esc(s.name || `Slip ${s.id}`)}</h2>
          <span class="sub">${
            s.placed_at ? new Date(s.placed_at).toISOString().slice(0, 16).replace('T', ' ') : ''
          }</span>
        </div>
        <div class="facts" style="padding-top:14px">
          <div class="fact"><div class="k">App</div><div class="v txt">${
            s.book === 'mixed' ? 'Mixed' : s.book === 'prizepicks' ? 'PrizePicks' : 'Underdog'
          }</div></div>
          <div class="fact"><div class="k">Entry</div><div class="v txt">${esc(s.entry_type)}</div></div>
          <div class="fact"><div class="k">Legs</div><div class="v">${s.legs}</div></div>
          <div class="fact"><div class="k">Stake</div><div class="v">${
            stake === null ? '—' : stake.toFixed(2)
          }</div></div>
          <div class="fact"><div class="k">To win</div><div class="v">${
            stake !== null && mult !== null ? (stake * mult).toFixed(2) : '—'
          }</div></div>
          <div class="fact"><div class="k">Status</div><div class="v txt pending">${
            s.pending === s.legs ? 'Awaiting results' : `${s.won}W / ${s.lost}L`
          }</div></div>
        </div>
        <div class="scroll"><table><tbody>${legs
          .map(
            (p) => `<tr>
          <td><div class="who">${leagueBadge(p.league)}<span class="name">${esc(p.handle)}</span></div></td>
          <td><div class="sub2">${esc(statLabel(p.stat))}</div>
              <div class="meta">${esc(maps(p.map_start, p.map_end))}</div></td>
          <td><span class="pickside ${p.side === 'over' ? 'o' : 'u'}" style="padding:3px 8px;border-radius:4px;font-size:13px;font-weight:600">${
            p.side === 'over' ? 'Over' : 'Under'
          }</span></td>
          <td class="n"><span class="fig">${num(p.line_at_pick)}</span></td>
          <td><span class="chip">${p.book === 'prizepicks' ? 'PP' : 'UD'}</span></td>
          <td class="hide-sm"><span class="sub2">${esc(p.match_title ?? '—')}</span></td>
          <td class="n"><span class="meta pending">${esc(p.status)}</span></td>
        </tr>`,
          )
          .join('')}</tbody></table></div>
      </div>`;
          })
          .join('');

  return shell({
    title: 'Slips',
    active: 'slips',
    health: o.health,
    rail: slipRail(o.picks, '/slips'),
    body,
  });
}
