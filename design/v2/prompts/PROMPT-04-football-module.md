# PROMPT-04 — Football Sport Module

**Read first:** `engine/04-sport-scoring-specs.md` §1 (normative), §9; re-verify tiebreaker
presets against the FIFA source in `engine/11-sources.md`. Preamble: PROMPT-00.
Depends: PROMPT-03.

## Task
Implement `sports/football/` fully per spec 04 §1:

1. Cfg schema + variants (`11-a-side`, `youth`, `small-sided`) incl.
   `points.shootoutWin/shootoutLoss` optional split.
2. Event schemas: `goal` (own-goal credits opponent), `card`, `sub`, `period`,
   `shootout.kick`. Minute optional everywhere (coarse scoring must work).
3. State machine per §1.3 — phase transitions validated (`WRONG_PHASE` on goal after FT
   unless ET configured, etc.). `supportsDraws(cfg, stage)`: league/group true, knockout false;
   undecided knockout at FT requires ET/shootout path before `outcome` returns non-null.
4. Shootout fold per §1.4: best-of-5 alternating, early decision (lead > remaining),
   sudden death. Property test: shootout always terminates and winner has strictly more
   scored kicks at decision point.
5. `standingsDelta` + metrics `gf/ga/gd/yellow/red/fair_play` (FIFA scale −1/−3/−4/−5).
6. `defaultTiebreakers`: export **both** presets `fifa2026` (H2H-first) and `classic`
   (GD-first); module default = `fifa2026`.
7. `core.forfeit` → `award` outcome with `cfg.awardScore` goals; `core.abandon` →
   configurable (`replay` = no outcome + fixture flagged, or `award`).
8. Position catalog GK/DF/MF/FW (+ child keys CB/LB/RB/CM/DM/AM/LW/RW/ST), roles
   captain(unique); lineup 11 + bench per cfg.
9. `arbitraryEvent(state)` generator + `coarsen()` (timeline → period summaries) for the
   dual-fidelity conformance hook.
10. Golden tests: (a) league draw 1-1 → 1pt each + metrics; (b) knockout 0-0 → ET 1-1 →
    shootout 4-3 with method='shootout'; (c) forfeit award 3-0; (d) own-goal + red card
    fixture folds to correct summary and fair-play points.

## Acceptance
- `conformanceSuite(football)` green; goldens green; spec-section comments present.
