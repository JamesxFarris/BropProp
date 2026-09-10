import { pool, q } from './db.js';

const fmt = (n: unknown) => (n === null || n === undefined ? '—' : String(n));

function table(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return '  (none)';
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => fmt(r[c]).length)),
  );
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => c.padEnd(w[i]!)).join('  ');
  return [
    line(cols),
    '  ' + w.map((n) => '-'.repeat(n)).join('  '),
    ...rows.map((r) => line(cols.map((c) => fmt(r[c])))),
  ].join('\n');
}

const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

section('Poll health (last 10 runs)');
console.log(table(await q(`
  SELECT book_code AS book, to_char(started_at,'MM-DD HH24:MI') AS started,
         http_status AS http, props_seen AS props, snaps_written AS snaps,
         ok, COALESCE(left(error,40),'') AS error
  FROM poll_run ORDER BY started_at DESC LIMIT 10`)));

section('Board coverage');
console.log(table(await q(`
  SELECT b.code AS book, p.league, count(*) AS props,
         count(DISTINCT p.player_id) AS players,
         count(DISTINCT p.match_id) AS matches
  FROM prop p JOIN book b ON b.id = p.book_id
  GROUP BY 1,2 ORDER BY 1,2`)));

section('Cross-book disagreements (widest gap per market, any books)');
console.log(table(await q(`
  SELECT handle AS player, league, stat,
         map_start||'-'||map_end AS maps,
         books,
         low_book||' '||low_line   AS low,
         high_book||' '||high_line AS high,
         line_diff AS diff,
         COALESCE(left(match_title,34),'') AS match
  FROM cross_book_diff
  ORDER BY line_diff DESC, player LIMIT 20`)));

section('Line movement (props whose line has moved since first logged)');
console.log(table(await q(`
  WITH hist AS (
    SELECT s.prop_id, count(*) AS obs,
           (array_agg(s.line ORDER BY s.observed_at))[1] AS opened,
           (array_agg(s.line ORDER BY s.observed_at DESC))[1] AS latest,
           max(s.observed_at) AS last_move
    FROM prop_snapshot s GROUP BY s.prop_id HAVING count(*) > 1
  )
  SELECT pl.handle AS player, b.code AS book, p.stat,
         p.map_start||'-'||p.map_end AS maps,
         h.opened, h.latest, (h.latest - h.opened) AS move, h.obs,
         to_char(h.last_move,'MM-DD HH24:MI') AS last_move
  FROM hist h
  JOIN prop p   ON p.id = h.prop_id
  JOIN book b   ON b.id = p.book_id
  JOIN player pl ON pl.id = p.player_id
  WHERE h.opened <> h.latest
  ORDER BY abs(h.latest - h.opened) DESC LIMIT 20`)));

section('Totals');
console.log(table(await q(`
  SELECT (SELECT count(*) FROM prop) AS props,
         (SELECT count(*) FROM prop_snapshot) AS snapshots,
         (SELECT count(*) FROM player) AS players,
         (SELECT count(*) FROM match) AS matches,
         (SELECT to_char(min(observed_at),'MM-DD HH24:MI') FROM prop_snapshot) AS logging_since`)));

console.log();
await pool.end();
