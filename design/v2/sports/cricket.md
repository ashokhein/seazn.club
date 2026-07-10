# Cricket — Engine & Scoring Architecture

Module: `cricket` · Spec anchor: `04-sport-scoring-specs.md` §2 (normative) ·
Implementation: PROMPT-05 · Sources: ESPNcricinfo NRR, DLS references ([11-sources.md](../11-sources.md)).

## 1. What makes cricket different
Everything. Asymmetric innings (teams don't score simultaneously), two resources (balls
*and* wickets), results expressed in different units ("by 24 runs" vs "by 6 wickets"),
weather rewriting targets mid-match (DLS), a standings metric that needs opponent context
(NRR), format variants of the same sport with different lengths (T20/ODI/100-ball/test),
and a draw that is *not* a tie. Cricket is why the engine is event-sourced and why
config is data.

## 2. Layered state (the key design)
```
BallLedger (fine)  ──fold──▶  InningsTotals  ──▶  ResultMath / NRR / DLS
InningsSummary (coarse) ─────▶  InningsTotals
```
**All downstream math reads only `InningsTotals`** `{runs, wickets, legalBalls,
declared?}`. Ball-by-ball (Pro) and innings-summary (Community) are two producers of the
same shape — spec §2.2 design note. Never let result logic peek at ball events.

### Fine-fidelity state (per innings)
`{ battingOrder cursor, striker, nonStriker, currentBowler, previousBowler,
   overBallCount(legal), batterCards: {runs, balls, fours, sixes, dismissal?},
   bowlerFigures: {balls, runs, wickets, maidens}, extras breakdown, fowList, freeHitPending }`
Enforced per ball: legal-delivery accounting (wide/no-ball don't advance the over),
free-hit dismissal restrictions (only runout family), striker rotation (odd runs; swap at
over end), bowler constraints (no consecutive overs, `maxOversPerBowler`), all-out at
`playersPerSide − 1`.

## 3. Match state machine (white-ball, 1 innings/side)
```
pre → cricket.toss {wonBy, elected} → core.start → innings1 → break → innings2(target = i1.runs+1)
  chase resolved live: runs > target−1 ⇒ win by (10−wickets) wickets
                       all out / balls out below target−1 ⇒ win by (target−1−runs) runs
                       exactly target−1 at close ⇒ TIE → superover? → outcome
interruption/revise events may shrink oversPerSide or set a DLS target at any point
abandon below cfg.minOversForResult ⇒ no_result (or DLS par decision, method 'dls')
```
**Impl note (PROMPT-05):** the toss is a dedicated `cricket.toss {wonBy, elected}` event
recorded in the `pre` phase, *not* a `core.start` payload — the kernel's `core.start`
schema is `strictObject({})` (spec 03 §2) and carries no sport data. Two-innings (test)
adds: follow-on decision (`cricket.followon`), declarations (`cricket.innings.declare`),
time-expiry **draw** (`cricket.match.close`), innings sequencing, **draw**
on time expiry, innings-victory margins.

### Super over
Recursive mini-match: `superover.ball` events fold an independent 1-over innings pair
with 2-wicket all-out. Still tied → cfg: repeat | boundary_count | shared. Outcome
`method: 'super_over'`.

## 4. NRR — standings ledger (spec §2.4)
Store integers only: `runs_for, balls_faced_eff, runs_against, balls_bowled_eff`.
- All-out ⇒ charge the **full quota** (`ballsPerInnings`), not actual balls.
- DLS-revised matches use revised quotas.
- Rank-time comparison by cross-multiplication; display = 3 dp.
Cascade (ICC-style): `points → wins → nrr → h2h → seed`.
Points: win 2, tie 1, no_result 1, loss 0 (Cfg; some leagues add bonus points — reserve
`bonus` hook in `standingsDelta`, off by default).

## 5. DLS (spec §2.5)
Pure function over the Standard Edition resource table (shipped as data):
`resources(oversRemaining, wicketsLost) → %`; target `1 + floor(S1 × R2/R1)` (+ edition
adjustment when R2 > R1). Applied only via an explicit `revise` event — umpire numbers
always win over our computation; our computation pre-fills the event (Pro `cricket.dls`).
Par-score curve exposed for the live "ahead/behind par" widget.

## 6. Positions, roles, lineup
Catalog: BAT/BOWL/AR/WK; roles captain (unique), wicketkeeper (unique, **required**).
Lineup: exactly `playersPerSide` starting, batting order = `order_no` (mutable until a
batter is dismissed past that slot), optional 12th+ as bench (fielding subs — no batting/
bowling). Profile attrs: batting hand, bowling style. Batting/bowling stat cards derive
entirely from ball events (Pro `stats.player`).

## 7. Age/format divisions (doc 06 worked example)
Templates: `U13 T20-ish {ballsPerInnings: 96 /*16 ov*/, maxOversPerBowler: 3, boundary
shortening = venue note}`, `U16 T20 {120, 4}`, `Open ODI {300, 10}` — one module, data
variants. Junior boards vary the cutoff date (Sep 1 England vs Jan 1) — cutoff explicit
in the eligibility rule, never assumed.

## 8. Edge cases checklist
- Retired hurt (not out — may resume) vs retired out; timed out.
- Penalty runs (5-run awards) → `extras.kind: 'penalty'`, either innings (can adjust a
  *completed* innings: model as `game.adjust`-style event on the fixture).
- Last-man rules for community variants (`pairs-6-a-side`: all out at N wickets, batter
  continues) — cfg switches, validated combos only.
- No-ball + boundary = 1 + 4; wide + byes stacking; free hit off wide? (no — only no-ball).
- Over reduced mid-over by rain: `revise` between balls; partial-over handling in
  balls-remaining math.
- Tie in a league (no super over) ⇒ `tie` outcome, 1 pt each — distinct from `no_result`
  in the table's T/NR column.
- DLS target reached exactly on the revised par at abandonment ⇒ tie by DLS (method 'dls').
