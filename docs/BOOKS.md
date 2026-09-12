# Books: where else esports player-prop prices live

Researched 2026-09-10/11. Every live measurement below was taken between
**03:55 and 04:10 UTC on 2026-09-11**. That is not a dead hour: Kalshi had 62
open CS2 series and 26 LoL series, Polymarket had 478 open CS2 match events, and
PrizePicks and Underdog each had 190-220 CS2 map 1-2 markets up.

Evidence is tagged **MEASURED** (I hit it and saw the data), **DOCUMENTED** (the
vendor says so), or **REPORTED** (a third party says so). Probe scripts are in
`raw/books4-*.mjs` and payloads in `raw/books4/`.

## Verdict

**There is a third book for CS2, it is Sleeper, and it was wrongly ruled out.**

- **Sleeper Picks lists CS2 player kills and headshots**, maps 1-2, with
  two-sided payout multipliers. Its pick'em endpoint needs no auth and returns
  JSON: `GET https://api.sleeper.app/lines/available`.
- **Coverage (MEASURED, 04:06 UTC):**
  - Sleeper: 204 CS2 player-stat markets, 112 players, 14 matches.
  - Underdog: 223 markets. PrizePicks: 187.
  - 150 markets are priced by all three books at the same moment.
  - Only 13 of the players on Underdog or PrizePicks are missing from Sleeper.
- **Why it was ruled out:** the 2026-09-10 check asked Sleeper's `sport_info`
  for `cs2`, `csgo`, `lol`, `val` and `dota`. Sleeper's code for Counter-Strike
  is **`cs`**. `sport_info(sport:"cs")` returns a live 2026 season;
  `sport_info(sport:"cs2")` returns null. The `app_info` sport list omits it
  too. Both are mismatches in the check itself; neither shows missing coverage.
- **Sleeper is a third line, but probably not an independent opinion.** Its
  prices track Underdog's closely:
  - Where the two books post the same line (152 markets), their devigged
    probabilities differ by 1.0 point on average.
  - Where the lines differ (33 markets), Sleeper's price leans toward Underdog's
    number 29 times.
  - The two look anchored to the same fair value, whether from a shared
    supplier or copying. So a three-book "crowd" here is closer to two votes
    than three. That limits what `consensusLine` can mean.
  - What Sleeper does add: it states a price on every market, and it leans off
    even money on 46 markets where Underdog sits at a flat -112/-112.
- **LoL still has no third book.** Sleeper has no LoL lines, and its
  `/players/lol` directory is `{}`. Nothing else reachable prices a LoL player.
- **No sportsbook, exchange or prediction market reachable from a server prices
  an esports player.**
  - Cloudbet, Kalshi, Polymarket, Novig, ProphetX, Bovada and Pinnacle price the
    match only.
  - The books that do price CS2 player kills sit behind walls or region blocks:
    Thunderpick and bet365 are REPORTED to; Pick6 and Betr carry CS2 props.
  - The only other sources are B2B odds makers (PandaScore, Rimble,
    Abios/Kambi, OpticOdds via Rimble), sold through sales conversations.

## Every source checked

| Source | Esports player props? | Reachable how | Auth | Cost | Coverage measured | Verdict |
|---|---|---|---|---|---|---|
| **Sleeper Picks** | **YES — CS2** kills + headshots, maps 1-2 (M1-3 also in its rules). No LoL | `GET api.sleeper.app/lines/available` + `GET api.sleeper.app/players/cs` | **None** | Free. Docs: "free to use for non-commercial purposes", stay under 1000 calls/min | **223 CS2 lines, 112 players, 14 matches** (04:04Z); 150 markets shared with both PP and UD | **BUILD. Overturns the old ruling.** |
| PrizePicks | yes (existing) | `partner-api.prizepicks.com/projections?league_id=265` | none | free | 213 CS2 projections, 187 standard M1-2 K/HS | control |
| Underdog | yes (existing) | `api.underdogfantasy.com/v1/over_under_lines` | none | free | 223 CS2 M1-2 K/HS lines | control |
| DraftKings Pick6 | CS2 kills: REPORTED (12-20 players on a major day vs 25-40 on UD, gameofskill.gg Mar 2026). LoL: rules page exists (DOCUMENTED) | none. Headless browser gets **Akamai "Access Denied"** (MEASURED 03:58Z); plain GET of `/` returns HTML | wall | — | none | Walled. Out |
| Betr Picks | CS2: REPORTED (gameofskill.gg) | `api.fantasy.betr.app/graphql` | **401 Unauthorized** (MEASURED). The public Apify scraper needs "curl_cffi Chrome TLS impersonation + US residential proxy" | — | none | Auth plus anti-bot. Out |
| ParlayPlay | unverified | Cloudflare (runbook) | wall | — | — | Out |
| HotStreak | unverified | Cloudflare (runbook) | wall | — | — | Out |
| Chalkboard | CS2: REPORTED | mobile only (runbook) | — | — | — | Out unless the phone is proxied |
| Boom, Vivid, Jock MKT, Fliff | no evidence | mobile only / no DNS (runbook) | — | — | — | Out |
| Rebet | "added esports": REPORTED; social sweepstakes | `api.rebet.app` 403 (runbook) | — | — | — | Out |
| OwnersBox, Epick | no evidence of esports found | not probed | — | — | — | No lead |
| Dabble | too thin | open JSON (runbook) | none | free | 3 CS2 fixtures, 0 LoL (runbook, 2026-09-10) | Out |
| **Kalshi** | **No.** Only player-named series is HLTV Player of the Year. Proposed CFTC rules may bar "discrete-action contracts involving specific participants" (REPORTED, esports.net 2026-06-12) | `api.elections.kalshi.com/trade-api/v2` | **none for reads** | free | 110 esports series. Open: KXCS2GAME 62, KXCS2MAP 122, **KXCS2TOTALMAPS 62**, KXLOLGAME 26, KXLOLMAP 71. Books often empty (sample: yes 0.01/0.99, volume 0) | No player props. Useful for match context |
| **Polymarket** | **No.** Kill markets are team-level: LoL "Total Kills O/U in Game N", "Any Player Penta Kill?", kill handicaps; CS2 odd/even kills | `gamma-api.polymarket.com/events?tag_slug=counter-strike-2` | **none** | free | CS2: 505 events, **478 matches**, 4,327 markets. LoL: 124 events, 77 matches, 3,258 markets. **0 named-player stat markets** | No player props. Useful for match context; tier-C liquidity is tiny ($6-98) |
| Novig | No | `api.novig.us` open to the web client | none for market reads | free | eSports tab lists LoL/CS2/Dota with **eventCount 0**; markets are ML/spread/total | Out |
| ProphetX | No | `prophetx.co/trade/public/api/v1/*` | none | free | `/sports` and the tournaments list contain **no esports** (MEASURED). REPORTED to list CS2/LoL | Out |
| Sporttrade | no evidence | — | — | — | — | Out |
| **Cloudbet** | **No.** CS2 event markets: `winner`, `map_winner`, `map_handicap`, `map_round_handicap`, `total_maps`, `correct_score_in_maps` | Web client's own `cloudbet.com/sports-api/c/v6/sports/events/{id}`, unauthenticated. Documented feed `sports-api.cloudbet.com/pub/v2` is 401 without a key | none (web) / account key (feed) | free | 17 CS2 events in a 31h window (PGL Bucharest, CCT, TP World Champ) | Match only. Not licensed for US customers |
| Thunderpick | player O/U kills: REPORTED (esportbet.com) | 403 HTML wall (runbook) | wall | — | — | Out |
| Rivalry | unverified | `/api/v1/matches` | none | — | **`data: []` again** (MEASURED 04:01Z) | Out |
| Midnite | unverified | challenge page (MEASURED 04:01Z) | wall | — | — | Out |
| GG.bet | unverified | region-blocks US (runbook) | — | — | — | Out |
| 1xBet | REPORTED | `LineFeed` → **302 to `/block`** (MEASURED) | region block | — | — | Out |
| bet365 | REPORTED CS2 coverage | no public API. BetsAPI resells it: token, from ~$10/mo, $2 one-day trial (REPORTED); its docs show no esports player markets | paid token | ~$10+/mo | not measured | Grey provenance (resold scrape). Not recommended |
| Betway, Stake, Roobet, BC.Game, Esportsbet | unverified | Stake Cloudflare (runbook); others not probed further | — | — | — | No lead |
| Bovada | No | open (runbook) | none | free | 77 events, match markets only | Match context only |
| Pinnacle | No | matchups open, prices 401 (runbook). Guest key deliberately **not** used | — | — | — | Match context only. Its moneylines reach us via OddsPapi |
| OddsPapi | **No** (`playerProp` false on all 28 CS2 / 28 LoL markets, runbook) | key | key | free 250 req/mo | — | Match context only. **Live since 2026-09-11** as the source of Pinnacle's CS2 moneylines (one daily pull, ~4 requests) |
| The Odds API | No esports | — | — | — | — | Out |
| odds-api.io | no esports evidence; "new free keys paused" (REPORTED) | key | key | — | — | Out |
| SportsGameOdds | Marketing says "hundreds of esports player… markets" (DOCUMENTED), but its **league list has no esports leagueIDs** (DOCUMENTED docs page) | key | key | Free (10 req/min), $99, $299, custom | not measured | Contradictory. A free key would settle it; low odds |
| OpticOdds | Esports player kills/assists/HS via **Rimble** (DOCUMENTED, blog) | key | key | sales / trial, undisclosed | — | B2B. The props are Rimble's own prices |
| Rimble | **Yes**, B2B odds originator: "Player Props: Deep stat markets"; sells to sportsbooks **and DFS platforms** (DOCUMENTED, llms.txt) | key | key | undisclosed | — | Best-fit paid option |
| PandaScore | **Yes**: CS:GO player markets "top-5 market ranking" (DOCUMENTED). Produces its own odds | key | key | Odds: sales. Stats: €400/mo/game, **non-betting use only** (runbook) | — | Paid option |
| Abios (Kambi) | **Yes**: "Esports Player Props", e.g. "Most kills" (DOCUMENTED); 40+ operators | sales via kambi.com | key | $2,000-10,000/mo (runbook) | — | Too expensive |
| GRID, Bayes Esports | Data, not prices. Bayes is PrizePicks' official data partner (2024 press) | — | — | per-tournament rights (runbook) | — | Not a price source |
| SportsDataIO | LoL / "CS:GO" data, odds, projections (DOCUMENTED) | key | key | sales | — | Unverified for player-prop prices; low odds |
| Unabated | no esports evidence | — | — | — | — | Out |
| OddsJam | page claims CS2 "player props" (REPORTED); 403 to fetch | consumer tool; API is B2B | — | — | — | Consumer app, not a feed |
| PickFinder | aggregates PP/UD/Sleeper/DK/FD "& 20+ books" | consumer app | login | $19.99/mo | — | Not an API. Its book list matches what is found here |
| props.com, propsbot.ai, cs2bet.io, egamersworld | content sites; no named multi-book prop lines found | — | — | — | — | Out |
| Apify actors | third-party scrapers for PP, UD, Betr (the Betr one needs residential proxies) | paid runs | — | per-run | — | Not needed for PP/UD. Betr's is anti-bot evasion |

## Sleeper, in detail

### The endpoints

```
GET https://api.sleeper.app/lines/available          # whole pick'em board, ~5.8 MB (~360 KB gzipped)
GET https://api.sleeper.app/players/cs                # CS player directory, ~2.2 MB, keyed by player_id
POST https://sleeper.app/graphql  {"query":"query sport_info { sport_info(sport: \"cs\") }"}   # confirms the sport code
```

No token, cookie or special header is needed; a normal browser User-Agent
works. The same host serves Sleeper's documented public API, which says: *"No
API Token is necessary… free to use for non-commercial purposes… stay under
1000 API calls per minute, otherwise, you risk being IP-blocked."* The `lines`
path is **not** in those docs. It is the app's own undocumented endpoint on the
documented host.

Sleeper's Terms of Use (updated 2026-08-27) have no general scraping clause.
The closest (5.20) bars *"unauthorized scripts or other automated means"* used
to *accumulate points or prizes*. Reading the board does neither. Polling a
single 360 KB gzipped document every 15 minutes is about 96 calls a day.

### What a line looks like

One row per player-market, with both sides priced (trimmed):

```json
{
  "sport": "cs", "subject_type": "player", "subject_id": "1083",
  "game_id": "match-2827992", "wager_type": "kills_maps_1_2",
  "game_status": "pre_game", "line_type": "normal", "updated_at": 1789097310827,
  "options": [
    {"outcome": "over",  "outcome_value": 29.5, "payout_multiplier": "1.78", "subject_team": "Alliance", "line_id": "1403979516195414022"},
    {"outcome": "under", "outcome_value": 29.5, "payout_multiplier": "1.78", "subject_team": "Alliance", "line_id": "1403979516195414023"}
  ],
  "recent_performance": {"values": [{"date": "2026-09-08", "opponent": "FaZe Clan", "value": 29.0}, "…9 more"]},
  "pick_stats": {"counts": {"over": 3, "total": 7, "under": 4}, "popularity": 0.617}
}
```

`subject_id` 1083 is `avid` (Alliance) in `/players/cs`. All 112 CS subject ids
resolved against the directory (MEASURED). `username` is the handle.

### Coverage, 2026-09-11 04:04-04:06 UTC

- **223 CS2 lines**: `kills_maps_1_2` 118, `headshots_maps_1_2` 105. All
  `pre_game`, all `line_type: normal`, all two-sided.
- **14 matches**, e.g. Alliance v MiBR, G2 v FURIA, NiP v 1WIN, B8 v Inner
  Circle, 3DMAX v 100 Thieves, Virtus.pro v K27.
- Pricing:
  - **110 of 223** lines sit at 1.78/1.78, which is even money.
  - The rest lean, e.g. 1.91/1.67 or 1.55/2.08.
  - The overround is 12.0-13.6% (median 12.4%).
  - Mean devigged P(over) is 0.503. 37 lines lean under and 50 lean over.

Against the other two books, same minute, keyed on handle + stat:

| | markets | players |
|---|---|---|
| Sleeper | 204 | 112 |
| Underdog | 223 | 114 |
| PrizePicks (standard only) | 187 | 96 |
| Sleeper ∩ Underdog | 185 | |
| Sleeper ∩ PrizePicks | 163 | |
| **All three** | **150** | |
| Players on UD or PP but not Sleeper | | 13 |

Line agreement:

| Pair | Markets shared | Same line | Differ by ≥1 unit |
|---|---|---|---|
| Sleeper vs Underdog | 185 | 152 | 33 |
| Sleeper vs PrizePicks | 163 | 104 | 33 |

### How independent is it?

Not very, and this matters more than the coverage number.

- **Same line (152 markets):** Sleeper's and Underdog's devigged probabilities
  differ by 1.0 point on average. Where both books lean off even money (8
  markets), they lean the same way 7 times.
- **Different line (33 markets):** Sleeper's price leans toward Underdog's
  number 29 times. Example: MahaR kills, Sleeper 30.5 at 1.38/2.43 against
  Underdog 32.5 at -125/+103. Sleeper moves its line and then prices the over
  heavily, which lands on nearly the same fair value.

So Sleeper's (line, price) pairs sit close to Underdog's fair line. That fits a
shared odds supplier or one book following the other. It does not fit an
independent opinion. Two implications:

1. **A three-book median is not three votes.** When Sleeper and Underdog agree
   against PrizePicks, that is roughly one opinion against one. The consensus
   module should be judged with that in mind.
2. **It still adds real information at no cost.** Sleeper is a second book that
   states a probability (`src/books.ts` had `sleeper.pricesSides: false`; fixed
   2026-09-11, it is now `true`). It leans off even money on 46 markets where Underdog is flat, so
   `fairLine` gets a price on markets where it has none today.

### What an entry pays (MEASURED 2026-09-12)

`GET https://api.sleeper.app/payouts` — no auth, and it answers with the whole
table:

```json
{"all_in":      {"2":2,"3":5,"4":9,"5":19,"6":34,"7":49,"8":99},
 "all_in_pick_8":{"2":2,"3":5,"4":9,"5":19,"6":29,"7":49,"8":99},
 "classic":     {"5":{"4":1,"5":9}, "6":{"5":1.5,"6":19}, "8":{"7":3,"8":59}},
 "version": 7}
```

`all_in` is the Power equivalent (every pick must win); `classic` is the flex
ladder that still pays something at n-1.

**The per-pick `payout_multiplier` is NOT the entry payout.** This was recorded
the other way round on 2026-09-11 ("an entry pays the product, no base ladder"),
on the strength of one screenshot, and it is wrong. The multiplier is Sleeper's
**marginal on that leg** — the number to devig, and nothing else. The product of
six of them (1.78^6 = 31.8) lands near the 34x ladder because the ladder is set
so a typical pick compounds into it, which is exactly why the mistake survived.

Using the multiplier as both the leg's price and the entry's payout counts the
same number twice and manufactures EV. The ladder lives in `PUBLISHED_LADDER`
(`src/web/optimize.ts`); re-read the endpoint if `version` moves off 7.

### Settlement

Per Sleeper's "Player Picks CS2 Scoring Rules" (updated 2026-08-11, DOCUMENTED):

- *M1-2 Kills*: "Total number of kills combined on Maps 1 and 2."
- *M1-3 Kills* / *M1-3 HS* also exist; none were listed at sampling time.
- "All players who start maps 1 and 2 will be graded regardless of
  substitutions, unless map 1 or 2 is forfeited, then all players will be
  graded as DNP and voided."
- No live scoring. The rules page does not name a stats source.

This is the same map-1-2 definition PP and UD use, so it joins on the existing
`(player, stat, map_start, map_end)` key.

### Adapter notes

- Poll `/lines/available` once per cycle. Keep `sport === 'cs'`, and map
  `wager_type` to `kills`/`headshots` and maps 1-2 (or 1-3).
- Join `subject_id` to `/players/cs` for the handle and team. Cache the
  directory daily; it is 2.2 MB.
- `game_id` is Sleeper's own (`match-NNNNNNN`), so match on team names
  (`subject_team`) and time, as with PP.
- Store the two `payout_multiplier`s as prices. Devig: `p = (1/m_over) / (1/m_over + 1/m_under)`.
- Set `sleeper.pricesSides = true`, add it to `KNOWN_BOOKS`, and correct the
  "no third book" comments in `src/web/consensus.ts`. *(Done 2026-09-11 —
  `src/adapters/sleeper.ts` is live. One stale comment remains:
  `src/results/validate_consensus.ts` still says there will not be a third
  book.)*
- Watch for LoL. If `/players/lol` ever returns a non-empty directory, Sleeper
  has added it.

## Match-level prices, free, as a side finding

These are not player props, but they bear on the untested "does a third map
happen" void question. The runbook planned to spend OddsPapi's 250-request
monthly budget on it.

- **Kalshi**:
  - `GET /trade-api/v2/markets?series_ticker=KXCS2TOTALMAPS&status=open`,
    no auth. It returns `yes_bid_dollars`, `yes_ask_dollars`, sizes and volume.
  - 62 open CS2 total-maps markets at sampling time. Many had no real book:
    one sample showed 0.01/0.99, volume 0.
  - Also KXCS2MAP (map winners), KXLOLTOTALMAPS and KXLOLMAP.
- **Polymarket**:
  - `GET gamma-api.polymarket.com/events?tag_slug=counter-strike-2&closed=false`,
    no auth, paged 100 at a time. It returns `outcomePrices`, `bestBid`/`bestAsk`
    and `liquidity`.
  - CS2 carries "Games Total: O/U 2.5", map winners, "Map N Total Rounds" O/U
    and round handicaps.
  - Tier-C liquidity is tiny: $6-98 on the samples, and matches already in
    progress show 0/1 prices. Tier-1 LoL is deep, e.g. T1 v DRX with $2.6M
    volume.
- **Cloudbet** `total_maps` / `map_handicap` via its web client's `sports-api/c/v6`.

Bovada remains the best-covered free match source (61/61, per the runbook).
Kalshi and Polymarket are free cross-checks with no request budget.

## What is worth building, ranked

1. **Sleeper CS2 adapter.** *Built and live since 2026-09-11
   (`src/adapters/sleeper.ts`): ~222 props a poll, 159 markets priced by all
   three books on the first poll. Only the `validate:consensus` re-run below is
   still to do.*
   - Cost: about a day. One unauthenticated GET plus a cached directory, a
     `wager_type` parser, a `pricesSides` flip, and a line in `KNOWN_BOOKS`.
     No money.
   - Gets a third CS2 line on 150+ markets a day, and a second stated price.
   - Risks:
     - The endpoint is undocumented and could change or be gated.
     - The documented API is "non-commercial"; that fits a personal tool, not a
       product.
     - Its prices are correlated with Underdog's (see above).
   - Re-run `validate:consensus` once a few weeks of three-book data settle. It
     reported "by 3+ books 0" and can finally get a nonzero n.
2. **Kalshi and/or Polymarket match context.**
   - Cost: half a day each, free, and no request budget, unlike OddsPapi.
   - Only for the total-maps and blowout experiments. Many tier-C markets have
     no real book, so treat a 0.01/0.99 quote as "no price", not as a price.
3. **Rimble (or PandaScore) quote. Only if a CS2 or LoL player-prop price from
   outside the DFS apps is ever needed.**
   - Cost: a sales call, and very likely thousands a month. Nothing is
     published.
   - Rimble explicitly sells to DFS platforms and prices kills, assists and
     headshots. PandaScore's stats tier is €400/mo/game and barred from betting
     use; its odds tier is sales-only.
   - This is the only route to a genuinely independent player-prop opinion. It
     is also possible PP/UD/Sleeper already buy from one of these suppliers,
     which would make the "independent" price not independent at all. Ask
     before buying.
4. **A free SportsGameOdds key.**
   - Cost: a signup and a few requests.
   - Settles a contradiction: the marketing claims esports player props, the
     docs list no esports leagues. Expect "no".

Not worth building:

- Pick6, Betr, ParlayPlay, HotStreak, Thunderpick, Midnite: every route in
  needs defeating a wall or auth.
- Novig and ProphetX: no esports events.
- BetsAPI's bet365 resale: grey provenance, and no esports player markets
  shown in its docs.
- Mobile-app proxying of Chalkboard or Pick6: possible, but it means installing
  a CA on a phone, and the apps' coverage is a subset of what Sleeper now gives
  for free.

## What this overturns

- **RUNBOOK "Book reachability, measured" and "The third book does not exist"**:
  the Sleeper row is wrong. The cause was the wrong sport code (`cs2` vs `cs`).
  The `app_info` sport list also omits `cs`, so it was never proof of absence.
- **`src/web/consensus.ts`** says "Sleeper carries no esports at all"; wrong.
- **`src/books.ts`** has `sleeper.pricesSides: false`; Sleeper publishes
  two-sided multipliers.
  *(Both corrected in code 2026-09-11.)*
- Everything else in the runbook's "ruled out" list held up when re-checked:
  - Rivalry still returns empty data.
  - Pick6 is now an Akamai wall rather than 404s.
  - Betr has a real API host, but it returns 401.
  - OddsPapi, Bovada and Pinnacle are match-only, and so is Cloudbet (new).

## 2026-09-12 re-probe: is there a fourth book?

Asked again, because a reference line is worth having even from a book we would
never place a bet at. **Answer: no — not without an account.** Sleeper remains
the only one that was wrongly ruled out.

| App | Result (MEASURED 2026-09-12) |
|---|---|
| **Boom Fantasy** | Endpoints FOUND — `production-api.boomfantasy.com/api/v1/contests/active` and `/api/v1/contests/lobby`. Both return **401 `JWT_MISSING`**. Needs an account. |
| **Betr** | `api.fantasy.betr.app/graphql` answers POST (GET is 405) but returns **401 Unauthorized** on `{__typename}`. Needs an account. |
| **Onyx** | No public feed found. `onyxpicks.com` redirects to `/login`; `onyx.bet` is a 114-byte placeholder; `onyxodds.com` is an odds-screen product and was flaky. |
| **ParlayPlay, HotStreak** | 403 Cloudflare, unchanged. Not probed further by design. |
| **Chalkboard, Vivid Picks** | No public API host resolves. Their sites are marketing pages (Webflow / Tinybird analytics) with no client bundle to read. |
| **Dabble** | **Open, no auth, and it works** — see below. |

### Dabble, in detail

Three unauthenticated GETs, and markets come embedded in the fixtures response
(there is no separate markets endpoint — every `/sport-fixtures/{id}/*` path is
404):

```
GET https://api.dabble.com/competitions/active                  # 29 competitions
GET https://api.dabble.com/competitions/{competitionId}/sport-fixtures
    CS2 = acd5b3f6-dd7a-484f-a4e5-a747badb32c6
    LoL = 086211fd-5445-4955-be1b-9ed7ba84641d
```

Coverage on 2026-09-12, and this is the problem: **1 CS2 fixture** (28 markets)
against 14 matches on each of PrizePicks, Underdog and Sleeper. LoL has 2
fixtures, mostly assists.

Of the 28 CS2 markets, **10 are `pandascore_player_kill_over_under_map_one_and_map_two`**
— which is exactly our `(player, kills, 1, 2)` key, so it would join. The rest
are per-map (`game_N`) kills and headshots. The line is embedded in the market
NAME ("HeavyGod game 1 kills 15.5"), and the market object carries **no price**;
a selections/prices call would have to be found to devig it.

**Verdict: not worth an adapter yet.** Ten joinable markets a day against our
~150-200 is about 6% more coverage, for a book we cannot place a stack at.
Revisit if its esports coverage grows.

### The finding that actually matters

Dabble's markets carry `"resultingType": "pandascore_game_1_player_kill_over_under"`.
**Dabble is settling — and probably pricing — off PandaScore**, one of the two
B2B originators this doc already identified (with Rimble) as selling to
sportsbooks *and DFS platforms*.

That is the missing explanation for a result we already have. The
market-anchored consensus arm was graded and failed flat — 74-73 over 147
series, p = 1.00 ([[bropprop-consensus]]) — and Sleeper's prices were found to
lean toward Underdog's number 29 times in 33. The reason is now visible: these
books are not independent opinions being polled. They are **one supplier's
opinion, resold several times.** A "consensus" across them is one vote wearing
four hats, which is why averaging them predicts nothing.

Two consequences worth carrying:

1. **Stop trying to build an edge out of cross-book agreement.** There is no
   crowd here to be wise. Line *shopping* still works (books disagree on 48.7%
   of shared markets, mean 0.84 units) because that is arithmetic, not opinion —
   but cross-book *disagreement as a signal* has now failed twice for what turns
   out to be a structural reason.
2. **The only genuinely independent player-prop price would have to come from
   outside this supplier set**, which means Rimble or PandaScore directly, at
   B2B prices — and if PP/UD/Sleeper already buy from them, it would not be
   independent of the books either.
