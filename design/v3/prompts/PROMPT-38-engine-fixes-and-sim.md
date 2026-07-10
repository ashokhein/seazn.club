# PROMPT-38 — Engine Fixes: Badminton, Cricket Undo, Sim-Replay v2, Division Delete

**Read first:** `v3/09-engine-fixes-and-sim.md` (normative); `engine/sports/badminton.md`,
`engine/sports/cricket.md` (normative rules); `engine/Jul3/03` (undo semantics);
`engine/04` §set-based kernel. Preamble: PROMPT-00. **Do this prompt first** (README order).
**Depends:** PROMPT-32 ConfirmDialog for §4 UI (or land API first, UI after 32).

## Task
1. **Badminton** (v3/09 §1): diagnose summary-vs-event divergence per the doc's decision
   tree (server summary wrong → fold bug; right → client invalidation) and fix at the
   root; verify/fix set-end rules (21, win-by-2 from 20-20, 30-cap at 29-29); reject
   impossible overshoots. Extend the same boundary matrix to table tennis + volleyball
   presets (shared kernel). Golden + property (summary == recount) tests that fail pre-fix.
2. **Cricket undo** (v3/09 §2): make fold total over compensating events (incl. undo of
   toss/innings-open/first-ball); undo-with-nothing = 409, never crash; chaos-suite
   extension: every sport × every event position → apply→undo→fold defined + summary
   renderable, then continue scoring. UI: scoring-panel error boundary renders recovery
   message + fixture link (never blank).
3. **Sim-replay v2** (v3/09 §3): cover all registered sport modules + Jul3/08 stage
   kinds + custom points/carry-over + officials; permanent scenarios for the two fixed
   bugs (undo storms, set-end matrices); emit `sim-report.json` (seeds, counts,
   invariants, coverage) + stdout table; bounded CI profile uploading the report; failure
   prints reproducing seed.
4. **Division delete** (v3/09 §4): `DELETE /api/v1/divisions/[id]` (setup-state hard
   delete) / 409 `DIVISION_HAS_RESULTS` with archive hint; `POST .../archive` +
   `.../restore`; `archived_at` hides from console/public/entitlement counts; purge for
   archived ≥30d (admin); open registrations block delete (error says close first);
   competition-ledger audit event; UI `typedName` confirm stating destroyed-vs-kept.

## Acceptance
- All new tests fail on pre-fix code (house rule) — demonstrate via stash run in PR notes.
- Chaos: full undo sweep green across every sport module.
- E2E: badminton score entry updates header summary live; cricket undo mid-over keeps
  scoring panel usable; setup-division delete lifts a free-plan gate; resulted division
  409→archive→restore round-trip.
- Sim CI job green with report artifact; `npm test` + `tsc` green; smoke.ts: delete on
  free, archive on pro; update v3/README + engine/README statuses.
