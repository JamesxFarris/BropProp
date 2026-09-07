# Sharper projections: rounds normalisation and a market probability

Two changes to how the board decides what a player will do, and one new number
to check that decision against. Both were chosen over the alternatives on
2026-09-07 after measuring what the data could actually support.

## Why these two

The projection is currently a mean of past totals. It has no notion of how long
a map ran and no notion of what anyone else thinks the number should be. Those
are the two largest things it is missing, and both are answerable from data we
already collect.

Explicitly **not** in scope, though both were considered and are worth doing
later: recency weighting, opponent-strength adjustment, and a proportional
`MIN_EDGE`. The last is already logged as an open question in `DESIGN.md` and
deserves its own measurement rather than being bundled here.

Also considered and rejected: pulling player props from a major sportsbook.
They do not exist. The esports market catalogue at every aggregator checked
(OddsPapi, covering Pinnacle, bet365, Stake and ~350 books) is *match winner,
map winner, maps handicap, total maps, correct score* — nothing per-player.
PandaScore is the one exception and was already ruled out: €400/mo per game,
and their terms sell stats plans for non-betting use only. Sharp books remain
useful as a source of *expected rounds* rather than as a line to price against,
which is a later phase and not this one.

---

## Part A — Kills per round, not kills per map (CS2 only)

### The defect

A map is currently one observation of "kills", and every map counts alike. A
13-4 stomp is 17 rounds; a 16-14 grinder is 30. Averaging them as equals means
a player's projected mean silently inherits the round-length mix of whatever
sample they happen to have. Ten blowouts in a row projects a player low for a
reason that says nothing about the player, and the model cannot tell that
apart from a genuine decline.

This is the largest single source of noise in every CS2 kills projection we
make, and CS2 is 273 of the 323 props on a typical board.

### Data model

`map_stat` gains one column:

```sql
ALTER TABLE map_stat ADD COLUMN rounds smallint;
```

Nullable on purpose. LoL rows will never have it, and a CS2 row whose round
count could not be established must stay empty rather than carry a guess.

### Collection — free

`src/results/bo3.ts` already requests `with=games` and iterates `m.games`, so
the game objects are **already in hand**. `rounds_count` is a field on each one.
Capturing it costs zero additional requests. Verified 2026-09-07 against match
127571: games 182458 and 182459 returned `rounds_count` 17 and 15, alongside
`winner_clan_score`/`loser_clan_score` and `map_name`.

Store `rounds` in its own column, not in `raw` — it is a modelling input now,
and burying it in JSON would mean every query that needs it pays to dig it out.

### Backfill — 13,517 games, ~135 requests

The table holds 47,449 bo3 rows across 13,517 distinct games and 5,875 matches,
spanning 2025-09-07 to 2026-09-07.

Page the games list at `page[limit]=100`, joining on `raw->>'game_id'`. bo3
imposes no observed rate limit; the existing politeness delay applies.

**Cross-check rather than trust.** KAST is a fraction whose denominator is the
round count, and it is present on 47,423 of 47,449 rows (99.95%). For a sample
of backfilled rows, assert `kast * rounds` is within a rounding tolerance of an
integer. Verified by hand: the stored KAST for game 182458 is
`0.7647058823529411` = 13/17, matching `rounds_count: 17` exactly. If the check
fails at any material rate, the backfill is wrong and must stop rather than
write.

This is a verification, not a fallback. Deriving rounds from KAST alone is
ambiguous — 0.75 is 12/16 and 15/20 alike — so it can confirm a fetched number
but must never produce one.

### Projection

`FormStats` carries per-map `(kills, rounds)` pairs for CS2 instead of bare
kill values. Kills per round is `kills_i / rounds_i`.

A total for an *n*-map range is resampled as now, but each draw is a pair:

```
total = Σ over n maps of ( kpr drawn from the player's KPR distribution
                         × rounds drawn from the match-length distribution )
```

**Rounds are drawn from the match, never from the player.** Round count is a
property of how the match went, not of who was in it. Drawing a player's own
past round counts would re-introduce exactly the sample-mix bias this change
exists to remove. The distribution comes from the 13,517 real games we hold,
conditioned on tier — `tier` is already stored in `raw`, with a usable spread
(b 23,606, c 14,326, s 6,461, a 3,056).

**When the upcoming match's tier is unknown, use the pooled CS2 distribution.**
Props come from PrizePicks and Underdog, neither of which publishes a tier, and
an upcoming match is not necessarily linked to a bo3 match yet. Conditioning is
therefore an improvement when available and never a requirement: the pooled
distribution over all 13,517 games is the default, and tier narrows it only
when the match can actually be identified. The projection must not stall or
refuse for want of a tier — round length varies far less between tiers than
between a stomp and a grinder, so the pooled distribution already captures most
of the effect being corrected for.

No fitted distribution is introduced. This is the same empirical resampling the
code already does, drawing from real observations.

### The correlation question, to be measured and not assumed

KPR and round count are not independent: a player who wins 13-4 has a high KPR
over few rounds, and drawing the two independently would misstate the spread.
This is the same trap `src/combo.ts` documents for teammates' kills, where the
measured joint spread was 1.06x to 1.18x what independence implied.

So it gets the same treatment: **measure it before choosing.** On the 47,449
stored rows, compute the correlation between a map's KPR and its round count.

- If it is immaterial, draw independently as above.
- If it is material, resample whole observed `(kills, rounds)` pairs and
  re-weight them so the round-length mix matches the expected mix, which
  preserves the relationship instead of assuming it away.

The measurement goes in `DESIGN.md` either way, with the number.

### Where it refuses

Consistent with how grading already refuses:

- **LoL is untouched.** It has no rounds. The code branches on league and does
  not invent an analogue. The existing per-map path stays exactly as it is.
- **A CS2 map with no round count is dropped from the KPR sample**, not
  assumed and not zero-filled.
- **A player without enough rounds-bearing maps falls back** to today's method
  and is marked. `Play.method` gains `'kpr'` alongside `'series'` and `'maps'`,
  so the board can say which basis a call rests on and never implies a
  precision it doesn't have.

### Testing

Pure functions, literal inputs, no database — matching `projection.test.ts`:

- A player whose sample is all blowouts is **not** projected low for a match
  expected to run long. This is the defect, stated as a test.
- Two players with identical KPR but different round-length samples project
  the same. Today they don't.
- A map with `rounds` null is excluded from the KPR sample rather than
  contributing a zero or a division by null.
- A LoL market is unaffected by any of it, and still reports `series`/`maps`.
- Below the rounds-bearing threshold, the call falls back and reports `maps`.
- KPR × rounds reproduces the observed kill total for a single map, so the
  decomposition is arithmetically sound before it is trusted statistically.

---

## Part B — A market probability, shown and not scored

### What it is

Underdog publishes genuine two-sided American odds (`-139` / `+113`). We store
them in `over_price` / `under_price` and the projection has never read them —
confirmed by grep: zero references in `projection.ts` or `optimize.ts`.
Devigging them yields a market-implied probability for each side.

PrizePicks cannot offer this by construction: flat multiplier, price expressed
by moving the line rather than by the odds. That makes Underdog's price the
only real market probability on the board.

### The module

New `src/devig.ts`, pure, no database:

American odds → implied probability per side → strip the overround,
**multiplicative**.

At −112/−112 the vig is small and near-symmetric, which is where multiplicative
and Shin barely differ; multiplicative is the standard and the transparent
choice. The method is **named in the returned value** so it can be swapped for
Shin or power later and the two compared on real results, rather than being
silently baked in.

**478 of 529** current Underdog markets carry both sides. The remaining 51 are
the higher-only markets `DESIGN.md` already describes. Those return *no market
probability*. A one-sided price cannot be devigged, and inventing one would be
the same error as grading a stat the source can't produce.

### How it is used

A column beside our own hit rate, plus a marker where our model and Underdog's
price disagree sharply — that being the interesting row.

**It does not feed `strength`, the score, or the ranking.** This is deliberate:

- Our hit rate is an empirical frequency over roughly 12-20 series. It is not a
  calibrated probability, and `DESIGN.md` is already explicit that the score is
  a rank rather than a probability. Multiplying an uncalibrated frequency
  against a market probability would present the product as an edge and sort
  the board on it.
- Underdog is a DFS operator, not a sharp book. Its price is *an* opinion
  informed by its own risk management, not the market's truth.

Showing the disagreement is useful immediately and costs nothing if it turns
out to be noise. Scoring on it should wait until graded picks can say whether
either number is calibrated — which is exactly what Phase 3 and Phase 5 exist
to find out. This ordering is the same principle the project has held from the
start: don't model before there's ground truth to model against.

### Testing

- A symmetric −110/−110 market devigs to 0.5/0.5.
- The two devigged sides sum to exactly 1.
- A skewed market devigs to probabilities that preserve the favourite, and the
  overround removed equals the overround measured.
- A one-sided market returns no probability, not 1.0 and not a guess.
- Positive and negative American odds both convert correctly, including the
  +100/−100 boundary.

---

## How we will know it worked

Rounds normalisation is a claim that can be checked against reality rather than
admired: hold out the most recent slice of `map_stat`, project into it with and
without the change, and compare mean absolute error on the actual totals. If
kills-per-round does not beat kills-per-map on held-out data, it does not ship,
however sound the reasoning is.

Validate on a **time-based split** — train on the past, test on the future.
Random splits on this data will lie, for the reasons the README already gives.

The devig has no accuracy claim to test yet. That is the point of not scoring
on it.
