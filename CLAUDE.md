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
| Kills vs headshots line consistency | **Not new information.** On one week of real closing lines (96 series), headshot lines 1.5+ above what the kills line and the player's headshot rate imply went under 56.5% [47.8, 65.2] on 57 series, and only on that side: when the headshot line ran low, the over hit 50%. 88% of those legs were already above the player's own headshot history — lead T2. Adding the gap moved T2-like legs from 55.9% to 58.9%, inside the noise, and the legs not covered by T2 are 10 legs over 10 series. Don't track it separately; watch T2's forward record instead. |
| 3-leg stacks | **-EV, dropped.** 16.8% vs a 20% bar. `STACK_SIZES = [5, 6]`. |
| **Correlated stacks at PrizePicks** | **DEAD — priced out, measured 2026-09-13.** Eleven controlled quotes: the entry multiplier falls x0.667 per extra leg from the same match (37.5x with none shared, 7.25x with six legs in one match). Every shape comes back 0.41-0.75 EV on the model; the 5+1 is 0.57 on archive rates and 0.94 on the thin real-line estimate. The correlation is real (same-game effect 2.82x) — PrizePicks simply charges for it. |
| **Correlated stacks at Underdog** | **About break-even — not a green light.** Six legs from one match quote 11.20x against 35.00x with none shared (32% of base). The 5+1 needs 8.9%: 0.87 EV on archive rates, 1.46 on the thin real-line sample, about 1.0 on the drift-corrected model. |
| **Correlated stacks at Sleeper** | **DEAD.** Six from one match quote 4.02x against 32.65x with none shared (12%, the steepest of the three). Needs 24.9%; EV 0.31-0.52. Its published flat ladder is not what the app pays. |

**PrizePicks is answered.** On 2026-09-13 a controlled sweep (`/calibrate`,
table `payout_quote`) measured its discount directly:

| x = legs - distinct matches | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| six-leg Power Play quote | 37.50 | 35.50 | 25.00 | 16.50 | 10.50 | 7.25 |

`quote = 37.5 x 1.453 x 0.667^x` fits every concentration within 3%. The team
split barely matters (5+1 7.25x; 4+2 and 3+3 both 7.75x) — it keys on the
**match**. Flipping one leg to the other side nearly doubles the quote (13.50x),
so direction is priced too. The 3-pick base today is **6x**, not the 5x assumed
everywhere; the 5-pick base is 20x as assumed. The remembered "22x for a six-leg
one-team stack" fits none of this and should be treated as a different shape or
a misremembered number.

**Underdog and Sleeper were measured the same day**, with the same sweep:

| app | none shared | all six from one match | share of base |
|---|---|---|---|
| PrizePicks | 37.50x | 7.25x | 19% |
| Underdog | 35.00x | 11.20x | 32% |
| Sleeper | 32.65x | 4.02x | 12% |

Every app charges for concentration. Only Underdog leaves the 5+1 near
break-even, and near break-even is exactly where the thin real-line sample and
the ~15% drift in the correlation constants decide the answer.

Two batches of those quotes were first filed under PrizePicks because the
calibrate page defaulted to it; they were relabelled with audit notes
(`payout_quote` ids 12-18 Underdog, 19-21 Sleeper), and a save now requires an
explicit app choice with nothing preselected.

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
- **Sleeper's per-pick `payout_multiplier` is both the leg's marginal and, on an
  uncorrelated entry, a factor of the entry's payout.** A six-leg entry with no
  shared match quoted 32.65x against a 33.06x product of its picks' multipliers.
  Its published `/payouts` ladder (6:34x) is NOT what the app applies, which is
  why `PUBLISHED_LADDER` is now empty. Same-match legs are then cut hard: 4.02x
  for six from one match. The trap that remains is pricing a stack's win
  probability off the book's marginals and then paying it the undiscounted
  product, which counts the correlation twice.

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

> **Corrected 2026-09-13: the conclusion of this section is wrong for
> PrizePicks.** The board really is 100% standard lines, but the defence was
> never on the board. It is in the entry builder, which cuts the payout by a
> third for every extra same-match leg, so a six-leg single-match stack listing
> at 37.5x is quoted 7.25x. That discount absorbs the correlation almost exactly:
> across zero to five shared legs the model's EV stays flat at 0.58-0.73. "The
> undefended ladder is the fulcrum" does not hold at PrizePicks. It may still
> hold at Sleeper, whose ladder is published flat, and that is the test that
> remains. The section is kept as written because it shows a true measurement
> (100% standard lines) leading to a wrong inference (no defence) — worth
> recognising the next time a board looks undefended.

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

> **Corrected 2026-09-13: the next paragraph is wrong.** Sleeper's app does not
> pay its published ladder. An uncorrelated six-leg entry pays the product of its
> per-pick multipliers (32.65x quoted, 33.06x product), and six legs from one
> match quote 4.02x — the steepest discount of the three apps. The edge did not
> transfer to Sleeper.

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

### Known bias: both correlation constants carry ~15% drift

The placebo above has a consequence for the shipped parameters. `RHO_TEAMMATE`
(0.324, from phi 0.210) was fitted on walk-forward lines, and the scatter null
says 15% of that phi is drift rather than shared-game:

```
teammate phi  REAL 0.2074 -> rho 0.320      SCATTER 0.0314 -> rho 0.049
same-game-only rho would be ~0.273          (48,499 teammate pairs)
```

Two independent statistics agree on the size: 15% of pairwise phi, 16% of the
5-core lift.

**This is not yet corrected, on purpose.** `PARTNER_SHIFT` — the 87% opponent
tail — was measured on the same construction and carries the same contamination.
Lowering rho alone would raise required multipliers while leaving the tail
overstated, which is an internally inconsistent model: worse than a known bias
whose sign is understood.

The bias points one way: **both constants over-credit correlation, so every
`winProb` is optimistic and every `requiredMultiplier` is too low.** Stacks look
slightly better than they are. Treat the shipped bar as a floor.

Correcting it means re-fitting rho AND the partner shift together against the
scatter null, in one change, with the tests repinned. Worth doing before any
stack is sized off the model rather than off a quoted multiplier.
