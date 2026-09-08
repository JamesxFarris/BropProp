import type { Movement, Health } from './queries.js';
import type { PickRow, SlipSummary } from './picks.js';
import type { MarketRow, PropHistory, PlayerGame } from './boardq.js';
import type { FormStats, Play, CallStatus, NoCall } from './projection.js';
import { evaluate, edgeProgress, type LineOption, flatBreakEven } from './projection.js';
import type { Entry } from './optimize.js';
import { isComboHandle } from '../normalize.js';
import { devig } from '../devig.js';

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

/** Stats a projection can be built from. Fantasy points use a scoring formula
 *  the books don't publish, so deriving one would be a guess. */
const PROJECTABLE = new Set(['kills', 'headshots', 'assists', 'deaths']);

/**
 * The Combo mark, driven by the handle rather than by the book's flag.
 *
 * PrizePicks sets `combo` on single players too, and a row reading `eraa`
 * beside a chip saying Combo is a plain lie about what the market is. The
 * handle is what actually names the players, so it is what the chip follows.
 */
const comboChip = (r: { handle: string }) =>
  isComboHandle(r.handle) ? ' <span class="chip warn">Combo</span>' : '';

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

/**
 * Kick-off time.
 *
 * The server renders the timezone-independent part ("in 3h") so the row is
 * correct with scripts blocked, and tags the timestamp for the browser to
 * upgrade to the reader's own clock. Rendering an absolute time server-side
 * would show Railway's UTC to someone sitting in Eastern.
 */
function whenCell(iso: string | null): string {
  if (!iso) return '<span class="when">time tbd</span>';
  return `<span class="when" data-at="${esc(iso)}">${starts(iso)}</span>`;
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

/**
 * `show` is the answer to "half this board isn't doing anything".
 *
 * A market the model priced as FAIR and a market it could not price at all are
 * not the same row, and one toggle could not say both. Measured on 2026-09-07:
 * of 465 markets, 22 carried a call, 27 were priced fair, and 386 were waiting
 * on stat history. Fifty-five minutes later, after a CS2 backfill, the same
 * board carried 278 calls and 89 waiting. Nothing about the markets changed —
 * so a filter that hid "no call" would have hidden the backfill too.
 *
 *   all    everything, dead rows sunk to the bottom (default)
 *   live   markets the model could actually evaluate — hides the ones waiting
 *          on data, keeps the ones it priced as fair
 *   calls  only markets with a call
 */
type ShowMode = 'all' | 'live' | 'calls';

type Filters = {
  league: string | null; book: string | null; matched: boolean;
  search: string | null; best: boolean; show: ShowMode;
};

function qs(f: Partial<Filters>, base: Filters): string {
  const merged = { ...base, ...f };
  const p = new URLSearchParams();
  if (merged.league) p.set('league', merged.league);
  if (merged.book) p.set('book', merged.book);
  if (merged.matched) p.set('matched', '1');
  if (merged.search) p.set('q', merged.search);
  if (merged.best === false) p.set('best', '0');
  if (merged.show !== 'all') p.set('show', merged.show);
  return p.toString() ? `?${p}` : '';
}

function filterBar(path: string, f: Filters, leagues: string[], locked: string | null = null): string {
  const a = (href: string, label: string, on: boolean, cls = '') =>
    `<a class="${cls}" href="${esc(path + href)}"${on ? ' aria-current="page"' : ''}>${label}</a>`;

  const leagueBtns = [
    a(qs({ league: null }, f), 'All', f.league === null),
    ...leagues.map((l) =>
      a(qs({ league: l }, f), esc(l), f.league === l, LEAGUE_CLASS[l] ?? ''),
    ),
  ].join('');

  // While a slip is open the app is decided by its first leg, so the control
  // reports that state rather than offering a switch that would be refused.
  const bookBtns = locked
    ? `<span class="seg-locked" aria-current="page">${bookName(locked)}</span>`
    : [
        // PrizePicks leads because it is the default. "Both" has to name
        // itself in the URL now that an absent param means PrizePicks.
        a(qs({ book: 'prizepicks' }, f), 'PrizePicks', f.book === 'prizepicks'),
        a(qs({ book: 'underdog' }, f), 'Underdog', f.book === 'underdog'),
        a(qs({ book: 'both' }, f), 'Both', f.book === null),
      ].join('');

  return `
  <div class="filters">
    <div class="group"><span class="lab">League</span><nav class="seg">${leagueBtns}</nav></div>
    <div class="group"><span class="lab">App</span><nav class="seg">${bookBtns}</nav>${
      locked ? '<span class="lab">set by your slip</span>' : ''
    }</div>
    <div class="group"><span class="lab">Show</span><nav class="seg">
      ${a(qs({ show: 'all' }, f), 'All', f.show === 'all')}
      ${a(qs({ show: 'live' }, f), 'Priced', f.show === 'live')}
      ${a(qs({ show: 'calls' }, f), 'With a call', f.show === 'calls')}
    </nav></div>
    <div class="group"><nav class="seg">
      ${
        f.book
          ? a(qs({ best: !f.best }, f), 'Best price only', f.best)
          : a(qs({ matched: !f.matched }, f), 'On both apps', f.matched)
      }
    </nav></div>
    <form class="search" method="get" action="${esc(path)}"
          data-live data-q="${esc(f.search ?? '')}">
      ${f.league ? `<input type="hidden" name="league" value="${esc(f.league)}">` : ''}
      ${f.book ? `<input type="hidden" name="book" value="${esc(f.book)}">` : ''}
      ${f.matched ? '<input type="hidden" name="matched" value="1">' : ''}
      ${f.show !== 'all' ? `<input type="hidden" name="show" value="${esc(f.show)}">` : ''}
      ${f.best === false ? '<input type="hidden" name="best" value="0">' : ''}
      <input name="q" type="search" value="${esc(f.search ?? '')}" autocomplete="off"
             enterkeyhint="search" placeholder="Player, match or stat"
             aria-label="Search players, matches or stats">
      <button class="search-go" type="submit" aria-label="Search">Search</button>
    </form>
  </div>`;
}

/**
 * Anything the live filter should be able to match a row on.
 *
 * Built server-side so the browser never has to guess which cell holds the
 * player: a continuation row deliberately omits the match title, and reading
 * it back out of the DOM would make those rows unsearchable.
 */
const rowKey = (...parts: (string | null | undefined)[]) =>
  esc(parts.filter(Boolean).join(' ').toLowerCase());

/** Polling cadence. Two of these with no successful run is the warning line. */
const POLL_INTERVAL_S = 900;

/**
 * How fresh the board is.
 *
 * A green dot said "fine" right up to the second it said "not fine", which is
 * the least useful thing a staleness indicator can do — the interesting part is
 * the approach, not the arrival. This is a depleting gauge instead: the fill is
 * the share of the two-interval budget already spent, so a board halfway to
 * overdue looks halfway to overdue. The age is written out next to it, because
 * a bar alone is a feeling and this page deals in numbers.
 */
function freshness(lastOk: string | null): string {
  const age = lastOk ? Math.max(0, (Date.now() - new Date(lastOk).getTime()) / 1000) : null;
  const budget = POLL_INTERVAL_S * 2;
  const level = age === null ? 'stale' : age > budget ? 'stale' : age > POLL_INTERVAL_S ? 'due' : 'ok';
  const pct = age === null ? 100 : Math.min(100, (age / budget) * 100);
  const title =
    age === null
      ? 'No successful poll on record.'
      : `Last successful poll ${ago(lastOk)}. Polls run every ${POLL_INTERVAL_S / 60} minutes; ` +
        `the gauge fills over two of them and turns red past that.`;
  return `<div class="fresh ${level}" title="${esc(title)}">
    <span class="fresh-k">Lines</span>
    <span class="fresh-v"${lastOk ? ` data-ok="${esc(lastOk)}"` : ''}>${
      age === null ? 'never' : ago(lastOk)
    }</span>
    <span class="fresh-gauge" role="img"
          aria-label="${esc(
            age === null ? 'No successful poll on record' : `Last poll ${ago(lastOk)}`,
          )}"><i style="width:${pct.toFixed(0)}%"></i></span>
    ${level === 'stale' ? '<span class="fresh-flag">overdue</span>' : ''}
  </div>`;
}

function shell(o: {
  title: string;
  active: 'board' | 'signal' | 'slips' | 'build' | 'none';
  health: Health;
  filters?: string;
  rail?: string;
  body: string;
}): string {
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#1a1816">
<link rel="stylesheet" href="/app.css">
</head>
<body>

<header class="top">
  <div class="top-in">
    <h1 class="brand">
      <a href="/board">Brop<span>Prop</span></a>
      <em>${esc(o.title)}</em>
    </h1>
    <nav class="tabs">
      ${tab('/board', 'Board', o.active === 'board')}
      ${tab('/build', 'Build', o.active === 'build')}
      ${tab('/', 'Edges', o.active === 'signal')}
      ${tab('/slips', 'Slips', o.active === 'slips')}
    </nav>
    <span class="grow"></span>
    ${freshness(o.health.last_ok_poll)}
    <button type="button" class="icon-btn" id="theme">Theme</button>
    <a class="icon-btn" href="/logout">Sign out</a>
  </div>
</header>

${o.filters ?? ''}

${
  o.health.failing_books
    ? `<div class="banner-wrap"><div class="banner">Polling failed for ${esc(o.health.failing_books)} in the last hour. Lines may be out of date.</div></div>`
    : ''
}

${o.rail ? '<input type="checkbox" id="slipsheet" class="sheet-toggle" aria-label="Show your slip">' : ''}
<main class="page${o.rail ? ' with-rail' : ''}">
  <div class="col">${o.body}</div>
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
  // Kick-off times in the reader's own timezone. The server can only know
  // UTC, so it renders the relative form and this fills in the clock time.
  (function () {
    var now = Date.now();
    document.querySelectorAll('.when[data-at]').forEach(function (el) {
      var t = new Date(el.getAttribute('data-at'));
      if (isNaN(t)) return;
      var mins = Math.round((t - now) / 60000);
      var sameDay = t.toDateString() === new Date(now).toDateString();
      var clock = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      var day = sameDay ? '' : t.toLocaleDateString([], { weekday: 'short' }) + ' ';
      var rel = mins < 0 ? 'started'
        : mins < 60 ? 'in ' + mins + 'm'
        : mins < 1440 ? 'in ' + Math.round(mins / 60) + 'h'
        : 'in ' + Math.round(mins / 1440) + 'd';
      el.textContent = day + clock + ', ' + rel;
      if (mins < 0) el.classList.add('started');
      el.title = t.toLocaleString();
    });
  })();

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
  // The freshness gauge keeps depleting while the tab sits open, so a board
  // left on a second monitor stops claiming it was updated a minute ago.
  (function () {
    var box = document.querySelector('.fresh');
    if (!box) return;
    var v = box.querySelector('.fresh-v');
    var fill = box.querySelector('.fresh-gauge > i');
    var at = v && v.getAttribute('data-ok');
    if (!at) return;
    var t = new Date(at).getTime();
    if (isNaN(t)) return;
    var BUDGET = ${POLL_INTERVAL_S * 2};
    function tick() {
      var s = Math.max(0, (Date.now() - t) / 1000);
      v.textContent = s < 60 ? Math.floor(s) + 's ago'
        : s < 3600 ? Math.floor(s / 60) + 'm ago'
        : s < 86400 ? Math.floor(s / 3600) + 'h ago'
        : Math.floor(s / 86400) + 'd ago';
      fill.style.width = Math.min(100, (s / BUDGET) * 100).toFixed(0) + '%';
      box.className = 'fresh ' + (s > BUDGET ? 'stale' : s > BUDGET / 2 ? 'due' : 'ok');
    }
    tick();
    setInterval(tick, 15000);
  })();

  // Search as you type. Read-only, and purely a narrowing of what the server
  // already sent: the form still submits on Enter, so with scripts blocked the
  // box behaves exactly as it did before. Nothing here writes anything.
  (function () {
    var form = document.querySelector('form.search[data-live]');
    if (!form) return;
    var input = form.querySelector('input[name=q]');
    var tables = [].slice.call(document.querySelectorAll('table[data-filter]'));
    if (!input || !tables.length) return;
    form.classList.add('live');

    var groups = tables.map(function (t) {
      var card = t.closest('.card');
      return {
        rows: [].slice.call(t.querySelectorAll('tbody > tr[data-search]')),
        count: card && card.querySelector('[data-count]'),
        empty: card && card.querySelector('.live-empty'),
      };
    });

    function apply() {
      var term = input.value.trim().toLowerCase();
      groups.forEach(function (g) {
        var shown = 0;
        g.rows.forEach(function (r) {
          var hit = !term || r.getAttribute('data-search').indexOf(term) !== -1;
          r.classList.toggle('filtered-out', !hit);
          if (hit) shown++;
        });
        // A continuation row borrows its match and kick-off from the row above.
        // Once filtering can hide that row, the first survivor has to stand on
        // its own, so the table stops quietening repeats while a term is live.
        if (g.count) g.count.textContent = String(shown);
        if (g.empty) g.empty.hidden = shown > 0 || !term;
      });
      document.body.classList.toggle('searching', term.length > 0);
    }

    var pending;
    input.addEventListener('input', function () {
      clearTimeout(pending);
      pending = setTimeout(apply, 60);
    });
    if (input.value.trim()) apply();
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

/**
 * The bar the slip collapses to when the rail can't sit beside the board.
 *
 * A label driving a checkbox rather than a script: the slip is where the write
 * actions live, and those have to keep working with scripts blocked. The bar
 * carries the leg count and the app, because those are the two facts that
 * decide whether it's worth opening.
 */
function sheetBar(picks: PickRow[]): string {
  const n = picks.length;
  const app = picks[0] ? bookName(picks[0].book) : null;
  return `<label class="sheet-bar" for="slipsheet">
    <span class="sb-k">Your slip</span>
    ${
      n === 0
        ? '<span class="sb-none">empty</span>'
        : `<span class="sb-n">${n}</span><span class="sb-k">leg${n === 1 ? '' : 's'}</span>`
    }
    <span class="grow"></span>
    ${app ? `<span class="sb-app">${esc(app)}</span>` : ''}
    <span class="sb-caret" aria-hidden="true"></span>
  </label>`;
}

function slipRail(picks: PickRow[], back: string): string {
  if (picks.length === 0) {
    return `${sheetBar(picks)}<div class="sheet-body"><div class="card">
      <div class="card-head"><h2>Your slip</h2></div>
      <div class="empty">No legs yet. Press <strong>O</strong> or <strong>U</strong> on any
        market to add one. Each leg records the line at the moment you take it.</div>
    </div></div>`;
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
          <div class="l2">${esc(statLabel(p.stat))}, ${esc(maps(p.map_start, p.map_end).toLowerCase())} on ${esc(
            p.book === 'prizepicks' ? 'PrizePicks' : 'Underdog',
          )}</div>
        </div>
        <div style="text-align:right">
          <span class="pickside ${p.side === 'over' ? 'o' : 'u'}">${p.side === 'over' ? 'Over' : 'Under'}</span>
          <div class="fig sm">${num(p.line_at_pick)}${
            drift !== 0
              ? ` <span class="move ${drift > 0 ? 'up' : 'down'}">${signed(drift)}</span>`
              : ''
          }</div>${
            p.payout_mult !== null && Math.abs(Number(p.payout_mult) - 1) > 0.005
              ? `<div class="meta"><span class="est" title="This leg pays ${Number(p.payout_mult).toFixed(2)}x a standard one">${Number(p.payout_mult).toFixed(2)}×</span></div>`
              : ''
          }
        </div>
        <form method="post" action="/pick/remove" class="inline">
          <input type="hidden" name="pick_id" value="${p.id}">
          <input type="hidden" name="prop_id" value="${p.prop_id}">
          <input type="hidden" name="back" value="${esc(back)}">
          <button class="rm" aria-label="Remove ${esc(p.handle)}">×</button>
        </form>
      </div>`;
    })
    .join('');

  const n = picks.length;
  const base = basePayout('power', n);
  const correlated = correlatedGroups(picks);

  // Underdog attaches a payout multiplier to each side, and a discounted leg
  // drags the whole slip down — four legs at ~0.87 turn a 10x into about 5.7x.
  // That is published per leg, so the slip can work it out rather than asking.
  const legMults = picks.map((p) => (p.payout_mult === null ? 1 : Number(p.payout_mult)));
  const multProduct = legMults.reduce((a, b) => a * b, 1);
  const discounted = legMults.filter((m) => Math.abs(m - 1) > 0.005).length;
  const estimated = base === null ? null : base * multProduct;

  return `${sheetBar(picks)}<div class="sheet-body"><div class="card">
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
                 placeholder="${estimated !== null ? estimated.toFixed(2) : (base ?? '')}"
                 aria-describedby="multhint">
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="slipname">Label</label>
          <input name="name" id="slipname" maxlength="80" placeholder="Optional">
        </div>
      </div>
      <p class="hint" id="multhint">${
        discounted > 0 && estimated !== null
          ? `${discounted} of ${n} legs pay below standard, so ${base}× becomes about <b>${estimated.toFixed(2)}×</b>. Check it against your app.`
          : correlated > 0
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
  </div></div>`;
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
 * Sample size sits next to the number and is never hidden. Six series is a
 * different claim from twenty, and a projection shown without its sample
 * invites exactly the confidence it hasn't earned.
 */
/**
 * What the "ours" number rests on, in a few words under the chip.
 *
 * The figure alone is a claim; this is the evidence behind it, and it is the
 * difference between a number measured over the exact map range and one
 * modelled from single maps. Both are shown as one chip, so the note is where
 * the distinction has to live.
 */
function formNote(f: FormStats | undefined, play: Play | null): string {
  if (!f) return '';
  if (play?.method === 'maps' || f.series === 0) {
    return `per map, ${f.mapValues.length} maps`;
  }
  return `${f.series} series`;
}

/**
 * Expected value, where a price exists to compute it from.
 *
 * Only Underdog publishes per-side odds; PrizePicks charges through a flat
 * multiplier whose break-even depends on the slip's eventual leg count, so
 * there is no honest per-market number to print. A dash says that, where a
 * zero would claim we had priced it and found nothing.
 */
function evCell(play: Play | null): string {
  if (!play || play.ev === null) return '<span class="meta">—</span>';
  const pct = play.ev * 100;
  return `<span class="ev ${pct >= 0 ? 'pos' : 'neg'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
}

function formCell(f: FormStats | undefined, play: Play | null): string {
  if (!f) return '<span class="meta">—</span>';
  // Show the number the call was actually made from, and say which it is.
  if (play?.method === 'maps') {
    return `<div class="fig sm">${(f.perMap ?? 0).toFixed(1)}</div>
      <div class="meta">per map, from ${f.mapValues.length} maps</div>`;
  }
  if (f.series > 0) {
    return `<div class="fig sm">${f.mean.toFixed(1)}</div>
      <div class="meta">${f.series} series</div>`;
  }
  return `<div class="fig sm">${(f.perMap ?? 0).toFixed(1)}</div>
    <div class="meta">per map, from ${f.mapValues.length} maps</div>`;
}

/**
 * The call: which side, on which app.
 *
 * Direction is a question about the player — does their real output sit above
 * or below this number. App is a question about price — an over wants the
 * lowest line available, an under the highest. Answering them separately and
 * then combining is what makes a single row actionable.
 *
 * "No call" is a real answer and is shown as one. Most markets don't have an
 * edge worth naming, and inventing one for every row would make the column
 * worthless.
 */
/**
 * How good this line is, at a glance.
 *
 * Coloured by the side it recommends rather than by a fifth hue, so the far
 * left of the row already tells you both how strong the call is and which way
 * it goes. Size and weight carry the strength; the colour carries direction.
 *
 * It is a rank, not a probability. 60 beats 30; it is not a claim about how
 * often it wins — hit rate sits in the Play column for that.
 */
function scoreCell(play: Play | null): string {
  if (!play) return '<span class="score none">—</span>';
  const tier = play.score >= 50 ? 'hi' : play.score >= 25 ? 'mid' : 'lo';
  return `<span class="score ${tier}" title="How good this line looks, 1-99. A ranking, not a win probability.">${play.score}</span>`;
}

/**
 * The words for each kind of "no call".
 *
 * These used to be guessed at from the form object, which conflated a market
 * priced honestly with one the model could not evaluate at all — and told
 * every combo it had "no single-player line" long after combos gained one.
 * They come from the engine's own verdict now, so the page cannot disagree
 * with the thing that made the decision.
 */
function noCallText(why: NoCall, r: { stat: string; handle: string }): string {
  switch (why.kind) {
    case 'unsupported':
      return `${statLabel(r.stat)} — no scoring formula`;
    case 'unreadable':
      return `combo — can't read the players in "${r.handle}"`;
    case 'unavailable':
      return 'neither side offered';
    case 'none':
      return 'no history yet';
    case 'thin':
      return why.maps === 0
        ? `only ${why.series} full ${why.series === 1 ? 'series' : 'series'}`
        : `only ${why.maps} ${why.maps === 1 ? 'map' : 'maps'}`;
    case 'fair':
      // The number matters: 0.4 off is one line move from a call and 2.0 off
      // is not, and a single flat "no edge" hid that difference on every row.
      return `no edge · ${signed(why.edge)}`;
    case 'priced-out':
      // Names the price, not the model, because that is what has to move. We
      // think it wins; the odds want more than we think.
      return `priced out — needs ${(why.breakEven * 100).toFixed(0)}%, we say ${(why.p * 100).toFixed(0)}%`;
  }
}

function playCell(
  play: Play | null,
  why: NoCall | null,
  r: { is_combo: boolean; stat: string; handle: string },
  /** The single app on screen, if there is one. */
  only?: string | null,
): string {
  if (!play) {
    return `<span class="meta">${esc(why ? noCallText(why, r) : 'no call')}</span>`;
  }
  const dir = play.side === 'over' ? 'Over' : 'Under';
  const cls = play.side === 'over' ? 'o' : 'u';
  // The hit rate has its own column and the sample size sits under the "ours"
  // chip, so repeating either here was printing the same fact three times
  // across one row. What is left is the one thing neither column says: how far
  // the number is from the line, in the units the market is quoted in.
  const basis = play.method === 'maps' ? 'modelled' : '';
  // Name the app and its number only when more than one app is on screen.
  // With a single app the same figure already sits in the line column two
  // cells away, and printing it twice was most of why a row was hard to read.
  const at =
    only === null || only === undefined
      ? `<span class="at">${bookName(play.book) === 'PrizePicks' ? 'PP' : 'UD'} ${play.line.toFixed(1)}</span>`
      : '';
  return `<div class="play ${cls}">
      <span class="dir">${dir}</span>
      ${at}
    </div>
    <div class="meta">${signed(play.edge)} in your favour${basis ? `, ${basis}` : ''}${
      play.method === 'maps'
        ? ` <span class="est" title="Estimated by resampling ${play.sample} single maps, because too few series played this exact map range">est</span>`
        : ''
    }</div>`;
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
  available: { over: boolean; under: boolean } = { over: true, under: true },
): string {
  if (propId === null) {
    return `<div class="ou"><button disabled>O</button><button disabled>U</button></div>`;
  }
  const b = (side: 'over' | 'under', label: string, cls: string) => {
    // The book doesn't list this side at all — every Underdog assists market
    // is higher-only, and PrizePicks promo projections are over-only.
    // A bare "O" or "U" is meaningless read aloud, and `title` is not reliably
    // announced. Every one of these carries the same sentence as a real label.
    if (!available[side]) {
      const msg = `${side === 'over' ? 'Higher' : 'Lower'} isn't offered on this market`;
      return `<button class="${cls}" disabled title="${msg}" aria-label="${msg}">${label}</button>`;
    }
    if (offer !== 'both' && offer !== side) {
      const msg = `The ${side} is a better number on the other app`;
      return `<button class="${cls}" disabled title="${msg}" aria-label="${msg}">${label}</button>`;
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
        title="Take ${side}${why}"
        aria-label="Take ${side}${why}"
        aria-pressed="${picked === side ? 'true' : 'false'}">${label}</button>
    </form>`;
  };
  // The id is what the redirect after a pick scrolls back to. Taking a leg is
  // a form post and a redirect — that is what keeps it working with scripts
  // blocked — and a redirect otherwise lands at the top of a board hundreds of
  // rows long, so you lose your place on every single leg.
  return `<div class="ou" id="m${propId}">${b('over', 'O', 'o')}${b('under', 'U', 'u')}</div>`;
}

/** Which side of a market is the better price on `book`. */
function bestSide(book: string, delta: number | null): 'both' | 'over' | 'under' {
  if (delta === null || delta === 0) return 'both';
  const ppCheaper = delta < 0;
  if (book === 'prizepicks') return ppCheaper ? 'over' : 'under';
  return ppCheaper ? 'under' : 'over';
}

/**
 * Which sides are takeable on `book` — the single answer both pages use.
 *
 * `bestSide` says which side is the better price; this says which sides are
 * *offered*, and the difference is the whole bug it was written for. The board
 * restricted the offer, but the disagreements page passed "both" and used
 * bestSide only to paint a marker — so with a slip open on Underdog it still
 * offered the Underdog over while PrizePicks priced that same over lower.
 * Marking a side is advice; offering it is a button that takes the worse
 * number, and the two pages must not disagree about which they are doing.
 */
export function offeredSides(
  book: string,
  delta: number | null,
  restrict: boolean,
): 'both' | 'over' | 'under' {
  return restrict ? bestSide(book, delta) : 'both';
}

/**
 * Our hit rate minus the probability Underdog's price implies.
 *
 * Positive means we are more optimistic than the market. Null means one of the
 * two numbers does not exist — a market Underdog lists one way only cannot be
 * devigged, and a player with no history has no hit rate. Zero means they
 * agree, which is a different fact from either being missing and is kept
 * distinguishable from it.
 *
 * Deliberately not folded into `strength`. Ranking on this would present the
 * product of an uncalibrated frequency and a DFS book's risk management as an
 * edge. It is shown so the rows where the two disagree can be looked at.
 */
export function marketDisagreement(
  hitRate: number | null,
  marketProb: number | null,
): number | null {
  if (hitRate === null || marketProb === null) return null;
  return hitRate - marketProb;
}

/**
 * How far apart our number and the market's must be before the row is worth a
 * second look. Twenty points is wide enough that small-sample noise in our own
 * hit rate does not light up half the board.
 */
const MARKET_GAP = 0.20;

export function boardPage(o: {
  rows: MarketRow[];
  picks: PickRow[];
  health: Health;
  leagues: string[];
  filters: Filters;
  lockedBook: string | null;
  blocked: string | null;
  form?: Map<string, FormStats>;
}): string {
  const back = `/board${qs({}, o.filters)}`;
  const formOf = (r: MarketRow) =>
    o.form?.get(`${r.canon_handle}|${r.stat}|${r.map_start}|${r.map_end}`);
  // Narrowing to one app must narrow the recommendation too. Filtering to
  // PrizePicks and then being told to take it on Underdog is the filter not
  // working, however good the number is.
  const only = o.lockedBook ?? o.filters.book;

  /**
   * The bar a PrizePicks leg has to clear, taken from the entry being built.
   *
   * PrizePicks quotes no price, so its markets used to clear MIN_P and nothing
   * else — the price gate bit only on Underdog. Its price is real though; it
   * is charged on the entry rather than on the side. What a leg has to win is
   * therefore a function of how many legs it ends up beside, and the slip on
   * screen is the best available answer: one more than it already holds, and
   * at least the two an entry needs.
   *
   * This makes the board move as a slip grows, which is the honest behaviour.
   * A 55% leg that ruins a two-pick is fine on a five-pick, because 20x across
   * five legs asks less of each one than 3x across two.
   */
  const ppBreakEven = flatBreakEven(o.picks.length + 1);

  const optionsFor = (r: MarketRow): LineOption[] => {
    const opts: LineOption[] = [];
    if (r.pp_line !== null && only !== 'underdog') {
      opts.push({
        book: 'prizepicks', line: Number(r.pp_line),
        overOk: r.pp_over_ok, underOk: r.pp_under_ok,
        // No per-side price to read, so the bar comes from the entry this leg
        // would join. See ppBreakEven above.
        breakEven: ppBreakEven,
      });
    }
    if (r.ud_line !== null && only !== 'prizepicks') {
      opts.push({
        book: 'underdog', line: Number(r.ud_line),
        overOk: r.ud_over_ok, underOk: r.ud_under_ok,
        // Only Underdog publishes these. PrizePicks charges through a flat
        // multiplier, so it has no per-side price to clear.
        overPrice: r.ud_over_price === null ? null : Number(r.ud_over_price),
        underPrice: r.ud_under_price === null ? null : Number(r.ud_under_price),
      });
    }
    return opts;
  };
  // Evaluated once per row and kept. The modelled path resamples 4000 draws,
  // and the sort alone asks for each row's verdict a dozen times.
  const cache = new Map<MarketRow, CallStatus>();
  const statusOf = (r: MarketRow): CallStatus => {
    let s = cache.get(r);
    if (!s) {
      s = evaluate({
        form: formOf(r),
        options: optionsFor(r),
        maps: r.map_end - r.map_start + 1,
        seed: `${r.canon_handle}|${r.stat}|${r.map_start}|${r.map_end}`,
        stat: r.stat,
        handle: r.handle,
      });
      cache.set(r, s);
    }
    return s;
  };
  const playOf = (r: MarketRow) => statusOf(r).play;

  // Strongest calls first. The point of the board is to find the few markets
  // worth acting on, so making them the first thing on screen is the feature.
  //
  // Underneath them the order is by how close a row is to becoming one, which
  // is not the same as "no call" being one bucket. A market the model priced
  // as FAIR is live: it has the history behind it, and one line move puts it
  // in play. A market with no history is inert — no amount of line movement
  // will make it say anything until the stat feed catches up. So fair rows
  // sort above waiting rows, nearest-to-the-threshold first, and the rows that
  // can never speak sink to the bottom rather than being interleaved with the
  // ones that nearly do.
  //
  // Matches already under way sink below the rest whatever their score: the
  // line can't be taken any more, and a strong call you cannot act on at the
  // top of the board is worse than no call at all.
  const started = (r: MarketRow) =>
    r.scheduled_at !== null && new Date(r.scheduled_at).getTime() < Date.now();

  // A priced-out row sits directly under the calls: we have a view worth
  // acting on and only the odds are stopping it, so it is the row a price
  // move turns live. `fair` needs the line itself to move, which is slower.
  const TIER: Record<NoCall['kind'], number> = {
    'priced-out': 1, fair: 2, unavailable: 3, thin: 4, none: 5, unreadable: 5, unsupported: 6,
  };
  const tier = (r: MarketRow) => {
    const s = statusOf(r);
    return s.play ? 0 : TIER[s.why.kind];
  };
  // Within the fair tier: closest to MIN_EDGE first, since that is the row a
  // half-point line move turns into a call.
  const nearness = (r: MarketRow) => {
    const s = statusOf(r);
    return s.play === null && s.why.kind === 'fair' ? edgeProgress(s.why.p) : -1;
  };

  // A model that can't see a market is not the same as a market with no edge,
  // so hiding is offered at two strengths rather than one. Filtering happens
  // here rather than in SQL because whether a market has a call is decided by
  // the projection, not by anything the query can see.
  const visible =
    o.filters.show === 'calls'
      ? o.rows.filter((r) => playOf(r) !== null)
      : o.filters.show === 'live'
        ? o.rows.filter((r) => tier(r) <= 1)
        : o.rows;

  const ranked = [...visible].sort((a, b) => {
    const sa = started(a);
    const sb = started(b);
    if (sa !== sb) return sa ? 1 : -1;
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    const pa = playOf(a);
    const pb = playOf(b);
    if (pa && pb) return pb.strength - pa.strength;
    return nearness(b) - nearness(a);
  });

  // Why the board is as quiet as it is, in numbers. "No call" is a real answer
  // and this says which of the several answers it is, so a quiet board reads as
  // a state of the data rather than as a broken page — and so a stat feed
  // filling in is visible as it happens instead of a week later.
  const counts = { call: 0, fair: 0, unavailable: 0, waiting: 0, unsupported: 0 };
  for (const r of o.rows) {
    const s = statusOf(r);
    if (s.play) counts.call++;
    else if (s.why.kind === 'fair') counts.fair++;
    else if (s.why.kind === 'unavailable') counts.unavailable++;
    else if (s.why.kind === 'unsupported') counts.unsupported++;
    else counts.waiting++;
  }
  const summary = [
    `${counts.call} with a call`,
    counts.fair ? `${counts.fair} priced fair` : null,
    counts.waiting ? `${counts.waiting} waiting on history` : null,
    counts.unavailable ? `${counts.unavailable} with no takeable side` : null,
  ]
    .filter(Boolean)
    // Commas, not middle dots: `A · B · C` meta strings are the documented
    // tell the rebuild removed, and a reason breakdown is a sentence anyway.
    .join(', ');

  // One app selected (by filter or by an open slip) means one column. Showing
  // the other app's line with live take buttons offered a pick that cannot
  // join this entry.
  const showPP = only === null || only === 'prizepicks';
  const showUD = only === null || only === 'underdog';
  /**
   * EV needs a per-side price, and only Underdog publishes one.
   *
   * On the PrizePicks board — the default — every cell in that column was a
   * dash, which is a column of nothing occupying the width of a column of
   * something. Honest, and still noise. It appears when a book that prices
   * both sides is on screen and stays away when none is.
   */
  const showEv = only !== 'prizepicks';
  const gapLabel = only ? `vs ${bookName(otherBook(only))}` : 'Gap';
  // Restrict sides only when an app is selected and best-price filtering is on.
  const restrict = Boolean(only) && o.filters.best;

  const body =
    ranked.length === 0
      ? o.filters.show !== 'all' && o.rows.length > 0
        ? // The rows exist; this filter hid them. Say which of them it hid and
          // why, so an empty screen reads as a state of the data rather than
          // as a broken page.
          `<div class="card"><div class="empty">
           None of these ${o.rows.length} markets ${
             o.filters.show === 'calls' ? 'carries a call' : 'could be priced'
           } right now — ${esc(summary)}. Switch <strong>Show</strong> back to
           <strong>All</strong> to see them anyway; a market with no edge on our numbers
           is still a market you may have a reason to take.</div></div>`
        : `<div class="card"><div class="empty">Nothing matches these filters.
         Try clearing the search, or switching back to <strong>Both</strong> apps — many
         markets are only listed on one of them.</div></div>`
      : `<div class="card">
      <div class="card-head">
        <h2>Board</h2>
        <span class="sub"><b data-count>${ranked.length}</b>${
          o.filters.show !== 'all' ? ` of ${o.rows.length}` : ''
        } markets — ${summary}${
          restrict ? ', showing only the side each app prices better' : ''
        }</span>
      </div>
      <div class="scroll cards-sm"><table class="board-table stack-sm" data-filter>
        <thead><tr>
          <th scope="col">Player</th>
          <th scope="col">Prop</th>
          <th scope="col" class="c">Line</th>
          <th scope="col" class="c">Ours</th>
          <th scope="col" class="c">Lean</th>
          <th scope="col" class="c">Win %</th>
          ${showEv ? '<th scope="col" class="c evcol">EV</th>' : ''}
          ${showPP ? `<th scope="col" class="n">${only ? 'Take' : 'PrizePicks'}</th>` : ''}
          <th scope="col" class="c gapcol">${gapLabel}</th>
          ${showUD ? `<th scope="col" class="n">${only ? 'Take' : 'Underdog'}</th>` : ''}
        </tr></thead>
        <tbody>${ranked
          .map((r, i) => {
            const play = playOf(r);
            // Three markets on one player are three different bets, but
            // repeating the name, match and kick-off in full for each made them
            // read as duplicates. A continuation row keeps the identity quiet
            // and lets the market be the thing that differs.
            const sameAsPrev = i > 0 && ranked[i - 1]!.canon_handle === r.canon_handle;
            const d = r.delta === null ? null : Number(r.delta);
            const gap =
              d === null
                ? `<span class="gap-chip flat">—</span>`
                : d === 0
                  ? `<span class="gap-chip flat">same</span>`
                  : `<span class="gap-chip ${d > 0 ? 'up' : 'down'}">${signed(d)}</span>`;
            const moved = r.moved === null ? null : Number(r.moved);
            const histId = r.pp_prop_id ?? r.ud_prop_id;
            // Underdog's own price for the side we are calling, margin removed. Only
            // Underdog publishes odds, so this column is blank for a market it does
            // not list — which is honest: there is no market probability, rather
            // than a market that thinks the chance is zero.
            const fair = devig(r.ud_over_price, r.ud_under_price);
            // A market probability is a probability *of a side*. With no call
            // there is no side to price, so there is nothing honest to show —
            // falling through to "over" would silently pick a side the reader
            // never chose and display it under a header that does not say which.
            const marketProb = fair === null || play === null ? null : play.side === 'under' ? fair.under : fair.over;
            const gapToMarket = marketDisagreement(play?.hitRate ?? null, marketProb);
            // The two numbers the whole page exists to compare, set side by
            // side as chips rather than as a figure and a distant column: the
            // book's line, and what this player's own history says. A reader
            // should not have to hold one in their head to reach the other.
            const theirLine = play ? play.line : (only === 'underdog' ? r.ud_line : r.pp_line);
            const f = formOf(r);
            const ours = !f
              ? null
              : play?.method === 'maps' || f.series === 0
                ? f.perMap
                : f.mean;
            return `<tr data-search="${rowKey(r.handle, r.match_title, statLabel(r.stat), r.league)}">
            <td>
              <div class="who${sameAsPrev ? ' cont' : ''}">
                ${sameAsPrev ? '<span class="tick"></span>' : leagueBadge(r.league)}
                <div class="whobody">
                  <div class="name">${
                    histId ? `<a href="/prop/${histId}">${esc(r.handle)}</a>` : esc(r.handle)
                  }${comboChip(r)}</div>
                  ${
                    sameAsPrev
                      ? ''
                      : `<div class="meta matchline" title="${esc(r.match_title ?? '')}">${esc(
                          r.match_title ?? '—',
                        )}</div>
                  <div class="meta whenline">${whenCell(r.scheduled_at)}${
                          moved !== null && moved !== 0
                            ? `, moved <span class="move ${moved > 0 ? 'up' : 'down'}">${signed(moved)}</span>`
                            : ''
                        }</div>`
                  }
                </div>
              </div>
            </td>
            <td>
              <div class="statname">${esc(statLabel(r.stat))}</div>
              <div class="meta">${esc(maps(r.map_start, r.map_end))}</div>
            </td>
            <td class="c" data-label="Line">${
              theirLine === null
                ? '<span class="meta">—</span>'
                : `<span class="chip-num book">${Number(theirLine).toFixed(1)}</span>`
            }</td>
            <td class="c" data-label="Ours">${
              ours === null
                ? '<span class="meta">—</span>'
                : `<span class="chip-num model">${Number(ours).toFixed(1)}</span>
                   <div class="meta">${formNote(formOf(r), play)}</div>`
            }</td>
            <td class="c" data-label="Lean">${playCell(play, statusOf(r).why, r, only)}</td>
            <td class="c${play ? ` strength s${Math.min(4, Math.max(1, Math.ceil((play.hitRate - 0.5) * 20)))}` : ''}" data-label="Win %">${
              play === null
                ? '<span class="meta">—</span>'
                : `<div class="prob">${Math.round(play.hitRate * 100)}%</div>
                   <div class="meta${
                     gapToMarket !== null && Math.abs(gapToMarket) >= MARKET_GAP ? ' fairgap' : ''
                   }"${
                     gapToMarket !== null && Math.abs(gapToMarket) >= MARKET_GAP
                       ? ` title="${Math.round(Math.abs(gapToMarket) * 100)} points from what we think — worth a second look"`
                       : ''
                   }>${marketProb === null ? 'no market price' : `market ${Math.round(marketProb * 100)}%`}</div>`
            }</td>
            ${showEv ? `<td class="c evcol" data-label="EV">${evCell(play)}</td>` : ''}
            ${
              showPP
                ? `<td class="n bookcol" data-book="PrizePicks"><div class="bookcell">
                ${only ? '' : `<span class="fig${r.pp_line === null ? ' muted' : ''}">${num(r.pp_line)}</span>`}
                ${ouButtons(r.pp_prop_id, back, r.pp_side,
                  offeredSides('prizepicks', r.delta === null ? null : Number(r.delta), restrict),
                  play?.book === 'prizepicks' ? play.side : 'both',
                  { over: r.pp_over_ok, under: r.pp_under_ok })}
              </div></td>`
                : ''
            }
            <td class="c gapcol">${gap}</td>
            ${
              showUD
                ? `<td class="n bookcol" data-book="Underdog"><div class="bookcell">
                ${only ? '' : `<span class="fig${r.ud_line === null ? ' muted' : ''}">${num(r.ud_line)}</span>`}
                ${ouButtons(r.ud_prop_id, back, r.ud_side,
                  offeredSides('underdog', r.delta === null ? null : Number(r.delta), restrict),
                  play?.book === 'underdog' ? play.side : 'both',
                  { over: r.ud_over_ok, under: r.ud_under_ok })}
              </div></td>`
                : ''
            }
          </tr>`;
          })
          .join('')}</tbody>
      </table></div>
      <p class="live-empty" hidden>No market on this board matches what you typed.
        Press <strong>Enter</strong> to search every market instead.</p>
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
  // Same two lines as the board, and deliberately identical: an app chosen by
  // filter and an app forced by an open slip narrow this page the same way,
  // because the server has already collapsed the two into filters.book. Every
  // row here has a non-zero gap, so under a narrowed app exactly one side of
  // each is the better number — and only that one is offered.
  const only = o.lockedBook ?? o.filters.book;
  const restrict = Boolean(only) && o.filters.best;

  const gapsCard =
    gaps.length === 0
      ? `<div class="card"><div class="card-head"><h2>Where the apps disagree</h2></div>
         <div class="empty">The apps agree on every market they both list right now.
         Disagreements appear here as soon as one of them moves.</div></div>`
      : `<div class="card">
      <div class="card-head">
        <h2>Where the apps disagree</h2>
        <span class="sub"><b data-count>${gaps.length}</b> of ${o.health.matched} shared markets</span>
      </div>
      <div class="scroll cards-sm"><table class="stack-sm gaps-table" data-filter>
        <thead><tr>
          <th scope="col">Player</th><th scope="col">Market</th>
          <th scope="col" class="n">PrizePicks</th><th scope="col" class="c">Gap</th><th scope="col" class="n">Underdog</th>
          <th scope="col">Better side</th><th scope="col" class="hide-sm">Match</th>
        </tr></thead>
        <tbody>${gaps
          .map((r) => {
            const d = Number(r.delta);
            // The lower of two lines is the cheaper over; name the side rather
            // than leaving it to be worked out per row.
            const cheaper = d < 0 ? 'Over on PrizePicks' : 'Over on Underdog';
            const cls = d < 0 ? 'o' : 'u';
            const histId = r.pp_prop_id ?? r.ud_prop_id;
            return `<tr data-search="${rowKey(r.handle, r.match_title, statLabel(r.stat), r.league)}">
            <td class="idcol"><div class="who">${leagueBadge(r.league)}
              <div class="whobody">
                <div class="name">${histId ? `<a href="/prop/${histId}">${esc(r.handle)}</a>` : esc(r.handle)}${
                  comboChip(r)
                }</div>
                <div class="meta matchline only-sm" title="${esc(r.match_title ?? '')}">${esc(
                  r.match_title ?? '—',
                )}</div>
              </div></div></td>
            <td class="statcol"><div class="statname">${esc(statLabel(r.stat))}</div>
                <div class="meta">${esc(maps(r.map_start, r.map_end))}</div></td>
            <td class="n bookcol" data-book="PrizePicks"><div class="bookcell"><span class="fig">${num(r.pp_line)}</span>
              ${
                o.lockedBook === 'underdog'
                  ? ''
                  : ouButtons(r.pp_prop_id, back, r.pp_side,
                      offeredSides('prizepicks', r.delta === null ? null : Number(r.delta), restrict),
                      bestSide('prizepicks', r.delta === null ? null : Number(r.delta)))
              }</div></td>
            <td class="c gapcell"><span class="gap-chip ${d > 0 ? 'up' : 'down'}">${signed(d)}</span></td>
            <td class="n bookcol" data-book="Underdog"><div class="bookcell"><span class="fig">${num(r.ud_line)}</span>
              ${
                o.lockedBook === 'prizepicks'
                  ? ''
                  : ouButtons(r.ud_prop_id, back, r.ud_side,
                      offeredSides('underdog', r.delta === null ? null : Number(r.delta), restrict),
                      bestSide('underdog', r.delta === null ? null : Number(r.delta)))
              }</div></td>
            <td class="sidecol"><span class="pickside wide ${cls}">${cheaper}</span></td>
            <td class="match hide-sm"><span class="sub2" title="${esc(r.match_title ?? '')}">${esc(r.match_title ?? '—')}</span></td>
          </tr>`;
          })
          .join('')}</tbody></table></div>
      <p class="live-empty" hidden>No disagreement matches what you typed.
        Press <strong>Enter</strong> to search every market instead.</p>
    </div>`;

  const movCard =
    o.mov.length === 0
      ? `<div class="card"><div class="card-head"><h2>Lines on the move</h2></div>
         <div class="empty">Nothing has moved yet. A line only counts as moved once it has been
         seen at two different values, so this fills in as the logger runs.</div></div>`
      : `<div class="card">
      <div class="card-head"><h2>Lines on the move</h2>
        <span class="sub"><b data-count>${o.mov.length}</b> lines, largest move first</span></div>
      <div class="scroll cards-sm"><table class="stack-sm moves-table" data-filter>
        <thead><tr><th scope="col">Player</th><th scope="col">Market</th><th scope="col">App</th>
          <th scope="col" class="n">Opened</th><th scope="col" class="n">Now</th><th scope="col" class="c">Move</th>
          <th scope="col" class="n">Changes</th><th scope="col" class="hide-sm">Match</th></tr></thead>
        <tbody>${o.mov
          .map((r) => {
            const mv = Number(r.move);
            return `<tr data-search="${rowKey(r.handle, r.match_title, statLabel(r.stat), r.league)}">
            <td class="idcol"><div class="who">${leagueBadge(r.league)}
              <div class="whobody">
                <div class="name"><a href="/prop/${r.prop_id ?? ''}">${esc(r.handle)}</a></div>
                <div class="meta matchline only-sm">${esc(r.match_title ?? '—')}</div>
              </div></div></td>
            <td class="statcol"><div class="statname">${esc(statLabel(r.stat))}</div>
                <div class="meta">${esc(maps(r.map_start, r.map_end))}</div></td>
            <td class="appcol"><span class="chip">${r.book === 'prizepicks' ? 'PrizePicks' : 'Underdog'}</span></td>
            <td class="n travel from"><span class="fig sm muted">${num(r.opened)}</span></td>
            <td class="n travel to"><span class="fig sm">${num(r.latest)}</span></td>
            <td class="c travel"><span class="gap-chip ${mv > 0 ? 'up' : 'down'}">${signed(mv)}</span></td>
            <td class="n obs"><span class="meta">${r.observations}</span></td>
            <td class="hide-sm"><span class="sub2">${esc(r.match_title ?? '—')}</span></td>
          </tr>`;
          })
          .join('')}</tbody></table></div>
      <p class="live-empty" hidden>No moving line matches what you typed.
        Press <strong>Enter</strong> to search every market instead.</p>
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

/**
 * The player's recent series for this exact market.
 *
 * Shows the maps that made up each total, so a number can be argued with
 * rather than taken on faith, and marks series that didn't play the whole
 * range as void — the same call grading makes, so the two can't disagree.
 */
function gamesCard(games: PlayerGame[], hist: PropHistory, line: number | null): string {
  const range = maps(hist.map_start, hist.map_end);

  if (games.length === 0) {
    const why = PROJECTABLE.has(hist.stat)
      ? `No games recorded for ${esc(hist.handle)} yet. Results are collected after each match,
         so this fills in once they have played — a player new to the board starts empty rather
         than being left out.`
      : `${esc(statLabel(hist.stat))} isn't stored per map, so past games can't be listed for
         this market. Kills, assists, deaths and headshots can.`;
    return `<div class="card">
      <div class="card-head"><h2>Recent games</h2></div>
      <div class="empty">${why}</div>
    </div>`;
  }

  const complete = games.filter((g) => g.total !== null);
  const hits =
    line === null ? null : complete.filter((g) => Number(g.total) > line).length;

  const rows = games
    .map((g) => {
      const vals = (g.values ?? []).map((v) => Number(v));
      const total = g.total === null ? null : Number(g.total);
      const beat = total !== null && line !== null ? total > line : null;
      return `<tr>
        <td><span class="sub2">${
          g.played_at ? new Date(g.played_at).toISOString().slice(0, 10) : '—'
        }</span>${g.team ? `<div class="meta">${esc(g.team)}</div>` : ''}</td>
        <td><span class="meta">${
          vals.length ? vals.join(' · ') : '—'
        }</span><div class="meta">${g.maps_total} map${g.maps_total === 1 ? '' : 's'} played</div></td>
        <td class="n">${
          total === null
            ? `<span class="chip" title="Only ${g.maps_in_range} of the ${
                hist.map_end - hist.map_start + 1
              } maps in this range were played, so this prop would have been voided">void</span>`
            : `<span class="fig">${total.toFixed(0)}</span>`
        }</td>
        <td class="n">${
          beat === null
            ? '<span class="meta">—</span>'
            : `<span class="pickside wide ${beat ? 'o' : 'u'}">${
                beat ? 'over' : 'under'
              }</span>`
        }</td>
      </tr>`;
    })
    .join('');

  return `<div class="card">
    <div class="card-head">
      <h2>Recent games</h2>
      <span class="sub">${esc(range)}, ${
        hits !== null && complete.length > 0
          ? `${hits} of ${complete.length} cleared ${line!.toFixed(1)}`
          : `${complete.length} complete series`
      }</span>
    </div>
    <div class="scroll"><table>
      <thead><tr>
        <th scope="col">Played</th><th scope="col">By map</th>
        <th scope="col" class="n">${esc(range)}</th><th scope="col" class="n">vs ${line === null ? 'line' : line.toFixed(1)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

export function historyPage(o: {
  hist: PropHistory;
  siblings: { prop_id: number; book: string; line: number }[];
  games: PlayerGame[];
  line: number | null;
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

  ${gamesCard(o.games, o.hist, o.line)}`;

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
        <div class="scroll cards-sm"><table class="stack-sm legs-table"><tbody>${legs
          .map(
            (p) => `<tr>
          <td class="idcol"><div class="who">${leagueBadge(p.league)}
            <div class="whobody"><span class="name">${esc(p.handle)}</span>
              <div class="meta matchline only-sm">${esc(p.match_title ?? '—')}</div>
            </div></div></td>
          <td class="statcol"><div class="sub2">${esc(statLabel(p.stat))}</div>
              <div class="meta">${esc(maps(p.map_start, p.map_end))}</div></td>
          <td class="sidecol"><span class="pickside ${p.side === 'over' ? 'o' : 'u'}">${
            p.side === 'over' ? 'Over' : 'Under'
          }</span></td>
          <td class="n linecol"><span class="fig">${num(p.line_at_pick)}</span></td>
          <td class="appcol"><span class="chip">${p.book === 'prizepicks' ? 'PP' : 'UD'}</span></td>
          <td class="hide-sm"><span class="sub2">${esc(p.match_title ?? '—')}</span></td>
          <td class="n statuscol"><span class="meta pending">${esc(p.status)}</span></td>
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


// ------------------------------------------------------------------ build --

/**
 * Suggested entries.
 *
 * The honest framing matters more than the arithmetic here: every number below
 * rests on win probabilities this tool estimated and has never yet been graded
 * against. An EV above 1.0 means "worth it if the probabilities are right",
 * which is a claim the results page will eventually settle and cannot settle
 * today.
 */
export function buildPage(o: {
  entries: Entry[];
  book: 'prizepicks' | 'underdog';
  lockedBook: string | null;
  picks: PickRow[];
  health: Health;
}): string {
  const tab = (b: string, label: string) =>
    `<a href="/build?book=${b}"${o.book === b ? ' aria-current="page"' : ''}>${label}</a>`;

  const filters = `<div class="filters">
    <div class="group"><span class="lab">App</span><nav class="seg">
      ${o.lockedBook
        ? `<span class="seg-locked">${bookName(o.lockedBook)}</span>`
        : tab('prizepicks', 'PrizePicks') + tab('underdog', 'Underdog')}
    </nav>${o.lockedBook ? '<span class="lab">set by your slip</span>' : ''}</div>
  </div>`;

  const body = o.entries.length === 0
    ? `<div class="card"><div class="empty">Not enough qualifying markets to build an entry on
       ${esc(bookName(o.book))} right now. Legs need a projection, a playable side, and a match
       that hasn't started.</div></div>`
    : o.entries.map((e) => {
        const ev = e.evMultiple;
        const cls = ev >= 1.15 ? 'up' : ev >= 1 ? 'flat' : 'down';
        return `<div class="card">
      <div class="card-head">
        <h2>${e.size}-pick</h2>
        <span class="sub">${e.payout.toFixed(2)}× payout for a ${(e.winProb * 100).toFixed(1)}% chance of hitting every leg${
          e.discounted ? `, with ${e.discounted} discounted leg${e.discounted === 1 ? '' : 's'}` : ''
        }</span>
      </div>
      <div class="evbar">
        <span class="evnum ${cls}">${ev.toFixed(2)}×</span>
        <span class="evlab">expected return per unit staked${
          ev < 1 ? ' — below break-even' : ''
        }</span>
        <span class="grow"></span>
        <form method="post" action="/build/stage" class="inline">
          <input type="hidden" name="prop_ids" value="${e.legs.map((l) => l.propId).join(',')}">
          <input type="hidden" name="sides" value="${e.legs.map((l) => l.play.side).join(',')}">
          <button class="go" style="width:auto;padding:9px 18px">Build this slip</button>
        </form>
      </div>
      <div class="scroll cards-sm"><table class="stack-sm entry-table"><tbody>${e.legs.map((l) => `<tr>
        <td class="idcol"><div class="who">${leagueBadge(l.row.league)}
          <div class="whobody">
            <div class="name">${esc(l.row.handle)}</div>
            <div class="meta matchline">${esc(l.row.match_title ?? '—')}</div>
          </div></div></td>
        <td class="statcol"><div class="sub2">${esc(statLabel(l.row.stat))}</div>
            <div class="meta">${esc(maps(l.row.map_start, l.row.map_end))}</div></td>
        <td class="callcol"><div class="play ${l.play.side === 'over' ? 'o' : 'u'}">
              <span class="dir">${l.play.side === 'over' ? 'Over' : 'Under'}</span>
              <span class="at">${l.play.line.toFixed(1)}</span>
            </div></td>
        <td class="n probcol"><span class="fig sm">${(l.p * 100).toFixed(0)}%</span>
            <div class="meta">${l.play.method === 'series' ? `${l.play.series} series` : 'modelled'}</div></td>
        <td class="n multcol">${
          Math.abs(l.mult - 1) > 0.005
            ? `<span class="est">${l.mult.toFixed(2)}×</span>`
            : '<span class="meta">standard</span>'
        }</td>
      </tr>`).join('')}</tbody></table></div>
    </div>`;
      }).join('');

  return shell({
    title: 'Build',
    active: 'build',
    health: o.health,
    filters,
    rail: slipRail(o.picks, `/build?book=${o.book}`),
    body: `<div class="notice">Each entry takes the highest-value legs available, where value is
      win probability times what the leg pays. One leg per player, at most two per match — legs
      from one match move together, and both books reprice correlated entries.</div>
      <div class="notice warn-notice">Treat the expected return as an upper bound, not a
      forecast. Picking the best few legs out of a hundred estimates selects for the ones that
      got lucky, so the number shown is optimistic even after probabilities are shrunk toward a
      coin flip. Nothing here has been checked against a graded result yet — that is what the
      Slips page will eventually settle.</div>
      ${body}`,
  });
}

/**
 * The sign-in page.
 *
 * Deliberately not the app shell: there is no board to navigate, no slip to
 * carry and no freshness to report, and a nav bar full of links that all
 * bounce back here would be furniture pretending to be a page. Same
 * stylesheet, same palette, so it reads as the same product.
 *
 * A plain form posting to itself, like every other write in this app — the
 * one screen you might meet on a bad connection is the last place to require
 * a script to run.
 */
export function loginPage(o: { next: string; error?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BropProp — Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#1a1816">
<link rel="stylesheet" href="/app.css">
</head>
<body class="login-body">
  <main class="login">
    <h1 class="brand login-brand">Brop<span>Prop</span></h1>
    <p class="login-sub">Esports prop research. Sign in to see the board.</p>
    <form class="login-card" method="post" action="/login">
      <input type="hidden" name="next" value="${esc(o.next)}">
      ${o.error ? `<p class="login-error" role="alert">${esc(o.error)}</p>` : ''}
      <label class="login-field">
        <span>Username</span>
        <input name="user" autocomplete="username" autocapitalize="none"
               autocorrect="off" spellcheck="false" required autofocus>
      </label>
      <label class="login-field">
        <span>Password</span>
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <button class="login-go" type="submit">Sign in</button>
    </form>
    <p class="login-foot">Your session lasts 30 days on this device.</p>
  </main>
</body>
</html>`;
}
