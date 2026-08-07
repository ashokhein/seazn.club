# Date/time scheduling UX — shared component, dynamic board segmentation, blackout editor

Status: design complete, ready for implementation plan. Date: 2026-08-07.

## Problem

Four related gaps, found by tracing actual current-state code (not assumed):

1. **No shared date/time input component.** `division-builder.tsx`,
   `competition-wizard.tsx`, and `board/settings-panel.tsx` each
   independently declare native `<input type="date"|"time"|
   "datetime-local">` elements with local `useState`. They share a CSS
   class (`.input`) so they look consistent, but there is no single
   component — six-plus separate declarations, duplicated logic, drift
   risk. The constraints panel's `notBefore`/`notAfter` rule has **no
   picker at all**, just a read-only count.
2. **The schedule board's time axis doesn't match what the solver
   actually reasoned about.** `schedule-board.tsx:862` computes
   `slotMinutes = matchMinutes + gapMinutes` — one fixed value for the
   whole board — and `board-grid.tsx` renders a fixed `h-10` row per
   slot regardless of that value. The backend's own lattice
   (`build-grid.ts`) already computes a finer, correct step,
   `gridStepMinutes = gcd(matchMinutes, gapMinutes)` — the frontend
   never references this at all (grep confirms zero hits under
   `apps/web/src`). The board and the solver have drifted apart on what
   "one time step" means.
3. **Blackout windows have no real editor.** The backend `Blackout`
   type (`calendar.ts`) is fully supported by both solvers. The only
   creation path today is natural language through the AI schedule
   console. `constraints-panel.tsx` shows a read-only count whose own
   helper string tells the organiser to "edit them on the constraints
   panel" — which is the same panel, and cannot. A dead-end pointer,
   independent of anything else in this doc.
4. **Removing a court from settings is completely unguarded.** Found
   while tracing the schedule board's rendering, not part of the
   original ask. `settings-panel.tsx`'s save path
   (`PUT /api/v1/divisions/:id/schedule-settings` →
   `putScheduleSettings`) only checks feature entitlement and
   frozen-competition state — nothing reads `Assignment.court` or
   checks for pinned/locked fixtures before persisting a court removal.
   The consequence is real: a **pinned** fixture on the removed court
   is exempt from AUTO's own cleanup filter and stays there forever;
   REFLOW's move-minimizing objective will typically leave it there too
   (moving it costs `k`, staying doesn't); the raw board grid drops the
   card from view entirely (matches no column, not even "unassigned")
   until a separate disruption-signal system catches up and raises an
   amber repair banner.

## Decisions

### 1. One shared component, native inputs, no custom picker

Componentize the six existing ad-hoc declarations into one shared
`<DateTimeField>`-style component, wrapping the same native
`<input type="date"|"time"|"datetime-local">` elements — not a
custom-built picker. Two real options were compared:

- **Native, componentized (chosen)**: fixes the actual problem
  (duplication, drift risk), keeps free OS-native accessibility and
  mobile picker UX, matches this repo's existing convention (native
  inputs + shared class is already the division-wizard pattern the
  "consistent inputs" rule points at).
- **Custom-built picker (rejected for now)**: the only real reason to
  want one is showing blackout/unavailable ranges shaded inline while
  picking a time — which native inputs structurally cannot do at all,
  componentized or not. There is no partial version of this: it's a
  full custom-picker project, separately justified, only if that
  specific need gets evidenced (e.g. organisers repeatedly scheduling
  into a blackout by mistake). Nothing in the current ask requires it —
  the blackout editor (decision 3) is its own form, not a shading layer
  on every other picker.

Used everywhere existing native inputs are today, plus the new blackout
editor's from/to fields (decision 3).

### 2. Board segmentation matches the backend's real step

`slotMinutes` on the frontend is replaced by the same
`gridStepMinutes = gcd(matchMinutes, gapMinutes)` the backend lattice
already computes — not a snap-to-{15,30,60} display rule. Two
alternatives were considered and rejected: rounding to the nearest
"clean" bucket (disconnected from what the solver actually reasoned
about, and this repo's engine culture is explicit that a rendering
layer stating something the solver didn't compute is exactly the
placer/verifier-fork risk class); per-division/per-court independent
granularity (most accurate for mixed-duration boards, but real
rendering complexity not justified by anything asked for here — no
board in this app currently mixes wildly different match durations on
one shared view).

**Row height**: currently fixed (`h-10`) regardless of `slotMinutes`.
Recommendation: keep a minimum readable row height as a floor, let the
board get taller for finer segmentation rather than shrinking rows to
illegibility — matches how calendar UIs generally handle finer time
resolution (more rows, not smaller text). Vertical scroll in a bounded
container is normal, unlike the horizontal-scroll rule this repo
already enforces elsewhere. Verify with a screenshot at both desktop
and 375px during implementation rather than settling exact pixel
values in this spec.

### 3. Blackout editor supplements the AI console, doesn't replace it

A real form — built from the shared component (decision 1) — for
organisers to create/edit a `Blackout` window directly (from/to time,
optional court scope), living where `constraints-panel.tsx`'s current
read-only count and dead-end pointer are. The AI natural-language
console keeps working exactly as it does today for fast entry; the
form is for organisers who want exact minute ranges or want to
review/adjust what the AI proposed before it's applied. Both write into
the same structured `Blackout` rule — no parallel/competing
representations.

Fixes the broken pointer string (`boardset.customWindows`) as part of
this work, independent of everything else — it's currently telling
users to do something impossible regardless of scope.

### 4. Block, don't just warn, on removing a court with pinned/frozen fixtures

Given what happens today if it's allowed (a pinned fixture becomes
permanently stuck, invisible in the raw grid until a delayed signal
catches it), the save path (`putScheduleSettings`) gets a check: if the
court being removed has pinned or frozen fixtures currently assigned to
it, the save is rejected with a clear count ("2 pinned matches are on
Court 2 — unlock or move them first") rather than silently accepted and
left for the disruption-signal system to catch after the fact. This is
the recommended default, not fully locked — see open item 2 below for
the one place this could instead be an override-with-confirmation. An unlocked, unpinned fixture on the removed court is not
blocked — AUTO already relocates those correctly today
(`restrictToConfiguredCourts`); only the currently-unrecoverable case
(pinned/frozen) is guarded.

## i18n / mobile / consistency

All net-new user-facing strings (blackout editor labels, the new
court-removal rejection message) go in all 4 locale dictionaries — no
hardcoded English outside `content/help/**`. Blackout editor and the
court-removal warning both verified at 375px with no horizontal page
scroll, per this repo's standing mobile rule. The shared date/time
component inherits the division-wizard's existing input sizing
(`text-base sm:text-sm`, no `text-xs`/`py-1` shrink variants) rather
than introducing a new size scale.

## Testing

- Existing tests that pin current behavior and need review before
  touching the relevant files: `schedule-board-polish.test.tsx`,
  `schedule-board-day-tab.test.tsx` (board-grid rendering/interaction),
  `disruption-signals.test.ts` (already asserts `court_gone` detection
  — this test's expectations may need to change once removal can be
  blocked outright rather than merely detected after the fact).
- New regression tests owed: shared component used consistently across
  all conversion sites (no leftover ad-hoc native declarations); board
  row segmentation matches `gcd(matchMinutes, gapMinutes)` for a
  representative set of duration/gap pairs; blackout editor writes a
  `Blackout` the same solvers/verifier already accept, round-tripped
  through `validateAssignments`; court removal with a pinned/frozen
  fixture present is rejected with the correct count, removal with only
  unlocked fixtures present still succeeds.
- Every new/changed test fails without its corresponding fix — no
  regression test ships without first proving it catches the gap it
  names (matches this repo's standing rule).

## Open items

1. Exact component API shape (props, whether it wraps all three native
   input types or is three thin variants over one internal helper) —
   implementation detail, not a design fork.
2. Whether the court-removal rejection is a hard block or an
   override-with-confirmation — leaning hard block given the
   consequence is currently unrecoverable without manual cleanup, but
   worth a quick gut-check against how this repo handles other
   destructive-setting-change guards, if any exist, before implementing.
3. Row-height exact values — deferred to implementation + screenshot
   verification, per decision 2.
