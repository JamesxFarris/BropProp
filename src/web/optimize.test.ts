import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFor } from './optimize.js';
import type { MarketRow } from './boardq.js';
import type { FormStats } from './projection.js';

/**
 * /build reaches the same `evaluate` engine as /board, but through
 * `candidatesFor` -> `recommend` rather than a direct call — and it is easy to
 * wire a new evaluate() input everywhere `evaluate` is called directly while
 * missing the one place that goes through `recommend`. This pins that a CS2
 * kills market gets the same `kpr` method here as it would on the board,
 * given the same league and round pool, so that path cannot silently regress
 * back to being priced from per-map totals while the board moves on.
 */

const row = (o: Partial<MarketRow> = {}): MarketRow => ({
  canon_handle: 'p1', handle: 'p1', league: 'CS2', stat: 'kills',
  map_start: 1, map_end: 1, is_combo: false,
  pp_prop_id: null, pp_line: null,
  ud_prop_id: 1, ud_line: 10.5,
  ud_over_price: null, ud_under_price: null,
  pp_over_ok: true, pp_under_ok: true,
  ud_over_ok: true, ud_under_ok: true,
  ud_over_mult: null, ud_under_mult: null,
  delta: null, match_title: 'Match', scheduled_at: null,
  confirmed_at: '2026-01-01T00:00:00Z', pp_side: null, ud_side: null, moved: null,
  ...o,
});

test('a CS2 kills market reaches the kpr method through candidatesFor, not just evaluate directly', () => {
  const form = new Map<string, FormStats>();
  form.set('p1|kills|1|1', {
    series: 0, mean: 0, sd: null, totals: [], mapValues: [],
    perMap: null, kpr: Array(20).fill(0.8), roundsSeen: 20,
  });
  const roundPool = [20, 24, 28];
  const cands = candidatesFor([row()], form, 'underdog', roundPool);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]?.play.method, 'kpr');
});

test('without a round pool, the same market falls back rather than pretending', () => {
  // The regression this guards: forgetting to thread the pool through must
  // not silently degrade to a different, still-plausible-looking method.
  const form = new Map<string, FormStats>();
  form.set('p1|kills|1|1', {
    series: 0, mean: 0, sd: null, totals: [], mapValues: [],
    perMap: null, kpr: Array(20).fill(0.8), roundsSeen: 20,
  });
  const cands = candidatesFor([row()], form, 'underdog');
  assert.equal(cands.length, 0, 'no maps/series history means no fallback call either');
});
