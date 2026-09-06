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
- **Combo props are marked.** A row like `Dhokla + Inspired + Saint` looks
  exactly like a single-player line and is not one — it can't be graded per
  player and must never be cross-book matched against one.
- **Legs read PENDING and stay there** until grading exists. Better an honest
  empty column than a fabricated result.

## Open decisions

- Whether grading results live in the same view as live lines, or separately.
- Auth, if this is ever shared beyond one user.

## Log

- **2026-09-06** — Constraints above set at project start. Scope narrowed to
  CS2 and LoL only; Apex and Valorant dropped from the default poll.
- **2026-09-06** — Direction chosen: *technical instrument*, over a
  terminal-dense and an editorial-print alternative.
- **2026-09-06** — First screen answers two questions only: *where do the books
  disagree* and *what has moved*. A results/hit-rate panel is deliberately
  deferred until Phase 2 grading exists rather than shipped as an empty
  placeholder.
- **2026-09-06** — Added Board and Slips. Wanted a Discord tracker later, once
  the core works — deferred deliberately, since the thing worth posting is
  graded results, not raw lines.
- **2026-09-06** — Stack: server-rendered HTML from the existing Node app with
  hand-written CSS. No framework and no component library, so nothing arrives
  with a default look that has to be fought. It's read-only tables over
  Postgres; a SPA would be machinery without a payoff.
