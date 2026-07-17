# PROMPT-71 — Scheduler: multi-venue courts + open-window clipping

**Goal:** when a division has assigned venues, the scheduler's grid columns come
from those venues' courts, every fixture is confined to its court's venue open
hours, and each scheduled fixture records its `venue_court_id` (+ clean
`venue`/`court_label` for `.ics`). **Zero engine change** — pure config
generation. This is the wave's payoff.

**Read first — the engine (do NOT edit it, but understand it):**
- `packages/engine/src/scheduling/calendar.ts` — `SlotConfig` (`courts: string[]`,
  `sessionWindows?`, `blackouts`, `startAt`, `gapMinutes`, `horizonMinutes`),
  the `Blackout`/`SessionWindow` types (**both carry `court?`** — court-scoped
  when set, global when omitted), `courtBlocked(court, …)` (honours a
  court-scoped blackout), `sessionGaps(windows, lo, hi)` (window complement),
  `effectiveBlackouts(config, lo, hi)`. **Key fact this whole prompt rests on:**
  `courtBlocked` respects `blackout.court`, so a court-scoped blackout confines
  placement on *that* column only. Confirm this by reading `courtBlocked` before
  writing config-gen; if (unexpectedly) it ignores `court`, STOP and raise it —
  the design assumes it honours it.
- `packages/engine/src/scheduling/calendar.test.ts` — the engine test style;
  you'll add a court-scoped-blackout confinement test here.
- **Do not** use court-scoped `sessionWindows`: `effectiveBlackouts` reduces
  `sessionWindows` **globally** (no per-court filter), so a court-scoped session
  window would leak onto every column. Court-scoped **blackouts** are the correct
  mechanism.

**Read first — the wiring:**
- `apps/web/src/server/usecases/schedule.ts` — where `SlotConfig` is assembled
  from `schedule_settings.config` + `tz`, how local-time `sessionWindows` are
  converted to epoch (reuse that exact tz→epoch conversion for venue windows),
  and the fixture write at **~lines 524–526** (`update fixtures set scheduled_at
  = …, court_label = …`). You add `venue_court_id` + `venue` there.
  Also `slotFixtures` import (line 16) and how `courts`/`blackouts` reach it.
- `apps/web/src/server/usecases/venues.ts` / `venue-assignment.ts` (PROMPT-70) —
  `listDivisionVenues(auth, divisionId): Promise<VenueWithCourts[]>` (the source
  of courts + `openFrom`/`openTo`).
- `apps/web/src/server/api-v1/schemas.ts` ~line 607 — the schedule config zod
  (`courts: string[]`, `blackouts`, `sessionWindows`, `tz`). Add the optional
  `courtVenueCourtIds` map (below).
- `apps/web/src/components/v2/board/settings-panel.tsx` + `.../board/types.ts`
  — where courts are typed into the board today; make courts **derived
  (read-only)** from venues when the division has them, manual entry as fallback.
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx` and
  `.../c/[compSlug]/schedule/page.tsx` (line ~95 `allCourts` union) — the board
  server pages; source their courts from venues.
- `apps/web/src/app/(public)/…/calendar.ics/route.ts` (uses `f.venue` +
  `f.court_label` → `location`) and the fixture detail page (`fixture.venue`
  caption) — these get richer automatically once `venue`/`court_label` are set
  from the venue.
- `apps/web/e2e/helpers.ts` (`mintLoginPathBySql`, `addEntrantsViaApi`,
  `createStageAndGenerate`) + `project_stg_e2e_runs` memory for e2e conventions.

**Depends:** PROMPT-68, 69, 70 merged. **No migrations.**

## Context

Everything so far is inert until the scheduler reads it. Today an organiser types
court strings into the board config (`config.courts: string[]`) and the engine
places matches across them within one division-global window. Multi-venue breaks
both assumptions: courts come from N venues, and each venue has its **own** open
window — a Northside court must never take a fixture during Riverside's hours.

The engine already models this (court-scoped blackouts + a courts list). So the
whole job is a **config generator**: turn a division's assigned venues into
(a) a unique, venue-qualified `courts[]`, (b) a `label → venue_court_id` map, and
(c) court-scoped `blackouts` = the complement of each court's venue window over
the schedule horizon. Then, on write-back, translate the engine's column label
into clean stored fields.

## Decisions

- **New pure helper** `venueScheduleInputs` (in `schedule.ts` or a small
  `schedule-venues.ts` it imports) — unit-testable without a DB:

```ts
interface VenueCourtColumn { label: string; venueCourtId: string; venueName: string; courtName: string; }
interface VenueScheduleInputs {
  courts: string[];                          // unique venue-qualified labels, ordered
  columns: Record<string, VenueCourtColumn>; // label → identity for write-back
  blackouts: { court: string; from: number; to: number }[]; // court-scoped closed-hours
}
// Pure: venues already resolved; horizon + tz given.
export function venueScheduleInputs(
  venues: VenueWithCourts[],
  opts: { startAt: number; horizonMinutes: number; tz: string },
): VenueScheduleInputs;
```

  - **Label** = `"<venueName> · <courtName>"`; if two venues share a name,
    disambiguate with a numeric suffix so labels stay unique (engine uses them as
    column keys). `courtName`/`venueName` are preserved in `columns` for clean
    write-back.
  - **Window → blackout:** for each court whose venue has `openFrom`/`openTo`,
    for each calendar day intersecting `[startAt, startAt + horizonMinutes]` in
    `tz`, emit court-scoped blackouts for `[dayStart, open)` and `[close,
    dayEnd)`. Reuse `schedule.ts`'s existing local-time→epoch conversion. A venue
    with null hours ⇒ no blackout (open across the horizon).
- **schedule.ts assembly:** when a division has assigned venues
  (`listDivisionVenues`), the effective `SlotConfig.courts` = `venueScheduleInputs
  (...).courts`, and its `blackouts` = engine config blackouts (the organiser's
  manual ones) **plus** the venue court-scoped blackouts. When it has **no**
  assigned venues, behaviour is exactly as today (manual `config.courts`) — full
  backward compatibility.
- **Persisted map:** store `columns` (label→venueCourtId) alongside the run so
  write-back can resolve ids. Add optional `courtVenueCourtIds: Record<string,
  string>` to the schedule config zod; it's regenerated each schedule, not
  hand-edited.
- **Fixture write-back:** at the existing `update fixtures set …`, when the
  engine label resolves in `columns`, set `court_label = courtName`,
  `venue = venueName`, `venue_court_id = venueCourtId`. Unknown label (manual
  legacy) ⇒ leave `court_label` as-is, `venue_court_id = null`. This keeps
  `.ics` `location` = "Riverside (Court 1)" and the fixture caption correct for
  free.
- **Board UI:** if the division has venues, the settings-panel court list is
  **derived + read-only** (shows "from N venues") with a link to venue settings;
  manual court entry only when no venue is assigned.

## Files

- **Modify** `apps/web/src/server/usecases/schedule.ts` (config assembly +
  write-back) — or split the generator into **Create**
  `apps/web/src/server/usecases/schedule-venues.ts`
- **Create** `apps/web/src/server/usecases/__tests__/schedule-venues.test.ts`
  (pure generator) + extend `schedule.test.ts` (integration write-back)
- **Modify** `packages/engine/src/scheduling/calendar.test.ts` — court-scoped
  blackout confinement test (proves the mechanism the design relies on)
- **Modify** `apps/web/src/server/api-v1/schemas.ts` — `courtVenueCourtIds`
- **Modify** `apps/web/src/components/v2/board/settings-panel.tsx`, `types.ts`
- **Modify** the two board server pages (comp + division `schedule/page.tsx`)
- **Create** `apps/web/e2e/venue-scheduling.spec.ts`
- **Modify** `apps/web/content/help/scheduling/board.md` (+ `constraints.md`) —
  courts-from-venues + venue hours; keep registry green
- **Modify** `scripts/smoke.ts` — schedule a 2-venue division, assert confinement

## Interfaces (consumed / produced)

- **Consumes:** `listDivisionVenues` (70), `VenueWithCourts` (68),
  `slotFixtures`/`SlotConfig`/`Blackout` (engine).
- **Produces:** `venueScheduleInputs(...)` and the write-back that sets
  `fixtures.venue_court_id` — end of the wave; nothing downstream in v15.

## Build steps (TDD, bite-sized)

- [ ] **Step 1 — Engine confinement test (guards the core assumption).** In
  `calendar.test.ts`:

```ts
it("a court-scoped blackout confines placement to that column only", () => {
  // Court A blacked out 00:00–09:00; Court B fully open. A match that would
  // otherwise take 08:00 on A must go to B (or wait), never place on A pre-09:00.
  const res = slotFixtures(/* 1 fixture, courts:["A","B"], blackout {court:"A", from:0, to:9*60*60_000} */);
  expect(res.assignments.find((a) => a.court === "A" && a.startAt < 9*60*60_000)).toBeUndefined();
});
```
  Run: `npx vitest run packages/engine/src/scheduling/calendar.test.ts`
  Expected: **PASS already** (mechanism exists). If it FAILS, the design's
  zero-engine-change premise is wrong — stop and escalate.

- [ ] **Step 2 — Failing generator test.** Create `schedule-venues.test.ts`
  (pure, no DB):

```ts
it("unions courts across venues and blacks out each court's closed hours", () => {
  const venues = [
    mkVenue("Riverside", { openFrom: "09:00", openTo: "22:00" }, ["Court 1", "Court 2"]),
    mkVenue("Northside", { openFrom: "18:00", openTo: "22:00" }, ["Pitch A"]),
  ];
  const out = venueScheduleInputs(venues, { startAt: DAY_09_LOCAL, horizonMinutes: 24*60, tz: "Europe/London" });
  expect(out.courts).toEqual(["Riverside · Court 1", "Riverside · Court 2", "Northside · Pitch A"]);
  // Northside pitch is closed 00:00–18:00 → a blackout covering 09:00 exists on it
  const nb = out.blackouts.filter((b) => b.court === "Northside · Pitch A");
  expect(nb.some((b) => b.from <= NINE_AM && b.to > NINE_AM)).toBe(true);
  // Riverside court is open at 09:00 → no blackout spanning 09:00
  const rb = out.blackouts.filter((b) => b.court === "Riverside · Court 1");
  expect(rb.some((b) => b.from <= NINE_AM && b.to > NINE_AM)).toBe(false);
  expect(out.columns["Northside · Pitch A"]!.courtName).toBe("Pitch A");
});

it("a venue with null hours adds a column but no blackout", () => {
  const out = venueScheduleInputs([mkVenue("Open", {}, ["C1"])], { startAt: 0, horizonMinutes: 60, tz: "UTC" });
  expect(out.courts).toEqual(["Open · C1"]);
  expect(out.blackouts).toEqual([]);
});
```
  Run: `npx vitest run apps/web/src/server/usecases/__tests__/schedule-venues.test.ts`
  Expected: FAIL — `venueScheduleInputs` undefined.

- [ ] **Step 3 — Implement `venueScheduleInputs`.** Pure function: build ordered
  unique labels, `columns` map, and per-day window-complement court-scoped
  blackouts using the same tz→epoch conversion `schedule.ts` uses for
  `sessionWindows` (import/extract it so there's one implementation). Handle
  null hours, day boundaries across the horizon, and label collisions.

- [ ] **Step 4 — Generator test green.**
  Run: same as Step 2 → PASS (both).

- [ ] **Step 5 — Failing integration test.** In `schedule.test.ts` add: seed a
  division with two assigned venues (Riverside 09–22 / Northside 18–22), generate
  fixtures, run the schedule, assert (a) fixtures exist on both venues' courts,
  (b) **no** fixture on a Northside court starts before 18:00, (c) each scheduled
  fixture row has a non-null `venue_court_id` and `venue` = the venue name.
  Run it → FAIL (schedule.ts not yet reading venues).

- [ ] **Step 6 — Wire schedule.ts.** In the `SlotConfig` assembly: if
  `listDivisionVenues(auth, divisionId)` is non-empty, replace `courts` with the
  generator's and append its `blackouts`; stash `columns` (persist
  `courtVenueCourtIds` = label→venueCourtId in config). In the write-back
  (`update fixtures set …`), resolve the engine label via `columns` and set
  `court_label`/`venue`/`venue_court_id`. No-venue divisions unchanged.
  Run: Step 5 test → PASS.

- [ ] **Step 7 — Board UI derives courts.** In the board server pages, when the
  division has venues, pass the derived court labels and render the settings-panel
  court list read-only ("Courts come from 2 venues — edit in Venue settings",
  linked). Manual entry stays only when no venue is assigned. Add/adjust the
  `types.ts` shape if needed.

- [ ] **Step 8 — Board test.** Extend the board/settings-panel test: given a
  division with venues, the court list is read-only and shows the venue-derived
  labels; given none, manual entry still works.
  Run: `npx vitest run apps/web/src/components/v2/board` → PASS.

- [ ] **Step 9 — e2e.** `apps/web/e2e/venue-scheduling.spec.ts`: as an organiser
  (seed via helpers), create 2 venues with courts + hours, assign both to a
  division (Pro seed), generate + schedule, open the board, assert columns show
  both venues' courts and that no card sits in a closed Northside slot; open a
  scheduled fixture and see "Riverside (Court 1)". Follow the e2e prod-target
  conventions (`E2E_PROD_TARGET`, `mintLoginPathBySql`).
  Run: the e2e invocation for this spec → PASS.

- [ ] **Step 10 — Smoke.** `scripts/smoke.ts` (pro): schedule a 2-venue division,
  assert every fixture's `scheduled_at` falls inside its court's venue window and
  `venue_court_id` is set. (Free path: single-venue schedule still works.)
  Run: `npm run smoke` → PASS.

- [ ] **Step 11 — Help closing pass.** Update `content/help/scheduling/board.md`
  and `constraints.md`: courts now come from assigned venues; venue open hours
  clip the schedule; cross-link `scheduling/multiple-venues` + `getting-started/
  venues`. Keep the registry bidirectional.
  Run: `npx vitest run apps/web/src/server/__tests__/help-content.test.ts` → PASS.

- [ ] **Step 12 — Verify + commit.**
  Run: `npx tsc -p apps/web --noEmit` → 0; `npx tsc -p packages/engine --noEmit` → 0.
  Run: `DATABASE_URL=$DATABASE_URL npx vitest run` → green; engine suite green.
  ```bash
  git add apps/web/src/server/usecases apps/web/src/server/api-v1/schemas.ts \
          packages/engine/src/scheduling/calendar.test.ts \
          apps/web/src/components/v2/board apps/web/src/app/o \
          apps/web/e2e/venue-scheduling.spec.ts \
          apps/web/content/help/scheduling scripts/smoke.ts
  git commit -m "feat(venues): scheduler reads venue courts + clips to venue hours; writes venue_court_id"
  ```

## Non-goals

- No engine changes (config-gen only). No per-court hours. No public venue map.
- No cross-competition venue clash detection. No reflowing already-scheduled
  fixtures when a venue's hours change (next schedule run picks it up).

## Done when

- A division with two venues schedules across both venues' courts, and **no**
  fixture lands outside its court's venue open window (engine + generator +
  integration + e2e all assert this).
- Scheduled fixtures carry `venue_court_id`, and `.ics`/fixture caption show
  "Venue (Court)". No-venue divisions behave exactly as before.
- Board shows venue-derived courts read-only (manual fallback intact).
- `tsc` (web + engine) clean; unit + engine + board + e2e + smoke + help all
  green. Committed.
