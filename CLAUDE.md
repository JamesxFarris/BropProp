# BropProp — working notes for whoever picks this up

An esports (CS2/LoL) prop-line logger and edge finder for DFS pick'em apps —
PrizePicks, Underdog, Sleeper. It polls their boards, stores every line it sees,
settles them against a stat archive, and tries to find shapes worth betting.

Most of what follows is not style preference. It is a list of things this
project got wrong, measured, and had to undo. Read it before proposing an idea
that has already been graded.

## The one rule that keeps getting broken

**A series is the unit of evidence. A leg is not.**

Ten players in one CS2 match share one game: when the map runs long, everybody's
kills go over together. So 1,348 legs are not 1,348 observations — in the last
measurement they were **84 series**, and the confidence interval is built from
that number, not the big one. Every hit rate in this repo is scored with a
cluster bootstrap over series (`clusterBootstrap` in `src/results/referee.ts`).

This has been rediscovered at least three times. If a result looks strong and
the leg count is in the thousands, count the series before believing it.

## Measurement rules

- **Use the shared scorer.** `src/results/referee.ts` — Brier, log loss,
  tie-aware AUC, reliability, ROI by edge, `perLegBreakEven(n)`. Don't hand-roll
  a hit rate.
- **Never validate a line idea on archive pseudo-lines.** Before 2026-09-06 we
  have no book lines, so the archive stands in a median-of-prior-series + 0.5.
  That is a line a book *could* have set, not one it *did*. A model beating it
  is beating a stand-in, which is how this project once found a fat fake edge.
  Correlation is exempt — it is a property of the game, and it survives the
  change of adversary (it measures *stronger* on real lines).
- **Pre-register slices, then Holm-correct.** With dozens of cells, ~2.5% clear
  any bar by luck. Print the number of cells tested next to every hit.
- **When a split is defined by an outcome, check the graded leg doesn't feed
  that outcome.** The "blowout effect" (62%/48%) was circular: the player's own
  kills decided whether his team lost, so going under made his own team the
  loser. Leave the leg out, and compare groups of equal size. Fair answer:
  57.2/45.7.
- **The bar is the ladder, not 50%.** Per-leg break-even is 58.5% (3-pick at
  5x), 55.5% (5-pick at 19x), 55.6% (6-pick at 34x). A 54% signal is a losing
  signal here.
- **Check independence at the base rate before calling anything an edge.**
  A 6-pick at 34x needs 2.94%, and independent legs at p give p^6 — so any base
  over-rate above 34^(-1/6) = **55.6%** clears that bar with no correlation at
  all. Run as a control on MLB, this method reported a 5+1 hits shape at 6.85%
  against a 2.94% bar: an apparent 2.3x edge that was purely an unpriced
  favourite, base rate 61.4%, independence 5.86%, lift 1.17. Report **lift =
  realised / independent-at-the-same-base-rate** as the headline, never the
  realised rate against the ladder. `independenceBar()` and
  `clearsOnBaseRateAlone()` in `slip.ts` do the arithmetic. CS2 kills maps 1-2
  survives this (base 47.8%, independence 1.19%, realised 7.7%, lift 6.5x) — but
  by luck of where the line convention sits, not because anything enforced it.

## What has already been graded — don't re-litigate

| Idea | Verdict |
|---|---|
| Per-prop projection model | **DEAD.** AUC 0.495, -9.5% ROI on real closing lines, 0 of 213 held-out slices positive, worse than always-under. Do not resurrect it. |
| Cross-book consensus / disagreement as signal | **DEAD.** 74-73 over 147 series, p = 1.00. Structural cause found: the books resell one B2B supplier (Dabble's markets are typed `pandascore_*`), so a "crowd" is one vote wearing several hats. |
| Blind over/under shade | **FADED.** 51.6% under, p = 0.14. |
| Team ratings (walk-forward Elo) | Null for props. Kept out of pricing. |
| Line movement / cross-book lag | **Below the bar.** 54.5% on 84 series (CI straddles 50), and you cannot take a line that already moved. |
| 3-leg stacks | **-EV, dropped.** 16.8% vs a 20% bar. `STACK_SIZES = [5, 6]`. |
| **Correlated stacks (5+1, 4+1)** | **The one live edge.** Teammate rho 0.324 over 8,923 series; opponent follows a 5-over core 87% of the time over 831 series, stable across five half-years. |

The open question is **not** the measurement any more. It is whether the apps
*permit* five legs from one team and how steeply they discount it — PrizePicks
once quoted 22x on a shape listing at 37.5x. Nothing in any unauthenticated feed
answers that, which is what `stack_log`'s quote capture exists to learn.

## Honesty rules for anything user-facing

- **Never present confidence the data cannot support.** No win percentages, no
  "hot" badges, no invented insights, no projections dressed as facts.
- The board states the arithmetic and stops. Recommendations live on Build.
- Both sides of a prop stay takeable — slips are built by hand, and these apps
  require 2+ players from 2+ teams, so a single prop is never a slip.
- Show the best line available, not a pile of cross-app numbers.
- If a payout is unknown, say so. A stale payout table makes every EV
  confidently wrong rather than visibly missing (`src/config.ts`).

## Environment and ops

- **There is no local Postgres.** `npm test` fails 12 tests with ECONNREFUSED on
  port 5433. That is environmental, not a regression. Expect 283/295.
- **There is no build step.** `tsx` transpiles with esbuild at run time, so the
  tests exercise the bundler. `npm run typecheck` is `tsc --noEmit`.
- **Query production** (no local DB, so this is how you measure anything):
  ```
  railway ssh --project 707463d9-4970-480f-abec-35397aecbd88 \
    --environment production --service bropprop-logger "cd /app && ..."
  ```
  Ship a script by gzip + base64 into a heredoc; run it with
  `node node_modules/.bin/tsx script.ts`. **`npx tsx -e` hangs** — don't.
- **Long jobs** need `setsid nohup ... &` or the SSH session kills them. Add
  `--max-old-space-size=2048` for anything loading the archive.
- **Deploy:** `git push origin n-book-consensus:main`. Railway builds both
  services; migrations in `db/` run on worker boot.

## Code traps specific to this repo

- **No backticks inside comments in `src/web/render.ts`.** Large parts of that
  file live inside template literals, and a backtick in a comment there ends the
  string as far as the bundler is concerned. This has broken the build twice.
- Watch for TDZ in `render.ts`: consts are read by helpers defined above them.
- `prop.extra` does not exist — it is `prop_snapshot.extra`.
- A Sleeper per-pick `payout_multiplier` is the leg's **marginal**, not the
  entry's payout. The entry pays a flat ladder (`PUBLISHED_LADDER`). Using the
  multiplier as both price and payout counts the same number twice and
  manufactures EV — it did, once.

## Safety

- **Never print, log or commit `ODDSPAPI_KEY`.** It lives in a `.env` comment.
- **Never use Pinnacle's lifted guest key.**
- When probing books: read-only, normal user agent, and **stop at a wall**. A
  403 from Cloudflare or a 401 from an API means that book is out. Do not defeat
  anti-bot measures or forge auth.
- Respect the request budget on OddsPapi (250/month; cap is 220).

## How to work here

- Prefer measuring to arguing. This repo can answer most questions about itself
  in one query against production.
- Report results faithfully, including the ones that kill your own idea. Every
  entry in the graded table above was something someone here wanted to be true.
- Small, verifiable steps. Say what you verified and what you assumed.

## Why the edge exists at all — and why it is perishable

For weeks the honest position here was "the stack measures +EV, every alternative
explanation has been eliminated, and nobody can say why it would be true." There
is now an answer, and it is structural rather than statistical.

**PrizePicks withdraws the flat ladder from the sports where stacking is famous.**
Measured directly off its partner feed on 2026-09-13, counting `odds_type`:

| league | lines | standard | % standard |
|---|---|---|---|
| **CS2** | 172 | 172 | **100.0%** |
| NFL | 8,719 | 1,801 | 20.7% |
| MLB | 3,419 | 155 | 4.5% |
| soccer | — | — | ~3% |

Demon and goblin lines carry their own multipliers and cannot be assembled into
a flat-ladder entry. So on MLB — where same-team stacking is the oldest strategy
in daily fantasy — 95.5% of the board simply cannot be stacked at a fixed price.
On CS2, all of it can.

**The flat ladder is the thing being exploited, and it survives only where nobody
exploits it.** That is the mechanism: not that CS2 players are more correlated
than baseball hitters (they are, but only about 3x), but that CS2 is the one
board where the payout structure has not been defended. The correlation is the
lever; the undefended ladder is the fulcrum.

Two consequences worth carrying:

1. **The edge is perishable.** If PrizePicks notices CS2 stacking it will do what
   it did to MLB and NFL: convert the board to demon/goblin pricing. The standard
   line share is therefore a health metric worth watching — a fall from 100% is
   the warning that the shape is being priced out. Nothing about our own maths
   will tell us; the board will.
2. **It explains the MLB control's result twice over.** MLB stacks measured weak
   partly because opponents there are uncorrelated (phi -0.007 against CS2's
   +0.059) and partly because the ladder is not on offer to stack against.

Sleeper, by contrast, publishes ONE ladder for every sport: `GET /payouts` is
`version: 7` with no sport dimension — `all_in` 5:19x, 6:34x applied to CS2, MLB,
NFL and NHL alike. If the correlation edge transfers to another sport at all, it
transfers at Sleeper first, because the ladder there has not been withdrawn
anywhere.

## The drift placebo — run it before believing any correlation

A correlated-stack claim says five teammates move together **because they share a
game**. There is a rival explanation that produces the same statistic: the line
is stale, the team is in form, and all five beat a number that has not caught up.
Nothing in a raw all-over rate separates the two.

The control that does, borrowed from the NBA scan:

| arm | construction | what it holds |
|---|---|---|
| REAL | the five teammates in the same series | everything |
| **SCATTER** | each player's flag from a **different** nearby series of the same team | team, roster, era — but NO shared game |
| SHUFFLE | each player's flag from a random series of his own | nothing |

`REAL / SCATTER` is the same-game effect. `SCATTER / SHUFFLE` is drift.

**Measured on CS2 kills maps 1-2, 1,921 team-series:**

```
REAL 8.80%   SCATTER 3.12%   SHUFFLE 2.08%
REAL/SHUFFLE 4.22x total · SCATTER/SHUFFLE 1.50x drift · REAL/SCATTER 2.82x same-game
drift accounts for 16% of the lift
```

So the CS2 effect is genuinely a game effect. **NBA fails the same test**: the
placebo attributes 65% of its only surviving shapes to drift, and its same-game
component goes to zero or negative under trailing-20 lines.

**The trap, because it was hit once here and gave the opposite answer.** Drawing
all five flags from ONE other game is not a placebo — it preserves the shared
game perfectly and merely measures the same event on a different date. It
returned "96% of the lift is drift" and reversed the project's conclusion for
about ten minutes. **Each player must come from a DIFFERENT game.** If REAL and
the null come out nearly equal, suspect the null before believing the result.
