# v3/09 — Engine Fixes: Badminton Scoring, Cricket Undo, Sim-Replay v2, Division Delete

Correctness items — **build these first** (README order). Bugs in scoring erode the only
trust that matters. Owns intake #28, #29, #27, #8.

## 1. Badminton scoring (intake #28)

Two reported defects in the `setbased` module path (badminton preset):

**(a) "Chosen score not reflected in top score."** Entering/updating a point does not
update the header score summary. Likely a summary/fold refresh gap: the score header
renders from a stale `scoreSummary` (derived snapshot) while the event appended fine —
or the optimistic client state isn't invalidated on `expected_seq` advance. Diagnose in
this order: (1) does `GET fixture` after the event show the right summary? → if yes,
client cache invalidation bug (UI); if no, `SportModule.summary()` fold bug (engine).
Fix at the root; add the regression test at that layer.

**(b) Set-end rules.** The founder's "tennis 45" analogy = deuce/cap semantics. Normative
BWF rules the preset must encode (already specced in engine/sports/badminton.md — verify
implementation matches):

- Game to **21** rally points; at **20-20** play continues until 2-point lead;
  at **29-29** next point wins (**30 cap**).
- Match = best of 3 games. A game at 0 for the loser (21-0) is valid — no skunk rule.
- Interval/side-change events optional; must not affect outcome.

Golden tests: 21-19 ends; 20-20 → 22-20 ends; 21-20 does **not** end; 29-29 → 30-29 ends;
30-cap unreachable-overshoot rejected (`INVALID_EVENT`); summary after every event equals
recount-from-events (property test). Same matrix for table tennis (11, deuce, no cap) and
volleyball (25/15 fifth set, no cap) since they share the kernel — a preset-parameter bug
here is probably shared.

## 2. Cricket undo regression (intake #29)

Repro: in-play cricket fixture → "Undo last" → scoring UI disappears (blank panel).
Undo appends a compensating event (engine invariant: append-only, no ledger mutation —
Jul3/03). Hypotheses, in likelihood order:

1. Cricket module's fold doesn't handle the compensating event type → `fold()` throws →
   UI error boundary swallows to blank. (Chess/football handle it; cricket's innings
   state machine may miss a case, e.g. undoing the innings-opening or toss event.)
2. Undo produces a state the UI can't render (e.g. `currentInnings` undefined after
   undoing the first ball).
3. Client: response shape from the undo endpoint differs for cricket (missing summary) →
   render crash.

Required outcome: **undo after *every* legal cricket event yields a renderable state**,
and undo of "nothing to undo" is a 409/no-op, never a crash. Add to the chaos suite
(`testkit/chaos.test.ts`): for every sport module, for every event in a simulated match,
apply → undo → assert fold total (no throw) and summary defined; then redo/继续-scoring
still works. UI: error boundary around the scoring panel must render "Something went
wrong — reload scoring" with the fixture link, never blank (defence in depth).

## 3. Sim-replay v2 (intake #27 — "deep simulation replay")

`packages/engine/scripts/sim-replay.ts` predates the Jul3 wave. Update:

- Cover all current sport modules (incl. carrom, generic v2 presets when 29 lands) and
  all stage kinds incl. Jul3/08 extensions (RR legs>2, americano, custom brackets,
  cross-stage feeds, auto-advance, ladder).
- Inject the two fixed bugs as permanent scenarios: mid-match undo storms (every sport),
  set-end boundary matrices (setbased presets).
- Custom points rules + carry-over (Jul3/05) and officials assignment (Jul3/02) folded
  into the sim loop where applicable.
- **Report artifact:** machine-readable JSON summary (seeds, event counts, invariant
  results, per-module coverage) written to `packages/engine/sim-report.json` + human
  table to stdout; CI job runs a bounded profile (n seeds, time-capped) and uploads the
  report. Failures print the seed for replay — determinism (engine ground rule 1) makes
  every failure reproducible.

## 4. Division delete (intake #8 — "can we allow deleting a division?")

Yes — with graduated destructiveness. No DELETE endpoint exists today.

| Division state | Action | Semantics |
|---|---|---|
| Setup (never started, no decided fixtures) | **Delete** | Hard delete: fixtures, entrant links, stages, division row. Entities that outlive the division (persons, teams, clubs) untouched. |
| Started or has decided fixtures | **Archive** | `archived_at` set: hidden from console lists + public site (404), excluded from entitlement counts, restorable from competition settings → "Archived divisions". |
| Any | Purge (archived only, 30-day cool-off) | Hard delete of an archived division after 30 days — admin-initiated, not automatic. |

- API: `DELETE /api/v1/divisions/[id]` → 204 (setup) / 409 `DIVISION_HAS_RESULTS` with
  `{archive: true}` hint; `POST .../archive` + `POST .../restore`. Owner/admin only.
- UI: ConfirmDialog with `typedName` (v3/03 §3) for delete; archive uses plain danger
  confirm. Copy states exactly what is destroyed vs kept.
- Ledger: deletion emits a division-scope audit event on the *competition* (the division
  ledger dies with it); hash chain of remaining ledgers unaffected.
- Registration guard: open registrations block delete (close registration first — the
  error says so).
- Free-plan interplay: deleting/archiving frees quota (that's the honest behaviour, and
  the reason people ask for delete).

## 5. Acceptance sketch

All §1/§2 golden + property + chaos tests green and *fail on the pre-fix code* (house
rule: regression test per change). Sim CI job produces report artifact. Delete/archive
e2e: setup-division delete frees Free-plan slot (gate lifts); resulted division 409s then
archives; restore round-trips. Smoke extended: delete path on free, archive on pro.

Related: engine/04 (scoring specs), engine/sports/badminton.md + cricket.md (normative),
Jul3/03 (undo semantics), [[v3/03]] ConfirmDialog.

## 6. Implementation notes (PROMPT-38, 2026-07-10)

Landed on `feat/engine-fixes-prompt-38`. Deviations/diagnoses vs the sketches above:

- **§1a root cause (engine, not client):** the setbased kernel's fold and set
  predicate were correct; the divergence was `summary()` collapsing the headline
  to sets-won only ("1 — 0"), so a summary-entered game score never appeared in
  the top score. Fixed in the kernel: headlines now carry per-set points
  ("2 — 0 · 21–15, 21–18", open set in parens). §1b set-end rules verified
  correct — the boundary matrices are now permanent tests + sim scenarios.
- **§2 root cause (persistence, not fold):** `resolveVoids` already hides
  compensating events from modules; the regression was `fixtures.status`
  drifting from the fold after a void (undo of `core.start`/`core.forfeit`/
  `core.abandon` left the status stuck), dead-ending the console. Status is now
  derived from the void-resolved ledger in `appendEvent`. Undo-of-nothing is a
  usecase-level 409 (`REGISTRATION_OPEN`-style typed code: no target / already
  undone / undoing an undo). The scoring-panel error boundary landed as
  defence in depth (`ScoringErrorBoundary`).
- **§4 route naming:** `POST /divisions/{id}/restore` was already taken by the
  Jul3/03 checkpoint restore, so un-archiving is `DELETE /divisions/{id}/archive`
  (archive as a resource). Purge reuses `DELETE /divisions/{id}` on an archived
  division (409 `ARCHIVE_COOL_OFF` inside 30 days). Open registration blocks
  archive as well as delete. Restore re-checks the divisions quota (402 rather
  than silently exceeding the plan).
- **§3:** `league_legs2` joined the division-matrix templates; americano/ladder
  are engine-level scenario suites (StageKind stays the six-kind enum — those
  formats are app-level stage configs). `npm run sim:matrix` emits
  `packages/engine/sim-report.json`; CI runs `SIM_SEEDS=5` and uploads it.
