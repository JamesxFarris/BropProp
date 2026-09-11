# Is there a positive-EV strategy on PrizePicks or Underdog?

**Written 2026-09-10.** This document answers one question: given that four
separate attempts to predict outcomes better than the book have been measured
and all four failed, does *slip construction* — exploiting payout structure and
correlation rather than prediction — have an edge?

Every claim below is labelled **MEASURED** (observed in our data or read off a
book's published rules), **ASSUMED** (an input we picked and have not verified),
or **DERIVED** (arithmetic on the other two). Nothing is asserted that is not
one of those three.

> **Read this first — superseded in part, 2026-09-11.** This was written before
> the correlation was re-measured and before any match odds were in. Since:
>
> - **The correlation was re-measured the way §3.7 asked:** teammate vs
>   opponent, walk-forward lines, significance over independent series
>   (`npm run validate:correlation`, 8,923 series). Teammates phi 0.210, 95% CI
>   [0.198, 0.222], copula **rho ≈ 0.324**; opponents rho ≈ 0.086. The blended
>   ρ = 0.2133 used in §3-§4 is superseded, and §3.6 (b)-(d) are answered. On the
>   books' own lines, k-teammates-all-under rates match the model within ~1%.
> - **§3.7's phone check was done for the 6-leg shape:** a PrizePicks 6-pick,
>   5 on one team plus 1 opponent, was quoted at **22x** — far above the 10.05x
>   in §3.6.
> - **The opponent leg follows the core in the tail** (`npm run validate:tail`):
>   after 5 same-team overs his over hits 87% (the pair model says ~58%); after
>   5 unders his under hits 72%. `findStacks` builds both sides per team, and
>   all-over 5+1 stacks now rank at the top.
> - **The side is team-level:** losers' players go under 57.2% vs winners' 45.7%
>   on the books' own lines (paired p = 0.040), priced from Pinnacle's moneyline,
>   which is live. A blind shade (55.3% under) appeared on 2026-09-10 and has
>   faded to 51.6% (p = 0.14).
> - Production is reachable via `railway ssh`; the "blocked on DB access" notes
>   below are stale.
>
> So §0's "no positive-EV strategy" predates all of it: whether a stack is +EV
> now turns on the multiplier the app quotes against the break-even the Build
> page prints. The prediction failures in §6 (AUC 0.495, 41-41, 74-73) still
> stand. Current numbers live in `RUNBOOK.md`.

---

## 0. The verdict, up front

**No. There is no positive-EV strategy available to us today, and the reason is
arithmetic rather than bad luck.**

- The cheapest structure either book sells holds **12.5%** of every dollar at
  coin-flip legs. The structures we currently build hold **37.5% to 41.4%**.
- To break even you need a per-leg win rate of **53.45%** at best — and that
  best case is a structure we do not play. On the structures the app actually
  builds you need **54.7% to 56.2%**.
- Our measured per-leg rate is **50.0–52.0%**, with no evidence it differs from
  50%. AUC 0.495 says the ordering carries no information at all.

**There is one lead that is not a prediction problem, and it is narrower than an
earlier draft of this document claimed.** The measured same-match correlation
(ρ ≈ 0.213), taken at face value, lifts a 4-leg one-match Power play from 0.625
to **1.173 — but only if the legs are true coin flips**. At the marginal the
correlation study actually measured, 46.15%, the same slip is **0.936: still
losing, at the full undiscounted 10x, before PrizePicks applies any same-game
repricing at all.**

Both figures are simulated independently (4M draws per cell) rather than taken
from the closed form, and they correct a mis-stated threshold in §3: the number
a stacked 4-pick must still pay to be **+EV is 8.52x, not the 5.36x** given
there — 5.36x is only the point where stacking beats *not* stacking, and both
sides of that comparison lose money.

So the surviving claim is narrow: *if* legs are genuinely 50/50, *and* the
correlation is real rather than a confound, *and* PrizePicks' undisclosed
same-game haircut takes less than 15% off the 10x — then a 4-leg one-match Power
is marginally +EV. Three conditions, one of which we cannot observe and one of
which the measurement itself casts doubt on. Section 3.7 gives the ten-minute
experiment that settles the observable one.

**What to change today, edge or no edge:** stop building 4-, 5- and 6-pick
Power plays. They are the worst products on the board. See §7.

---

## 1. The break-even table

This is the most important table in the document. It says how good a leg has to
be before anything else matters.

For an all-must-win entry of `n` legs paying `M`, with independent legs each
winning with probability `p`:

```
EV = M · p^n          break-even p* = (1/M)^(1/n)
```

For a flex entry the EV is a sum over the binomial distribution:

```
EV = Σ_k  M_k · C(n,k) · p^k · (1-p)^(n-k)
```

solved numerically for `EV = 1`.

**Payout multipliers — MEASURED (published rules, re-verified 2026-09-10):**

- PrizePicks Power and Flex confirmed against
  `prizepicks.com/help-center/payouts`. The brief's figures were correct.
- Underdog's own help centre returns HTTP 403 to us. Two independent secondary
  sources agree on Standard 2→3.5x, 3→6.5x, 5→20x and on the Flex table; they
  **disagree on the 4-pick (10x vs 12x)**. Both are shown. **The brief's "UD
  3-pick pays 6x" appears stale — current sources say 6.5x.** Verify 2-pick
  3.5x and 3-pick 6.5x in the app before staking; they carry the whole
  recommendation.

### Table 1 — required per-leg win rate, independent legs (DERIVED)

| Structure | Top payout | EV at p = 0.50 | House hold | **Break-even p** |
|---|---:|---:|---:|---:|
| **UD Standard 2** | 3.5x | **0.8750** | **12.50%** | **53.45%** |
| **UD Standard 3** | 6.5x | 0.8125 | 18.75% | **53.58%** |
| UD Standard 4 *(if 12x)* | 12x | 0.7500 | 25.00% | 53.73% |
| UD Flex 6 | 25x | 0.6930 | 30.70% | 53.82% |
| PP Flex 6 | 25x | 0.6719 | 32.81% | 54.21% |
| PP Flex 5 | 10x | 0.7500 | 25.00% | 54.25% |
| PP Power 6 | 37.5x | 0.5859 | 41.41% | 54.66% |
| UD Flex 5 | 10x | 0.7031 | 29.69% | 54.75% |
| PP Power 5 / UD Standard 5 | 20x | 0.6250 | 37.50% | 54.93% |
| PP Flex 4 / UD Flex 4 | 6x | 0.7500 | 25.00% | 55.03% |
| PP Power 3 | 6x | 0.7500 | 25.00% | 55.03% |
| UD Flex 8 | 80x | 0.5156 | 48.44% | 55.07% |
| UD Flex 7 | 40x | 0.5449 | 45.51% | 55.42% |
| PP Power 4 / UD Standard 4 *(if 10x)* | 10x | 0.6250 | 37.50% | 56.23% |
| PP Power 2 | 3x | 0.7500 | 25.00% | 57.74% |
| PP Flex 3 / UD Flex 3 | 3x | 0.7500 | 25.00% | 57.74% |
| PP Flex 2 | 2x | 0.7500 | 25.00% | 61.80% |

**The brief's rough pass was exactly right.** PP Power at 50/50 legs gives
0.75 / 0.75 / 0.625 / 0.625 / 0.5859 for 2/3/4/5/6 legs. Confirmed to four
decimal places.

### What the table says

1. **The floor is 53.45%.** No structure on either book breaks even below that.
   Against a fair coin you are giving up 12.5 cents on the dollar at absolute
   best.

2. **PrizePicks Power 4, 5 and 6 are the worst products on the board** at
   37.5%, 37.5% and 41.4% hold. `buildEntries` defaults to `sizes = [3,4,5,6]`,
   so three of the four entries the app builds are drawn from the bottom of
   this list.

3. **PP Flex is strictly better than PP Power for 4, 5 and 6 legs.** Flex 4 and
   Flex 5 hold 25% where Power 4 and Power 5 hold 37.5%. Same legs, same board,
   half the hold. The app cannot currently build a Flex entry at all.

4. **EV-at-0.50 and break-even-p rank differently, and both matter.**
   PP Power 3 and PP Flex 3 both return 0.75 at p = 0.50, but their break-even
   points are 55.03% and 57.74%. If you have *no* edge, minimise the hold
   (column 3). If you have a *small* edge, minimise the break-even (column 4).
   **UD Standard 2-pick wins on both**, which is a rare and clean result.

### The marginal-leg rule (DERIVED — the practically useful form)

Adding an `n`th leg to an `(n-1)`-leg all-must-win entry raises EV only if

```
p_n  >  M_{n-1} / M_n
```

| Ladder | 2→3 | 3→4 | 4→5 | 5→6 |
|---|---:|---:|---:|---:|
| PrizePicks Power | 50.0% | **60.0%** | 50.0% | 53.3% |
| Underdog Standard (4 = 10x) | 53.8% | **65.0%** | 50.0% | — |
| Underdog Standard (4 = 12x) | 53.8% | 54.2% | 60.0% | — |

The 3→4 step is brutal on both books. On PrizePicks a fourth leg must win **60%
of the time** to be worth adding to a 3-pick; on Underdog (if the 4-pick is 10x)
it must win **65%**. `optimize.ts` currently fills entries to a requested size
with no test of this kind, and its own `shrink()` function — a Beta(8) prior
centred at 0.5 — makes it nearly impossible for any leg to legitimately clear
60%. **The code's own shrinkage already implies its own default sizes are
wrong.**

---

## 2. Void risk and the tier-demotion rule

**MEASURED (verified against production 2026-09-10):**
LoL maps 1-3 props never void (0 of 67 player-matches played fewer than 3 maps).
CS2 maps 1-2 props effectively never void (99.4% played ≥2). **CS2 map-3-only
props void ~60.1% of the time.**

**MEASURED (PrizePicks published rules, verified 2026-09-10):** a voided leg
does **not** refund the entry. The entry drops one tier — a 4-pick at 10x
becomes a 3-pick at 6x. Ties demote the payout the same way without removing the
pick. And if voids leave every remaining player on the same team, the lineup is
**ineligible** — worth noting given §3 recommends stacking.

So EV of an `n`-pick containing one leg that voids with probability `v`:

```
EV = v · M_{n-1} · p^(n-1)  +  (1-v) · M_n · p^n
```

At p = 0.50 and v = 0.60 (DERIVED):

| Entry | With one map-3 leg | Clean n-pick | Clean (n-1)-pick |
|---|---:|---:|---:|
| 3-pick | 0.7500 | 0.7500 | 0.7500 |
| 4-pick | **0.7000** | 0.6250 | **0.7500** |
| 5-pick | 0.6250 | 0.6250 | 0.6250 |
| 6-pick | 0.6094 | 0.5859 | 0.6250 |

A void-prone leg is *better than a clean leg* (0.700 vs 0.625) because 60% of
the time it demotes you out of the 37.5%-hold tier into the 25%-hold tier. It is
still *worse than not adding a leg at all* (0.700 vs 0.750).

**The clean result: the void probability cancels out of the add-or-don't-add
decision entirely.** Adding leg `n` beats stopping at `n-1` iff
`p_n > M_{n-1}/M_n`, whatever `v` is — because when the leg voids you land
exactly on the alternative you were comparing against. Void risk is therefore
*not a thing to model*. The marginal-leg rule from §1 already handles it.

This is a genuine simplification: **CS2 map-3-only props need no special
treatment.** The only caution is the same-team-ineligibility rule above.

---

## 3. Does correlation rescue it?

### 3.1 What was actually measured

**MEASURED** (`raw/correlation.ts`, 35,702 same-match pairs of real CS2 series,
maps 1-2, each player's own career median + 0.5 used as a stand-in line):

| Event | Observed | Under independence | Ratio |
|---|---:|---:|---:|
| both legs OVER, same match | 24.69% | 21.30% | **1.159** |
| one OVER + one UNDER, same match | 20.56% | 24.85% | **0.828** |

### 3.2 The base rate is 0.46, not 0.50 — and here is why

The brief flagged this correctly. `0.4615² = 0.2130` and
`0.4615 × 0.5385 = 0.2485`, and those two reproduce the independence column
exactly. So the **marginal over-rate in that sample was 46.15%, not 50%**, and
the four cells of the 2×2 table sum to 1.0 on that marginal. The "one over one
under" figure is an *ordered* pair (leg A over, leg B under), not the unordered
event — that is why it sits near 25% rather than near 50%.

**But this 46.15% is a measurement artifact, not a finding about books.** The
line used was `median + 0.5` on integer kill totals, so a leg "wins" only at
`total ≥ median + 1`. Ties at the median — common on discrete counts — all
resolve as losses. That mechanically pushes the over-rate below 50%. It is
**not** evidence that books shade lines toward the under, and it must not be
read that way.

**Consequence for everything downstream:** the 1.159 ratio is measured *at
p ≈ 0.46*. A dependence ratio is not scale-free — it shrinks as `p` rises. You
cannot carry 1.159 to p = 0.50 and you certainly cannot raise it to a power.

### 3.3 Modelling it properly

Fit a one-factor Gaussian copula: `X_i = √ρ·Z + √(1-ρ)·ε_i`, leg `i` wins if
`X_i > c` where `Φ(c) = 1 - p`. Then

```
P(exactly k of n win) = C(n,k) · ∫ φ(z) · u(z)^k · (1-u(z))^(n-k) dz
     where u(z) = Φ( (√ρ·z - c) / √(1-ρ) )
```

Fitting `ρ` to the measured pair rate (DERIVED):

| Marginal q used | Independence P(both) | Target | Fitted ρ | Implied P(over,under) vs measured 20.56% |
|---|---:|---:|---:|---|
| 0.4615 (reported marginal) | 21.30% | 24.69% | **0.2133** | 21.46% |
| 0.4525 (implied by the 2×2 itself) | 20.48% | 24.69% | 0.2650 | 20.56% — exact |
| 0.5000 | 25.00% | 24.69% | 0.000 | 25.00% — fails badly |

The third row is the important one: **at p = 0.50 the measured "both over" rate
of 24.69% is *below* the independence value of 25%.** The entire correlation
signal comes from the fact that the marginal was 0.46. The model is only
coherent because the base rate is low.

`ρ = 0.2133` is adopted below (fitted at the reported marginal, the conservative
of the two coherent fits).

### 3.4 The lift decays fast in p — and grows fast in n

`P(all n win) / p^n`, one match, all same direction (DERIVED):

| p | n=2 | n=3 | n=4 | n=5 | n=6 |
|---:|---:|---:|---:|---:|---:|
| 0.4615 | 1.159 | 1.485 | 2.044 | 2.970 | 4.505 |
| 0.50 | 1.137 | 1.410 | 1.865 | 2.588 | 3.730 |
| 0.55 | 1.111 | 1.329 | 1.677 | 2.205 | 2.994 |
| 0.60 | 1.090 | 1.261 | 1.526 | 1.912 | 2.463 |

Two things to take from this. First, **the naive move of multiplying by 1.159
per extra leg is wrong in both directions** — it understates the gain at n ≥ 3
(the true lift compounds faster than linearly) and overstates it as p rises.
Second, the effect is large. A 6-leg one-match stack at p = 0.50 is **3.7 times**
as likely to sweep as independence predicts.

### 3.5 Does that beat the house edge? On paper, yes

PP Power EV at p = 0.50, all legs from one match, **at the standard payout**
(DERIVED):

| ρ | n=2 | n=3 | n=4 | n=5 | n=6 |
|---:|---:|---:|---:|---:|---:|
| 0.00 | 0.750 | 0.750 | 0.625 | 0.625 | 0.586 |
| 0.10 | — | — | 0.871 | — | 1.243 |
| 0.15 | — | — | 0.999 | — | 1.635 |
| **0.2133** | 0.853 | 1.058 | **1.166** | 1.617 | **2.186** |
| 0.30 | — | — | 1.403 | — | 3.029 |

ρ required for EV = 1 at the standard payout:

| p | n=2 | n=3 | n=4 | n=5 | n=6 |
|---:|---:|---:|---:|---:|---:|
| 0.46 | 0.697 | 0.307 | 0.247 | 0.160 | 0.125 |
| 0.48 | 0.604 | 0.241 | 0.199 | 0.124 | 0.095 |
| **0.50** | 0.500 | 0.174 | **0.150** | 0.088 | **0.066** |
| 0.52 | 0.386 | 0.105 | 0.102 | 0.052 | 0.037 |

The measured ρ = 0.2133 clears the p = 0.50 bar for every n ≥ 3, and clears the
pessimistic p = 0.48 bar for n ≥ 4. **If the payout table held for stacked
slips, this would be a real edge and a large one.**

It does not hold. See §3.6 and §3.7.

### 3.6 Why this must not be banked — four problems, any one fatal

**(a) PrizePicks reprices exactly this shape, and hides the number.**
**MEASURED (published rules):** selecting multiple players from the same game —
same team *or* opposing teams — produces "same-game combinations" with reduced
payout multipliers, visible only when the slip is built in the app. Combined
with the RUNBOOK finding that **no payout multiplier appears anywhere in the
PrizePicks API**, the entire correlation gain lives inside a number we
structurally cannot observe from our data.

How much haircut kills it (DERIVED): stacking beats not-stacking iff the
surviving payout fraction `h` exceeds `1 / lift`.

| Shape | n | Lift at p=0.50 | Min `h` | Slip must still pay at least |
|---|---:|---:|---:|---|
| 2 same match | 2 | 1.137 | 0.880 | 2.64x (vs 3x) |
| 3 same match | 3 | 1.411 | 0.709 | 4.25x (vs 6x) |
| 2+2 (two matches) | 4 | 1.292 | 0.774 | 7.74x (vs 10x) |
| **4 same match** | 4 | 1.865 | 0.536 | **5.36x (vs 10x)** |
| 3+3 | 6 | 1.990 | 0.503 | 18.85x (vs 37.5x) |
| 4+2 | 6 | 2.120 | 0.472 | 17.69x (vs 37.5x) |
| **6 same match** | 6 | 3.731 | 0.268 | **10.05x (vs 37.5x)** |

> **CORRECTION (verified by independent simulation, 4M draws per cell).**
> The `h` column above answers "when does stacking beat NOT stacking" — and both
> sides of that comparison lose money. It is not the +EV threshold, and an
> earlier draft of this section conflated the two.
>
> A 4-leg one-match Power at p = 0.50 and ρ = 0.213 has **P(all 4) = 11.73%**
> (simulated; independence gives 6.40%, so the lift of ~1.87 is confirmed).
> Break-even needs `1 / 0.1173`, which is **8.52x — not 5.36x**. A slip paying
> exactly 5.36x has EV `5.36 × 0.1173 = 0.629`: better than the 0.625 of an
> unstacked 4-pick, and still a 37% loss.
>
> So the haircut PrizePicks may charge has to leave **more than 8.52x of the
> 10x**, i.e. no more than a **15%** haircut — not the 46% the row implies.
>
> And at the marginal we actually measured rather than an assumed coin flip,
> it is worse still. At **p = 0.4615**, P(all 4) = **9.36%**, so a 4-leg
> one-match Power at the full undiscounted 10x has **EV 0.936** — losing before
> any same-game repricing is applied at all, and break-even would need 10.68x.
>
> **The decisive test below therefore uses 8.52x, not 5.36x.** Since PrizePicks
> starts at 10x and is known to reprice same-game combinations, this avenue is
> considerably narrower than the table suggests, and at measured win rates it is
> already closed.

**(b) The measurement has an era confound that plausibly explains all of it.**
`raw/correlation.ts` sets each player's line at their **career median over the
entire sample**, then asks whether two players in the same match beat their
career medians together. Any factor shared by both players *and* varying over
the sample becomes correlation: patch and meta shifts that move league-wide kill
rates, tournament tier, roster era, changes in map pool and round pacing. Two
players in one match share all of it.

A real book's line is set for *that match*, on current form, and prices those
shared factors in. Only the *residual* correlation is exploitable. **The
measured 0.2133 is an upper bound on the exploitable ρ, and there is no way to
say from the current output how much survives.**

**(c) It was never tested over independent series — the trap from RUNBOOK
fact 6, applied to the correlation result itself.** 35,702 pairs come from
roughly 800 series (about 45 pairs per 10-player match). The pairs within a
series are massively dependent. The point estimate may well be fine, but no
significance has been established, and this project's entire discipline says leg
counts describe and do not prove.

**(d) Teammates and opponents were never separated.** *(Since done: teammates
rho ≈ 0.324, opponents ≈ 0.086 — see the note at the top.)* The script selects `team`
and never uses it. The mechanism matters enormously: total kills scale with
round count, which lifts *everyone* (positive for teammates and opponents
alike), but kills are near-conserved within a map — RUNBOOK fact 2 — so one
side's kills are the other's deaths, which is negative across teams. The
aggregate 0.2133 is a blend of a probably-large teammate correlation and a
possibly-near-zero or negative opponent correlation. And PrizePicks **requires
at least two players from different teams**, so a pure-teammate stack is not
even legal there. If the correlation is concentrated in teammates, the legal
shapes capture much less of it than §3.5 suggests.

### 3.7 What would settle it

Two things, in this order:

1. **The ten-minute one (settles the payout question, which is decisive).**
   Open the PrizePicks app. Build a 4-leg Power play with all four legs from one
   CS2 match, three players from one team and one from the other. Read the
   multiplier. **If it is above 8.52x the structure survives; if it
   is at or below 8.52x this avenue is closed and should never be
   re-litigated.** Repeat for 6 legs against the 10.05x threshold. Nothing else
   in this document is as cheap to resolve or as decisive.

2. **The re-measurement (settles the confound).** `raw/corr2.ts` is written and
   ready; it could not be run because `.env` points at `localhost:5433` and
   there is no local Postgres, and the `railway-mcp-server` MCP connection
   failed this session. Run it against production. *(Done 2026-09-10 as
   `npm run validate:correlation`, run in production over `railway ssh`, with
   walk-forward lines and a series-level bootstrap: the teammate effect
   survives, phi 0.210, CI [0.198, 0.222].)* It re-does the pair analysis
   three ways: split **teammate vs opponent**, with an **out-of-sample trailing
   20-series median** line instead of a career median (which absorbs the era
   drift), and with a **per-series sign test** instead of a pair count. If the
   trailing-line teammate ρ collapses toward zero, the confound was the whole
   story.

---

## 4. Power vs Flex under correlation

The intuition in the brief is right and worth stating precisely: **positive
correlation helps an all-must-win Power play (legs sweep together) and hurts a
Flex play (Flex wants independent legs so that "most" hit).** The full
distributions confirm it, and give a crossover.

PrizePicks, EV at p = 0.50, ρ = 0.2133 within a match and 0 across matches
(DERIVED). "Shape" is the partition of legs across matches.

**4 legs** (Power 10x; Flex 6x / 1.5x)

| Shape | P(all 4) | Power EV | Flex EV | Winner | Power BE p | Flex BE p |
|---|---:|---:|---:|---|---:|---:|
| 4 singles | 6.250% | 0.6250 | 0.7500 | **Flex** | 56.23% | 55.03% |
| 2+2 | 8.077% | 0.8077 | 0.8526 | **Flex** | 53.12% | 52.97% |
| 3+1 | 8.815% | 0.8815 | 0.9039 | **Flex** | 51.91% | 51.94% |
| 4 same match | 11.655% | 1.1655 | 1.0579 | **Power** | 47.39% | 48.82% |

**6 legs** (Power 37.5x; Flex 25x / 2x / 0.4x)

| Shape | P(all 6) | Power EV | Flex EV | Winner |
|---|---:|---:|---:|---|
| 6 singles | 1.563% | 0.5859 | 0.6719 | **Flex** |
| 2+2+2 | 2.296% | 0.8609 | 0.8741 | **Flex** |
| 3+3 | 3.108% | 1.1657 | 1.0930 | **Power** |
| 4+2 | 3.313% | 1.2422 | 1.1519 | **Power** |

**3 legs** (Power 6x; Flex 3x / 1x)

| Shape | Power EV | Flex EV | Winner |
|---|---:|---:|---|
| 3 singles | 0.7500 | 0.7500 | tie at p=0.50 (Power has the lower BE: 55.03% vs 57.74%) |
| 2+1 | 0.8526 | 0.7842 | **Power** |
| 3 same match | 1.0579 | 0.8526 | **Power** |

### The decision rule (DERIVED)

> **Play Power when the slip is concentrated; play Flex when it is spread.**
>
> Operationally: compute the lift `L = P(all n win) / p^n` for the slip's actual
> match structure. Power beats Flex when `L` is above roughly **1.6 at n = 4**
> and **1.7 at n = 6**. In practice that means:
>
> - **n = 3:** Power, unless all three legs are from three different matches
>   (then they tie at p = 0.50 and Power still has the lower break-even).
> - **n = 4:** Flex, unless **all four** legs share one match.
> - **n = 6:** Flex, unless **at least half** the legs share a match (3+3 or
>   4+2 flip it to Power).
>
> **At realistic slip shapes — no more than half the legs from one match —
> PP Flex beats PP Power in every case computed at n ≥ 4.** Since PrizePicks
> haircuts precisely the concentrated shapes that would favour Power, the
> practical rule collapses to: **on PrizePicks, prefer Flex at 4+ legs.**

Note the recurring subtlety that EV-at-0.50 and break-even-p can disagree
(3 singles: equal EV, different break-even). Curvature differs between the two
payout shapes. If you believe you have an edge, use the break-even column; if
you do not, use the EV column.

---

## 5. Demons and goblins

**Scope note.** The brief's figure of standard 4,721 / demon 19,305 / goblin
5,515 is **suspect** — a re-count against the `prop` table gives PrizePicks CS2
standard 1,935 / goblin 252 / demon 223 and LoL standard 286 / demon 26 /
goblin 23, with Underdog standard-only. **Demons and goblins are roughly 20% of
the PrizePicks board, not 84%.** The RUNBOOK figure may have been counting
snapshots rather than props. This section is therefore worth about a fifth of
what the brief implied, and is scoped accordingly.

### The rule

On an all-must-win entry the objective factorises to one number per leg,
`p × m`. So a shifted leg beats a standard leg iff

```
p_shift · m_shift  >  p_std · 1        ⟹        m  ≥  p_std / p_shift
```

Approximating the player's distribution as normal with standard deviation `σ`
over the offered map range, and taking the standard line as roughly a coin flip:

```
p_shift ≈ 0.5 ∓ 0.3989 · Δ/σ      (− for a demon, + for a goblin)
```

so the required multiplier is `m ≥ 0.5 / Φ(∓Δ/σ)`.

**`σ` is ASSUMED, not measured.** Kill totals over CS2 maps 1-2 average about
29.8 (2 × 14.88, MEASURED). A Poisson floor gives σ ≈ 5.5; real kill counts are
overdispersed and the same player's two maps are positively correlated, so
σ ≈ 7-8 is the plausible range. **Measuring the actual per-player σ for each
offered range is a small query and would sharpen this table considerably.**

### Table 5a — DEMON: the multiplier it must pay to be worth taking

| Line shifted by Δ | σ=6 | σ=7 | σ=8 | σ=9 |
|---:|---:|---:|---:|---:|
| 0.5 | 1.07 | 1.06 | 1.05 | 1.05 |
| 1.0 | 1.15 | 1.13 | 1.11 | 1.10 |
| 1.5 | 1.25 | 1.20 | 1.18 | 1.15 |
| 2.0 | 1.35 | 1.29 | 1.25 | 1.21 |
| 2.5 | 1.48 | 1.39 | 1.33 | 1.28 |
| 3.0 | 1.62 | 1.50 | 1.41 | 1.35 |
| 4.0 | 1.98 | 1.76 | 1.62 | 1.52 |

### Table 5b — GOBLIN: the multiplier below which it is NOT worth taking

| Line shifted by Δ | σ=6 | σ=7 | σ=8 | σ=9 |
|---:|---:|---:|---:|---:|
| 0.5 | 0.94 | 0.95 | 0.95 | 0.96 |
| 1.0 | 0.88 | 0.90 | 0.91 | 0.92 |
| 1.5 | 0.84 | 0.86 | 0.87 | 0.88 |
| 2.0 | 0.79 | 0.82 | 0.84 | 0.85 |
| 2.5 | 0.76 | 0.78 | 0.80 | 0.82 |
| 3.0 | 0.72 | 0.75 | 0.77 | 0.79 |
| 4.0 | 0.67 | 0.70 | 0.72 | 0.74 |

### The phone rule

> Read the demon's or goblin's multiplier off the app and the shift off the
> board. Take the demon only if its multiplier is **above** the Table 5a cell;
> take the goblin only if its multiplier is **above** the Table 5b cell. With
> σ ≈ 8, a rough mental version for CS2 maps 1-2 kills is:
>
> **a demon needs about +6% of multiplier per kill of shift; a goblin must keep
> at least about 90% of the multiplier per kill of shift.**

### The honest caveat, which matters more than the tables

If PrizePicks prices its line shifts fairly against its own model, then
`p × m` is **constant across standard, goblin and demon** on the same player,
and the choice changes nothing but variance. The tables above do not create an
edge; they only tell you **which of the book's own three offerings the book has
mispriced relative to the other two**. And since our own estimate of `p` at a
shifted line is not better than the book's (AUC 0.495), we cannot reliably tell
which one that is.

The one thing the tables *do* buy you is a check that you are not being robbed:
a goblin at 0.75x on a 1.0-kill shift, or a demon at 1.05x on a 3.0-kill shift,
is clearly bad and can be declined without any model at all.

---

## 6. The verdict, in full

**There is no positive-EV strategy available to us today.**

**Required per-leg win rate: 53.45%** in the best structure either book sells
(Underdog Standard 2-pick at 3.5x), **54.7% to 56.2%** in the structures the app
currently builds.

**Our measured per-leg win rate is indistinguishable from 50%:**

| Attempt | Result | Reference |
|---|---|---|
| Model projection | 52.0% (168/323), **AUC 0.495** | `validate:calls` |
| Opponent strength → kills | **r = 0.018** over 4,403 walk-forward predictions | RUNBOOK |
| Stale-line signal | **41-41 (50.0%)** over 49 independent series | `validate_stale.ts` |
| Market-anchored edge | **74-73 (50.3%)**, exact sign test **p = 1.00** | `validate_consensus.ts` |

The gap to close is **3.45 percentage points**, and that is the *easiest* target
on the board. In stat units, 0.035 of win probability is about `0.035/0.3989 ≈
0.088σ` — with σ ≈ 8 kills, we would need to know a player's true mean **to
within better than 0.7 kills more accurately than the book does**. RUNBOOK fact
4 measured the opposite of that: larger claimed gaps performed *worse*
(58.2% at 0.5-0.9 units vs 45.7% at 1.0-1.9), which argues the signal is wrong
rather than merely unproven.

### An important piece of intellectual honesty

**We have not proven that no edge exists. We have proven that we cannot detect
one at the sample sizes we have.** The market-anchored test, 74-73 over 147
independent series, has a 95% confidence interval of roughly **[42.3%, 58.4%]**.
The 53.45% we need sits comfortably inside it.

To detect a true 53.45% edge at 80% power and 5% significance requires about
**1,600 independent series**. We have 147. Anyone proposing a new signal should
be told this number first: **a signal exactly large enough to be profitable is
invisible in a season of data.** That is not a reason for optimism — it is a
reason to stop running underpowered tests and expecting them to settle anything.

### The one thing that could be true

If — and only if — **both** of the following hold, a positive-EV structure
exists:

1. PrizePicks pays more than **8.52x** on a 4-leg all-one-match Power play
   (or more than **10.05x** on a 6-leg one), i.e. its same-game haircut is
   smaller than the correlation is worth; **and**
2. the residual same-match correlation, measured with out-of-sample lines and
   tested over independent series, survives at ρ > 0.15 in the *legal* shapes
   (which must span at least two teams).

Condition 1 is a ten-minute phone check. Condition 2 is one query. Neither
requires any predictive skill, which is precisely why they are the only
remaining leads worth spending time on. **Both are falsifiable, and if either
fails, this question is closed.**

*Update 2026-09-11: neither has failed. Condition 2: teammate rho ≈ 0.324 on
walk-forward lines over 8,923 series, and the legal 5+1 shape spans two
teams. Condition 1: the 6-leg 5+1 shape was quoted at 22x in the app; the
4-leg one-match figure is still unread.*

---

## 7. What to do while that is unresolved

**Even with zero predictive skill, structure choice changes the bleed rate by
3x.**

| | Hold at p=0.50 | Loss per $100 staked |
|---|---:|---:|
| What the app builds today (PP Power 4/5/6) | 37.5% – 41.4% | $37.50 – $41.41 |
| **Underdog Standard 2-pick** | **12.5%** | **$12.50** |
| Underdog Standard 3-pick | 18.75% | $18.75 |

Concretely:

1. **Play Underdog Standard 2-pick and 3-pick.** Lowest hold and lowest
   break-even of anything on either book. *(Verify 3.5x and 6.5x in the app
   first — the brief's "3-pick = 6x" looks stale, and if it really is 6x the
   3-pick break-even rises from 53.58% to 55.03%.)*
2. **Never build a PrizePicks 4-, 5- or 6-pick Power play.** If you want that
   many legs on PrizePicks, use **Flex** — same legs, 25% hold instead of 37.5%.
3. **Underdog's per-side multipliers are a real minority effect.** 1,571 of
   ~1,866 current markets sit at exactly 1.00, the rest spread 0.80–1.37. A
   1.05x on a leg you were taking anyway is free; a 0.87x is a 13% tax that must
   be justified by a better `p`, which we do not have. Prefer 1.00x-and-above
   sides, all else equal.
4. **Ignore CS2 map-3-only void risk.** §2 shows it cancels.
5. **Stake accordingly.** At a 12.5% hold with no edge, every structure here is
   a losing proposition. The correct stake is zero. The above is the ranking of
   how to lose least if the stake is not zero.

---

## 8. Is the implemented strategy right?

*Partly out of date (2026-09-11): the optimiser now uses the correlated
`probAllWin` from `slip.ts` instead of the plain product, a marginal-leg test
exists, 4 is out of the default sizes, and `findStacks` searches whole shapes.
Check the code before acting on this section.*

`src/web/optimize.ts` maximises `p × mult` per leg, takes the top `N` subject to
constraints, and computes `winProb` as a plain product of per-leg probabilities.
Given §1-§4, here is what is wrong.

### 8.1 The objective is right for one product it does not build, and wrong for the ones it does

`p × mult` and "take the N largest" is **exactly correct** for an all-must-win
entry whose base payout is fixed and whose legs are independent. The comment at
the top of the file is a good derivation. It is wrong in four ways here:

- **It does not hold for Flex**, where EV is a sum over the binomial and does
  not factorise into per-leg terms. Per §4, Flex is the better PrizePicks
  product at n ≥ 4 in every realistic shape. **The app cannot build a Flex entry
  at all.** That is the largest single omission.
- **It does not hold when the base payout depends on the shape.** PrizePicks
  haircuts same-game combinations. `bestEntry` now deliberately *builds*
  same-game combinations (`maxPerMatch = 4`, same-direction-only), so the base
  it multiplies by is precisely the base that does not apply.
- **It assumes independence in `winProb`.** See 8.2.
- **It optimises the wrong thing at the margin.** See 8.3.

### 8.2 The product-of-probabilities is wrong, and two errors cancel invisibly

```ts
const winProb = legs.reduce((acc, l) => acc * l.p, 1);
```

Under the measured correlation this **understates** `P(all win)` for a
same-match stack — by 1.29x for a 2+2 four-leg and 1.87x for a four-leg
one-match slip (§3.4). Meanwhile `payout` uses the flat `BASE` table, which
**overstates** what PrizePicks pays for exactly those shapes.

So `evMultiple = payout × winProb` contains **two errors of unknown size
pointing in opposite directions**. It is not conservative and it is not
optimistic; it is unfalsifiable. That is worse than either, and it is the
sharpest thing to say about this file.

The same applies to the RUNBOOK's otherwise-excellent inversion, "`1/P(all legs
win)` is the multiplier at which an entry breaks even." That is right, but
`P(all legs win)` must be the **correlated** probability. For a stacked slip the
app currently quotes a required multiplier that is up to 87% too high — telling
the user to decline slips they should take. Replace the product with the
one-factor computation in §3.3 (about 30 lines, grouping legs by `matchKey`,
which is already on every candidate).

### 8.3 The missing marginal-leg test — the single biggest concrete fix

`buildEntries` defaults to `sizes = [3, 4, 5, 6]` and `bestEntry` fills to the
requested size, returning `null` only if it cannot find enough legs. There is no
test that the last leg is worth adding.

Per §1, adding a 4th leg to a PrizePicks 3-pick requires `p₄ > 60%`. And
`shrink()` — a deliberately heavy Beta(8) prior centred at 0.5, correctly chosen
to defeat the optimiser's bias toward lucky small samples — makes 60% almost
unreachable: a leg needs a genuine, well-evidenced 65-70% raw hit rate to shrink
above 0.60.

**The code's own shrinkage therefore implies the code's own default sizes are
almost always -EV.** The fix is to stop treating size as an input:

```
grow the entry while  p_next > M_{size} / M_{size+1}   (and stop otherwise)
```

which for PrizePicks Power means: go to 3 legs whenever `p₃ > 50%`, go to 4 only
if `p₄ > 60%`, and so on. In practice this will usually return a 2- or 3-pick,
which is the correct answer.

### 8.4 The constraints

- **One leg per player** — correct and well-argued, including the combo
  handling. Keep.
- **`maxPerMatch = 4`** — no longer a risk control and not yet a real
  optimisation. It is a ceiling on a benefit the payout table cannot price.
  Keep it, but the comment should say it is unpriced rather than implying the
  correlation gain is banked.
- **Refusing same-match opposite directions** — right in *sign* (0.828 vs
  independence is a real and intuitive effect: a long bloody series cashes every
  over and busts every under). But the estimate behind it carries the confound
  in §3.6(b), and it says nothing about *teammate vs opponent*, which is the
  distinction that actually determines the sign of the mechanism. Keep the rule;
  downgrade the confidence in the comment.
- **Missing: PrizePicks' two-team minimum.** §3.6(d) — a lineup that ends up
  all-one-team is ineligible, and voids can *create* that situation (§2). Not
  enforced anywhere in `bestEntry`.

### 8.5 Summary of changes to `optimize.ts`

| Priority | Change |
|---|---|
| 1 | Add the marginal-leg test; stop filling to a fixed `sizes` array. Default should be `[2, 3]`. |
| 2 | Model Flex. It is the better PrizePicks product at 4+ legs in every realistic shape. |
| 3 | Replace the product `winProb` with the one-factor correlated computation, grouped by `matchKey`. |
| 4 | Do not report `evMultiple` from a flat `BASE` for a slip containing a same-game combination — that base is known not to apply. Report the required multiplier from the *correlated* `P(all win)` and let the user read the real one off the app. |
| 5 | Enforce the two-team minimum, and check it still holds after a plausible void. |
| 6 | Downgrade the confidence expressed in the correlation comment to match §3.6. |

None of this makes a slip positive-EV. Items 1 and 2 alone cut the hold on a
typical entry from ~37.5% to ~19-25%, which is the largest improvement available
without a predictive edge.

---

## 9. Data that would change these conclusions

| Question | What would answer it | Cost |
|---|---|---|
| **Does the PrizePicks same-game haircut leave the correlation gain intact?** | Build a 4-leg one-match Power play in the app and read the multiplier. Compare to 8.52x (NOT 5.36x — see the correction above). | 10 minutes. **Decisive.** The 6-leg 5+1 read **22x** (2026-09-11); the 4-leg is still unread. |
| Is the measured ρ real or an era artifact? | Run `raw/corr2.ts` against production — trailing-20 out-of-sample lines, teammate/opponent split, per-series sign test. | Done — `validate:correlation`, 8,923 series: real, teammate rho ≈ 0.324. |
| Are the Underdog payouts current? | Read 2-, 3-, 4- and 5-pick Standard multipliers off the app. Sources disagree on the 4-pick (10x vs 12x) and the brief's 3-pick figure (6x) looks stale against 6.5x. | 5 minutes. |
| What is σ for each offered range? | `stddev(total)` per player per map-range on `map_stat_dedup`. Sharpens §5 from a guess to a measurement. | One query. |
| Is there any predictive edge at all? | ~1,600 independent series. We have 147. | A season or more. |

Two notes on access, since both blocked work this session: `.env` points
`DATABASE_URL` at `localhost:5433` and there is no local Postgres; and the
`railway-mcp-server` MCP connection failed with `CONNECTION_CLOSED`, so
production could not be reached that way either. *(Superseded: `railway ssh`
into `bropprop-logger` works and is how production is queried — see RUNBOOK,
"The logger".)*

---

## Appendix: reproducing the arithmetic

Throwaway scripts, none of them part of the application:

- `raw/corr2.ts` — the re-measurement of §3.7, written but not run (no DB).
  Superseded by `npm run validate:correlation`, which was run.
- Break-even, correlation-fit and Power-vs-Flex calculations were done in
  scratchpad scripts using a one-factor Gaussian copula with Simpson quadrature
  (4,001 nodes over z ∈ [-9, 9]) and bisection root-finding. Every number in
  this document is reproducible from the formulas given in §1 and §3.3.

### Sources for the payout tables

- PrizePicks Power and Flex: <https://www.prizepicks.com/help-center/payouts>
- PrizePicks void / Reboot / DNP tier-demotion rules:
  <https://intercom.help/prizepicks/en/articles/9047668-payouts-explained>
- PrizePicks same-game combination repricing:
  <https://oddsassist.com/dfs/prizepicks/>
- Underdog Standard and Flex (secondary — the official help centre 403s):
  <https://oddsassist.com/dfs/how-underdog-works/> and
  <https://propellerpicks.com/tools/underdog-payout-calculator/>
