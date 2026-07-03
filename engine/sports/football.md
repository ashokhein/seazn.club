# Football — Engine & Scoring Architecture

Module: `football` · Spec anchor: `04-sport-scoring-specs.md` §1 · Implementation:
PROMPT-04 · Sources: FIFA 2026 tiebreakers ([11-sources.md](../11-sources.md)).

## 1. What makes football different
Timed periods (not points targets), draws as a first-class result in leagues but
forbidden in knockouts (⇒ ET/shootout sub-machines), squad depth (11 + bench, positions,
substitutions), and **two competing official tiebreaker traditions** (H2H-first vs
GD-first) that organisers argue about — both must ship as presets.

## 2. Match state machine
```
pre ──core.start──▶ H1 ─period(HT)─▶ HT ─▶ H2 ─period(FT)─▶ FT
  league/group: FT ⇒ outcome (win/draw)
  knockout, level at FT:
      cfg.extraTime ⇒ ET_H1 → ET_HT → ET_H2 → ET_FT
      still level & cfg.shootout ⇒ SHOOTOUT → decided
      neither configured ⇒ engine refuses finalize (WRONG_PHASE) — no silent draws in KO
```
State: `{ phase, goals: {home[], away[]}, cards[], subs[], shootout?: {kicks[]} }`.
Minutes optional on every event — coarse mode = bare `goal {by}` events; timeline
(minutes, scorers) is the Pro `scoring.match_timeline` tier. Same fold either way.

## 3. Event vocabulary
| event | payload | rules |
|---|---|---|
| `goal` | by, scorer?, minute?, ownGoal?, penalty? | ownGoal credits opponent; scorer optional (coarse) |
| `card` | by, person?, color: Y/R/second_yellow, minute? | second_yellow implies red; drives fair-play metric |
| `sub` | by, off, on, minute? | validated vs lineup + bench + cfg.maxSubs |
| `period` | phase marker | phase transitions; guards all other events |
| `shootout.kick` | by, person?, scored | only in SHOOTOUT phase, alternating sides enforced |

## 4. Shootout algorithm (spec §1.4)
Best-of-5 alternating; decided early when `lead > opponent's remaining kicks`; then
sudden-death pairs. `outcome = {kind: 'win', method: 'shootout'}` — regulation score
stays a draw in metrics; competition points may split SO win/loss via
`points.shootoutWin/shootoutLoss` (youth-cup convention 2/1).

## 5. Standings & tiebreakers
Delta per fixture: `points, gf, ga, gd, yellow, red, fair_play` (FIFA scale: Y −1,
2nd-Y −3, direct R −4, Y+R −5).
Presets:
- **`fifa2026`** (default): pts → H2H pts → H2H GD → H2H goals → overall GD → overall GF
  → fair play → lots. H2H uses the tied-group mini-table with FIFA fall-through
  (`h2hRecursive: false`).
- **`classic`**: pts → overall GD → overall GF → H2H block → fair play → lots.
- UEFA-style recursive H2H available via `h2hRecursive: true`.

## 6. Positions, lineup, roster
Catalog: groups GK(min1,max1)/DF/MF/FW; child keys CB LB RB CM DM AM LW RW ST; role
captain (unique). Lineup: 11 starting + bench ≤ cfg; formation string (`4-3-3`)
display-only metadata. Roster: squad numbers unique per entrant; profile attrs
`{preferred_position, foot}`.

## 7. Divisions interplay (doc 06)
Youth templates bundle eligibility + config: `U13 {halfMinutes: 30, extraTime: off}`,
small-sided `{7v7, lineup.size: 7}` — lineup size is Cfg, catalog adapts (`lineup.size`
parameterised). Never a separate module.

## 8. Abandonment/forfeit policy
`core.forfeit` → `award` with cfg.awardScore (3-0). `core.abandon` → `cfg.abandonPolicy`:
`replay` (default — no outcome, fixture flagged for regeneration, `finalize` refused while
undecided) | `award` (decide for the current leader; level score ⇒ `no_result`). The
`stand` policy (result stands if ≥ cfg.minMinutesForResult) is reserved for a later prompt
— not yet in the module Cfg. League withdrawal: 05 §5 policies apply (expunge <50% played,
else award remaining).

## 9. Edge cases checklist
- Own goal in shootout: not a thing — reject `ownGoal` in SHOOTOUT phase.
- Red card before kickoff (pre phase): allowed (cards valid in `pre`), affects lineup validation.
- Both teams forfeit → double `no_result` with 0 pts (cfg).
- Goal minute > phase bounds (e.g. 47' in H1) — allow (stoppage time), order by event seq not minute.
- 3rd-place playoff and two-legged ties (aggregate + away-goals toggle) — stage-level
  config (05 §1 `legs: 2` on knockout), aggregate computed by competition layer from the
  pair of fixtures; away-goals rule as cascade key `away_goals` (off by default, UEFA
  abolished 2021 — keep for legacy leagues).
