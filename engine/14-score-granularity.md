# 14 — Score Granularity: What "a Score" Means Per Sport

Chess needs one tap (win/draw/loss). Football has goals — maybe with scorers. Cricket can
go all the way to runs/wickets per player. These are not different features; they are
**tiers of the same event ledger**. This doc makes the ladder explicit and answers the
product question: *is per-player scoring needed?*

## 1. The four-tier ladder

Every fixture's events sit at exactly one (highest-used) tier. Higher tiers always fold
down to lower ones — standings never care which tier produced the outcome.

| Tier | Name | What's recorded | Unlocks | Plan |
|------|------|-----------------|---------|------|
| **0** | Result | winner / loser / draw (+ method) | standings, progression, brackets | all |
| **1** | Score breakdown | team-level numbers: goals 3–1, sets 25-20 23-25…, innings 165/7 | correct metrics (GD, NRR, set ratio), score on public dashboard | all |
| **2** | Attributed events | *who*: goal scorers + minutes, wicket taker + batter out, rally not needed | player stats, timelines, top-scorer tables, player cards | Pro (`scoring.*` keys, doc 10) |
| **3** | Full play-by-play | every ball / rally / kick in sequence | live ball-by-ball UI, DLS par curve, derived analytics (strike rates, partnerships) | Pro |

Chess **tops out at Tier 0** (result *is* the score — method checkmate/resign/time is
free metadata, not a tier). Set-based sports: Tier 1 = set summaries, Tier 3 = rallies —
**no Tier 2** (a rally has no meaningful attribution in our model; skip). Football:
Tier 1 = final score, Tier 2 = goals with scorer/minute + cards, Tier 3 ≈ Tier 2 (no
finer unit worth capturing). Cricket: Tier 1 = innings summaries, Tier 3 = ball-by-ball;
**Tier 2 = a deliberate middle: per-player batting/bowling lines entered as a scorecard
summary** (`cricket.player.line {person, runs, balls, wickets, overs}`) — clubs that keep
paper scorebooks can type in the card after the match without live ball-by-ball. Add this
event type to the cricket module (extends spec 04 §2.2's two fidelities to three).

## 2. Per-sport answer to "what kinds of score exist"

| Sport | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|-------|--------|--------|--------|--------|
| Chess/boardgame | result ✅ (the whole game) | — | — | (PGN attachment, cosmetic) |
| Carrom | match result | board summaries (points, queen) | — | strike-by-strike (reserved) |
| Football | result | final score | goals w/ scorer+minute, cards, subs | = Tier 2 |
| Volleyball/Badminton/TT | result | set/game summaries | — | rally-by-rally |
| Cricket | result | innings summaries | **player lines (post-match scorecard)** | ball-by-ball |
| Basketball | result | quarter/final score | scorer attribution (points per player) | shot-by-shot (out of scope) |
| Generic (v1) | result | p1/p2 score | — | — |

Rule for module authors: **declare tiers in the module** —
`SportModule.fidelityTiers: {tier: 0|1|2|3, eventTypes: string[], entitlement?: FeatureKey}[]`
— so the scoring UI, entitlement gate (PROMPT-13 maps tier → feature key), and API docs
derive from one source. Add this field to the contract (PROMPT-03).

## 3. Is per-player scoring needed for our use case? — Verdict

**Yes, but strictly as an optional Pro tier — never required, never blocking.**

- **Not needed for the core loop.** Standings, brackets, NRR, public dashboard results —
  all complete at Tier 0/1. A Community organiser running a school carnival taps winners
  and final scores; done. The engine must never demand attribution.
- **Needed for retention/monetisation.** Player cards with "12 goals this season",
  top-wicket-taker tables, MVP boards — this is what makes players (not just organisers)
  visit the dashboard, and it's already the doc 10 `stats.player` differentiator. Cricket
  clubs in particular *expect* batting/bowling averages; the Tier 2 scorecard entry gives
  them that without the cost of live ball-by-ball.
- **Cost control:** derived stats (averages, strike rates, top scorers) are **computed
  read models, never stored facts** — always re-derivable from the ledger by refold.
  Storage cost of Tier 2 is trivial; Tier 3 cricket ≈ 250 events/match — fine.

UX rule: tiers are **progressive in the scoring pad** — start at Tier 0 buttons; "add
detail" expands to breakdown; Pro orgs see the attributed/live pads. Mixed tiers across
fixtures in one division are normal (rain-rushed match entered coarse; final scored live).
A fixture can be **upgraded post-hoc** (enter player lines after tapping the winner) —
events append fine; the fold reconciles, and validation only cross-checks consistency
(player lines must sum to the innings totals — reject mismatched cards with a clear diff).

## 4. Implementation deltas (fold into existing prompts)

- PROMPT-03: add `fidelityTiers` to the `SportModule` contract + conformance check
  (tier events fold down consistently: fold(tier-n events).summary == declared totals).
- PROMPT-05: add `cricket.player.line` Tier-2 event + sum-consistency validation.
- PROMPT-13: gate mapping derives from `fidelityTiers` declarations, not a hand-kept table.
- PROMPT-15: scoring pads render tier-progressive per module declaration.
