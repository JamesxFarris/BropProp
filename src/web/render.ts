import type { Movement, Health } from './queries.js';
import type { PickRow, SlipSummary } from './picks.js';
import type { MarketRow, BookLine, PropHistory, PlayerGame } from './boardq.js';
import type { FormStats, Play, CallStatus, NoCall } from './projection.js';
import { config } from '../config.js';
import { evaluate, edgeProgress, type LineOption, flatBreakEven } from './projection.js';
import { staleLine } from './stale.js';
import type { Counters, ScoreRow, LeadRow, StackRecord } from './statsq.js';
import type { ClvSummary } from './clv.js';
import type { Entry, Stack } from './optimize.js';
import type { TeamOdds } from './matchodds.js';
import { isComboHandle } from '../normalize.js';
import { devig } from '../devig.js';
import { bookMeta, bookName, bookShort, orderBooks, KNOWN_BOOKS, type BookCode } from '../books.js';
import { bestEdge, fairLine, betterSide } from './consensus.js';

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

/**
 * Book display names come from the registry now, not from a ternary.
 *
 * `b === 'prizepicks' ? 'PrizePicks' : 'Underdog'` appeared a dozen times in
 * this file, and every one of them silently renamed a third book to
 * "Underdog". A lookup that falls back to the code itself is wrong in a way
 * you can see on screen rather than wrong in a way you cannot.
 */

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

/**
 * A team's short name, the way a broadcast overlay puts it in the corner.
 *
 * Derived from the name rather than drawn from logos, which would need a
 * licensed source and break the day a CDN moves. The few teams every viewer
 * knows by a different name are spelled out; the rest follow one rule: drop
 * the filler words, keep a short single word whole or cut a long one to three
 * letters, and take initials across several (numbers kept whole — "100T").
 */
const TEAM_SHORT: Record<string, string> = {
  'natus vincere': 'NAVI', 'navi': 'NAVI', 'natus vincere junior': 'NAVI J',
  'ninjas in pyjamas': 'NIP', 'cloud9': 'C9', 'team liquid': 'TL', 'faze clan': 'FAZE',
  'g2 esports': 'G2', 'team spirit': 'SPIRIT', 'team vitality': 'VIT',
};
const TEAM_FILLER = new Set(['team', 'esports', 'esport', 'gaming', 'clan', 'club', 'academy', 'gg']);
export function teamShort(name: string): string {
  const key = name.trim().toLowerCase();
  const known = TEAM_SHORT[key];
  if (known) return known;
  const words = key.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !TEAM_FILLER.has(w));
  if (words.length === 0) return name.trim().slice(0, 3).toUpperCase();
  if (words.length === 1) {
    const w = words[0]!;
    return (w.length <= 4 ? w : w.slice(0, 3)).toUpperCase();
  }
  return words.slice(0, 4).map((w) => (/^\d/.test(w) ? w : w[0])).join('').toUpperCase();
}
const teamBug = (name: string | null | undefined) =>
  name ? `<span class="tbug" title="${esc(name)}">${esc(teamShort(name))}</span>` : '';

/**
 * Which maps of the series a prop covers, as pips: ■■□ is maps 1–2 of a
 * best-of-three, ■■■□□ maps 1–3 of a LoL best-of-five. It is the difference
 * between two props that otherwise look identical, drawn rather than read.
 */
const mapPips = (league: string, a: number, b: number) => {
  const n = Math.max(league === 'LOL' ? 5 : 3, b);
  let s = '';
  for (let i = 1; i <= n; i++) s += `<i${i >= a && i <= b ? ' class="on"' : ''}></i>`;
  return `<span class="mpips" aria-hidden="true">${s}</span>`;
};

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
/**
 * Entry-type payouts, from the same config table as the per-book ones — and
 * empty until someone fills them in.
 *
 * These were hardcoded as power `{2:3, 3:5, 4:10, 5:20, 6:37.5}`, flex
 * `{3:2.25, 4:5, 5:10, 6:25}` and single `1.9`, from when the books paid a
 * flat rate by leg count. They no longer do, so the numbers are a guess
 * wearing the authority of a constant. The slip estimates nothing it cannot
 * source; the payout field on the slip form still accepts whatever the app
 * actually offers, which is where the real figure has always come from.
 */
const basePayout = (type: string, legs: number) =>
  config.payoutTable[type]?.[legs] ?? null;

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
type ShowMode = 'all' | 'live' | 'calls' | 'moved';

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
        // PrizePicks leads because it is the default. "All" has to name itself
        // in the URL now that an absent param means PrizePicks. One button per
        // book with an adapter, so a new one appears here on the day it ships
        // rather than needing this list edited.
        ...KNOWN_BOOKS.map((b) => a(qs({ book: b }, f), bookName(b), f.book === b)),
        a(qs({ book: 'all' }, f), 'All', f.book === null),
      ].join('');

  /**
   * Everything except league and search folds away.
   *
   * There were eleven controls across four labelled groups above the board,
   * and on a phone they filled the screen before a single prop appeared —
   * which is the wrong thing at the top of a page whose whole job is to put
   * the best bets in front of you. League and search are the two anyone
   * touches often; app, show and the price toggles are set once and then left
   * alone, so they live behind a disclosure.
   *
   * A `<details>`, so it costs no JavaScript and survives scripts being
   * blocked like every other control here. The summary counts what is active,
   * because a filter you cannot see is a filter you forget you set.
   */
  const changed = [
    f.book !== 'prizepicks' ? 1 : 0,
    f.show !== 'all' ? 1 : 0,
    f.best === false ? 1 : 0,
    f.matched ? 1 : 0,
  ].reduce((x: number, y: number) => x + y, 0);

  return `
  <div class="filters">
    <nav class="seg">${leagueBtns}</nav>
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
    <!-- Never open by default, even with filters active. Auto-opening put the
         whole panel back above the board — 342px of it on a phone — which is
         the thing folding it away was for. The count on the summary is the
         signal; expanding is the reader's choice. -->
    <details class="more">
      <summary>Filters${changed ? ` <span class="dot">${changed}</span>` : ''}</summary>
      <div class="more-in">
        <div class="group"><span class="lab">App</span><nav class="seg">${bookBtns}</nav>${
          locked ? '<span class="lab">set by your slip</span>' : ''
        }</div>
        <div class="group"><span class="lab">Show</span><nav class="seg">
          ${a(qs({ show: 'all' }, f), 'All', f.show === 'all')}
          ${a(qs({ show: 'live' }, f), 'Priced', f.show === 'live')}
          ${a(qs({ show: 'calls' }, f), 'With a call', f.show === 'calls')}
          ${a(qs({ show: 'moved' }, f), 'Line moved', f.show === 'moved')}
        </nav></div>
        <div class="group"><nav class="seg">
          ${
            f.book
              ? a(qs({ best: !f.best }, f), 'Best price only', f.best)
              : a(qs({ matched: !f.matched }, f), 'On both apps', f.matched)
          }
        </nav></div>
      </div>
    </details>
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
/**
 * The BropProp mark, inline so it needs no request and inherits nothing: a
 * broadcast tile with the call tag's notch cut from its corner, and a staggered
 * up and down chevron — over and under. The same drawing is public/favicon.svg.
 */
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M0 0H32V22L22 32H0Z" fill="#FF5B14"/><path d="M6.5 15.5 12 10l5.5 5.5" fill="none" stroke="#0B1220" stroke-width="3.6" stroke-linecap="square"/><path d="M14.5 17.5 20 23l5.5-5.5" fill="none" stroke="#0B1220" stroke-width="3.6" stroke-linecap="square"/></svg>`;

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
  active: 'board' | 'signal' | 'slips' | 'build' | 'stats' | 'none';
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&family=Barlow+Semi+Condensed:wght@500;600;700&display=swap">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0B1220">
<link rel="stylesheet" href="/app.css">
</head>
<body>

<header class="top">
  <div class="top-in">
    <h1 class="brand">
      <a href="/board" aria-label="BropProp, go to the board">${MARK}<span class="word">BropProp</span></a>
    </h1>
    <span class="tagline hide-sm">Read the line</span>
    <nav class="tabs">
      ${tab('/board', 'Board', o.active === 'board')}
      ${tab('/build', 'Build', o.active === 'build')}
      ${tab('/', 'Edges', o.active === 'signal')}
      ${tab('/slips', 'Slips', o.active === 'slips')}
      ${tab('/stats', 'Stats', o.active === 'stats')}
    </nav>
    <span class="grow"></span>
    ${freshness(o.health.last_ok_poll)}
    <button type="button" class="icon-btn" id="theme">Theme</button>
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
  <span class="grow"></span>
  <!-- Signing out is a once-a-month action; in the masthead it was a
       full-width row of its own on a phone, above the board it belongs to. -->
  <a class="foot-link" href="/logout">Sign out</a>
</footer>

<script>
  try {
    var t = localStorage.getItem('bp-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
  // The slip notices a new leg: the count pops and the leg slides in. Taking a
  // pick is a form post and a redirect, so the page can't know what changed —
  // it compares against the count it saw last time. Pure decoration; with
  // scripts off, the slip simply shows the leg.
  (function () {
    try {
      var legs = document.querySelectorAll('.slip-legs .leg');
      var n = legs.length;
      var prev = Number(sessionStorage.getItem('bp-legs') || '0');
      if (n > prev) {
        if (legs[n - 1]) legs[n - 1].classList.add('just-added');
        document.querySelectorAll('.sb-n').forEach(function (e) { e.classList.add('bump'); });
      }
      sessionStorage.setItem('bp-legs', String(n));
    } catch (e) {}
  })();
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

  // Stake sizing on a stack: quarter-Kelly from the stack's win probability
  // and the multiplier the app is actually offering, capped at 2% of bankroll.
  // Only stacks get this — their probability rests on measured correlation and
  // a measured tail, where a single prop's rests on a projection that has not
  // shown skill. Quarter, and capped, because even the measured number carries
  // a wide interval and the app can reprice the slip.
  // Only the typed multiplier: the form carries hidden fields too, and the
  // first of those is what a bare "kelly input" selector would have found.
  // (No backticks in here — this script lives inside a template literal.)
  document.querySelectorAll('.kelly input[name="mult"]').forEach(function (inp) {
    var box = inp.closest('.kelly'), out = box.querySelector('b');
    var p = Number(box.getAttribute('data-p'));
    function size() {
      var m = Number(String(inp.value).replace(',', '.').replace(/[x×\s]/gi, ''));
      if (!(m > 1) || !(p > 0)) { out.textContent = '—'; return; }
      var kelly = (p * m - 1) / (m - 1);
      // EV is the return per unit staked, stake included: 1.00x is break-even.
      out.textContent = kelly <= 0
        ? 'nothing: at ' + m + '× it pays less than it needs'
        : (Math.min(kelly / 4, 0.02) * 100).toFixed(1) + '% of your bankroll (EV '
          + (p * m).toFixed(2) + '× per unit)';
    }
    inp.addEventListener('input', size);
    size();
  });

  document.getElementById('theme').addEventListener('click', function () {
    // Light unless dark was chosen, so an unset theme toggles to dark.
    var el = document.documentElement, cur = el.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
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
        ? '<span class="sb-none">nothing riding yet</span>'
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
      <div class="empty">Clean slate. Tap <strong>Over</strong> or <strong>Under</strong> on any
        prop to start one — each leg keeps the line you took it at, even if it moves.</div>
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
            bookName(p.book),
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
      <span class="grow"></span>
      <!-- In the header, not under the Place button. It used to sit below the
           payout form, which on a phone is past the fold of an already
           scrolling sheet: the way out of a slip you did not mean to build
           was the one control you had to go looking for. -->
      <form method="post" action="/slip/clear" class="inline">
        <input type="hidden" name="back" value="${esc(back)}">
        <button class="clear-all" title="Remove every leg">Clear all</button>
      </form>
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
  </div></div>`;
}

/**
 * PrizePicks and Underdog are separate books — a single entry cannot draw legs
 * from both. Once a slip has its first leg the take buttons narrow to that app,
 * and this says so, because otherwise columns of numbers with no buttons on
 * them just look like a bug.
 */
function lockNotice(locked: string | null, blocked: string | null, blockedOn: string | null): string {
  if (blocked) {
    return `<div class="notice warn-notice">
      ${blockedOn ? `That prop is on ${esc(bookName(blockedOn))}, but your` : 'Your'}
      slip is on ${esc(bookName(blocked))}. Entries can't mix apps —
      clear the slip to switch.</div>`;
  }
  if (locked) {
    return `<div class="notice">
      Your slip is on ${esc(bookName(locked))}, so picks go there. Clear the slip to switch apps.</div>`;
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
  // What the projection was built from, in words a person uses. "Matches"
  // rather than "series": a series is one match, and only one word is needed.
  if (play?.method === 'maps' || f.series === 0) {
    return `Built from ${f.mapValues.length} single maps`;
  }
  // Where the shown number has been pulled toward the line, say by how much
  // and from what. Otherwise "17.2 from 8 matches" reads as their average when
  // their average is 19.6, and the reader has no way to tell.
  if (play && Math.abs(play.anchored - play.rawMean) >= 0.05) {
    return `Last ${f.series} matches average ${play.rawMean.toFixed(1)}, pulled toward the line`;
  }
  return `Average of the last ${f.series} matches`;
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

/**
 * "One book moved, the other hasn't" — shown above the model's own lean.
 *
 * It reports that the two books disagree about a number one of them has just
 * changed. That is an observation, not a forecast, and it is phrased that way
 * on purpose: "UD moved +2.0, PP still 15.0" says exactly what we know.
 *
 * What it is NOT is a pick. Taking the stale side and settling it against
 * what the player actually did came out 41-41 — 50.0%, a coin flip, over 49
 * independent player-matches (RUNBOOK, 2026-09-08). The 6.5-to-1 figure that
 * motivated this cell is about how the *other book* responds, which turns out
 * to be a different thing from how the *player* performs. So this sits beside
 * the model's lean rather than above it, and the tooltip says the number.
 */
function staleCell(r: MarketRow): string {
  const s = staleLine(r.books);
  if (!s) return '';
  const staleAt = r.books.find((b) => b.book === s.book);
  // Wide screens only. On a phone card it was a second coloured arrow beside
  // the call, pointing its own way, and the book lines below already show
  // which app lags.
  return `<div class="stale card-hide ${s.side === 'over' ? 'o' : 'u'}"
    title="${esc(bookShort(s.mover))} moved ${signed(s.move)} and ${esc(bookShort(s.book))} has not followed. Useful for choosing where to place a bet — but not a reason to make one: taking the stale side settled 50.0% (41-41) over 49 matches.">
    <span class="stale-k">${esc(bookShort(s.mover))} ${signed(s.move)}</span>
    <span class="stale-v">${esc(bookShort(s.book))} ${num(staleAt?.line)}</span>
  </div>`;
}

/**
 * Where this market sits against the market's own fair line.
 *
 * **Graded 2026-09-10, and it does not win.** `npm run validate:consensus`
 * scored the side this cell names across every settled market both books
 * priced: 74-73 over 147 independent series, an exact sign test of p = 1.00.
 * Bigger gaps did WORSE, not better — 58.2% at 0.5-0.9 units against 45.7% at
 * 1.0-1.9 — which is backwards from the theory and is the strongest single
 * piece of evidence against it. The arm that should have been strongest,
 * where Underdog states an actual lean rather than flat vig, was the worst at
 * 30-37 series.
 *
 * So this is kept for the same reason `staleCell` is: knowing which app has
 * the cheaper number is worth something when placing a bet you had already
 * decided on. It is an observation about two prices, not a claim about a
 * player, and the tooltip says the measurement.
 */
function edgeCell(r: MarketRow, form?: FormStats): string {
  const maps = r.map_end - r.map_start + 1;
  const seed = `${r.canon_handle}|${r.stat}|${r.map_start}|${r.map_end}`;
  const fl = fairLine(r.books, form, maps, seed);
  const e = bestEdge(r.books, form, maps, seed);
  if (!e || !fl) return '';
  // Where the anchor came from decides what this cell is allowed to claim. A
  // crowd is several books agreeing; a priced book is one book's own opinion,
  // which is a weaker thing and must not be described as a market consensus.
  const why = fl.method === 'crowd'
    ? `the other ${fl.n - 1} books median ${num(e.fair)}`
    : `${esc(bookName(fl.from ?? ''))}, the only book here quoting odds, puts the coin flip at ${num(e.fair)}`;
  return `<div class="edge ${e.side === 'over' ? 'o' : 'u'}"
    title="${esc(bookName(e.book))} prices this at ${num(e.line)} while ${why}. That makes its ${e.side} ${e.gap.toFixed(1)} cheaper than the market. MEASURED AND IT DOES NOT WIN: 74-73 across 147 independent series, p = 1.00. Useful for choosing where to place a bet you were making anyway; not a reason to make one.">
    <span class="edge-k">${esc(bookShort(e.book))} ${e.side === 'over' ? 'O' : 'U'}</span>
    <span class="edge-v">${e.gap.toFixed(1)} off ${num(e.fair)}</span>
  </div>`;
}

function playCell(
  play: Play | null,
  why: NoCall | null,
  r: { is_combo: boolean; stat: string; handle: string },
  /** The single app on screen, if there is one. */
  only?: string | null,
): string {
  if (!play) {
    // "No play", with the engine's reason ("waiting on history", "priced
    // fair") in the tooltip rather than on the row.
    return `<span class="meta nocall" title="${esc(why ? noCallText(why, r) : 'No projection for this prop')}">—</span>`;
  }
  // The hit rate has its own column and the sample size sits under the "ours"
  // chip, so repeating either here was printing the same fact three times
  // across one row. What is left is the one thing neither column says: how far
  // the number is from the line, in the units the market is quoted in.
  const basis = play.method === 'maps' ? 'modelled' : '';
  // Name the app and its number only when more than one app can be taken from.
  // With a single app selected the same figure already sits in the line column
  // two cells away — the other apps' columns are there to compare, and the
  // call is never made on them — and printing it twice was most of why a row
  // was hard to read.
  // With an app selected the call is made at that app's own line only (see
  // `optionsFor`), so it never names another app: a PrizePicks card that said
  // "Under UD 8.5" was a PrizePicks prop advertising an Underdog bet.
  const at =
    only === null || only === undefined
      ? `<span class="at card-hide">${esc(bookShort(play.book))} ${play.line.toFixed(1)}</span>`
      : '';
  // The detail that used to take a second line is the tag's tooltip now, so
  // the row stays one horizontal line. Said plainly: the distance between our
  // figure and the line. Where that distance is negative (about 7% of calls —
  // a few outsized games drag a right-skewed average across the line while
  // most series land on the called side) it says what actually drove the call
  // instead of printing a gap with a minus sign in front of it.
  const detail = [
    play.edge > 0
      ? `Projected ${play.edge.toFixed(1)} ${play.side === 'over' ? 'above' : 'below'} the line`
      : `Most of this player's series land ${play.side} the line, though a few outsized games pull the average the other way`,
    basis ? `Modelled from ${play.sample} single maps, because too few series played this exact map range` : '',
  ].filter(Boolean).join('. ');
  /**
   * The board states the gap and stops there — no OVER/UNDER tag, no side
   * picked for you.
   *
   * Scored against the books' own closing lines (`npm run validate:backtest`),
   * legs the projection called returned -9.5% [-16.4%, -3.2%] at the per-leg
   * bar a Power entry needs, and -10.4% on the held-out later days: claimed
   * 54.9%, realised 47.2%, worse than taking every under. A tag and a filled
   * button were a recommendation the measurement does not support. What is
   * left is the arithmetic — how far our projection sits from this line — and
   * the reader can see which way that points from the two numbers beside it.
   * Recommendations live on Build, where the whole entry is priced from the
   * correlation and the tail that were measured.
   */
  const edge = play.edge > 0
    ? `<span class="pedge">+${play.edge.toFixed(1)}<small>edge</small></span>`
    : '<span class="meta">—</span>';
  return `<div class="play" title="${esc(detail)}">${edge}${at}</div>`;
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
  /** The line, spelled into the phone buttons: "Over 41.5". */
  line: number | null = null,
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
  // "O" on the dense wide board; the rest of the word appears on a phone card,
  // where there is room and a bare letter was one more thing to decode.
  const ln = line === null || !Number.isFinite(line) ? '' : ` ${line.toFixed(1)}`;
  return `<div class="ou" id="m${propId}">${b('over', `O<span class="w">ver${ln}</span>`, 'o')}${b('under', `U<span class="w">nder${ln}</span>`, 'u')}</div>`;
}

/**
 * Which side of a market is the better price on `book`.
 *
 * Delegates to `consensus.betterSide`, which answers it by comparing this
 * book's line against every other book's rather than by reading the sign of a
 * two-book difference. The old version took `delta = pp_line - ud_line` and
 * branched on which book it had been handed — arithmetic with no third arm.
 */
function bestSide(books: BookLine[], book: BookCode): 'both' | 'over' | 'under' {
  return betterSide(books, book);
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
  books: BookLine[],
  book: BookCode,
  restrict: boolean,
): 'both' | 'over' | 'under' {
  return restrict ? bestSide(books, book) : 'both';
}

/**
 * A stored American price, in the notation the book's own users read.
 *
 * Every price is kept as American odds so the maths has one convention; this is
 * display only. Decimal is the payout per unit staked, stake included — what
 * Sleeper prints as "1.86x" — so -116 is 1 + 100/116 and +150 is 1 + 150/100.
 * American gets a real minus sign, like every other signed figure on the board.
 * Rounded, because a multiplier converted to American and back is rarely a
 * whole number and "-116.28" is precision nobody on either app ever sees.
 */
export function formatPrice(american: number, style: 'american' | 'decimal'): string | null {
  if (!Number.isFinite(american) || american === 0) return null;
  if (style === 'decimal') {
    const dec = american < 0 ? 1 + 100 / Math.abs(american) : 1 + american / 100;
    return `${dec.toFixed(2)}x`;
  }
  const a = Math.round(Math.abs(american));
  return american > 0 ? `+${a}` : `−${a}`;
}

/**
 * Each side's price on one book, formatted, or null where it publishes none.
 *
 * Null for the whole book is the PrizePicks case, and it must render as
 * nothing at all. PrizePicks charges through the entry multiplier, not the
 * side, so there is no per-side price to show — and a dash or "n/a" in the
 * price slot would sit beside Underdog's -112 looking like a price that
 * happens to be missing. A side the book doesn't offer carries no price
 * either, even if one was stored: it cannot be taken at any price.
 */
export function sidePrices(
  b: Pick<BookLine, 'book' | 'over_price' | 'under_price' | 'over_ok' | 'under_ok'>,
): { over: string | null; under: string | null } | null {
  const style = bookMeta(b.book).priceStyle;
  const over = b.over_ok && b.over_price !== null ? formatPrice(Number(b.over_price), style) : null;
  const under = b.under_ok && b.under_price !== null ? formatPrice(Number(b.under_price), style) : null;
  return over === null && under === null ? null : { over, under };
}

/**
 * A book's column header. With an app selected the header says which column
 * is the one you are taking from, and why — "your slip" when an open entry
 * decided it, since that is a thing you can only change by clearing the slip.
 */
function bookHead(code: BookCode, only: BookCode | null, locked: boolean): string {
  const name = esc(bookName(code));
  if (only === null) return `<th scope="col" class="n bookh">${name}</th>`;
  return code === only
    ? `<th scope="col" class="n bookh primary">${name}<span class="colnote">${locked ? 'your slip' : 'your app'}</span></th>`
    : `<th scope="col" class="n bookh ref">${name}<span class="colnote">to compare</span></th>`;
}

/**
 * One book's number on one market: the line, its price, whether it is the best
 * number on the row for either side, and — on the book being built on — the
 * take buttons.
 *
 * Every book gets a column whichever app is selected, because the comparison
 * is the product. Selecting an app narrows what can be TAKEN, not what can be
 * seen: another app's line with live buttons offered a pick that cannot join
 * this entry, so those columns are read-only. With no app selected (All) every
 * column is takeable, as before.
 *
 * The best-number mark is `betterSide`, the same rule that restricts which
 * side is offered: the lowest line on the row is the best over and the highest
 * the best under, for any number of books. Where every book agrees, or only
 * one lists the market, it says nothing — there is no better number to point
 * at. It compares lines only; two books on the same line are both marked even
 * if one pays more, because price and line are different axes and folding one
 * into the other is a model, not an observation.
 */
function bookCell(
  books: BookLine[],
  code: BookCode,
  only: BookCode | null,
  buttons: (b: BookLine) => string,
  /**
   * The app holding the best line for the call. A phone card shows that app
   * alone and drops the rest, so a card never shows a number worse than the
   * one it is recommending. Wide screens keep every column for comparison.
   */
  focus: BookCode | null = null,
): string {
  const role = only === null ? 'take' : code === only ? 'take primary' : 'ref';
  const b = books.find((x) => x.book === code);
  const alt = focus !== null && code !== focus ? ' alt' : '';
  const attrs = `class="n bookcol ${role}${alt}${b ? '' : ' none'}" data-book="${esc(bookName(code))}" data-short="${esc(bookShort(code))}"`;
  // A book that does not price this market gets an empty cell, not a missing
  // one: the columns have to line up down the page.
  if (!b) {
    return `<td ${attrs}><div class="bookcell"><span class="bk-fig muted" title="Not listed on ${esc(bookName(code))}">—</span></div></td>`;
  }
  // A plain number. The tinted O/U best-number chips came out with the rest of
  // the highlighting: the board already lists only markets where your app has
  // the best line, and the take button marks the side.
  const fig = `<span class="bk-fig">${num(b.line)}</span>`;
  const px = sidePrices(b);
  const title = px
    ? `${bookName(code)}: ${[px.over && `over ${px.over}`, px.under && `under ${px.under}`].filter(Boolean).join(', ')}`
    : '';
  // A flat price on both sides — 397 of Underdog's 434 priced markets sit at
  // -112/-112 — is one fact, so it is printed once rather than twice.
  const price = !px
    ? ''
    : px.over !== null && px.over === px.under
      ? `<span class="bk-px" title="${esc(title)}">${px.over}</span>`
      : `<span class="bk-px" title="${esc(title)}">${
          px.over !== null ? `<span><span class="k">O</span>${px.over}</span>` : ''
        }${px.under !== null ? `<span><span class="k">U</span>${px.under}</span>` : ''}</span>`;
  return `<td ${attrs}><div class="bookcell"><div class="bk-num">${fig}${price}</div>${
    role === 'ref' ? '' : buttons(b)
  }</div></td>`;
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
  /** Which book the refused prop was on — see WrongBookError. */
  blockedOn?: string | null;
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

  // Best-line mode: an app is selected and "Best price only" is on. Declared
  // before `optionsFor`, which reads it.
  const restrict = Boolean(only) && o.filters.best;

  const optionsFor = (r: MarketRow): LineOption[] =>
    r.books
      // With "Best price only" on, every app's line is weighed, so the call
      // lands on the best number for its side wherever that is — and the row
      // filter below keeps the market only if the selected app holds it. With
      // it off, the call is made at the selected app's own line.
      .filter((b) => only === null || restrict || b.book === only)
      .map((b) => {
        // A devigged read from elsewhere counts as a read on this book's
        // number only when it IS the same number. A probability is the chance
        // of clearing the line it was quoted against, so lending 30.5's answer
        // to 28.5 would anchor to a different question.
        //
        // Only books with no price of their own need borrowing one. Any priced
        // book can lend it — the old version could only lend Underdog's, so a
        // third book publishing odds would have gone unused.
        const twin = b.over_price === null
          ? r.books.find(
              (o) => o.book !== b.book && o.line === b.line
                && o.over_price !== null && o.under_price !== null,
            )
          : undefined;
        const fair = twin ? devig(twin.over_price, twin.under_price) : null;
        return {
          book: b.book,
          line: Number(b.line),
          overOk: b.over_ok,
          underOk: b.under_ok,
          // Underdog publishes a price per side. PrizePicks charges through a
          // flat multiplier on the whole entry, so it has no per-side price
          // and the bar comes from the entry this leg would join — see
          // ppBreakEven above.
          overPrice: b.over_price === null ? null : Number(b.over_price),
          underPrice: b.under_price === null ? null : Number(b.under_price),
          breakEven: b.over_price === null ? ppBreakEven : null,
          anchorOver: fair?.over ?? null,
          anchorUnder: fair?.under ?? null,
        };
      });
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

  /**
   * In best-line mode a market stays only if the selected app holds the best
   * line for the call — its own, or a tie. A PrizePicks under at 7.5 beside
   * Underdog's 8.5 is a worse number than the board knows about, and showing
   * it as a PrizePicks pick is how a card came to contradict itself. Markets
   * with no call keep the SQL's own best-price test.
   */
  const bestHere = (r: MarketRow): boolean => {
    const p = playOf(r);
    if (!restrict || !p || p.book === only) return true;
    const mine = r.books.find((b) => b.book === only);
    return mine !== undefined && Number(mine.line) === p.line
      && (p.side === 'over' ? mine.over_ok : mine.under_ok);
  };
  const pool = restrict ? o.rows.filter(bestHere) : o.rows;

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
    // Markets where one book has moved and the other has not followed. The
    // only signal here with a measured edge behind it, and until now there
    // was no way to look at just those rows — they were scattered through a
    // board sorted by a projection we have four experiments saying is at its
    // ceiling.
    o.filters.show === 'moved'
      ? pool.filter((r) => staleLine(r.books) !== null)
      : o.filters.show === 'calls'
      ? pool.filter((r) => playOf(r) !== null)
      : o.filters.show === 'live'
        ? pool.filter((r) => tier(r) <= 1)
        : pool;

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
  for (const r of pool) {
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

  /**
   * One column per book actually on the board, in registry order — whichever
   * app is selected.
   *
   * Was two fixed columns. Deriving the set from the rows means a new adapter
   * shows up the day it starts returning data, with no layout edit — and a
   * book that goes dark stops occupying a column of dashes.
   *
   * Selecting an app used to narrow this to that app's column alone, so the
   * default board was a list of PrizePicks lines and Sleeper was invisible
   * unless you went looking under All. What selecting narrows now is the
   * buttons, not the numbers — see `bookCell`.
   *
   * Registry order rather than selected-first, so a book's number sits in the
   * same place on every tab and switching apps doesn't reshuffle a layout the
   * reader has learnt. The selected column is marked by tone instead.
   */
  const columns: BookCode[] = orderBooks(
    [...new Set(o.rows.flatMap((r) => r.books.map((b) => b.book)))],
    (b) => b,
  );
  /**
   * EV needs a per-side price, and only Underdog publishes one.
   *
   * On the PrizePicks board — the default — every cell in that column was a
   * dash, which is a column of nothing occupying the width of a column of
   * something. Honest, and still noise. It appears when a book that prices
   * both sides is on screen and stays away when none is.
   */
  /**
   * EV is computed and stored, and deliberately not shown.
   *
   * The arithmetic was never wrong — p x profit − (1 − p) is what it is — but
   * every EV it produced inherited a win probability measured on the same
   * history that chose the side, so the column printed things like "+42.0%"
   * beside a market the book itself prices at 50%. A 25-point disagreement
   * with a real market is not an edge, it is a bug in the confidence.
   *
   * A backtest could not settle it either way: only ten or so independent
   * matches have both a pre-match line and a settled result so far, and props
   * inside one match move together, so a single short series drags every leg
   * under at once. The number returns when a graded record can support it.
   * `Play.ev` stays populated so that record accumulates in the meantime.
   */
  const showEv = false;
  const gapLabel = 'Gap';

  const body =
    ranked.length === 0
      ? o.filters.show !== 'all' && o.rows.length > 0
        ? // The rows exist; this filter hid them. Say which of them it hid and
          // why, so an empty screen reads as a state of the data rather than
          // as a broken page.
          `<div class="card"><div class="empty">
           None of these ${o.rows.length} markets ${
             o.filters.show === 'calls'
               ? 'carries a call'
               : o.filters.show === 'moved'
                 ? 'has one book moving while the other holds'
                 : 'could be priced'
           } right now — ${esc(summary)}. Switch <strong>Show</strong> back to
           <strong>All</strong> to see them anyway; a market with no edge on our numbers
           is still a market you may have a reason to take.</div></div>`
        : `<div class="card"><div class="empty">Nothing matches these filters.
         Try clearing the search, or switching back to <strong>Both</strong> apps — many
         markets are only listed on one of them.</div></div>`
      : `<div class="card">
      <div class="card-head">
        <h2>Board</h2>
        <span class="sub" title="${esc(`${summary}${
          restrict ? `. Only props where ${bookName(only as BookCode)} has the best line for the play.` : ''
        }`)}"><b>${counts.call}</b> plays from <b data-count>${ranked.length}</b> props</span>
      </div>
      <div class="scroll cards-sm"><table class="board-table stack-sm" data-filter>
        <thead><tr>
          <th scope="col">Player</th>
          <th scope="col">Prop</th>
          <th scope="col" class="c">Projected</th>
          <th scope="col" class="c">Edge</th>
          <th scope="col" class="c">Recent</th>
          ${showEv ? '<th scope="col" class="c evcol">EV</th>' : ''}
          ${columns.map((b) => bookHead(b, only, o.lockedBook !== null)).join('')}
          <th scope="col" class="c gapcol">${gapLabel}</th>
        </tr></thead>
        <tbody>${ranked
          .map((r, i) => {
            const play = playOf(r);
            // The app the call is taken on. After the best-line filter, a call
            // on another app means the selected one ties its line, so it is
            // taken where you are.
            const callBook: BookCode | null = play
              ? (only && play.book !== only ? only as BookCode : play.book)
              : null;
            // Three markets on one player are three different bets, but
            // repeating the name, match and kick-off in full for each made them
            // read as duplicates. A continuation row keeps the identity quiet
            // and lets the market be the thing that differs.
            const sameAsPrev = i > 0 && ranked[i - 1]!.canon_handle === r.canon_handle;
            // How far apart the books are on this row. Unsigned now: with more
            // than two of them "PP minus UD" names a direction that no longer
            // exists, and the useful fact is how wide the disagreement is.
            const d = r.spread === null ? null : Number(r.spread);
            const gap =
              d === null
                ? `<span class="gap-chip flat">—</span>`
                : d === 0
                  ? `<span class="gap-chip flat">same</span>`
                  : `<span class="gap-chip up">${d.toFixed(1)}</span>`;
            // The widest move any book on this row has made.
            const movedAll = r.books.map((b) => b.moved).filter((m): m is number => m !== null);
            const moved = movedAll.length
              ? movedAll.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a))
              : null;
            const histId = r.books[0]?.prop_id ?? null;
            // Underdog's own price for the side we are calling, margin removed. Only
            // Underdog publishes odds, so this column is blank for a market it does
            // not list — which is honest: there is no market probability, rather
            // than a market that thinks the chance is zero.
            const priced = r.books.find((b) => b.over_price !== null && b.under_price !== null);
            const fair = priced ? devig(priced.over_price, priced.under_price) : null;
            // A market probability is a probability *of a side*. With no call
            // there is no side to price, so there is nothing honest to show —
            // falling through to "over" would silently pick a side the reader
            // never chose and display it under a header that does not say which.
            const marketProb = fair === null || play === null ? null : play.side === 'under' ? fair.under : fair.over;
            // A symmetric price is a correct devig of exactly 0.500, and it is
            // not an opinion. 397 of Underdog's 434 priced markets sit at
            // -112/-112 — flat vig on both sides, no side taken. Reporting
            // that as "market 50%" invites the reader to treat a default as a
            // second estimate agreeing with ours, so the three cases are told
            // apart: no price at all, a price with no view, and a real view.
            const flatVig =
              priced !== undefined
              && Number(priced.over_price) === Number(priced.under_price);
            const gapToMarket = marketDisagreement(play?.hitRate ?? null, marketProb);
            const f = formOf(r);
            // When there is a call, show the number the call was made from —
            // the average anchored toward the line, not the raw one. Showing
            // the raw mean beside a lean computed from the anchored figure
            // would print a gap the model never acted on, which is how the
            // board came to advertise "+3.6 in your favour" when a third of
            // that was our own measured over-projection.
            const ours = play
              ? play.anchored
              : !f
                ? null
                : f.series === 0
                  ? f.perMap
                  : f.mean;
            // The line the play is made against, for the phone card's
            // "41.5 PrizePicks" figure: the play's app, else the selected app.
            const lineBook = (callBook ? r.books.find((b) => b.book === callBook) : undefined)
              ?? (only ? r.books.find((b) => b.book === only) : undefined)
              ?? r.books[0];
            // Rows the model has no opinion on are dimmed rather than removed.
            // They still belong here — a line move turns a fair one into a call,
            // and hiding them would hide why the board is quiet — but giving them
            // the same weight as a live call is what made two dozen rows read as
            // one undifferentiated block.
            return `<tr class="${play ? 'live' : 'quiet'}" data-search="${rowKey(r.handle, r.match_title, statLabel(r.stat), r.league)}">
            <td>
              <div class="who${sameAsPrev ? ' cont' : ''}">
                ${sameAsPrev ? '<span class="tick"></span>' : ''}
                <div class="whobody">
                  <div class="name">${
                    sameAsPrev ? '' : teamBug(r.books.find((b) => b.team)?.team)
                  }${
                    histId ? `<a href="/prop/${histId}">${esc(r.handle)}</a>` : esc(r.handle)
                  }${comboChip(r)}</div>
                  ${
                    sameAsPrev
                      ? ''
                      : `<div class="meta matchline" title="${esc(r.match_title ?? '')}">${
                          // The league is a word at the start of the match, not a
                          // badge of its own: one fewer box on every row.
                          leagueBadge(r.league)
                        }${esc(r.match_title ?? '—')}</div>
                  <div class="meta whenline">${whenCell(r.scheduled_at)}${
                          moved !== null && moved !== 0
                            // Said the way a person would: "line up 1.5", not
                            // the engine's "moved +1.5".
                            ? `, line ${moved > 0 ? 'up' : 'down'} <span class="move">${Math.abs(moved).toFixed(1)}</span>`
                            : ''
                        }</div>`
                  }
                </div>
              </div>
            </td>
            <td>
              <div class="statname">${esc(statLabel(r.stat))}</div>
              <div class="meta">${mapPips(r.league, r.map_start, r.map_end)}${esc(maps(r.map_start, r.map_end))}</div>
            </td>
                        <td class="c" data-label="Ours">${
              // The model has a name — Projected — and says what it was built
              // from (the tooltip here, a line under the record on a phone).
              ours === null
                ? '<span class="meta">—</span>'
                : `${
                    lineBook
                      ? `<span class="pv only-sm"><b>${num(lineBook.line)}</b><small>${esc(bookName(lineBook.book))}</small></span>`
                      : ''
                  }<span class="pv proj" title="${esc(formNote(f, play))}"><b>${Number(ours).toFixed(1)}</b><small>Projected</small></span>${
                    // On a phone the edge is the third figure in the strip, the
                    // same shape as the line and the projection, rather than a
                    // label bolted under the call tag.
                    play && play.edge > 0
                      ? `<span class="pv edgev only-sm"><b>+${play.edge.toFixed(1)}</b><small>Edge</small></span>`
                      : ''
                  }`
            }</td>
            <td class="c" data-label="Edge">${playCell(play, statusOf(r).why, r, only)}</td>
            <td class="c" data-label="Record">${
              // A record, not a percentage, and a defined sample: "11 of last
              // 12 matches over". This column once read "72%", which every
              // reader takes as the chance the leg wins; measured against
              // settled outcomes the calls claimed 58.9% and realised 52.2%,
              // with no ordering (AUC 0.521). A count of what happened makes no
              // such promise, and the tooltip says what it is and isn't. On a
              // phone the projection's reason sits under it.
              play === null
                ? '<span class="meta">—</span>'
                : `<div class="rec" title="${esc(
                     play.rawOf === null
                       ? 'Estimated by resampling single maps — too few matches over this exact map range to count directly.'
                       : `${play.rawWins} of this player's last ${play.rawOf} matches would have gone ${play.side} ` +
                         `this line (${maps(r.map_start, r.map_end)}). That is what happened before, not the chance it happens ` +
                         `again: across settled props, plays like this have hit about 52%, near a coin flip.`,
                   )}">${
                     play.rawOf === null
                       ? 'Estimated from single maps'
                       : `<b>${play.rawWins}</b> of last <b>${play.rawOf}</b> matches ${play.side}`
                   }</div><div class="why only-sm">${esc(formNote(f, play))}</div>`
            }</td>
            ${showEv ? `<td class="c evcol" data-label="EV">${evCell(play)}</td>` : ''}
            ${columns
              .map((code) => bookCell(r.books, code, only, (b) =>
                ouButtons(b.prop_id, back, b.side,
                  offeredSides(r.books, code, restrict),
                  // No side is marked as the one to take: see `playCell`.
                  'both',
                  { over: b.over_ok, under: b.under_ok },
                  Number(b.line)),
                only ?? callBook))
              .join('')}
            <td class="c gapcol">${gap}</td>
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
    body: lockNotice(o.lockedBook, o.blocked, o.blockedOn ?? null) + body,
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
  /** Which book the refused prop was on — see WrongBookError. */
  blockedOn?: string | null;
}): string {
  const back = `/${qs({}, o.filters)}`;
  const gaps = o.rows.filter((r) => r.spread !== null && Number(r.spread) !== 0);
  // Same two lines as the board, and deliberately identical: an app chosen by
  // filter and an app forced by an open slip narrow this page the same way,
  // because the server has already collapsed the two into filters.book. Every
  // row here has a non-zero gap, so under a narrowed app exactly one side of
  // each is the better number — and only that one is offered.
  const only = o.lockedBook ?? o.filters.book;
  const restrict = Boolean(only) && o.filters.best;
  const columns: BookCode[] = orderBooks(
    [...new Set(o.rows.flatMap((r) => r.books.map((b) => b.book)))],
    (b) => b,
  );

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
          ${columns.map((b) => bookHead(b, only, o.lockedBook !== null)).join('')}
          <th scope="col" class="c">Gap</th>
          <th scope="col">Better side</th><th scope="col" class="hide-sm">Match</th>
        </tr></thead>
        <tbody>${gaps
          .map((r) => {
            const d = Number(r.spread);
            /**
             * Two different claims, and the row says which one it is making.
             *
             * With three books or more there is a consensus to be off, and the
             * flagged book's cheap side is a real direction read off the other
             * books. With two there is only a cheaper number — true, useful for
             * deciding where to place a bet you had already chosen, and NOT a
             * reason to make one. Labelling both the same way is how a price
             * observation gets mistaken for an edge.
             */
            const edge = bestEdge(r.books);
            const lowest = r.books.reduce((a, b) => (b.line < a.line ? b : a));
            const cheaper = edge
              ? `${edge.side === 'over' ? 'Over' : 'Under'} on ${bookName(edge.book)} — ${edge.gap.toFixed(1)} off ${num(edge.fair)}`
              : `Over on ${bookName(lowest.book)} (cheaper line only)`;
            const cls = edge ? (edge.side === 'over' ? 'o' : 'u') : 'o';
            const histId = r.books[0]?.prop_id ?? null;
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
            ${columns
              // Same cell as the board. This page used to hide buttons only on
              // a slip lock, so choosing an app by tab still left every other
              // app takeable here while the board had narrowed — the two pages
              // disagreeing about what "selected" means.
              .map((code) => bookCell(r.books, code, only, (b) =>
                ouButtons(b.prop_id, back, b.side,
                  offeredSides(r.books, code, restrict),
                  bestSide(r.books, code),
                  { over: b.over_ok, under: b.under_ok })))
              .join('')}
            <td class="c gapcell"><span class="gap-chip up">${d.toFixed(1)}</span></td>
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
    body: lockNotice(o.lockedBook, o.blocked, o.blockedOn ?? null) + gapsCard + movCard,
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
            s.book === 'mixed' ? 'Mixed' : s.book === null ? '—' : esc(bookName(s.book))
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
  /** Team stacks from `findStacks`, best first. Optional so older callers still render. */
  stacks?: Stack[];
  /** Pinnacle win probabilities by our team name, for saying why a stack is priced as it is. */
  teamOdds?: Map<string, TeamOdds>;
  book: BookCode;
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
        : KNOWN_BOOKS.map((b) => tab(b, bookName(b))).join('')}
    </nav>${o.lockedBook ? '<span class="lab">set by your slip</span>' : ''}</div>
  </div>`;

  /**
   * Stacks: the one strategy here with measured numbers behind it, so it goes
   * above everything else on the page.
   *
   * Each is one team's core plus one opponent, every leg on the same side,
   * ranked by the multiplier it has to be PAID to break even — the number to
   * hold up against the app. It rests on three measurements and no
   * projection: teammates move together (rho 0.324, CI on phi [0.198, 0.222]
   * over 8,923 series); in the tail the opponent follows the core — 87% after
   * five overs, 72% after five unders (`validate:tail`); and losing teams'
   * players go under more than winners' (57.2% against 45.7% on the books' own
   * lines, p = 0.040), which is what the moneyline feeds.
   *
   * The caption is one sentence, on purpose. It used to carry the break-even
   * rule, a coin-flip disclaimer and a lift factor in one paragraph, and the
   * only thing a reader needs from it is the number to compare with the app.
   */
  const stacksCard = !o.stacks || o.stacks.length === 0 ? '' : `<div class="card">
    <div class="card-head"><h2>Stacks</h2>
      <span class="sub">take one when your app pays more than the number shown</span></div>
    ${o.stacks.map((s) => {
      const odds = o.teamOdds?.get(s.team);
      const partner = s.legs.find((l) => l.team !== s.team);
      const why = odds ? ` Pinnacle has ${esc(s.team)} at ${(odds.pWin * 100).toFixed(0)}% to win.` : '';
      /**
       * Where the book publishes what each pick pays — Sleeper does — the
       * entry's payout is the product of them, so the EV needs nothing typed
       * in. PrizePicks publishes no payout at all (verified against its feed:
       * odds_type and promo flags, no multiplier), and Underdog's numbers are
       * relative to a base ladder it does not publish, so both still need the
       * quote. The figure is offered, not asserted: it prefills the box so one
       * tap corrects it if the app says otherwise.
       */
      const published = s.legs.every((l) => (l.payout ?? 0) > 0)
        ? s.legs.reduce((a, l) => a * (l.payout ?? 1), 1)
        : null;
      const paysLine = published === null ? '' :
        ` ${esc(bookName(s.book))} pays <b>${published.toFixed(2)}×</b> on its own numbers — EV <b>${(s.winProb * published).toFixed(2)}×</b> per unit.`;
      return `<div class="stack">
        <div class="evbar">
          <span class="evnum flat">${s.requiredMultiplier.toFixed(2)}×</span>
          <span class="evlab"><b>${s.legs.length}-pick: ${esc(s.team)} ${s.side}s${
            partner ? ` + ${esc(partner.team ?? 'opponent')} ${s.side}` : ''
          }</b><br>Worth it if your app pays more than ${s.requiredMultiplier.toFixed(1)}×.${why}${paysLine}
            <form class="kelly" method="post" action="/stack/quote" data-p="${s.winProb.toFixed(5)}">
              <input type="hidden" name="book" value="${esc(s.book)}">
              <input type="hidden" name="match_key" value="${esc(s.matchKey)}">
              <input type="hidden" name="team" value="${esc(s.team)}">
              <input type="hidden" name="side" value="${esc(s.side)}">
              <input type="hidden" name="size" value="${s.legs.length}">
              <input type="hidden" name="win_prob" value="${s.winProb}">
              <input type="hidden" name="indep_prob" value="${s.winProbIndependent}">
              <input type="hidden" name="required_mult" value="${s.requiredMultiplier}">
              <input type="hidden" name="prop_ids" value="${s.legs.map((l) => l.propId).join(',')}">
              <input type="hidden" name="sides" value="${s.legs.map((l) => l.play.side).join(',')}">
              If it pays <input name="mult" type="text" inputmode="decimal" autocomplete="off"
                value="${published === null ? '' : published.toFixed(2)}"
                aria-label="What your app pays for this slip, as a multiplier">×,
              stake <b>—</b>
              <button class="save" title="Record what the app quoted, so we learn how it prices these">Save</button>
            </form></span>
          <span class="grow"></span>
          <form method="post" action="/build/stage" class="inline">
            <input type="hidden" name="prop_ids" value="${s.legs.map((l) => l.propId).join(',')}">
            <input type="hidden" name="sides" value="${s.legs.map((l) => l.play.side).join(',')}">
            <button class="go" style="width:auto;padding:9px 18px">Build this slip</button>
          </form>
        </div>
        <div class="scroll cards-sm"><table class="stack-sm entry-table"><tbody>${s.legs.map((l) => `<tr>
          <td class="idcol"><div class="who">${leagueBadge(l.row.league)}<div class="whobody">
            <div class="name">${esc(l.row.handle)}</div>
            <div class="meta matchline">${esc(l.team ?? '—')}</div></div></div></td>
          <td class="statcol"><div class="sub2">${esc(statLabel(l.row.stat))}</div>
            <div class="meta">${esc(maps(l.row.map_start, l.row.map_end))}</div></td>
          <td class="callcol"><div class="play ${l.play.side === 'over' ? 'o' : 'u'}">
            <span class="dir">${l.play.side === 'over' ? 'Over' : 'Under'}</span>
            <span class="at">${l.play.line.toFixed(1)}</span></div></td>
          <td class="n probcol"><span class="fig sm">${(l.p * 100).toFixed(0)}%</span></td>
        </tr>`).join('')}</tbody></table></div>
      </div>`;
    }).join('')}
  </div>`;

  const body = o.entries.length === 0
    ? `<div class="card"><div class="empty">Not enough qualifying markets to build an entry on
       ${esc(bookName(o.book))} right now. Legs need a projection, a playable side, and a match
       that hasn't started.</div></div>`
    : o.entries.map((e) => {
        /**
         * What the slip NEEDS, not what it returns.
         *
         * PrizePicks publishes no multiplier anywhere reachable — the
         * projections payload has no payout object, no payout relationship,
         * and /payout_tables, /multipliers, /payouts and /wager_types are all
         * 404. It is applied client-side when the slip is built, and per prop,
         * so no table we could store would stay right.
         *
         * So the question gets turned around. `1 / P(all legs win)` is the
         * multiplier at which this entry breaks even, it needs nothing from
         * the book to compute, and it cannot go stale. The reader compares it
         * against the number their app is showing them: above it is value,
         * below it is not. That is the whole decision, and it survives every
         * repricing both books do.
         */
        // From the correlated model in slip.ts, not 1 / product-of-p. On a
        // stacked entry the product understates P(all win) by up to 1.87x,
        // which made this bar look far higher than it is.
        const needed = e.requiredMultiplier;
        const ev = e.evMultiple;
        const cls = ev === null ? 'flat' : ev >= 1.15 ? 'up' : ev >= 1 ? 'flat' : 'down';
        return `<div class="card">
      <div class="card-head">
        <h2>${e.size}-pick</h2>
        <span class="sub">${
          e.payout === null
            ? `${(e.winProb * 100).toFixed(1)}% chance of hitting every leg`
            : `${e.payout.toFixed(2)}× payout for a ${(e.winProb * 100).toFixed(1)}% chance of hitting every leg`
        }${
          e.discounted ? `, with ${e.discounted} discounted leg${e.discounted === 1 ? '' : 's'}` : ''
        }</span>
        ${(() => {
          // The one number that says how much of this entry rests on something
          // measured. Legs the crowd chose are backed by a signal that does not
          // depend on our projection; the rest are not backed by anything that
          // has survived a measurement.
          // Both sources have now been graded and neither wins: the projection
          // at AUC 0.495, the market anchor at 74-73 over 147 series. So this
          // counts them rather than endorsing them — "picked by the books" was
          // starting to read as a quality mark for a signal measured at a coin
          // flip, which is exactly the dressing-up this project refuses to do.
          const backed = e.legs.filter((l) => l.source === 'consensus').length;
          return `<span class="sub">${backed} of ${e.legs.length} legs sided by the books, ${e.legs.length - backed} by the projection — neither has beaten a coin flip</span>`;
        })()}
      </div>
      <div class="evbar">
        <span class="evnum ${ev === null ? 'flat' : cls}">${
          ev === null
            ? (needed === null ? '—' : `${needed.toFixed(2)}×`)
            : `${ev.toFixed(2)}×`
        }</span>
        <span class="evlab">${
          ev === null
            ? `needed to break even. Read the multiplier off your app and take it only if that number is bigger — a 6-pick is not always 37.5×, it moves with the props you picked`
            : `expected return per unit staked${ev < 1 ? ' — below break-even' : ''}${
                needed === null ? '' : `, needs ${needed.toFixed(2)}×`
              }`
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
            <div class="meta">${
              // Which signal chose this side, because they are not equally
              // trustworthy and a slip should not hide the difference. The
              // projection has been measured at AUC 0.495 — no ability to tell
              // a winner from a loser — so a leg resting on it is a leg resting
              // on nothing, however confident the percentage looks.
              l.source === 'market'
                ? `<span title="Sided by the team, not the player: Pinnacle's moneyline where there is one, otherwise close to a coin flip.">team read</span>`
                : l.source === 'consensus'
                ? `<span title="Direction read off the other books: this app is ${l.gap?.toFixed(1)} off their median. No projection involved.">${l.gap?.toFixed(1)} off the crowd</span>`
                : `<span title="No consensus available — fewer than three books price this market, so the side comes from our projection, which has been measured at AUC 0.495 and has shown no ability to pick winners.">projection only</span>`
            }</div></td>
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
    body: `${stacksCard}<div class="notice">Each entry takes the highest-value legs available, where value is
      win probability times what the leg pays. One leg per player, at most two per match — legs
      from one match move together, and both books reprice correlated entries.</div>
      <div class="notice warn-notice"><b>The break-even figure is a floor, and the real one is
      higher.</b> It is computed from our own win probabilities, and those have been graded:
      across settled markets these calls claim about 59% and realise about 52%, which is close
      enough to a coin flip that a four-leg entry needs roughly <b>13×</b> rather than the ~8×
      our numbers imply. Picking the best few legs out of a hundred estimates also selects for
      the ones that got lucky, so the bar shown is optimistic even after every probability is
      shrunk toward a coin flip. Treat a slip that only just clears it as one that does not.</div>
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&family=Barlow+Semi+Condensed:wght@500;600;700&display=swap">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0B1220">
<link rel="stylesheet" href="/app.css">
</head>
<body class="login-body">
  <main class="login">
    <h1 class="brand login-brand">${MARK}<span class="word">BropProp</span></h1>
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

// ------------------------------------------------------------------ stats --

/**
 * A bar chart as inline SVG.
 *
 * No chart library, for the same reason there is no framework here: a
 * dependency arrives with a default look that then has to be fought, and this
 * is a dozen rectangles. Bars are drawn against the largest value rather than
 * a rounded axis, because the shape of the growth is the point and a tidy
 * axis would flatten it.
 */
function barChart(
  data: Array<{ label: string; value: number }>,
  o: { height?: number; label?: string } = {},
): string {
  if (data.length === 0) return '<div class="empty">Nothing recorded yet.</div>';
  const h = o.height ?? 120;
  const max = Math.max(...data.map((d) => d.value), 1);
  const w = 100 / data.length;
  const bars = data
    .map((d, i) => {
      const bh = (d.value / max) * h;
      return `<g><title>${esc(d.label)}: ${d.value.toLocaleString()}</title>
        <rect x="${(i * w).toFixed(3)}%" y="${(h - bh).toFixed(2)}"
              width="${(w * 0.78).toFixed(3)}%" height="${Math.max(bh, 0.5).toFixed(2)}"
              rx="1" class="bar"/></g>`;
    })
    .join('');
  const first = data[0]!.label;
  const last = data[data.length - 1]!.label;
  return `<div class="chart">
    <svg viewBox="0 0 100 ${h}" preserveAspectRatio="none" role="img"
         aria-label="${esc(o.label ?? 'chart')}: ${data.length} points, peak ${max.toLocaleString()}">
      ${bars}
    </svg>
    <div class="chart-x"><span>${esc(first)}</span><span>${esc(last)}</span></div>
  </div>`;
}

/**
 * Two probability series over time, against a 50% reference.
 *
 * Built for the model scorecard, where the gap between the two lines IS the
 * finding — claimed sitting above realised is overconfidence, and you can
 * only see that if both are drawn on one axis. The 50% rule is dashed and
 * always present, because every number here has to be read against a coin.
 *
 * A single stored day cannot make a polyline, so points are drawn as dots
 * too. That is the normal state on a young install, not an edge case.
 */
function lineChart(
  series: Array<{ label: string; points: Array<number | null>; cls: string }>,
  xLabels: string[],
  o: { rule?: number; label?: string } = {},
): string {
  const n = xLabels.length;
  if (n === 0) return '<div class="empty">Nothing scored yet.</div>';

  const h = 120;
  // A fixed window rather than an auto-fit: rescaling the axis as data arrives
  // would make an unchanged model look like it was moving. Values outside it
  // pin to the edge — deliberate, since anything beyond 35-70% on a prop hit
  // rate is either a bug or a sample of three.
  const lo = 0.35, hi = 0.7;
  const y = (v: number) => h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);

  const rule = o.rule ?? 0.5;
  const parts = series.map((s) => {
    const pts = s.points
      .map((v, i) => (v === null ? null : `${x(i).toFixed(3)},${y(v).toFixed(2)}`))
      .filter((p): p is string => p !== null);
    // Point markers are zero-length round-capped lines, not circles. The
    // viewBox is stretched to the container (100 units across a 1400px card),
    // so a circle renders as an ellipse fourteen times wider than it is tall —
    // which turned the whole series into a fuzzy band. A stroke with
    // non-scaling-stroke ignores that scaling, and a round cap on a zero-length
    // segment is a true circle at any width.
    const dots = s.points
      .map((v, i) => (v === null ? '' :
        `<line x1="${x(i).toFixed(3)}" y1="${y(v).toFixed(2)}"
               x2="${x(i).toFixed(3)}" y2="${y(v).toFixed(2)}" class="dot ${s.cls}"/>`))
      .join('');
    const line = pts.length > 1
      ? `<polyline points="${pts.join(' ')}" class="line ${s.cls}"/>` : '';
    return line + dots;
  }).join('');

  const keys = series
    .map((s) => `<span class="key"><i class="swatch ${s.cls}"></i>${esc(s.label)}</span>`)
    .join('');

  return `<div class="chart">
    <svg viewBox="0 0 100 ${h}" preserveAspectRatio="none" role="img"
         aria-label="${esc(o.label ?? 'scorecard over time')}">
      <line x1="0" x2="100" y1="${y(rule).toFixed(2)}" y2="${y(rule).toFixed(2)}" class="rule"/>
      ${parts}
    </svg>
    <div class="chart-x"><span>${esc(xLabels[0]!)}</span><span>${esc(xLabels[n - 1]!)}</span></div>
    <div class="chart-key">${keys}<span class="key"><i class="swatch rule"></i>50% — a coin</span></div>
  </div>`;
}

/** A labelled proportion bar — ready against total, that kind of thing. */
function meter(done: number, total: number, label: string): string {
  const pct = total > 0 ? Math.round((100 * done) / total) : 0;
  return `<div class="meter-row">
    <div class="meter-top"><span>${esc(label)}</span>
      <span class="meter-n"><b>${done}</b> of ${total}</span></div>
    <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
  </div>`;
}

export function statsPage(o: {
  health: Health;
  counters: Counters;
  weeks: Array<{ week: string; league: string; n: number }>;
  coverage: Array<{ league: string; total: number; ready: number }>;
  record: Array<{ status: string; n: number }>;
  sources: Array<{ source: string; league: string; n: number }>;
  clv: ClvSummary;
  scores: ScoreRow[];
  leads?: LeadRow[];
  stacks?: StackRecord | null;
}): string {
  const c = o.counters;

  // Weeks come back split by league; the growth chart is about the archive as
  // a whole, so they are summed back together here.
  const byWeek = new Map<string, number>();
  for (const w of o.weeks) byWeek.set(w.week, (byWeek.get(w.week) ?? 0) + w.n);
  const weekData = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, n]) => ({ label: week, value: n }));

  // Takes a string as well as a number so a percentage can carry its sign.
  // It read "33" under "beat the close", which is a different claim entirely.
  const stat = (n: number | string, k: string, sub = '') =>
    `<div class="stat"><div class="stat-n">${typeof n === 'number' ? n.toLocaleString() : esc(n)}</div>
      <div class="stat-k">${esc(k)}</div>${sub ? `<div class="meta">${esc(sub)}</div>` : ''}</div>`;

  const graded = o.record.filter((r) => r.status !== 'pending').reduce((a, r) => a + r.n, 0);
  const won = o.record.find((r) => r.status === 'won')?.n ?? 0;

  const clvBody = o.clv.picks === 0
    ? `<div class="empty">No pick has been placed on a market that kept moving yet.
        This fills in on its own — every placed leg gets compared against the last
        line before kick-off.</div>`
    : `<div class="stat-row">
        ${stat(o.clv.picks, 'picks measured')}
        ${stat(`${Math.round(o.clv.beatRate * 100)}%`, 'beat the close', `${o.clv.beat} of ${o.clv.picks}`)}
        <div class="stat"><div class="stat-n ${o.clv.meanClv >= 0 ? 'good' : 'bad'}">${
          o.clv.meanClv >= 0 ? '+' : ''
        }${o.clv.meanClv.toFixed(2)}</div>
          <div class="stat-k">mean CLV</div><div class="meta">stat units per pick</div></div>
      </div>
      <div class="scroll"><table class="board-table">
        <thead><tr><th scope="col">Player</th><th scope="col">Market</th>
          <th scope="col" class="c">Took</th><th scope="col" class="c">Closed</th>
          <th scope="col" class="c">CLV</th><th scope="col">Result</th></tr></thead>
        <tbody>${o.clv.rows
          .slice(0, 25)
          .map(
            (r) => `<tr>
            <td><div class="name">${esc(r.handle)}</div></td>
            <td><div class="statname">${esc(statLabel(r.stat))}</div>
                <div class="meta">${esc(r.side)} on ${esc(bookName(r.book))}</div></td>
            <td class="c"><span class="chip-num book">${r.taken.toFixed(1)}</span></td>
            <td class="c"><span class="chip-num model">${r.closing.toFixed(1)}</span></td>
            <td class="c"><span class="ev ${r.clv >= 0 ? 'pos' : 'neg'}">${
              r.clv >= 0 ? '+' : ''
            }${r.clv.toFixed(1)}</span></td>
            <td><span class="meta">${esc(r.status)}</span></td>
          </tr>`,
          )
          .join('')}</tbody>
      </table></div>`;

  /**
   * The stack record: the one shape with a measured edge, being checked.
   *
   * Hit rate is compared against what the entries needed — the average of
   * 1/P(all win) — because a stack is only good relative to the multiplier it
   * has to clear. `matches` rather than entries is the sample that counts:
   * several stacks from one match share its outcome.
   */
  const sr = o.stacks ?? null;
  const stackBody = sr === null || sr.graded + sr.pending === 0
    ? `<div class="empty">No stack has been recommended and settled yet. Every stack the
        Build page shows is written down and graded once its matches finish — the record
        fills in on its own.</div>`
    : `<div class="stat-row">
        ${stat(sr.graded, 'stacks graded', `${sr.matches} matches, ${sr.pending} waiting`)}
        ${stat(sr.graded === 0 ? '—' : `${((sr.won / sr.graded) * 100).toFixed(1)}%`, 'came in',
               `${sr.won} of ${sr.graded}`)}
        ${stat(sr.mean_required === null ? '—' : `${sr.mean_required.toFixed(1)}×`, 'they needed',
               'average break-even multiplier')}
        ${
          sr.priced === 0 || sr.mean_return === null
            ? stat('—', 'return per unit', 'place a slip from a stack to record what it pays')
            : stat(`${sr.mean_return.toFixed(2)}×`, 'return per unit', `${sr.priced} placed at a known payout`)
        }
      </div>
      <p class="note">A stack pays only when every leg lands, so a handful of entries says
        nothing either way. What makes it worth watching is that the shape was priced from
        measured correlation before any of these were placed.</p>`;

  /**
   * Leads: pricing patterns the bias scan found in the first days of lines,
   * scored only on games since they were found. A lead is an edge only once it
   * has its pre-registered sample and its whole interval still clears the
   * five-pick bar; until then it is shown as collecting, whatever it reads.
   */
  const LEAD_BAR = 0.549;
  const leadRows = o.leads ?? [];
  const leadBody = leadRows.length === 0
    ? `<div class="empty">Tracking starts with games from 12 September. The first
        forward record appears after the daily scoring run.</div>`
    : leadRows.map((l) => {
        const need = l.series_needed ?? 0;
        const rate = l.win_rate === null ? '—' : `${(l.win_rate * 100).toFixed(1)}%`;
        const ci = l.ci_lo === null || l.ci_hi === null
          ? '' : ` [${(l.ci_lo * 100).toFixed(0)}–${(l.ci_hi * 100).toFixed(0)}%]`;
        const status = l.series < need
          ? `collecting — ${l.series} of ~${need} matches`
          : l.ci_lo !== null && l.ci_lo > LEAD_BAR
            ? 'holding up: the whole interval clears the 5-pick bar'
            : 'not holding up at full sample';
        return `<div class="lead">
          <div class="lead-h"><b>${esc(l.label)}</b><span class="meta">${esc(status)}</span></div>
          <div class="meta">won ${rate}${ci} of ${l.legs} legs across ${l.series} matches since ${esc(l.since)}${
            l.series_up !== null && l.series_down !== null ? `; matches leaning its way ${l.series_up}-${l.series_down}` : ''
          }</div>
          ${meter(Math.min(l.series, need || 1), need || 1, 'matches toward the target')}
        </div>`;
      }).join('');

  // The scorecard, newest first from the table; charts read oldest-first.
  const hist = [...o.scores].reverse();
  const latest = o.scores[0] ?? null;
  const pc = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : `${(100 * v).toFixed(1)}%`;

  const scoreBody = latest === null
    ? `<div class="empty">No scorecard stored yet. It is computed once a day, and
        needs settled matches to score against — this fills in on its own.</div>`
    : `<div class="stat-row">
        ${stat(pc(latest.realised), 'the model realised', `${latest.calls} calls`)}
        ${stat(pc(latest.claimed), 'it predicted', 'average confidence')}
        ${stat(latest.auc === null ? '—' : latest.auc.toFixed(3), 'AUC',
               '0.50 = no skill')}
        ${stat(latest.series, 'independent series', `over ${latest.days} days`)}
      </div>

      <p class="note">The number to read is <b>AUC</b>, not the hit rate. It is the
        chance a winning call carried higher confidence than a losing one, so 0.500
        means the model cannot tell the two apart — and no amount of recalibration
        fixes that, because there is no ordering to correct. A hit rate on its own
        says nothing until you know what doing nothing would have scored, which is
        why both baselines sit below.</p>

      <div class="stat-row">
        ${stat(pc(latest.always_under), 'always take the under', 'no model at all')}
        ${stat(pc(latest.always_over), 'always take the over', 'no model at all')}
        ${stat(latest.series_judged
                 ? `${latest.series_ahead}/${latest.series_judged}`
                 : '—',
               'series the model led',
               latest.series_p === null ? '' : `p = ${latest.series_p.toFixed(3)}`)}
      </div>

      ${
        latest.ours_mae === null || latest.line_mae === null
          ? ''
          : `<p class="note"><b>Is our number better than the book's?</b> The board
              shows "Ours" beside the line and calls the gap between them your
              edge. That only holds if ours is the closer estimate. Measured
              against what players actually did, over ${latest.est_n ?? 0} settled
              markets:</p>
            <div class="stat-row">
              ${stat(latest.ours_mae.toFixed(2), 'our average miss',
                     latest.ours_bias === null ? ''
                       : `runs ${latest.ours_bias >= 0 ? '+' : ''}${latest.ours_bias.toFixed(2)} high`)}
              ${stat(latest.line_mae.toFixed(2), "the book's average miss",
                     latest.line_bias === null ? ''
                       : `runs ${latest.line_bias >= 0 ? '+' : ''}${latest.line_bias.toFixed(2)} high`)}
              <div class="stat"><div class="stat-n ${
                latest.ours_mae <= latest.line_mae ? 'good' : 'bad'
              }">${latest.ours_mae <= latest.line_mae ? 'ours' : 'the book'}</div>
                <div class="stat-k">closer estimate</div>
                <div class="meta">by ${Math.abs(latest.ours_mae - latest.line_mae).toFixed(2)}</div></div>
            </div>
            ${
              latest.ours_mae <= latest.line_mae
                ? ''
                : `<p class="note">The book's line is the better estimate, so part of
                    every "in your favour" gap on the board is our own error rather
                    than an edge. Read the lean as a disagreement, not a discount.</p>`
            }`
      }

      <p class="note"><b>Leg counts are not sample sizes.</b> Every player in a
        series shares its length, its overtime and its pace, so one long map sends
        every leg over at once. ${latest.calls} calls from ${latest.series} series is
        ${latest.series} pieces of evidence, not ${latest.calls} — which is why the
        significance quoted above is counted per series, and why nothing here is
        settled yet.</p>

      ${hist.length
        ? lineChart(
            [
              { label: 'predicted', cls: 'claimed', points: hist.map((r) => r.claimed) },
              { label: 'realised', cls: 'realised', points: hist.map((r) => r.realised) },
              { label: 'always under', cls: 'baseline', points: hist.map((r) => r.always_under) },
            ],
            hist.map((r) => r.day),
            { label: 'model scorecard over time' },
          )
        : ''}`;

  const body = `
  <div class="card">
    <div class="card-head"><h2>What has been collected</h2>
      <span class="sub">${esc(c.oldest ?? '—')} to ${esc(c.newest ?? '—')}</span></div>
    <div class="stat-row">
      ${stat(c.statLines, 'stat lines', 'one player, one map')}
      ${stat(c.series, 'series')}
      ${stat(c.players, 'players')}
      ${stat(c.lineChanges, 'line changes', 'every move, timestamped')}
      ${stat(c.props, 'markets logged')}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>History collected, by week</h2>
      <span class="sub">per-map results, the thing everything else rests on</span></div>
    <div class="card-body">${barChart(weekData, { label: 'stat lines per week' })}</div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Has the model actually been right?</h2>
      <span class="sub">every logged line replayed through the real engine, on history it had at the time</span></div>
    <div class="card-body">${scoreBody}</div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Stacks recommended</h2>
      <span class="sub">written down when Build suggests them, graded when the matches finish</span></div>
    <div class="card-body">${stackBody}</div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Leads being tested</h2>
      <span class="sub">pricing patterns found in the first days of lines, scored only on games since</span></div>
    <div class="card-body">
      <p class="note">A pattern found by looking at five days of lines can't be proven by those same
        five days. Each lead here was written down before the games it is scored on, and it only
        counts as an edge once it reaches its target sample with its whole interval above the
        five-pick break-even.</p>
      ${leadBody}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Closing line value</h2>
      <span class="sub">did the market move toward the number you took</span></div>
    <div class="card-body">
      <p class="note">Win rate needs hundreds of settled bets to mean anything —
        props inside one match move together, so a single short series drags every
        leg with it. CLV needs dozens, because it scores each pick against what the
        market decided next rather than against one noisy result. Beating the close
        is what being sharp looks like before the results arrive.</p>
      ${clvBody}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>How much of the board the model can speak to</h2>
      <span class="sub">a player under six series gets no call, however good the engine</span></div>
    <div class="card-body">
      ${
        o.coverage.length === 0
          ? `<div class="empty">No upcoming matches are priced right now, so there is
              no board to measure. This fills back in as soon as the books post lines.</div>`
          : o.coverage
              .map((x) => meter(x.ready, x.total, `${x.league} players with enough history`))
              .join('')
      }
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Where the history comes from</h2></div>
    <div class="scroll"><table class="board-table">
      <thead><tr><th scope="col">Source</th><th scope="col">Game</th>
        <th scope="col" class="c">Stat lines</th></tr></thead>
      <tbody>${o.sources
        .map(
          (s) => `<tr><td><div class="statname">${esc(s.source)}</div></td>
          <td>${leagueBadge(s.league)}</td>
          <td class="c"><span class="prob">${s.n.toLocaleString()}</span></td></tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Graded record</h2>
      <span class="sub">${graded === 0 ? 'nothing settled yet' : `${won} of ${graded} settled picks won`}</span></div>
    <div class="card-body">
      ${
        graded === 0
          ? `<div class="empty">Picks grade automatically once results land — CS2 stats
              arrive 7 to 33 hours after a match ends, so a pick taken tonight settles
              tomorrow.</div>`
          : `<div class="stat-row">${o.record.map((r) => stat(r.n, r.status)).join('')}</div>
             <p class="note">Far too few to read anything into. This is the number that
               eventually matters, and the one that takes longest to earn.</p>`
      }
    </div>
  </div>`;

  return shell({ title: 'Stats', active: 'stats', health: o.health, body });
}
