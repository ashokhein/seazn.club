# Fidelity model redesign + the tier-3 extension lane

Date: 2026-08-06. Produced by session **S2 / #430** of the ScoringPad v2
programme (`2026-08-06-scoringpad-v2-prompts/`). Read `_RULES.md` and
`_INDEX.md` first — every ruling cited here is recorded in that decision log.

Two deliverables, deliberately separated:

1. **A redesign of the fidelity model**, which lands **inside S6** because S6
   seals the tier model into `PadSpec`. Not optional, not deferrable — the
   current model is internally inconsistent and S6's own conformance criterion
   would fail on it.
2. **The T lane** — four *shelf-ready* sessions that fill fidelity band 3 for
   the sports that never got one. Specced and parked; nothing runs until a real
   customer ask.

Terminology note: **"ladder" is never used bare in this repo.** It carries five
unrelated meanings, one of them an exact `StageKind` enum value. This document
says "fidelity band" or "fidelity tier".

---

## Part 0 — What S2 found

The ten rows #430 parked as "tier 4, a different product" were parked on a false
premise. The findings, in the order they collapse the question:

- **Fidelity band 3 is a byte-identical duplicate of band 2 in 7 of 8 module
  files.** `football.ts` declares both with the same `eventTypes` and the same
  `scoring.match_timeline`; `setbased/kernel.ts:912`, `nested/kernel.ts:1202`
  and `period/kernel.ts:1310` do the same; `carrom.ts:709`, `generic.ts:362`
  and `boardgame.ts:503` stop at band 1. **Cricket alone**
  (`cricket.ts:2392-2401`) genuinely uses all four bands: band 2
  `cricket.player.line` → `stats.player`, band 3 `cricket.ball` →
  `scoring.ball_by_ball`. So "tier 3 tops out at attributed timeline scoring" is
  true only because band 3 was left as a copy. **Band 3 is not full. It is
  empty.**
- **The "statistician terminal" already shipped — for cricket.** Ball-by-ball is
  ~250 deliveries a match with runs, extras, wicket type and fielder
  attribution, entered by a dedicated scorer sitting through the innings. Same
  operator profile, same volume and the same paid band as an ice-hockey shot
  stream. `apps/web/src/components/v2/pads/cricket-pad.tsx` is 23.8K, the
  largest pad in the repo, on the same hash-chained `score_events` substrate.
- **The model is internally inconsistent, and S6 would trip on it.**
  `fidelityTiers[].eventTypes` carries two incompatible mental models. Football
  and all three kernels treat it as **cumulative bands** — football's band 2
  repeats every band-1 type and adds card/sub/penalty/sinbin. Cricket treats it
  as a **per-event lookup** — band 1 is innings context, band 2 is
  `["cricket.player.line"]` alone, band 3 is
  `["cricket.ball","cricket.superover.ball","cricket.retire"]`. Cricket's bands
  therefore **do not nest**: band 1 ⊄ band 2. It works only because
  `requiredFeatureForEvent` takes lowest-band-wins. S6's conformance criterion
  (d) "tiers nest" would red the one sport that got the model right.
- **The root cause of both: what a band MEANS is declared nowhere.** "doc 14" is
  cited three times in engine comments (`sport/module.ts:61-62`,
  `fidelity.ts:1`, `carrom.ts:113-116`) and does not exist anywhere under
  `docs/`. Each sport author invented a reading. That is how a duplicate band
  and a non-nesting band both went unchallenged into eight dossiers.

**Owner rulings from S2** (verbatim in `_INDEX.md`): the band scale is **closed
at 0–3, there will never be a `z.literal(4)`**; `CarromStrike` is kept and the
pattern is replicated for none; the coverage invariant is standing at match
granularity; the fidelity model is redesigned **in S6**; the T lane is
**shelf-ready**, per-family entitlement keys, declarative rendering only, sliced
as one machinery session plus three family sessions.

---

## Part I — The fidelity model redesign (lands in S6)

### The shape

Declare the semantics once, cross-sport, and give each event exactly one band.

```ts
// packages/engine/src/sport/module.ts
// The scale's meaning — what "doc 14" was supposed to say, as code.
export const FIDELITY = {
  0: "result",   // the outcome only
  1: "card",     // + context a scorer marks without a timeline (toss, pairing, powerplay)
  2: "timeline", // + each scoring event, person-attributed, as it happens
  3: "detail",   // + every event of play, scored or not
} as const;
export type FidelityBand = keyof typeof FIDELITY; // 0 | 1 | 2 | 3 — sealed
```

Per module, one band per event type — no cumulative repetition:

```ts
fidelity: {
  "cricket.innings.summary": 0,
  "cricket.toss":            1,
  "cricket.player.line":     2,
  "cricket.ball":            3,
},
fidelityEntitlements: { 2: "stats.player", 3: "scoring.ball_by_ball" },
```

### What it buys

| property | today | after |
|---|---|---|
| nesting | asserted, and **false in cricket** | **structural** — a band-N scorer emits every band ≤ N by construction. Criterion (d) stops being a test that can fail and becomes a property that cannot |
| "this sport has no band 3" | inexpressible, so authors copied band 2 | the **absence of a band-3 event**. The bug that started S2 becomes unrepresentable |
| the free floor | hardcoded `tier <= 1` at `fidelity.ts:27` | bands 0 and 1 declare no entitlement |
| the scale's meaning | nowhere (`doc 14` is missing) | one constant that cannot drift from the code |
| adding a band-3 event | edit a cumulative list, remember the band below, hope nesting holds | one map row + one entitlement + one padSpec action |

### Why it is safe — proved, not asserted

The old `fidelityTiers` array is **derived** from the new declaration, so no
consumer changes shape. Both existing readers take a **set union across all
bands**:

- `testkit/golden.ts:281` — `flatMap(tier => tier.eventTypes)`, deduped
- `conformance/discipline.test.ts:28` — `some(tier => some(eventTypes))`

The union of `{b0,b1,b2,b3}` where `b3 ≡ b2` equals the union of `{b0,b1,b2}`,
so **collapsing the duplicates is invisible to both** — no corpus movement, no
discipline change. And `requiredFeatureForEvent` (`fidelity.ts:22-28`) takes
lowest-band-wins, so removing the *higher* duplicate cannot move a gate.

The only visible change is the fidelity picker offering one fewer option per
duplicated sport — which is the defect being fixed. The duplicate 2/3 is **not**
a billing bug today (lowest-band-wins gates identically either way); whether the
picker presents a dead choice is unverified and S6 reports it.

### Blast radius

11 modules · `SportInfo.fidelityTiers` (`fixture-console.tsx:140`) ·
`requiredFeatureForEvent` (`fidelity.ts:17-29`) · `testkit/golden.ts:282` ·
`conformance/discipline.test.ts:28`. Mechanical. No prod data. Modules stay
`1.0.0` — extend in place, `registry.get(key,version)` has no fallback. Grows S6
by roughly a third.

---

## Part II — The T lane

**Placement: after S13.** The whole ScoringPad v2 chain ships first, so each
family is an engine event type plus a `padSpec` declaration plus an entitlement
key, and the UI comes free from S10's renderer and S11's skins. Doing it before
S6 would follow the W4→W5→W6 precedent, but that precedent existed because W6
needed W4's fields to *exist* — a hard data dependency S6 does not have. S6's
conformance gate ("every `eventSchema` branch reachable from some action") is
*designed* to fail loudly when a new event type lands without a pad action.
That is the seam working, not a rework tax.

**Status: shelf-ready.** Prompt files written and committed, T rows in
`_INDEX.md` marked `PARKED`. Nothing runs until a real ask. Each family is then
a one-session pull with no re-derivation.

**Not a "ScoringPad v3".** Every row in the lane is a count, an enum, a number,
a person picker or a sequence of person ids — all of which `PadSpec.actions`
already describes. Building a third pad tree to render a "Shot" button next to a
"Goal" button would be the platform failing at the job S6–S11 exist to do. If v2
cannot absorb band 3, that is a v2 defect worth finding in S6. **Spatial input
is the one thing deliberately excluded** — no coordinates, no shot maps; faceoff
location is an enum of named zones. That door reopens only if a customer asks
for a shot map, and then it is genuinely a new pad generation.

### Sessions

| | scope | rows | entitlement |
|---|---|---|---|
| **T1** | shared machinery — the coverage primitive, `derive` returning absent, the declared-band state, conformance for all three | — | — |
| **T2** | period family — hockey, icehockey | shots on goal, saves + save %, faceoffs, circle penetrations | new key |
| **T3** | setbased + nested — volleyball, badminton, tabletennis, tennis | rally length, first vs second serve, attack-block-dig chain | `scoring.rally_by_rally` |
| **T4** | carrom | strike-by-strike | `scoring.strike_by_strike` |

T1 runs first. T2–T4 are independent of each other and may be pulled in any
order. The slicing follows S6's own family grouping and exists to avoid three or
four forks of one function — `_INDEX.md` names the placer/verifier fork as this
repo's recurring bug, hit three times in a single session.

### Packaging

Follows cricket, and reuses names that already exist. `scoring.ball_by_ball` is
cricket's **band 3**; `scoring.rally_by_rally` is its exact parallel and is
currently stuck on band 2 *and* band 3 because those bands are duplicates.
Splitting them lands the vocabulary where it was always meant to go.

| family | band 2 → | band 3 → |
|---|---|---|
| cricket | `stats.player` | `scoring.ball_by_ball` *(already correct)* |
| setbased + tennis | `scoring.match_timeline` | `scoring.rally_by_rally` *(exists)* |
| period | `scoring.match_timeline` | **one new key** |
| carrom | — | `scoring.strike_by_strike` *(reserved in prose, not yet live)* |

Two new keys total. Plan-table and price wiring is a **pricing change** — load
the `stripe:*` skill at that point; never answer billing from memory.

### The event shape every band-3 row follows

```ts
<sport>.<detail> = {
  side:    EntrantId,      // always — the fact belongs to a side
  by?:     PersonId,       // explicit attribution; falls back to personsOf(side)
  outcome: <closed enum>,  // discrete, never a coordinate
  ...discrete sport fields
}
```

- **`outcome` is a closed enum and never optional.** An optional outcome is
  exactly the `PeriodSetPiece.outcome` defect S1 paid for — an attempt the
  scorer never resolved folded to the same numbers a recorded miss folds to.
  Band-3 events are born after that lesson: the unknown state is an explicit
  enum member, not an absent field.
- **`by?` is optional, `side` is not.** Per the programme's carried-in ruling —
  prefer the explicit PersonId, fall back to `personsOf(entrantId)` — a scorer
  who taps a shot without naming the shooter still produces a valid side count.
- **No field references another event.** This is the void test (below) as a
  schema rule, and it is what mechanically excludes plus/minus and PGN.

The fold adds, per `(side, metric)`, the S1 `resolved` shape generalised:
`{ attempts, resolved, ...outcomeBuckets }`, where `attempts − resolved` is the
visible unknown and every rate is `bucket / resolved`.

### T2 — period family

New event types. The heaviest session.

| sport | fact | dossier | shape |
|---|---|---|---|
| icehockey | shots on goal | `icehockey/DOMAIN.md:59` | `icehockey.shot { side, by?, keeper?, outcome: 'goal'\|'saved'\|'missed'\|'blocked' }` |
| icehockey | saves, save % | `:60` | derived from the same event — **no new type** |
| icehockey | faceoffs won/lost | `:61` | `icehockey.faceoff { side, wonBy?, lostBy?, zone?: enum }` |
| hockey | circle penetrations, shots | `hockey/DOMAIN.md:73` | `hockey.entry`, `hockey.shot` — same shape |

**The dossier's objection to save % dissolves.** `:60` refuses it as needing "a
goalie-on-ice track" — continuous state, the plus/minus problem. It does not:
the shot event carries `keeper?: PersonId` and the scorer names it. That is the
explicit-PersonId ruling doing its job.

Faceoff `zone` is an **enum of named zones**, never coordinates.

### T3 — setbased + nested

**Not new event types.** `volleyball.rally`, `badminton.rally`,
`tabletennis.rally` and `tennis.point` already exist; these are **additive
optional fields on them**:

- `rallyLength?: number` on the three rally types
- `serve?: 'first' | 'second'` on `tennis.point`
- `chain?: { action: 'attack'|'block'|'dig'|'reception', by: PersonId }[]` on
  `volleyball.rally`

One event, still independently voidable. Cheapest family by a wide margin — an
additive optional field is the sanctioned `EXTEND_GOLDEN=1` path, with no new
type and none of the five-edit envelope work.

Dossier rows: `setbased/DOMAIN.volleyball.md:48`,
`setbased/DOMAIN.badminton.md:49`, `setbased/DOMAIN.tabletennis.md:55`,
`tennis/DOMAIN.md:52`.

### T4 — carrom

`CarromStrike` is **already written** (`carrom.ts:117-123`). The session adds it
to the `CarromEv` union (`:125`), maps it to band 3, activates
`scoring.strike_by_strike` as a live key, and corrects the stale comment at
`:113-116` — which claims `apply()` rejects `carrom.strike` when in fact the
type is simply absent from the union. Smallest session in the lane.

Dossier row: `carrom/DOMAIN.md:48`.

---

## Part III — Data flow

```
band-3 event → score_events (hash-chained) → foldMatch → State
                                                  ├→ summary/sideMetrics → standings   ✗ never
                                                  └→ playerStats → S8 → S9 career rollup ✓
```

**Standings boundary — band-3 metrics never enter `sideMetrics` or
tiebreakers.** Follows S1's conversion-rate ruling: no federation ranks on them,
and a partially covered statistic must never decide a title. Display and
analysis only.

**The stat model already fits.** `PlayerStatMetric.when?: (payload) => boolean`
(`stats/stats.ts:54`) expresses "saves = shots where `outcome === 'saved'`", and
`PlayerStatDerive` (`:57-61`) expresses save % as a derive over
`{saves, shotsFaced}`. No model extension is needed for the metrics themselves.

**One gap, and it is the recurring one.** `derive` is typed
`(stats: Record<string, number>) => number` (`:60`) — it **cannot return
absent**. With partial coverage it returns a plausible wrong number; with a zero
denominator, `NaN`. This is the third appearance of the absent-vs-zero class in
this programme: `metricOf` at the ranking layer (S1), `PeriodSetPiece.outcome`
at the fold (S1 pass 4), and now `derive` one layer above both. **T1 changes it
to `number | undefined`, and absent must survive to the surface.** Distinct from
S6's serialisable-predicate gotcha — `when`/`derive` are server-side fold
closures, not padSpec gate predicates.

**Coverage granularity.** Coverage is a property of the **(person, metric,
match)** triple. The *decision* granularity is the match — that is the owner
ruling — but the *subject* is a single metric: a scorer can complete shots and
skip faceoffs in the same match, and shots stay while faceoffs go absent.

**Rollup rules for S9**, both silent-wrongness bugs otherwise:

- **Ratio-of-sums, never mean-of-ratios.** A goalkeeper with 1/1 in one match and
  20/40 in another is 51%, not 75%. Simpson's paradox, and mean-of-ratios is the
  natural thing to write.
- **Every aggregate carries `matchesCovered`.** "412 shots" across 6 band-3
  matches out of 20 played is a total over an unstated subset. It renders as
  "412 over 6 matches", or not at all.

**Public surface** — player cards stay competition-scoped and consent-filtered,
gated by `dashboard.player_profiles`. The coverage caveat travels with the
number; a card never shows a bare band-3 figure.

---

## Part IV — Error handling

**A mid-match fidelity downgrade produces a complete-looking number, and the
coverage counter cannot catch it.** A scorer starts at band 3 and drops to band
2 at the second interval: shot events simply stop arriving, so `attempts` stops
incrementing too, and the fold sees a small, internally consistent, entirely
wrong total. The counter is built from the very events that stopped.

**Fix: coverage is declared, not inferred.** The band in force is part of match
state, changed only by an explicit event, and the rule is *"band 3 held for the
whole match."* Any downgrade marks the match partial and every band-3 metric
goes absent. Checkable, voidable, no inference. Without this the entire
invariant is defeated by one tap.

The remaining three cases need no new machinery:

- **Unentitled band-3 append** → a paywall response, not 422. `fidelity.ts:13-15`
  already draws the line: an *undeclared* type is a 422 from `eventSchema`
  ("which is the right error, not a paywall"), a *declared but ungated* type is
  the paywall. That convention simply has to hold.
- **`core.void` on a detail event** → clean by the shape rule above.
- **`409 SEQ_CONFLICT`** → existing `expected_seq` / `since_seq` resync. Only the
  rate is new; see Part V.

---

## Part V — Volume

Cricket already carries ~250 events a match, so the substrate is proven
per-match. The untested case is **burstiness and concurrency**: cricket's 250
spread over three hours is ~1.4/min, whereas ice-hockey shots cluster, and a
tournament runs eight rinks at once — each with a realtime channel, a 15s
polling fallback, and a `match_states` fold invalidation per append.

Position: **no new substrate, one measurement gate.** T2 ships a load test over
append + fold + broadcast. **The budget must be set high enough to be
non-vacuous** — a resource-budget test whose ceiling is too low has the real and
mutated code both hitting it and agreeing, proving nothing.

---

## Part VI — The excluded set

Excluded **iff not an independently voidable discrete fact.** This is a
structural rule, not a judgement about product appetite.

| excluded | why |
|---|---|
| plus/minus + on-ice sets | needs a complete *set*; one void breaks it. Real cost is continuous lineup state — every line change, ~60–80 more events a match — plus an undesigned pad affordance. Own wave if ever |
| boardgame PGN / movetext | needs move *order*; one void breaks it. Also needs a blob-storage decision (`score_events` is hash-chained per event; movetext is one growing opaque string) and validating SAN is writing a chess engine |
| hockey possession | a *duration* — a continuous clock over who holds the ball, not a fact |
| generic strike-by-strike | **no dossier row exists.** #430 says "carrom / generic"; `generic/DOMAIN.md` has nothing |

**The accounting, so it cannot drift.** Counting at #430's own granularity — one
row per sport per subject, which is how it reaches ten:

| | rows |
|---|---|
| #430's claim | 10 |
| less `generic` strike-by-strike, which has no dossier row | **9** |
| less plus/minus + on-ice sets (icehockey) | 8 |
| less boardgame PGN | **7 — the T lane** |

Hockey's row survives with one fact removed from inside it (**possession**). The
seven: icehockey shot-detail (`:59`+`:60`+`:61` — shots, saves, save %,
faceoffs), hockey circle penetrations + shots (`:73`), volleyball chains
(`:48`), tennis first-vs-second serve (`:52`), badminton rally length (`:49`),
tabletennis rally length (`:55`), carrom strike-by-strike (`:48`).

Also already shipped, and not owed: **penalty-corner conversion %**, part of
hockey's `DOMAIN.md:73` row, landed in S1/S2's set-piece counters (`3e3d298e`).

---

## Part VII — Testing

Six groups. A–C are S6, D–E are T1 and the family sessions, F is what keeps the
design robust after we stop looking.

**A. Equivalence proof** — the migration's safety net. Generated over all 11
modules × every declared event type, never hand-listed:

- `requiredFeatureForEvent` returns an identical key (or null) under old and new
- `tierEventTypes(module)` is byte-identical → proves golden coverage unmoved
- `emitsCards(module)` is identical for all 11 → proves discipline conformance
  unmoved

**B. Structural nesting** — every event of band ≤ N appears in derived band N.
True by construction; asserted anyway so a later refactor cannot quietly break
it. Plus the recorded deliberate change: cricket's derived bands now nest where
today's do not.

**C. Semantics conformance** — the checks that would have prevented the original
defect:

- every `eventSchema` type has **exactly one** band — none unmapped, none
  double-mapped
- **no band duplicates its neighbour** ← catches the 7-of-8 duplication at the
  moment it is written
- bands ≥ 2 declare an entitlement; bands 0 and 1 declare none — replaces the
  magic `tier <= 1`
- every entitlement named is a **live key** in `entitlement-domains.ts` —
  catches `scoring.strike_by_strike` being prose-only. Lives in `apps/web`; the
  engine purity gate forbids the reverse direction

**D. Coverage invariant** — a metric declared without a coverage counter fails
conformance; a partially covered match emits **absent**, not 0; a mid-match
downgrade marks the match partial. Mutation proof: delete the guard, a suite
reds. Restore from a `cp` backup, never `git checkout`.

**E. Golden** — corpora byte-identical through the migration (proved by A). Each
family session that fills band 3 extends via `EXTEND_GOLDEN=1` in an isolated
commit; any fold change ships as a red code commit followed by its re-baseline,
per S1.

**F. The scale stays closed** — a test asserting `FIDELITY` has exactly four
members and the `tier` union is sealed at 0–3. The S2 ruling enforced rather
than documented.

Standard obligations still apply per `_RULES.md` §5: unit, regression, and —
because these are engine sessions with no reachable surface until the pad
renders them — e2e and smoke are **deferred to a named later session** and said
so in the PR body, never silently dropped.

---

## Part VIII — i18n, help, smoke, rollout

**i18n.** Every action needs a `labelKey` in S7's scoring-vocab convention —
engine declares the key and a fallback label, web dictionaries translate. All
four dictionaries (`en`, `es`, `fr`, `nl`), flat dotted keys, `i18n:check` green.
Label keys are API the moment they ship.

**Help.** `content/help/**` gains one English page per family: what band 3
records, and that partial coverage shows nothing rather than a number. One
English tree — no translation owed.

**Smoke.** The demo gains a band-3 fixture per family so the surface is
exercised.

**Rollout.** No migration, ever — `score_events.payload` is jsonb and the
programme already records that richer events are a payload-shape change only.
Modules stay `1.0.0`. Each family ships behind its own entitlement, off by
default, so no org sees a change until it buys.

**Drift gates** (CI-only, so a green local run proves nothing): if any api-v1
zod schema moves, run `openapi:gen`, then `i18n:gen-keys`, then
`schema:snapshot` — and `git status --porcelain` must then be empty.

---

## Open decisions

- **The new period-family entitlement key has no name yet.** It should follow
  `ball_by_ball` / `rally_by_rally`; `scoring.shot_by_shot` is the obvious
  candidate. Named when T2 is pulled, alongside the plan-table work, with the
  `stripe:*` skill loaded.
- **Whether the fidelity picker presents a dead choice** where band 3 duplicates
  band 2 is unverified. S6 checks and reports it.
</content>
