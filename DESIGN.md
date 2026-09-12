# Design notes

A living document. Decisions and constraints get written down here as they're
made, so the dashboard stays coherent instead of drifting.

## Standing constraints

Non-negotiable, from the outset:

- **No purple gradients.** No violet-to-indigo anything — backgrounds, buttons,
  headers, charts.
- **No "AI" iconography.** No sparkles, magic wands, stars, brains, robots.
- **Nothing that reads as vibe-coded.** No glassmorphism, no frosted cards
  floating on a gradient mesh, no neon glow, no oversized hero with a tagline.
- **Clean.** Restraint over decoration.

Those rule things *out*. What follows is what we're doing *instead* — the part
that actually makes it look like something.

## What this thing actually is

A tool for reading numbers fast and deciding on slips. The user is scanning for
disagreement between two books and for lines that moved. Everything follows
from that:

**Density is a feature, not a flaw.** The failure mode of a "clean" dashboard is
four giant stat cards with 40px numbers, on a page that answers no question.
Twenty rows of legible, well-aligned data beats four decorative tiles. Think
trading terminal or a printed stats almanac, not a SaaS marketing page.

**Colour encodes meaning or it isn't used.** There is no brand accent sprinkled
around for warmth. Colour means: line moved up, line moved down, books disagree,
market is stale. A page where colour is decoration is a page where colour can't
carry information — and the whole product is a colour-codeable signal.

**Numbers are the typography.** Tabular figures throughout, so digits form
columns and the eye can compare down a row without reading. Right-align every
numeral. Line values (`28.5`) and diffs (`-2.5`) are the largest type on the
page; labels are small and quiet. This single decision does more for the way it
looks than any palette will.

**Every screen answers a question.** Not "here's your data" but *where do the
books disagree right now*, *what moved since I last looked*, *which of my logged
edges actually hit*. If a component doesn't answer one, it's cut.

**Show the data's honesty.** Sample size next to every hit rate. A timestamp on
every number, because a line from 40 minutes ago is a different fact from a line
from 40 seconds ago. Staleness gets shown, not hidden. This is a tool that will
be wrong sometimes; the design shouldn't project false confidence.

## Practical rules

- Neutral ground (near-white or near-black), one signal colour per direction,
  nothing else. Both themes carry the full palette.
- Borders and spacing for structure — not shadows.
- One type family, or a text face plus a mono for figures. No display fonts.
- Icons only where a word won't do, and from one set. Never as ornament.
- Tables scroll inside their own container; the page never scrolls sideways.
- Empty states say what's missing and when it'll fill, since much of this data
  only accrues over time.

## Visual direction: technical instrument

Chosen 2026-09-06. The dashboard reads like a measuring instrument or an
engineering drawing, not an app: hairline rules, small-caps letterspaced
headers, precise alignment, a light paper ground, and figures set in mono with
tabular numerals. Restrained, and unusual without trying to be.

What that means concretely:

- **Hairlines, not shadows.** Structure comes from 1px rules at low contrast.
  Nothing floats; nothing has a drop shadow or a rounded card border.
- **Labels are small-caps and quiet.** `PRIZEPICKS`, `DELTA`, `MOVEMENT` —
  letterspaced, small, low-contrast. They frame the numbers without competing.
- **Figures are the subject.** Mono, tabular, right-aligned, the largest and
  darkest type on the page.
- **Two signal colours only**, one per direction, used exclusively to encode
  sign. Everything else is ink on paper.
- **Rules and gutters do the grouping**, so density stays legible at 30+ rows.

## Taking props

The dashboard writes as well as reads. Rules that fell out of building it:

- **A pick stores the line it was taken at**, copied, never joined to the live
  board later. Lines move; a pick that silently re-reads the current number
  would rewrite its own history and make every future backtest a lie.
- **Over/under are plain forms**, not fetch calls, and every write redirects
  (Post/Redirect/Get). Taking a prop works with scripts blocked, and a refresh
  never double-adds a leg.
- **Combo props are marked, and now priced.** A row like
  `Dhokla + Inspired + Saint` looks exactly like a single-player line and is
  not one. It is still marked, and still never cross-book matched against a
  single player — but it is no longer a dead row. Its projection is built from
  the series its members actually played *together*, and its result is the sum
  of their totals, so it grades like anything else.
- **The handle decides what a combo is, not the book's flag.** PrizePicks also
  sets `combo` on the player node, and it over-fires: on 2026-09-07 it was set
  on `eraa`, one CS2 player, whom Underdog listed as an ordinary player on the
  same kills market. Believing the flag split that market in two, hid a 4.0
  cross-book gap, and made it ungradeable. A name with one player in it is one
  player.
- **Legs read PENDING and stay there** until grading exists. Better an honest
  empty column than a fabricated result.
- **A slip belongs to one app.** PrizePicks and Underdog are separate books
  and no single entry can draw legs from both, so the first leg decides the app
  and the board narrows to it. Enforced server-side, not just hidden: a hidden
  button is still a submittable form. Choosing an app in the filter narrows the
  board the same way — the other book's column disappears rather than sitting
  there with live buttons that lead nowhere.
- **"Better on an app" is a property of a side, not of a prop.** A lower line
  is the better over; a higher line is the better under. So on any market where
  the two apps differ, the selected app wins exactly one side — and only that
  side is offered. Markets where the lines match are hidden, since there is
  nothing to gain. Markets the other app doesn't list are kept: with no
  comparison they can't be called worse.
- **The other app's number survives as the gap.** Narrowing drops the column
  but keeps the comparison, relabelled "vs Underdog" / "vs PrizePicks", because
  knowing your number is worse elsewhere is the reason this tool exists.
- **A side the book doesn't list is not offered.** Every Underdog LoL assists
  market is higher-only, and PrizePicks' promo projections are over-only — 105
  of the markets on a typical board. Those buttons are disabled and the
  recommendation never names an unplayable side.
- **The payout multiplier is never asserted.** PrizePicks reprices correlated
  legs and demotes individual props, so a leg-count table is a hint, not a
  quote. The field starts empty with the standard rate as placeholder text, and
  the slip stores whatever was actually typed. When two legs on a slip come
  from the same match on the same app, the panel says so, because that is the
  usual repricing trigger.

## Visual direction, revised

The first build was a "technical instrument": hairline rules, zero radius,
tracked-out all-caps labels, mono for every small label. Run against the
frontend-design skill's calibration, that turned out to hit two documented
AI-design tells head-on — trait 3 (broadsheet hairlines, zero radius, dense
columns) and trait 5 (all-caps eyebrow labels, `A · B · C` meta strings, mono
for small data labels). It also read as flat and hard to scan, which is what
prompted the rebuild.

**The idea now:** the subject is a head-to-head between two apps, so the board
is a *scoreboard*. One row per market with PrizePicks and Underdog paired and
the gap between them as the thing the eye lands on — rather than one row per
book, which duplicated every player and made you hold two numbers in your head.

Rules that follow from it:

- **Boldness is spent in one place**: the gap chip. Everything else is quiet.
- **League carries colour** — CS2 amber, LOL cyan — because "which game is
  this" is the first question when scanning a mixed board.
- **Semantic colour is separate from league colour**, and the primary action is
  high-contrast neutral, so no two hues ever mean the same thing.
- **Radius by role**: controls are rounded because they're pressable, table
  rows are square because they're a table.
- **Mono is for figures only.** A match name set in mono reads as data, not a
  name.
- **Sentence case labels**, sized and coloured for hierarchy. No all-caps
  eyebrows, no middle-dot meta strings.
- Base type is 15px, figures 17px — the first version was too small to scan.

## The call

Two questions were being answered as one, which is why the board could say
"take the over on PrizePicks" about a side the numbers didn't support.

- **Direction is a question about the player.** Does their real output over this
  map range sit above or below the number.
- **App is a question about price.** An over wants the *lowest* line available,
  an under the *highest*. Opposite books win opposite sides of the same market.

So each direction is priced at the best line available for it, and the direction
with the larger edge wins — which picks the book as a side effect. One
highlighted button per row: the one to press.

Ranking is hit rate, scaled by the edge relative to how much that player
actually swings, damped by sample size. Two kills on a 30-kill line is a smaller
claim than two kills on a 5-kill line; ranking them alike would float noisy
high-volume markets to the top forever.

**No call is a real answer.** Below six series or half a stat unit the column
says so. A tool that names an edge on every row has no edges.

**But "no call" was one word for six different facts**, and counting them
settled the question of whether to hide the quiet rows — by accident, because
the answer changed while it was being counted.

Same 465-market board, same code, on 2026-09-07:

| | 07:45 UTC | 08:40 UTC |
|---|---|---|
| CS2 stat rows in `map_stat` | 527, over 36 series | **8,390, over 719 series** |
| Markets with a call | 22 (4.7%) | **278 (59.8%)** |
| Priced fair — no edge | 27 | 70 |
| Waiting on stat history | 386 | 89 |
| CS2 board handles with enough history | 0 of 200 | **155 of 200** |

Nothing about the markets changed in that hour. A bo3.gg backfill ran. The 386
rows that looked dead were not markets without an edge — they were markets the
model could not see, and 255 of them had an opinion an hour later.

That is the whole argument. A market priced *fair* is live: the evidence is
there and one line move puts it in play — 20 of the 70 sit within a single
half-point move of the threshold. A market with no history is inert, and no
line movement will make it speak. Two different rows, one word. So:

- **Nothing is hidden by default.** The dominant reason a row is quiet is our
  own data pipeline, not the market. Hiding those rows would have hidden the
  gap rather than the market, and would have hidden it right through the hour
  in which it closed.
- **The header counts the reasons.** "278 with a call · 70 priced fair · 89
  waiting on history" answers *why is this board quiet* without scrolling it,
  and would have made the backfill visible the moment it landed.
- **Dead rows sink rather than disappear.** Calls first by strength, then
  markets priced fair — nearest to the threshold first, because those are the
  ones a half-point move turns into a call — then everything waiting on data.
- **Hiding is offered, at two strengths.** *Priced* keeps only markets the
  model could evaluate. *With a call* keeps only markets it has an opinion on.
  Both are one click and neither is the default, because a market with no edge
  on our numbers is still a market the user may have a reason to take, and the
  model cannot see those reasons.

**Left open:** with CS2 history filled in, 60% of the board now carries a call,
which is the opposite complaint. The damping holds the top of the board honest
— of 284 calls, 199 score under 10 and only 13 reach 50 — but `MIN_EDGE` is an
absolute 0.5, and half a kill against a 30.5-kill CS2 line is a 1.6% claim
where the same 0.5 against a 5.5-kill assists line is 9%. A proportional floor,
or one scaled by the player's own spread, is the obvious next question. Not
changed here: it decides money and deserves its own measurement.

## Open decisions

- Whether grading results live in the same view as live lines, or separately.
- Auth, if this is ever shared beyond one user.

## Log

- **2026-09-11** — **Broadcast.** The owner chose it from three directions
  (Broadcast, Desk, Clubhouse), asking for life, a sleek rigid feel rather than
  rounded, love for the desktop header, and a mark of our own in place of the
  two-tone wordmark and the thin coloured band, which read as overdone. So: a
  dark score-bug bar in both themes with tabs as overlay labels and an orange
  rule under the current page; a LIVE chip for freshness with a pulsing square;
  square panels and 2px controls; the call in a notched ink tag with its
  direction as a stripe down the leading edge; the book's line as a dark
  scoreboard box beside our steel-outlined number. Chakra Petch for display,
  Hanken Grotesk for text, Barlow Semi Condensed for every number (the display
  face's digits read as off in the mockup). The mark is an orange tile with the
  call tag's notch cut from its corner and a staggered up and down chevron, over
  and under; it is also the favicon. Orange now means only "press this" and "you
  are here" — strong records went from gold to ink. The standing constraints
  hold: no violet, no AI iconography, no middle-dot meta strings. The caps are
  confined to the bar, the tabs and the call tag.
  Then, at the owner's word — "a more horizontally linear feel", no number "a
  few pixels above the number directly to their right", and less highlighting
  over everything — every row became one line on one axis: value cells are
  single-line and vertically centred, a book's price sits beside its number
  rather than under it, and each number takes a fixed right-aligned slot. What
  took second lines (the gap to the line, the sample behind our number, the
  market %) moved into tooltips; the stale chip left the row. Highlighting
  came down to the call tag and the take button: the tinted O/U best-number
  chips and their key, the direction stripe down each row, the coloured line
  moves, the box around our number and the duplicate Line column are gone.
  On a phone the verdict is one centred line — tag, "11 of 12 series",
  "Ours 45.3" — above your app's line and buttons.
  Then a pass against "looks vibecoded" (the owner ran the board past another
  assistant and agreed with all of it): the model got a name — **Projected** —
  and says what it was built from ("Last 12 matches average 48.4, pulled toward
  the line"); the record got a defined sample ("11 of last 12 matches over");
  engine language left the row ("moved +1.5" → "line up 1.5", "waiting on
  history" → "No play" with the reason in a tooltip, the header's call/fair/
  waiting breakdown → "4 plays from 14 props"); and boxes came down —
  league badges are a coloured word, filters are underlined text tabs, the
  phone board is a hairline list rather than stacked cards, and the play is
  one solid button with the other side quiet. The phone card now reads
  ESPN-style: who and prop; the line, Projected and the play with its edge;
  the record with its reason; the button. The one suggestion NOT taken was a
  win percentage ("68% O"): the model's probabilities measured as uncalibrated
  (claimed ~60%, realised ~52%, AUC ≈ 0.5), and a confident percentage is the
  fakest thing the board could print.
- **2026-09-11 (later)** — The board stopped claiming a play on single props,
  because the claim was measured and it loses. `npm run validate:backtest`
  scored every leg the projection called against the books' own closing lines:
  -9.5% [-16.4%, -3.2%] at the per-leg bar a Power entry needs, -10.4% on the
  held-out later days, claimed 54.9% against 47.2% realised — worse than taking
  every under, with 0 of 213 held-out slices positive. So the notched
  OVER/UNDER tag and the filled take button are gone from board rows; the
  column is "Edge" and states the gap between the app's line and Projected,
  and both sides stay takeable because slips are still built by hand (and
  these apps need two players from two teams anyway). Recommendations moved to
  Build, where the entry is priced from the measured correlation and tail.
  Everything else on the row — team bug, line, Projected, record, map pips —
  is untouched, at the owner's request.
  Personality, next: a bolder mark and wordmark with the tagline "Read the
  line" (not "props with edge", which the single-prop plays have not earned);
  a faint grain, an orange glow behind the mark and a gentle gradient in the
  bar; a team "bug" — the short name an overlay puts in the corner, in the call
  tag's notch, derived from the name because logos need a licensed source;
  map-range pips (■■□ is maps 1–2 of a Bo3) so 1–2 and 1–3 props stop looking
  identical; on a phone the line, Projected and Edge as three figures of one
  shape beside the tag; buttons that press in; and a slip whose count pops and
  whose new leg slides in. Declined, on the same principle as the percentage:
  brighter colours for bigger edges, "hot" badges for 11/12 records, and
  pulsing strong projections — bigger edges and stronger records measured as
  no more likely to win, so dressing them up steers the reader toward noise;
  and invented "insight" lines, which on these samples are storytelling.
- **2026-09-11** — Light is the default, at the owner's request; dark is one
  tap away. The phone card was cut to one call made at your own app's line:
  the cheaper-app chip, the stale chip, the "+3.8 in your favour" figure and
  the market % now appear on wide screens only, and the other apps' lines are
  one grey line with no marks. With an app selected both of its sides stay
  takeable. A PrizePicks card that said "Under" beside a greyed-out U, with
  Underdog's 8.5 the only takeable under, read as an Underdog bet on a
  PrizePicks prop, which is exactly the noise this pass exists to remove. Wide
  screens now show every book side by side, Sleeper included. A new palette
  and type are being chosen separately.
- **2026-09-08** — Line movement is now louder than the model's own lean, and
  that ordering is the point. Four experiments have failed to beat a player's
  flat average, so the projection is the weaker evidence on the row. "UD moved
  +2.0, PP still 28.5" is an observation about two numbers; "we say 61%" is a
  forecast about a person, and only one of those has a measured edge behind it
  (the lagging book agrees with the mover about 6.5 to 1). Phrased as what
  happened rather than as a recommendation, and the tooltip says outright that
  it is not yet proven profitable.
- **2026-09-08** — Added a Stats page, and deliberately made it about the
  archive rather than about profit. The honest headline here is a year of
  per-map history nobody sells; the graded record is five settled picks. So
  the collection counters and the history-by-week chart lead, and the record
  sits last, captioned as too small to read anything into. A page that opened
  with a win rate on five bets would be projecting confidence the data cannot
  carry — the same rule that keeps an empty results panel out of the board.
  Closing line value sits between them because it is the one measure that
  works at this sample size.
- **2026-09-08** — Charts are inline SVG with no library and no gridlines.
  Same reasoning as having no framework: a dependency arrives with a default
  look that then has to be fought, and this is a dozen rectangles. Structural
  devices should encode information, and a gridline behind a growth curve
  encodes nothing the bars do not already say.
- **2026-09-08** — The ground is a deep forest green, and nothing on the page
  is grey. Four attempts at this and the first three were all a flavour of
  grey: near-black, then blue-grey (which was OddsJam), then warm grey (which
  was bland). Each time the hue was a few points of correction applied to a
  neutral, so every surface still read as "grey, slightly". Green is the
  surface now, holding its hue from page to card to control — and it gives
  gold somewhere to sit the way light sits in trees, rather than a neutral
  that mutes everything equally.
  Colour alone was not the whole of "bland", though. Every row carried the
  same weight, so two dozen of them read as one block however good the
  palette. Rows the model has an opinion on now carry a leading-edge mark in
  their own direction and the rest are dimmed — never hidden, because a fair
  market is one line move from a call.
- **2026-09-08** — Dropped blue entirely from the chrome and the ground. The
  cyan accent and the navy slate together were the whole reason the board
  looked like OddsJam, and the navy was self-inflicted the same day: the fix
  for "grey on grey" added blue chroma and landed on the default hue of the
  entire category. Ground is warm charcoal now, red over green over blue.
  Chrome is a warm bone rather than a hue at all — by that point gold, green,
  red and the two league pastels were all spoken for and violet is ruled out,
  so any saturated replacement would have made one hue answer two questions,
  which is precisely the mistake cyan was introduced to fix. The wordmark
  takes the brand gold, since a name is the one thing on the page that means
  itself rather than something about a market.
- **2026-09-08** — Radius by role, not one number. A single house radius on
  cards, chips, buttons and inputs alike is documented tell #4 — "one
  border-radius on everything regardless of hierarchy" — and it is what
  "everything feels round" describes: every element becomes the same kind of
  object. Panels are 3px because they are regions of a page, controls 6px
  because they are pressable, chips 3px so figures do not read as buttons.
- **2026-09-08** — Surfaces got chroma. The first pass off near-black still
  carried only about six points of blue over red, so the three steps separated
  by lightness alone — legible, but grey on grey. Eighteen points now, held as
  they lighten, so a card reads as a lit surface of the same material.
- **2026-09-08** — Strength is back, as a shape rather than a number. Dropping
  Score was right — it was `(p − 0.5) × 2` and duplicated Win % — but a bare
  "67%" gives no sense of where it sits in the range a call can occupy, and on
  a phone there is no neighbouring row to compare against. Four banded steps
  drawn on the figure itself, width proportional to the claim.
- **2026-09-08** — Taking a prop cross-fades instead of whiting out. The write
  is a form POST and a redirect, which is what keeps it working with scripts
  blocked; a cross-document view transition sits entirely in CSS, so that
  guarantee is untouched and unsupporting browsers navigate as before. Motion
  here is user-triggered, which is the only kind the frontend-design guidance
  permits — no fade-up entrances, no hover transitions on every card.
- **2026-09-08** — Audit found three real defects, all invisible on the dark
  default: the new `--model` / `--cs2` / `--lol` tokens had no light-theme
  values, so light mode would have rendered pastels on white; four chip
  borders were hardcoded hex that duplicated those tokens and could not
  follow the theme at all (now `color-mix` off the token); and every take
  button was a bare "O" or "U" with only a `title`, which screen readers do
  not reliably announce. All 29 column headers gained `scope`.
- **2026-09-08** — Rebuilt the board around the comparison it exists to make.
  Their line and our number are a matched pair of chips now, gold against
  teal, sat next to each other; before, the average lived in a grey column
  band, right-aligned to the far edge of it, as far from the market it
  described as the cell allowed. Dropped the Score column — with the engine
  ranking on probability, score was `(p − 0.5) × 2` and said nothing Win %
  did not. Added EV, blank wherever the book publishes no per-side price,
  because a zero there would claim we had priced it and found nothing.
- **2026-09-08** — One app at a time, PrizePicks by default. Two lines and
  four O/U buttons per row implied a choice that never existed: on a market
  where the apps differ, exactly one side of one app is the best available
  price, and the engine already knows which. The other app's number survives
  as the gap. `book=both` still compares them directly. With one app on
  screen the line is printed once rather than in both the call and the take
  cell, which was most of what made a row hard to read.
- **2026-09-08** — Lifted the ground off near-black to a warm slate and moved
  every signal to a pastel. Nothing was actually lit before, so surfaces read
  as outlines and the page looked flat; and thirty saturated calls on one
  board is thirty things shouting. League got its tint back — `fc8325c` was
  right to cut it while gold was overloaded, but cyan has taken the chrome
  job since, and "which game is this" is the first question on a mixed board.
  Deliberately not the violet the reference designs use: the standing
  constraint rules out violet-to-indigo, and it still holds.
- **2026-09-08** — A real sign-in page, replacing the browser's basic-auth
  dialog for people while keeping the header for `curl` and scripts. Same
  credentials. The session is a signed cookie rather than a table: one user
  and one password would make that a table with one row, a migration and a
  cleanup job, where an HMAC keyed by the password gets revocation-on-change
  for free. Kept as its own module so the auth boundary could be tested
  without standing up a server.
- **2026-09-06** — Constraints above set at project start. Scope narrowed to
  CS2 and LoL only; Apex and Valorant dropped from the default poll.
- **2026-09-06** — Direction chosen: *technical instrument*, over a
  terminal-dense and an editorial-print alternative.
- **2026-09-06** — First screen answers two questions only: *where do the books
  disagree* and *what has moved*. A results/hit-rate panel is deliberately
  deferred until Phase 2 grading exists rather than shipped as an empty
  placeholder.
- **2026-09-06** — Rebuilt the UI as a scoreboard after the frontend-design
  skill flagged the original as hitting two AI-design defaults. Added league
  colour identity, segmented app/league filters, a sticky slip rail with live
  payout preview, and per-prop line history.
- **2026-09-06** — Prop history ships as *line* history only. Player hit rate
  needs match results that aren't collected yet, and the page says so rather
  than showing an estimate.
- **2026-09-06** — Added Board and Slips. Wanted a Discord tracker later, once
  the core works — deferred deliberately, since the thing worth posting is
  graded results, not raw lines.
- **2026-09-07** — CS2 stat history stopped being a blocker: bo3.gg serves
  per-map, per-player kills/deaths/assists/**headshots** free and unauthenticated.
  The prop-history panel can therefore stop saying player hit rate is
  uncollectable — though it should keep saying so until enough history has
  actually accrued, since the honest empty state was never the problem.
  Headshot props specifically move from ungradeable to gradeable.
- **2026-09-07** — Combo props stopped being dead rows. A combo is projected
  from the series its members played *together*, never from summing their
  distributions: means add under any dependence, but variances only add under
  independence, and every combo on the board is several players in one match.
  Measured across each board combo's full joint history, the real per-map
  spread was 1.06x to 1.18x what independence implies — teammates' kills move
  together — which would have inflated every combo's `edgeSd` and floated them
  above the single-player markets they compete with. Combos grade too, now that
  both games have per-map stats: the result is the members' totals summed, with
  the same two refusals applied member by member (an unplayed map voids, a
  missing stat line is ungradeable rather than zero).
- **2026-09-07** — Counted why the board is quiet rather than assuming, and the
  count answered itself: 22 of 465 markets carried a call at 07:45 with 386
  waiting on stat history, and 278 did at 08:40 after a CS2 backfill landed.
  Chose to sort dead rows down and count the reasons in the header rather than
  hide them, with hiding available at two strengths behind the Show filter.
  Hiding by default would have concealed a data-pipeline fact behind a page
  that looked like a judgement — and concealed it through the hour it fixed
  itself.
- **2026-09-07** — Gave the chrome its own colour, because gold was making two
  claims at once. A selected filter and a high-scoring line were the same
  amber, which meant the one hue that is supposed to say *this is worth your
  money* also said *you clicked this*. Navigation, filters and the freshness
  readout moved to a cyan drawn from the LoL identity, and cyan is now barred
  from appearing on a row exactly as gold, green and red are barred from the
  chrome. The wordmark takes the same cyan on its second half — the one place
  colour is allowed to be decoration, since a name means itself. (Note the
  drift this resolves: the section above still says league carries colour, but
  the palette was cut to three meanings before this and league identity is a
  neutral chip. It is a chip because the label already says which game it is.)
- **2026-09-07** — Replaced the green status dot with a depleting gauge. A dot
  is binary and spends its whole life saying "fine" right up to the moment it
  says "not fine", which is the least useful shape a staleness indicator can
  take — the interesting part is the approach, not the arrival. The gauge fills
  over two poll intervals with a notch at one, so a board halfway to overdue
  looks halfway to overdue, and the age is written beside it because a bar
  alone is a feeling and this page deals in numbers. Once it pins, colour and
  the word "overdue" take over and on a narrow header the bar stands down,
  having nothing left to say.
- **2026-09-07** — Everything except the board was unusable on a phone, and in
  the worst way: the tables didn't overflow, they were *clipped* by the card
  around them, so the Underdog column, the match and the leg status were not
  merely awkward but unreachable. Silent truncation is worse than a scrollbar,
  and a card is better than either, so the board's card treatment became a
  general one and each table now places its own cells — the disagreement table
  leads with the gap and the side it favours, the movement table with where a
  line came from and where it got to. Tap targets went to 44px throughout;
  where a player name genuinely is a small piece of text, the hit area is grown
  with a pseudo-element so the target gets bigger without the card getting
  taller.
- **2026-09-07** — The slip became a bottom sheet wherever the rail can't sit
  beside the board. Stacked under twenty market cards it existed but could not
  be seen while building, which is the only time it matters. It is a label
  driving a checkbox rather than a script, because everything inside it is a
  write and writes here are plain forms that survive having scripts blocked — a
  drawer needing JavaScript to open would have hidden the one set of controls
  that must never need it.
- **2026-09-07** — Search filters as you type. This is deliberately a narrowing
  of what the server already sent rather than a fetch: the form still submits on
  Enter, so with scripts off the box behaves exactly as it did, and no write
  path learned a new trick. Rows carry their own search text from the server,
  since a continuation row omits the match title on purpose and reading it back
  out of the DOM would have made those rows unfindable. While a term is live the
  continuation rows stop being quiet, because the row they were borrowing their
  identity from may no longer be on screen.
- **2026-09-07** — Took some of the flatness out without reaching for shadows.
  Structure still comes from rules and spacing, but card headers now sit on
  their own tone, raised surfaces carry a one-pixel highlight along their top
  edge, and the header wears a band of the chrome colour. That is lighting, not
  a drop shadow: it says where the light is and nothing else. The remaining
  middle-dot meta strings went at the same time — they were the documented tell
  the last rebuild was supposed to have removed.
- **2026-09-06** — Stack: server-rendered HTML from the existing Node app with
  hand-written CSS. No framework and no component library, so nothing arrives
  with a default look that has to be fought. It's read-only tables over
  Postgres; a SPA would be machinery without a payoff.
- **2026-09-07** — Measured whether kills-per-round and round count move
  together before letting the CS2 kills projection resample them
  independently, the same question combos already forced once: means add
  under any dependence, but a resampled spread does not, and a player who
  wins 13-4 has a high rate over few rounds. Over the 47,594 completed maps
  with `rounds >= 13` (MR12's floor; 91 rows below it are forfeits and
  abandonments, 90.8% KAST-consistent against 99.79% for the rest, and were
  dropped), Pearson r between kills/round and rounds is **-0.0298** — with
  all rows included, including those 91, it moves to -0.0595. Both are
  negligible. Mean KPR by bucket does not drift monotonically: 0.740 at
  13-15 rounds (n=2,755), 0.690 at 16-19 (n=13,165), 0.676 at 20-24
  (n=25,836), 0.684 at 25+ (n=5,838, genuine deep overtime, kept rather
  than clamped) — no thin bucket anywhere. The shortest bucket does sit
  about 9% above the middle two, which is not nothing and is worth saying
  rather than calling the line flat: a one-sided map concentrates the
  fragging. But it does not continue — the longest bucket ticks back up,
  and that is exactly why the correlation lands near zero and why scaling
  the rate by round length would be fitting noise rather than a trend.
  Unlike combos, this is a null result:
  rate and round count may be drawn independently in the resample. Written
  down so the next person doesn't re-measure it. See
  `src/results/measure_rounds.ts`.
- **2026-09-07** — Held the rate projection out against data it never saw, and
  it did not win. Time-based split of CS2 `map_stat_dedup`: everything before
  2026-06-01 is training (4,788 series, 35,610 maps), everything from
  2026-06-01 onward is test (1,134 series). Never random — rosters churn, and
  a random split would let a player's own future maps leak into their own
  training data. Of 5,279 held-out player-series groups, 66 played an
  incomplete map range and were dropped, and 296 had too little training
  history for one method or the other (`MIN_MAPS` / `MIN_KPR_MAPS`, both 12);
  the remaining 4,917 were scored against both methods, built from training
  rows only — the round pool included, which is the leak that's easy to miss
  and was checked for specifically. Per-map (`resampleTotals`) scored MAE
  6.8778, median AE 5.6420. The rate path (`resampleFromRates`) scored MAE
  6.8831, median AE 5.6145. Paired, the rate method beat per-map on 2,435 of
  4,917 series (49.5%) and lost on 2,482 (50.5%); the mean of its per-series
  error difference against per-map was 0.0053 kills with a standard error of
  0.0135 (t = 0.39) — indistinguishable from zero. This is not "barely lost,"
  it is a coin flip: the two methods are statistically the same predictor on
  data neither saw, which means Task 6's near-zero correlation was measured
  correctly but doesn't cash out as a sharper projection once round length is
  drawn from the pool instead of the player's own mix. Task 6's argument
  survives; the accuracy claim built on it does not. See
  `src/results/validate_kpr.ts`.
- **2026-09-07** — Found out *why* the rate projection couldn't win, and took
  it back out. The dead heat above looked like it might be a mixing effect:
  rounds-normalisation only corrects a player whose past maps ran unusually
  short or long, so if most players are typical the correction does nothing
  for them and could drown a real effect on the few it was built for. That is
  a prediction the theory makes, so it was tested — bands fixed before
  looking, same split, same leakage guards, nothing changed but the grouping.
  **There is no such population.** Of the 250 players who clear
  `MIN_KPR_MAPS`, the median carries 197 maps of history, and their mean round
  length sits between −0.52 and +0.19 pool standard deviations of the pool
  mean, with exactly one player past ±0.5. At two hundred maps the law of
  large numbers has already pulled a player's round-length mix back to
  average, so there is no bias left for the correction to remove — and the
  small-sample players where it genuinely would bite are precisely the ones
  the twelve-map threshold excludes from the rate path. The method can only
  fire where it cannot help.
  So the projection change came out, along with the resampler it needed: it
  moved 41 of 261 live calls (12 gained, 17 lost, 12 flipped side) and bought
  nothing measurable. The rule was written before the work started — a change
  that decides money ships only if it wins on held-out data — and it is worth
  more than any of the reasoning it overrode. **What stayed:** the `rounds`
  column, its capture (free — it rides along in a response the collector
  already holds), the backfill of 13,564 games, the `map_stat_dedup` fix, and
  both measurements. The data is a real asset and Phase 4 may yet use round
  count as a model feature; what failed was one specific way of using it, and
  it failed for a reason now written down so nobody rebuilds it from the same
  argument.
- **2026-09-08** — Asked the two questions the board had been quietly assuming
  the answers to, and both came back no.

  **Does the stale side win?** The board leads with "one book moved, the other
  hasn't", added on the strength of a real measurement: when the lagging book
  responds, it agrees with the mover about 6.5 to 1. Nobody had checked
  whether *taking* the stale number wins, because that needs settled outcomes.
  It came out **41-41, exactly 50.0%**. Taking the same direction at the
  mover's own new number was worse, 41.7%. So the signal predicts what the
  other book will print, not what the player will do — two different claims,
  and only the first survived. The cell stays, because a standing 1.0-unit gap
  is worth knowing when choosing *where* to place a bet you were making
  anyway, but the doc comment no longer calls it "the better evidence" and the
  tooltip quotes the record instead of hinting at value. `npm run
  validate:stale`.

  **Does the board's own Take win?** The walk-forward replay was sitting in
  gitignored scratch, which is the wrong home for the most important
  measurement in the project, so it is now `npm run validate:calls`. Promoting
  it exposed that it had been feeding the model 20 series and 60 maps against
  production's 30 and 90, and that it had no baseline to beat. Fixed both. The
  answer: model **52.0%**, always-take-the-under **58.1%**, always-over 41.9%;
  claimed 60.3% against 52.0% realised; **AUC 0.495**.

  AUC is the number that matters and it is the one that kills the flattering
  reading. Being eight points overconfident is a calibration problem and
  shrinking every probability toward 0.5 fixes it. AUC 0.495 says there is no
  ordering to calibrate — a call the model rates 75% wins no more often than
  one it rates 56%.

  **And then the correction to my own correction.** The 58% under baseline
  looked like a real DFS shading edge at z = 5.11. It is not, or at least
  nothing here can show it is: those 520 legs come from **17 series across 3
  days**. Every player in a series shares its length, its overtime and its
  pace, so one long map sends every leg over at once. Asked once per series
  the lean is 12 of 16, two-sided p = 0.077, and the model's own calls led in
  8 of 17, p = 1.000. The map-3 slice that looked strongest — 73% over, +3.13
  against the line — is **three series**, and its mechanism is visible in the
  data: map 3 only happens at 1-1 and those maps ran a median 28 rounds
  against 19, so everyone inflates together.

  This is the third time this project has been fooled by treating correlated
  legs as a sample, after 271 markets from ~10 matches and the same-match leg
  correlation that made the optimizer direction-constrained. So leg-level
  z-scores were removed from the script's output **entirely** rather than
  annotated — a number that is wrong in a predictable direction should not be
  printed next to a caveat, it should not be printed. What replaces them is
  the series count and an exact sign test.

  A structural constraint fell out of this and is worth stating plainly: book
  lines exist in the database only from the day the logger started, and there
  is no historical line data to buy or scrape. **Any line-shade finding can
  only ever be confirmed forward, never backtested.** Logging time is the only
  thing that moves it.

  **What shipped as a result.** Not a model change — there is nothing here
  that earned one. Instead the scorecard became a tracked series: `model_score`
  takes one row a day from `SCORE_CRON`, and the Stats page leads with AUC and
  both no-model baselines, with a note in plain words that leg counts are not
  sample sizes. The user asked for something showing the model learning, to
  show off. The honest version of that is a scoreboard that would make it
  obvious if it never does, and the same page is what proves it when it
  finally moves.
- **2026-09-08 (later)** — Anchored the projection to the book's line, because
  we measured that the line is the better estimate.

  Earlier the same day, scoring every settled market showed our central
  estimate losing to the number we were betting against: MAE 5.25 against the
  line's 5.01 over 823 CS2 markets, with our average running **+1.16 high**
  against the line's +0.43. The board was printing that difference as "+3.6 in
  your favour" — advertising our own over-projection as edge.

  The standard response to "a better estimate exists" is to shrink toward it,
  which is what `evaluate()` already did with probabilities. But it anchored to
  a devigged market probability, and that is available on about 5% of the
  board: PrizePicks publishes no per-side price at all (0 of 365 markets) and
  91.5% of Underdog's are flat −112/−112, which devigs to exactly 0.500. The
  **line**, by contrast, exists on every market. So the anchor moved from a
  probability that is almost never there to a number that always is.

  `rateAt` now reads the player's distribution against `line + (1 - w)(mean -
  line)`, with `w = n / (n + PRIOR)`. It is a translation, so the *shape* stays
  entirely the player's; only where it sits moves. At zero history the sample
  lands centred on the line and reads 50/50, which is the correct answer to
  "we know nothing" and precisely what the old code got wrong — it reported the
  gap between an unanchored six-game average and the line as an edge.

  **`LINE_PRIOR` was not tuned.** It is set equal to `PRIOR`, on principle.
  Every settled market comes from three days, so any value fitted here would be
  fitted to its own noise; that mistake has been made three times in this
  project already and each time the fitted parameter turned out to be
  scale-dependent.

  Measured, CS2, walked forward:

  | | before | after |
  |---|---|---|
  | calls made | 491 | 462 |
  | realised | 50.5% | **52.4%** |
  | claimed − realised | 8.3 pts | **6.5 pts** |
  | our MAE | 5.25 | **5.13** |
  | our bias | +1.16 | **+0.95** |
  | AUC | 0.538 | 0.526 |

  Better calibrated, better located, fewer and better-evidenced calls. **It
  does not create skill** — AUC moved from 0.538 to 0.526 and both are inside
  noise on 28 series. Nothing on this data could create skill. What it fixes is
  a measured defect in the number the board shows, and the line is still the
  closer estimate even after anchoring (5.13 against 5.01), which the Stats
  page now says out loud.

  LoL moved the other way (raw 4.79 → anchored 5.01) because there the raw
  average happened to beat the line. That is 3 series and reads as noise; the
  parameter is not being split per league on the strength of it.

  **A test caught a real bug in the first cut.** Shifting the comparison point
  also shifted the push test, so a total landing exactly on the book's line was
  being scored as a win or a loss instead of a refund. Pushes are defined by
  the book's number, not ours. `projection.test.ts` failed on exactly that,
  which is the second time that suite has caught a push regression.

  The board shows the anchored figure now, with the raw average beside it —
  "Ours 17.5, 8 series, avg 12.5" — because showing 12.5 next to a lean
  computed from 17.5 would print a gap the model never acted on.
