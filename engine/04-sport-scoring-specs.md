# 04 — Sport Scoring Specifications & Algorithms

The normative spec each sport module implements. Every module rule in code must cite its
section here (e.g. `// spec 04 §2.4 NRR`). Official sources in [11-sources.md](11-sources.md).
Per-sport architecture deep dives (state machines, edge-case checklists, division
interplay) live in [sports/](sports/) — chess, carrom, football, cricket, volleyball,
badminton, table tennis. Where this doc and a `sports/*.md` file differ, the sports file
is more recent and wins; fold the fix back here.

Legend: **Cfg** = variant config schema · **Ev** = event vocabulary · **State** = fold
state · **Outcome/Points** = mapping to competition points · **TB** = default tiebreaker
metrics the sport contributes.

---

## 1. Football (soccer) — `football`

### 1.1 Cfg
```ts
{ halfMinutes: 45, halves: 2,
  extraTime: { enabled: boolean, halfMinutes: 15 },   // knockout only
  shootout: boolean,                                   // knockout only
  points: { win: 3, draw: 1, loss: 0 },
  awardScore: { goals: 3 },                            // forfeit award, "3–0"
  fairPlay: boolean }                                  // track cards for FIFA fair-play TB
```
Variants: `11-a-side`, `youth {halfMinutes: 30..40}`, `small-sided {halfMinutes: 20, halves: 2}`.

### 1.2 Ev
`goal {by, scorer?, minute?, ownGoal?, penalty?}` · `card {by, person?, color: yellow|red|second_yellow, minute?}` ·
`sub {by, off, on, minute?}` · `period {phase: HT|FT|ET_HT|ET_FT}` ·
`shootout.kick {by, person?, scored}`.

### 1.3 State machine
```
pre → H1 → HT → H2 → FT ─┬─ decided (scores differ, or draw allowed in league stage)
                          └─ ET_H1 → ET_HT → ET_H2 → ET_FT ─┬─ decided
                                                             └─ SHOOTOUT → decided
```
- Goals accumulate per side; own-goal credits opponent.
- `supportsDraws(cfg, stage)` — true for league/group, false for knockout ⇒ at FT with
  equal score the module *requires* ET/shootout events per config (engine rejects
  `core.finalize` on an undecided knockout fixture).

### 1.4 Shootout algorithm
Best-of-5 alternating kicks; decide early when lead > remaining kicks for the other side
(e.g. 3–0 after 3 v 2 kicks); then sudden-death pairs. State tracks `kicks: [{by, scored}]`;
`outcome.method = 'shootout'`; **group standings treat a shootout win by regulation-draw
rules if the competition config says so** (e.g. some youth cups: SO win = 2 pts, SO loss = 1).
Expose `points.shootoutWin?/shootoutLoss?` in Cfg for that.

### 1.5 Outcome/Points & metrics
Win 3 / draw 1 / loss 0 (configurable). Metrics per entrant per fixture:
`gf, ga, gd = gf−ga, yellow, red, fairPlayPoints` (FIFA scale: yellow −1, second-yellow
−3, direct red −4, yellow+red −5).

### 1.6 TB (two official presets, organiser-selectable)
- `fifa2026`: points → **head-to-head points → H2H GD → H2H goals** → overall GD →
  overall GF → fair play → drawing of lots. (FIFA aligned with UEFA for 2026.)
- `classic` (pre-2026 WC): points → overall GD → overall GF → H2H block → fair play → lots.

---

## 2. Cricket — `cricket`

The hardest module. Innings grammar, overs/balls arithmetic, NRR, DLS, tie-breaking super
overs, and multi-day draws.

### 2.1 Cfg
```ts
{ inningsPerSide: 1 | 2,
  ballsPerInnings: number | null,        // T20: 120, ODI: 300, Hundred: 100; null = unlimited (test)
  ballsPerOver: 6,                        // Hundred uses 5-ball "sets" — keep configurable
  playersPerSide: 11, maxOversPerBowler?: number,   // T20: 4, ODI: 10
  points: { win: 2, tie: 1, noResult: 1, loss: 0, draw?: 1 },   // draw only for 2-innings
  superOver: boolean,                     // knockout tie resolution
  dls: { enabled: boolean, edition: 'standard' },   // §2.5
  followOn?: { enabled: boolean, lead: 200 } }      // 2-innings only
```
Variants: `t20 {ballsPerInnings: 120, maxOversPerBowler: 4}`, `odi {300, 10}`,
`hundred {100, ballsPerOver: 5}`, `test {inningsPerSide: 2, ballsPerInnings: null}`,
`pairs-6-a-side` (community formats — playersPerSide/balls configurable).

### 2.2 Ev — ball-by-ball ledger
```ts
ball { over, ballInOver, striker, nonStriker, bowler,
       runs: { bat: 0..6+, extras?: { kind: wide|noball|bye|legbye|penalty, runs } },
       wicket?: { kind: bowled|caught|lbw|runout|stumped|hitwicket|retired|obstructed|timedout,
                  out: personId, fielder?, bowlerCredited: boolean },
       boundary?: 4|6, freeHit?: boolean }
innings.declare {} · innings.close {}     // all-out and balls-exhausted close automatically
interruption { kind: rain|light|other, oversLostEstimate? }
revise { oversPerSide?, target? }         // umpire/DLS revision applied as an event
superover.ball { ... }                    // same ball grammar, separate mini-innings
```
Ball legality: wides/no-balls don't consume a legal delivery (ball count doesn't advance);
no-ball ⇒ next delivery `freeHit` in white-ball variants. Module enforces: over = 6 legal
balls, bowler can't bowl consecutive overs, `maxOversPerBowler`, striker rotation on odd
runs and over-end swap.

**Design note — two scoring fidelities.** Ball-by-ball is heavy for casual organisers.
Module accepts *either* granularity:
- `cricket.ball` events (full scorecard, Pro-tier live experience), or
- `innings.summary {runs, wickets, legalBalls}` coarse events (community tier).
Both fold to the same `InningsTotals` shape all downstream math (result, NRR, DLS) reads.
This is the single most important cricket design decision — do not skip it.

### 2.3 Result determination (single-innings-per-side)
Team B chasing: B > A runs ⇒ B wins (`by W wickets`); B all out / balls out with B < A ⇒
A wins (`by R runs`); B == A ⇒ **tie** → super over if `superOver` (fold `superover.*`
events recursively — a super over is itself a 1-over innings pair; still tied ⇒ repeat or
boundary-count per config). Abandoned before minimum overs (config `minOversForResult`,
T20: 5) ⇒ `no_result`. Two-innings: standard test rules incl. **draw** on time expiry,
innings victory, follow-on.

### 2.4 Net Run Rate (standings metric) — exact algorithm
```
NRR = runsFor / oversFacedEff  −  runsAgainst / oversBowledEff
```
- Overs decimalised: 47.3 overs = 47 + 3/6 = 47.5 (with `ballsPerOver` generality).
- **All-out rule (ICC):** a side bowled out is charged its **full allotted quota** (20/50
  overs), not actual balls faced, in both `oversFacedEff` and opponent's `oversBowledEff`.
- DLS-revised matches use the revised overs/targets per ICC playing conditions.
- Accumulated across the stage, not averaged per match ⇒ standings ledger stores
  `runs_for, balls_faced_eff, runs_against, balls_bowled_eff` and computes NRR at rank time
  (never store the ratio — precision).

### 2.5 DLS (rain-revised targets) — design
Model DLS as a **pure target-revision function** the module calls when it folds a
`revise` event; the *event* carries umpire-confirmed numbers, so the engine works even
where our table differs from the official panel:
```
dlsTarget(cfg, s1: InningsTotals, oversLostInfo) → { target, parScoreCurve }
resources(oversRemaining, wicketsLost) → % from the published Standard Edition table
target = 1 + s1.runs × R2/R1   (R2 > R1 case: + G50-style adjustment per edition notes)
```
Ship the **Standard Edition public resource table** (published by ICC/academic sources) as
data in the module; label output "DLS (Standard Ed.)". The professional edition is
proprietary software — organisers needing it enter the umpire's target via `revise`.
Par-score curve powers the live "ahead/behind DLS par" widget (Pro feature).

### 2.6 Points & TB
Group points: win 2, tie/no-result 1, loss 0 (Cfg). Default cascade (ICC-style):
`points → wins → NRR → head-to-head → pre-tournament seeding`.

### 2.7 Positions/roles
Catalog: BAT / BOWL / AR (all-rounder) / WK; roles captain (unique), wicketkeeper
(unique, required in lineup), 11 starting + substitutes. PlayerProfile attrs: batting
hand, bowling style. Batting order = `LineupSlot.order_no`; bowling figures derived from
ball events.

---

## 3. Volleyball — `volleyball` (set-based kernel)

### 3.1 Cfg
```ts
{ bestOf: 5, setTo: 25, finalSetTo: 15, winBy: 2, cap: null,
  points: { w30: 3, w31: 3, w32: 2, l23: 1, l13: 0, l03: 0 } }   // FIVB league convention
```
Variants: `indoor`, `beach {bestOf: 3, setTo: 21}`.

### 3.2 Ev
`rally {wonBy}` (point-by-point) **or** `set.summary {home, away}` (coarse — same
dual-fidelity rule as cricket). Optional `timeout`, `sub`, `libero` events (no score effect).

### 3.3 Set/match algorithm
Set won at `≥ setTo` with margin `≥ winBy` (24-24 ⇒ play on: 26-24, 27-25…; `cap` for
house rules). Set `bestOf` = first to ⌈bestOf/2⌉ sets; deciding set uses `finalSetTo`.
No draws, ever ⇒ `supportsDraws = false` for all stages.

### 3.4 Points & TB
FIVB convention: 3–0/3–1 win = 3 pts, 3–2 win = 2, 2–3 loss = 1, 0–3/1–3 = 0 (Cfg-driven).
Metrics: `sets_won, sets_lost, points_won, points_lost`. Cascade:
`points → matches won → set ratio (sets_won/sets_lost) → point ratio → head-to-head`.
Ratios computed at rank time from ledger integers; division-by-zero ⇒ +∞ ordered first.

---

## 4. Badminton — `badminton` (set-based kernel)

Cfg `{bestOf: 3, gameTo: 21, winBy: 2, cap: 30}` — BWF: game to 21 rally points, win by 2,
**hard cap 30** (29-29 ⇒ 30 wins golden point). Ev = `rally {wonBy}` / `game.summary`.
Disciplines: singles/doubles/mixed = entrant kind `individual|pair` (doc 02 §2) — same
module. Points: match win = configurable (leagues often 2/1/0 or ladder). TB:
`points → matches → games ratio → points ratio → H2H`.

## 5. Table tennis — `tabletennis` (set-based kernel)

Cfg `{bestOf: 5|7, gameTo: 11, winBy: 2, cap: null}` (ITTF). Same kernel as badminton.
Team ties (Swaythling-style, best of 5 singles) = a **stage-level feature**: a "tie" is a
mini round-robin of fixtures aggregated by the competition engine, not a sport-module
concern — model later via `Fixture.parent_fixture_id` (schema reserves the column).

> **Implementation note:** volleyball/badminton/TT share `sports/setbased/` — one kernel
> parameterised by `{bestOf, gameTo, finalTo, winBy, cap, pointsMap}`, three thin presets.
> This is PROMPT-06.

---

## 6. Chess & board games — `boardgame`

### 6.1 Cfg
`{ scoring: { win: 1, draw: 0.5, loss: 0 }, colors: boolean, byeScore: 1 | 0.5 }`
Variants `classical|rapid|blitz` (clock metadata only). Also covers draughts, go, carrom
(colors→sides), and generic 1v1 win/draw/loss sports.

### 6.2 Ev
`result {winner: entrantId | null /* null = draw */, method?: checkmate|resign|time|agreement|forfeit}`.
Single terminal event per fixture — simplest possible module; it exists to carry the
**metrics and pairing metadata** Swiss needs:

### 6.3 Swiss metrics (fed to competition engine)
- **Score** — Σ game points (1/½/0), the primary key.
- **Buchholz** — Σ opponents' final scores; **Buchholz Cut-1** drops the lowest (FIDE
  recommends Cut-1 first). Unplayed-game handling per FIDE: virtual-opponent adjustment.
- **Sonneborn-Berger** — Σ (defeated opponents' scores) + ½ Σ (drawn opponents' scores).
- **Direct encounter**, **number of wins**, **wins with black** — cascade tail.
- Colour history per entrant (`colorSeq: 'WBWB…'`) — consumed by the pairing algorithm
  (doc 05 §3.2), constraint: no 3 same colours in a row, |W−B| ≤ 2.

Default cascade: `score → buchholz_cut1 → buchholz → sberger → direct → wins → rng(seeded)`.

---

## 7. Basketball — `basketball`

Cfg `{ quarterMinutes: 10|12, quarters: 4, overtimeMinutes: 5, points: {win: 2, loss: 1, forfeit: 0} }`
(FIBA points convention: loss earns 1). Ev: `score {by, points: 1|2|3}` or
`period.summary {home, away}`; `foul` optional. No draws — OT repeats until decided.
Metrics `pf, pa, diff`. TB (FIBA): `points → H2H points → H2H diff → overall diff → overall pf`.

---

## 8. Generic — `generic` (v1 compatibility)

Reproduces v1 semantics so existing users lose nothing on cutover: Cfg
`{resultMode: win_loss|score, allowDraws, points{w,d,l}, progressScore}`; Ev
`result {winnerId?, p1Score?, p2Score?, isDraw?}`. Metrics `for, against, diff`. This is
the migration target for all v1 tournaments (PROMPT-15).

---

## 9. Cross-sport invariants (testkit enforces on every module)

1. `apply` is pure & total on valid input; throws typed `EngineError` otherwise.
2. `outcome` monotone: never returns to null; never changes identity after decision.
3. `standingsDelta` conserves: `Σ points awarded per fixture ∈ sport's declared set`
   (e.g. football {3,2 if SO-split,…}, volleyball {3}, cricket {2}).
4. Ledger metrics are integers or exact rationals (store numerator/denominator fields,
   never floats — NRR/ratios computed at comparison time with cross-multiplication).
5. `summary(fold(events))` defined at every prefix of a valid event stream (live UI safety).
6. Dual-fidelity sports: coarse and fine event streams describing the same match fold to
   identical `InningsTotals`/set totals and identical outcomes.
