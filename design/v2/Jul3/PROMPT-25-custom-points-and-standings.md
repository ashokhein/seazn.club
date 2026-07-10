# PROMPT-25 — Custom Points, Standings Carry-Over & Manual Rank Control

**Read first:** `engine/Jul3/05-custom-points-and-standings.md` (normative);
`engine/05-formats-progression-tiebreakers.md` §3–4; `engine/02-domain-model.md` §5–7;
`engine/04-sport-scoring-specs.md` §per-sport (forfeit/no-result). Preamble: PROMPT-00.
**Depends:** PROMPT-08 (standings + cascade). Rides existing StandingsDelta plumbing — no
sport-module changes.

## Task
1. **Points rule** (Jul3/05 §2): `PointsRule` Zod on `stages.config.points`; pure evaluator
   reading `StandingsDelta.metrics` (margins/ratios/forfeit/no_result) → competition points;
   support fractional/negative. Sport default + division override. Cite `// Jul3/05 §2`.
2. **Carry-over** (Jul3/05 §3): extend `qualification` with `carry: none|points|full`;
   synthetic opening delta folded before new fixtures; no replay of prior H2H; emit
   `division_events: standings_carried`.
3. **Manual rank override** (Jul3/05 §4): `POST /stages/{id}/standings/override` setting
   `rank_locked` rows; cascade ranks only unlocked remainder around locks; emit
   `rank_overridden` (actor+reason, hash-chained).
4. **Cascade additions** (Jul3/05 §5): tie-exhaustion → `rows[].tie_unbroken` + `warn`;
   `h2h_scope: mini_table|overall`; fair-play as selectable step + fair-play standings view.
5. **Decisions** (Jul3/05 §6): `core.forfeit` / `core.no_result` events → outcome + points
   from rule; no fake scores; surface penalty-shootout decider in summary/slide.
6. **Entitlements**: base win/draw/loss = all plans; bonuses + carry-over + circular-H2H +
   override = Pro (`standings.custom_points`, `standings.carry_over`, existing
   `tiebreakers.custom`); tie-unbroken alert all plans.

## Acceptance
- Property: points evaluator is a pure fold — reordering decided fixtures yields identical
  standings; fractional/negative sums exact; a rule referencing a missing metric fails at
  stage-config (fail closed).
- Golden: netball 5/3/1 + losing-≥50% bonus reproduces a hand table; carry-over of top-3
  from each of 2 groups into a super-pool with prior H2H not replayed; 3rd/4th set by
  placement-game override (not alphabetical).
- E2E: two teams tie through the whole cascade → alert shown before KO seeding; forfeit
  awards configured points, no invented score; double-forfeit gives both `no_result` points.
- `npm test` + `npm run lint` green; update `engine/README.md` indexes.
