import { q } from '../db.js';
import { config } from '../config.js';
import { comboParts } from '../normalize.js';
import { foldCombo, type ComboStatRow } from '../combo.js';
import { americanToProb, devig } from '../devig.js';

/**
 * What a player has actually done over the same map range, and how that sits
 * against the line being offered.
 *
 * Deliberately empirical rather than a fitted distribution. "Cleared 8.5 in 9
 * of their last 12 series" is a statement about what happened; a normal
 * distribution fitted to a dozen noisy esports games is a statement about an
 * assumption. With samples this small the assumption does more work than the
 * data, so it isn't made.
 *
 * The same rule grading uses applies here: only series where every map in the
 * range was actually played are counted. Including a 2-0 sweep in a "maps 1-3"
 * sample would drag every average down with a total that could never have been
 * bet.
 */

const STAT_COLUMN: Record<string, string> = {
  kills: 'kills', headshots: 'headshots', assists: 'assists', deaths: 'deaths',
};

export type Projection = {
  series: number;        // sample size: completed series covering the range
  mean: number;          // average total over the range
  sd: number | null;
  last: number | null;   // most recent series total
  overCount: number;     // how many cleared the line
  hitRate: number | null;
  edge: number | null;   // mean minus line, in stat units
};

/**
 * A player's output, held two ways.
 *
 * `totals` are real observed totals over the exact map range, from series that
 * actually played every map in it — the truest measure, and the scarcest. A
 * Bo3 that ends 2-0 contributes nothing to a "maps 1-3" sample, and a Bo1
 * league contributes nothing at all.
 *
 * `mapValues` are single-map outputs from every series regardless of length.
 * Far more data, and it can answer any map range including ones the books
 * haven't offered yet — at the cost of assuming maps are interchangeable.
 */
export type FormStats = {
  series: number;
  mean: number;
  sd: number | null;
  totals: number[];      // most recent first, exact-range series only
  mapValues: number[];   // most recent first, every map played
  perMap: number | null; // mean of a single map
};

export type Play = {
  side: 'over' | 'under';
  book: 'prizepicks' | 'underdog';
  line: number;
  edge: number;          // stat units in your favour at that line
  edgeSd: number | null; // edge relative to how much this player swings
  hitRate: number;       // share of past series that would have won this side
  /**
   * What `hitRate` was computed from, before shrinking — "8 of 8" behind a
   * displayed 72%.
   *
   * Null on the modelled path, where the counts describe 4,000 resampled
   * draws rather than games this player played. Null means "do not show a
   * count", not "zero".
   */
  rawWins: number | null;
  rawOf: number | null;
  /** Our estimate after anchoring toward the line — what the board shows. */
  anchored: number;
  /** The player's own unanchored average, for saying why the two differ. */
  rawMean: number;
  series: number;
  strength: number;      // ranking score, not a probability
  score: number;         // strength on a 0-99 scale, for reading at a glance
  method: 'series' | 'maps';  // measured over the exact range, or modelled from single maps
  sample: number;        // series counted, or maps drawn from
  /** What this price needs to win to return nothing. Null where the book publishes none. */
  breakEven: number | null;
  /** Expected profit per 1 staked at that price, null when there is no price. */
  ev: number | null;
};

const MIN_SERIES = 6;    // below this, form is noise wearing a number
export const MIN_MAPS = 12;     // single maps needed before modelling a range from them
/**
 * How confident the shrunk history must be before a market is a call.
 *
 * This replaced an absolute half-a-kill floor, which DESIGN.md had already
 * flagged as the wrong shape: 0.5 against a 30.5-kill line is a 1.6% claim
 * and against a 5.5-kill assists line a 9% one, and the board treated them
 * alike. A probability is scale-free, so one threshold means the same thing on
 * every market.
 */
const MIN_P = 0.55;

/**
 * Strength of the coin-flip prior an observed rate is shrunk toward, in
 * pseudo-observations. Ten is deliberately heavy: hit rate here is measured on
 * the same history used to choose the side, so it is optimistic by
 * construction — the board read 85-90% on markets the market itself priced
 * near 50%. Ten flips pulls a six-game sweep back to 73% and leaves a
 * forty-game record largely intact, which is the trade this is for.
 */
const PRIOR = 10;
const DRAWS = 4000;

/**
 * Counting, and why it is still counting.
 *
 * `rateAt` counts how many past totals cleared the line, which throws away
 * magnitude: against 28.5, a 28 and a 12 are both just "under". Reading the
 * same distribution through a logistic kernel instead — letting a near miss
 * count partially — was measured over 18,310 CS2 series walked forward, and
 * it did win: Brier 0.2410 against 0.2415 at thirty series, consistently, at
 * every history length tried.
 *
 * It is not shipped, and the reason is the size of that number next to the
 * risk. 0.2415 to 0.2410 is a fifth of one percent, against 0.25 for a coin
 * flip. And the bandwidth that produced it is an ABSOLUTE two stat units,
 * tuned on CS2 kills over maps 1-2 where totals run near thirty. Two units on
 * a 5.5-kill assists line is a different instrument entirely — the same
 * scale-dependence that made MIN_EDGE wrong and got it replaced by a
 * probability. A spread-proportional bandwidth would fix that, and would then
 * need re-measuring on every market type rather than the one it was fitted
 * on.
 *
 * So: a real effect, too small to buy that risk today. Revisit it if the
 * estimator ever becomes the binding constraint. It is not — see HISTORY.
 */

/**
 * How many past series a projection reads.
 *
 * Was twenty, from when twenty was most of what existed. With a year of CS2
 * history the sweep says thirty: identical Brier to twenty (0.2410) and a
 * better estimate of the total itself (mean absolute error 6.37 against
 * 6.43). Ten is clearly worse on both, and beyond forty the gain is gone —
 * old form stops describing the player.
 *
 * Worth being plain about the size of this: across every history length and
 * both estimators, Brier moved between 0.2410 and 0.2427 against 0.25 for a
 * coin flip. Tuning the estimator is polishing near its ceiling. What would
 * actually move it is information it does not have — opponent strength, above
 * all — not another pass over the same numbers.
 */
export const HISTORY = 30;

/**
 * Blend a player's own average with the book's line, by how much history there
 * is behind the average.
 *
 * Exported so the validator scores the estimate the board actually makes.
 * Recomputing the same blend there by hand would let the two drift apart, and
 * the whole point of the validator is that it measures what ships.
 */
export function anchorToLine(
  mean: number, line: number, observations: number, prior = PRIOR,
): number {
  const w = observations / (observations + prior);
  return w * mean + (1 - w) * line;
}

/** Deterministic PRNG, so the same board renders the same numbers every time. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    return x / 4294967296;
  };
}

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Totals for an n-map range, resampled from single-map outputs.
 *
 * A Bo3 that ends 2-0 tells you nothing about a three-map total directly, but
 * it still tells you what this player does in a map. Drawing n maps at random
 * and summing turns two maps of evidence into an estimate for any range —
 * including ranges the books haven't offered yet.
 *
 * The assumption is that maps are interchangeable and independent. They aren't
 * quite: a player having a good series tends to be good across all of it, so
 * real totals swing wider than this produces. Calls built this way are
 * therefore marked, and their score is damped rather than trusted equally.
 */
export function resampleTotals(mapValues: number[], maps: number, seed: string): number[] {
  const rand = rng(seedFrom(seed));
  const out: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    let sum = 0;
    for (let m = 0; m < maps; m++) sum += mapValues[Math.floor(rand() * mapValues.length)]!;
    out.push(sum);
  }
  return out;
}

/**
 * Which side to take, on which app.
 *
 * The two questions are separate and were being answered as one. Direction is a
 * question about the player: does their real output sit above or below this
 * number. App is a question about price: for an over you want the LOWEST line
 * available, for an under the HIGHEST — opposite books win opposite sides.
 *
 * So each direction is evaluated at the best line available for it, and the
 * direction with the larger edge wins. That naturally picks the book too.
 *
 * No call is made below MIN_SERIES or MIN_EDGE. A recommendation off four games
 * would be a coin flip wearing a decimal point.
 */
export type LineOption = {
  book: 'prizepicks' | 'underdog';
  line: number;
  overOk: boolean;
  underOk: boolean;
  /**
   * American odds per side, where the book publishes them.
   *
   * Underdog does; PrizePicks cannot, because it prices with a flat
   * multiplier and expresses price by moving the line instead. Null therefore
   * means "this book has no per-side price", not "this side is free" — the
   * bar falls back to MIN_P rather than to zero.
   */
  overPrice?: number | null;
  underPrice?: number | null;
  /**
   * A break-even the book implies without quoting odds, as a probability.
   *
   * PrizePicks pays a flat multiplier on the whole entry rather than a price
   * per side, so its break-even is a property of the slip — 3x on two legs
   * needs (1/3)^(1/2) = 57.7% per leg, 20x on five needs 54.9%. That cannot be
   * read off the market, so the caller works it out from the entry being built
   * and passes it in. Used only when there is no per-side price.
   */
  breakEven?: number | null;
  /**
   * A market probability for THIS line, when the book itself publishes none.
   *
   * PrizePicks quotes no odds, but the same market often exists on Underdog at
   * the same number — and when the numbers match, that devigged probability is
   * a read on this line too. The caller supplies it only in that case; see
   * `anchorFor`.
   */
  anchorOver?: number | null;
  anchorUnder?: number | null;
};

/**
 * Why there is no call, when there is no call.
 *
 * "No call" was one answer covering six different situations, and they are not
 * the same fact about a market. `fair` means the model looked and found the
 * line honest — that row is one line move from being live. `none` and `thin`
 * mean the model could not look at all, and no amount of line movement will
 * change that until the stat history arrives. Sorting and filtering both need
 * to tell those apart, and so does anyone asking why the board is quiet.
 */
export type NoCall =
  /** No stored column for the stat — fantasy points use a formula the books don't publish. */
  | { kind: 'unsupported' }
  /** A combo whose handle can't be split into players. */
  | { kind: 'unreadable' }
  /** Not one stat line for this player. */
  | { kind: 'none' }
  /** Some history, below MIN_SERIES whole-range series and MIN_MAPS single maps. */
  | { kind: 'thin'; series: number; maps: number }
  /** Neither side is offered by any book listing it. */
  | { kind: 'unavailable' }
  /** Evaluated, and the best side available is under MIN_P. */
  | { kind: 'fair'; edge: number; p: number }
  /**
   * We have a view, and the price eats it.
   *
   * Distinct from `fair`: there the number looked honest, here our own
   * probability clears MIN_P but not what the odds demand. A -170 side needs
   * 63.0% before it returns anything, so a 58% view is a losing bet however
   * confident it looks. That is a fact about the price, and it changes when
   * the price moves — so the row is worth watching, unlike a thin one.
   */
  | { kind: 'priced-out'; edge: number; p: number; breakEven: number };

export type CallStatus = { play: Play; why: null } | { play: null; why: NoCall };

/** Everything `evaluate` needs to either make a call or say why it won't. */
export type Evaluation = {
  form: FormStats | undefined;
  options: LineOption[];
  maps?: number;
  seed?: string;
  /** Canonical stat, so an unprojectable one is named as such rather than as missing history. */
  stat?: string;
  /** The market's handle, so an unsplittable combo is named as such. */
  handle?: string;
};

/**
 * How close a `fair` market is to being a call — 1.0 means it is at MIN_P.
 *
 * Takes the shrunk probability rather than the stat-unit edge, because that is
 * what the threshold is now measured in. A market two points of probability
 * short is one line move from live; one sitting at a coin flip is not, however
 * many kills separate the mean from the number.
 */
export const edgeProgress = (p: number) => Math.max(0, (p - 0.5)) / (MIN_P - 0.5);

export function recommend(
  form: FormStats | undefined,
  options: LineOption[],
  maps = 1,
  seed = '',
): Play | null {
  return evaluate({ form, options, maps, seed }).play;
}

export function evaluate(o: Evaluation): CallStatus {
  const { form, options, maps = 1, seed = '' } = o;

  if (o.stat !== undefined && !STAT_COLUMN[o.stat]) return { play: null, why: { kind: 'unsupported' } };
  if (o.handle !== undefined && /\+/.test(o.handle) && comboParts(o.handle).length < 2) {
    return { play: null, why: { kind: 'unreadable' } };
  }
  if (!form) return { play: null, why: { kind: 'none' } };

  // Prefer real totals over the exact range. Fall back to modelling the range
  // from single maps only when there aren't enough of them — more data, but
  // one assumption further from what actually happened.
  const useSeries = form.series >= MIN_SERIES;
  const sample = useSeries
    ? form.totals
    : form.mapValues.length >= MIN_MAPS
      ? resampleTotals(form.mapValues, maps, `${seed}|${maps}`)
      : null;
  if (!sample || sample.length === 0) {
    return form.series === 0 && form.mapValues.length === 0
      ? { play: null, why: { kind: 'none' } }
      : { play: null, why: { kind: 'thin', series: form.series, maps: form.mapValues.length } };
  }

  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const sd =
    sample.length > 1
      ? Math.sqrt(sample.reduce((a, b) => a + (b - mean) ** 2, 0) / (sample.length - 1))
      : null;

  // Only sides that can actually be taken. Underdog lists every LoL assists
  // market higher-only, and PrizePicks' promo projections are over-only —
  // naming a side the book won't accept is as useless as naming the wrong one.
  const overs = options.filter((x) => x.overOk);
  const unders = options.filter((x) => x.underOk);
  if (overs.length === 0 && unders.length === 0) return { play: null, why: { kind: 'unavailable' } };

  // An over wants the lowest number available; an under wants the highest.
  const forOver = overs.length ? overs.reduce((a, b) => (b.line < a.line ? b : a)) : null;
  const forUnder = unders.length ? unders.reduce((a, b) => (b.line > a.line ? b : a)) : null;

  // How much history this actually rests on. NOT sample.length: the modelled
  // path resamples 4,000 draws from a handful of maps, and shrinking against
  // 4,000 would treat a guess as a certainty.
  const observations = useSeries ? form.series : form.mapValues.length;
  // The modelled path carries an extra assumption — that maps are
  // interchangeable — so it is held to twice the evidence for the same claim.
  const prior = useSeries ? PRIOR : PRIOR * 2;

  /**
   * How much of our own history to keep when locating the distribution, with
   * the rest coming from the book's line. Same shrink as the probability, and
   * deliberately the same prior — see the note in `rateAt`.
   */
  const lineWeight = observations / (observations + prior);

  /**
   * The share of this player's own history that would have won a side, shrunk
   * toward a coin flip by how little history there is.
   *
   * A push leaves the denominator: the book hands the leg back rather than
   * losing it, which is how `grade.ts` has always recorded it. 15% of
   * PrizePicks lines are whole numbers and 7.4% of series land exactly on
   * them, so counting those as losses understated every such market.
   *
   * The shrink is what stops six games from outranking sixty. Six wins from
   * six is an observed 100% and is not a 100% chance; against a prior of ten
   * coin flips it reports 73%, which is a claim the sample can carry.
   */
  /**
   * The share of past totals that would have won a side — read with a soft
   * edge rather than counted.
   *
   * Counting throws away magnitude: against a 28.5 line, a 28 and a 12 are
   * both just "under", though one is a near miss and the other says the line
   * is nowhere near this player. At twenty samples that costs real precision,
   * because the estimate can only move in steps of 1/20.
   *
   * A logistic kernel of width KERNEL lets a near miss count partially. It is
   * still the empirical distribution — nothing is fitted, no shape assumed —
   * just read with a window instead of a step. Measured over 18,310 CS2
   * series walked forward, this beat plain counting at every history length
   * tried, though by a small margin: Brier 0.2410 against 0.2415 at K=20.
   *
   * Exact ties stay out of it entirely. A total landing on the line is a
   * push, which the book refunds; folding it in at half a win would price a
   * refund as half a bet.
   */
  const rateAt = (line: number, side: 'over' | 'under', anchor: number | null) => {
    // Recentre this player's history between their own mean and the book's
    // number before reading it. Measured 2026-09-08 over 823 settled CS2
    // markets, the line is the better estimate of what a player actually
    // does — MAE 5.01 against our 5.25, and our mean runs +1.16 high — so a
    // thin sample should not be trusted to out-locate it.
    //
    // The shift is a translation, so the SHAPE of the distribution is still
    // entirely the player's: only where it sits moves. Weight is the same
    // sample-size shrink the probability already uses, and `LINE_PRIOR` is
    // set equal to `PRIOR` on principle rather than tuned — three days of
    // settled data cannot fit a parameter without fitting its noise.
    //
    // At zero history the sample lands centred on the line, which reads as
    // 50/50 and makes no call. That is the correct answer to "we know
    // nothing", and it is what the old code got wrong: it reported the gap
    // between an unanchored six-game average and the line as edge.
    const effLine = line + (1 - lineWeight) * (mean - line);
    // A push is defined by the BOOK's number, not by our shifted one: a total
    // landing exactly on 20 against a line of 20 is refunded whatever we think
    // the player's true level is. Testing equality against `effLine` instead
    // scored those as wins or losses and silently undid the push handling —
    // caught by `projection.test.ts`, which is why that test exists.
    const settled = sample.filter((t) => t !== line).length;
    if (settled === 0) return null;
    const wins = sample.filter(
      (t) => t !== line && (side === 'over' ? t > effLine : t < effLine),
    ).length;
    const raw = wins / settled;
    // Shrink toward the market where there is one, toward a coin flip where
    // there isn't. See the note on `anchorFor`.
    const p = (raw * observations + (anchor ?? 0.5) * prior) / (observations + prior);
    // The counts are returned so the board can show what the number is made
    // of — "8 of 8, shrunk" says in four words what 72% hides. They are only
    // real counts on the series path: the modelled path counts resampled
    // draws, where "2,914 of 4,000" would describe the resampler rather than
    // the player. `useSeries` decides, and the caller must not show them
    // otherwise.
    return { p, wins, settled };
  };

  /**
   * What to shrink toward: the market's own opinion, when it has one.
   *
   * This used to be 0.5 — the assumption that, absent evidence, a side is a
   * coin flip. But a priced market is not an absence of evidence; it is
   * somebody else's estimate, made with more information than twenty of a
   * player's past series, and on average a better one. Shrinking to 0.5 threw
   * that away and then reported the difference as an edge: the board would say
   * 75% beside a market pricing the same side at 50%, which is a claim to have
   * out-read the market by twenty-five points on a tier-C CS2 prop.
   *
   * Anchored at the market, the same twenty series move the number a few
   * points instead of thirty, and a call now means "our history disagrees with
   * this price, and there is enough of it to say so" — which is the only thing
   * that was ever worth betting.
   *
   * Only ever the price for THIS line. A devigged probability is the chance of
   * clearing the number it was quoted against; borrowing Underdog's 30.5 to
   * anchor PrizePicks' 28.5 would anchor to a different question. Lines that
   * differ fall back to the coin flip, which is the honest "we have no market
   * read on this number".
   */
  const anchorFor = (o: LineOption, side: 'over' | 'under'): number | null => {
    const fair = devig(o.overPrice, o.underPrice);
    if (fair) return side === 'over' ? fair.over : fair.under;
    if (typeof o.anchorOver === 'number' && typeof o.anchorUnder === 'number') {
      return side === 'over' ? o.anchorOver : o.anchorUnder;
    }
    return null;
  };

  /**
   * Pick the side by probability, not by the mean.
   *
   * Kills are right-skewed: across 239 CS2 players and 18,712 series, 53.3% of
   * a player's series land below their own mean, and mean minus median averages
   * +0.55 kills. A line set near the median therefore sits under the mean, so
   * choosing by `mean - line` recommended the over on markets where the over
   * was the losing side more often than not. It produced a board that was 77%
   * over calls, and lines moved AWAY from those calls 72% of the time — 0 of 6
   * on the highest-scoring ones, which is the market telling you it disagrees.
   *
   * A probability also makes the threshold proportional, which an absolute
   * half-a-kill floor never was: 55% means the same thing against a 5.5 line
   * and a 30.5 line.
   */
  /**
   * The bar a side has to clear, and what it returns if it does.
   *
   * Two different bars, and a side must clear both. MIN_P is our own
   * confidence floor — below it we do not have a view worth acting on. Break-
   * even is the price's floor: at -139 a bet returns nothing until it wins
   * 58.2% of the time, whatever we think. Taking the max means a cheap price
   * never lowers the evidence we demand, and an expensive one raises it.
   *
   * PrizePicks has no per-side price to read: it charges through a flat
   * multiplier whose break-even depends on how many legs the slip ends up
   * carrying, which is not a property of this market. Those fall back to
   * MIN_P, and the slip panel is where leg count gets priced.
   */
  const assess = (o: LineOption, side: 'over' | 'under') => {
    const anchor = anchorFor(o, side);
    const at = rateAt(o.line, side, anchor);
    if (at === null) return null;
    const p = at.p;
    const price = side === 'over' ? o.overPrice : o.underPrice;
    // A quoted price wins; a flat-multiplier break-even is the fallback.
    const be =
      typeof price === 'number' && Number.isFinite(price)
        ? americanToProb(price)
        : typeof o.breakEven === 'number' && Number.isFinite(o.breakEven)
          ? o.breakEven
          : null;
    const bar = be === null ? MIN_P : Math.max(MIN_P, be);
    // Expected profit per 1 staked, only where a real price exists.
    const ev = be === null || price === null || price === undefined
      ? null
      : p * (price < 0 ? 100 / -price : price / 100) - (1 - p);
    return {
      side, book: o.book, line: o.line, p, breakEven: be, bar, ev, margin: p - bar,
      rawWins: at.wins, rawOf: at.settled,
    };
  };

  // Every takeable side of every book, rather than the best line per direction
  // and then the better direction. Line shopping is still in here — a lower
  // line raises P(over) by itself — but price can now outweigh it, which the
  // two-step version could not express.
  const candidates = [
    ...overs.map((o) => assess(o, 'over')),
    ...unders.map((o) => assess(o, 'under')),
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  if (candidates.length === 0) return { play: null, why: { kind: 'unavailable' } };

  /**
   * Rank by how far past its own bar a side is, so clearing a cheap price by
   * four points beats scraping over an expensive one. Price is already inside
   * `margin`, because an expensive side carries a higher bar.
   *
   * The tie-break is line shopping, and it is not decoration. Whenever a
   * player's whole history sits on one side of both books' numbers, the two
   * lines score an identical probability — and the cheaper one is still the
   * one to take. Ranking on probability alone would have quietly picked
   * whichever book happened to be listed first.
   */
  const better = (a: typeof candidates[number], b: typeof candidates[number]) => {
    if (Math.abs(b.margin - a.margin) > 1e-9) return b.margin > a.margin ? b : a;
    if (a.side !== b.side) return a;
    return (a.side === 'over' ? b.line < a.line : b.line > a.line) ? b : a;
  };
  const pick = candidates.reduce(better);

  // Our estimate after anchoring — the number the board should show, because
  // it is the one the call was actually made from. The player's raw average
  // is kept separately for the tooltip: "they average 19.6, we say 17.2
  // because eight series is thin" is the honest sentence.
  const anchored = lineWeight * mean + (1 - lineWeight) * pick.line;

  // Still reported in stat units, because "the number is 2.4 kills light" is
  // what a person reads, while the probability is what the model acts on.
  const edge = pick.side === 'over' ? anchored - pick.line : pick.line - anchored;

  // Evaluated and honest. Both numbers are reported: the stat-unit gap is what
  // the row shows, and the probability is what decides whether it is a call.
  // Two different refusals, because they are two different facts. Below MIN_P
  // we have no view; above it but below break-even we have one the price has
  // already taken. The second moves when the odds move, so it stays worth
  // watching in a way a thin market is not.
  if (pick.p < MIN_P) return { play: null, why: { kind: 'fair', edge, p: pick.p } };
  if (pick.p < pick.bar) {
    return { play: null, why: { kind: 'priced-out', edge, p: pick.p, breakEven: pick.breakEven ?? pick.bar } };
  }

  const hitRate = pick.p;

  // Relative to how much the player actually swings — kept for display, since
  // two kills on a 30-kill line is a smaller claim than two on a 5-kill line.
  // It no longer scales the ranking: the probability already is the claim.
  const edgeSd = sd && sd > 0 ? edge / sd : null;

  // The probability IS the ranking now. It already carries the sample size in
  // its shrink, so multiplying by a separate evidence term would damp twice —
  // and the old edgeSd factor was a proxy for the proportionality the
  // probability gives directly.
  const strength = (hitRate - 0.5) * 2;

  return {
    why: null,
    play: {
      side: pick.side,
      book: pick.book,
      line: pick.line,
      edge,
      edgeSd,
      hitRate,
      // Only where they count real series — see the note on the type.
      rawWins: useSeries ? pick.rawWins : null,
      rawOf: useSeries ? pick.rawOf : null,
      anchored,
      rawMean: mean,
      series: form.series,
      strength,
      method: useSeries ? 'series' : 'maps',
      sample: useSeries ? form.series : form.mapValues.length,
      breakEven: pick.breakEven,
      ev: pick.ev,
      // A rank, not a probability. 60 is a better bet than 30; it is not a claim
      // that it wins 60% of the time — hit rate is shown separately for that.
      score: Math.max(1, Math.min(99, Math.round(strength * 100))),
    },
  };
}

export async function projectFor(opts: {
  canonHandle: string;
  league: string;
  stat: string;
  mapStart: number;
  mapEnd: number;
  line: number;
  limit?: number;
}): Promise<Projection | null> {
  const col = STAT_COLUMN[opts.stat];
  if (!col) return null;
  const need = opts.mapEnd - opts.mapStart + 1;

  const rows = await q<{
    series: number; mean: number | null; sd: number | null;
    last: number | null; over_count: number;
  }>(
    `WITH totals AS (
       SELECT series_key,
              max(played_at) AS at,
              count(*) FILTER (WHERE map_number BETWEEN $3 AND $4)      AS maps_played,
              sum(${col}) FILTER (WHERE map_number BETWEEN $3 AND $4)   AS total
       FROM map_stat_dedup
       WHERE canon_handle = $1 AND league = $2
       GROUP BY series_key
     ),
     usable AS (
       -- Only series that actually played the whole range, and where the stat
       -- exists for it. A source that knows the map happened but not this stat
       -- must not count as a zero.
       SELECT * FROM totals
       WHERE maps_played = $5 AND total IS NOT NULL
       ORDER BY at DESC
       LIMIT $6
     )
     SELECT count(*)::int                                   AS series,
            avg(total)::float                               AS mean,
            stddev_samp(total)::float                       AS sd,
            (array_agg(total ORDER BY at DESC))[1]::float    AS last,
            count(*) FILTER (WHERE total > $7)::int          AS over_count
     FROM usable`,
    [opts.canonHandle, opts.league, opts.mapStart, opts.mapEnd, need, opts.limit ?? HISTORY, opts.line],
  );

  const r = rows[0];
  if (!r || r.series === 0 || r.mean === null) return null;
  return {
    series: r.series,
    mean: r.mean,
    sd: r.sd,
    last: r.last,
    overCount: r.over_count,
    hitRate: r.series > 0 ? r.over_count / r.series : null,
    edge: r.mean - opts.line,
  };
}

/**
 * Projections for a whole board in one query, keyed by `canon|stat|start|end`.
 *
 * Per-row lookups would mean hundreds of round trips to render one page. The
 * line differs per book, so hit rate is computed against the line passed in
 * for each market.
 */
export async function projectBoard(
  markets: {
    canon_handle: string; league: string; stat: string;
    map_start: number; map_end: number;
  }[],
  limit = HISTORY,
): Promise<Map<string, FormStats>> {
  const out = new Map<string, FormStats>();
  const wanted = markets.filter((m) => STAT_COLUMN[m.stat]);
  if (wanted.length === 0) return out;

  // One query per stat column, since the column name can't be parameterised.
  const byCol = new Map<string, typeof wanted>();
  for (const m of wanted) {
    const col = STAT_COLUMN[m.stat]!;
    const list = byCol.get(col);
    if (list) list.push(m);
    else byCol.set(col, [m]);
  }

  for (const [col, group] of byCol) {
    const rows = await q<{
      canon_handle: string; league: string; map_start: number; map_end: number;
      totals: number[];
    }>(
      `WITH want AS (
         SELECT DISTINCT canon_handle, league, map_start, map_end
         FROM unnest($1::text[], $2::text[], $3::int[], $4::int[])
              AS t(canon_handle, league, map_start, map_end)
       ),
       totals AS (
         SELECT w.canon_handle, w.league, w.map_start, w.map_end,
                ms.series_key,
                max(ms.played_at) AS at,
                count(*) FILTER (WHERE ms.map_number BETWEEN w.map_start AND w.map_end)     AS maps_played,
                sum(ms.${col}) FILTER (WHERE ms.map_number BETWEEN w.map_start AND w.map_end) AS total
         FROM want w
         JOIN map_stat_dedup ms ON ms.canon_handle = w.canon_handle AND ms.league = w.league
         GROUP BY w.canon_handle, w.league, w.map_start, w.map_end, ms.series_key
       ),
       ranked AS (
         SELECT *, row_number() OVER (
                  PARTITION BY canon_handle, league, map_start, map_end ORDER BY at DESC) AS rn
         FROM totals
         WHERE maps_played = (map_end - map_start + 1) AND total IS NOT NULL
       )
       SELECT canon_handle, league, map_start, map_end,
              array_agg(total ORDER BY at DESC)::float[] AS totals
       FROM ranked WHERE rn <= $5
       GROUP BY canon_handle, league, map_start, map_end`,
      [
        group.map((m) => m.canon_handle),
        group.map((m) => m.league),
        group.map((m) => m.map_start),
        group.map((m) => m.map_end),
        limit,
      ],
    );

    const stats = new Map(
      rows.map((r) => [`${r.canon_handle}|${r.league}|${r.map_start}|${r.map_end}`, r]),
    );

    // Every single map this player has produced, whatever the series length.
    // This is what lets a "maps 1-3" prop be projected from Bo1 and Bo2 play,
    // and what will answer whatever map range the books invent next.
    const mapRows = await q<{ canon_handle: string; league: string; vals: number[] }>(
      `WITH want AS (
         SELECT DISTINCT canon_handle, league
         FROM unnest($1::text[], $2::text[]) AS t(canon_handle, league)
       ),
       m AS (
         SELECT w.canon_handle, w.league, ms.${col} AS v, ms.played_at,
                row_number() OVER (PARTITION BY w.canon_handle, w.league
                                   ORDER BY ms.played_at DESC) AS rn
         FROM want w
         JOIN map_stat_dedup ms ON ms.canon_handle = w.canon_handle AND ms.league = w.league
         WHERE ms.${col} IS NOT NULL
       )
       SELECT canon_handle, league, array_agg(v ORDER BY played_at DESC)::float[] AS vals
       FROM m WHERE rn <= $3
       GROUP BY canon_handle, league`,
      [group.map((m) => m.canon_handle), group.map((m) => m.league), limit * 3],
    );
    const maps = new Map(mapRows.map((r) => [`${r.canon_handle}|${r.league}`, r.vals]));

    // Line-independent: the two books price the same market differently, and
    // the recommendation has to weigh both lines against one set of totals.
    for (const m of group) {
      const key = `${m.canon_handle}|${m.stat}|${m.map_start}|${m.map_end}`;
      if (out.has(key)) continue;
      const s = stats.get(`${m.canon_handle}|${m.league}|${m.map_start}|${m.map_end}`);
      const mapValues = maps.get(`${m.canon_handle}|${m.league}`) ?? [];
      const totals = s?.totals ?? [];
      if (totals.length === 0 && mapValues.length === 0) continue;
      const n = totals.length;
      const mean = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
      const sd =
        n > 1 ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
      const perMap = mapValues.length
        ? mapValues.reduce((a, b) => a + b, 0) / mapValues.length
        : null;
      out.set(key, { series: n, mean, sd, totals, mapValues, perMap });
    }
  }

  return out;
}

/** The shape both `projectBoard` and `projectCombos` are asked about. */
export type MarketKey = {
  canon_handle: string;
  handle: string;
  league: string;
  stat: string;
  map_start: number;
  map_end: number;
};

export const formKey = (m: {
  canon_handle: string; stat: string; map_start: number; map_end: number;
}) => `${m.canon_handle}|${m.stat}|${m.map_start}|${m.map_end}`;

/**
 * Form for combo markets, keyed the same way as single-player form so the
 * board can look either up without knowing which it has.
 *
 * The query fetches raw per-player, per-map rows for the members and the
 * folding happens in `src/combo.ts`, deliberately: the rule that decides which
 * maps and series count is the rule that decides money on these markets, and a
 * rule buried in SQL cannot be unit tested without a database. What SQL is left
 * to do is the part it is good at — bounding the fetch to series where every
 * member appears at all, most recent first.
 *
 * One query per (stat column, member set); combos are a couple of percent of
 * the board, so this is a handful of round trips, not a per-row lookup.
 */
export async function projectCombos(
  markets: MarketKey[],
  limit = HISTORY,
): Promise<Map<string, FormStats>> {
  const out = new Map<string, FormStats>();

  // Collapse to one job per distinct market, since both books' rows arrive
  // already paired but a search or filter can repeat one.
  const jobs = new Map<string, { m: MarketKey; parts: string[]; col: string }>();
  for (const m of markets) {
    const col = STAT_COLUMN[m.stat];
    if (!col) continue;
    const parts = comboParts(m.handle);
    if (parts.length < 2) continue;
    const key = formKey(m);
    if (!jobs.has(key)) jobs.set(key, { m, parts, col });
  }

  for (const [key, { m, parts, col }] of jobs) {
    const rows = await q<ComboStatRow>(
      `WITH r AS (
         SELECT ms.series_key, ms.map_number, ms.canon_handle, ms.played_at,
                ms.${col} AS value
         FROM map_stat_dedup ms
         WHERE ms.league = $1 AND ms.canon_handle = ANY($2::text[])
       ),
       -- Only series every member turned up in are worth carrying back. A
       -- series missing one of them can never produce a combo total, so
       -- fetching it would only be work for the fold to throw away.
       keep AS (
         SELECT series_key, max(played_at) AS at
         FROM r
         GROUP BY series_key
         HAVING count(DISTINCT canon_handle) = $3
         ORDER BY max(played_at) DESC NULLS LAST
         LIMIT $4
       )
       SELECT r.series_key, r.map_number, r.canon_handle, r.value, r.played_at
       FROM r JOIN keep k ON k.series_key = r.series_key
       ORDER BY k.at DESC NULLS LAST, r.map_number`,
      [m.league, parts, parts.length, limit * 3],
    );

    const { totals, mapValues } = foldCombo(parts, rows, m.map_start, m.map_end, limit);
    if (totals.length === 0 && mapValues.length === 0) continue;

    const n = totals.length;
    const mean = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
    const sd =
      n > 1 ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
    const perMap = mapValues.length
      ? mapValues.reduce((a, b) => a + b, 0) / mapValues.length
      : null;
    out.set(key, { series: n, mean, sd, totals, mapValues, perMap });
  }

  return out;
}

/**
 * Form for a whole board, single-player markets and combos alike.
 *
 * Callers shouldn't have to know which kind a row is — the combo is a market
 * like any other once its members' history has been combined, and keeping the
 * split inside here is what lets the board, the builder and the recommendation
 * treat them alike.
 */
export async function projectMarkets(
  markets: MarketKey[],
  limit = HISTORY,
): Promise<Map<string, FormStats>> {
  const singles = markets.filter((m) => comboParts(m.handle).length < 2);
  const combos = markets.filter((m) => comboParts(m.handle).length >= 2);
  const [a, b] = await Promise.all([
    projectBoard(singles, limit),
    projectCombos(combos, limit),
  ]);
  for (const [k, v] of b) a.set(k, v);
  return a;
}

/**
 * What a flat-multiplier entry needs from each leg to break even.
 *
 * PrizePicks quotes no price per side. It pays a fixed multiple of the stake
 * if every leg wins, so the bar is set by the entry rather than by the market:
 * n legs at multiple m return nothing until each leg wins (1/m)^(1/n) of the
 * time. The table is not monotone — 3x on two legs demands 57.7% while 20x on
 * five demands 54.9% — so guessing a single figure would be wrong in both
 * directions depending on the slip.
 *
 * Assumes the legs are independent, which they are not when two come from the
 * same match; the slip panel already warns about that separately, and the
 * error is in the safe direction here (correlated legs win together more often
 * than independence implies, so a real parlay clears a lower bar than this).
 */
export function flatBreakEven(
  legs: number,
  book = 'prizepicks',
  /** Injected so tests pin the arithmetic, not the environment. */
  payouts: Record<string, Record<number, number>> = config.payoutTable,
): number | null {
  // An entry needs at least two legs; a slip being built is one leg short of
  // the entry it will become, so the caller adds the leg it is considering.
  const n = Math.max(2, Math.min(6, Math.round(legs)));
  // Unknown unless someone has entered the book's real table. The multipliers
  // that used to live here were written when both books paid a flat rate by
  // leg count, and neither does now — PrizePicks prices per prop and publishes
  // the multiplier nowhere in its API. Returning null makes the caller fall
  // back to MIN_P, which is the honest bar when the price is unknown; a stale
  // number here would instead move the gate by a few points in a direction
  // nobody could see.
  const mult = payouts[book]?.[n];
  return mult === undefined ? null : Math.pow(1 / mult, 1 / n);
}
