# 12 — Scheduling UX: Auto-Schedule & Drag-and-Drop

Extends `05-formats-progression-tiebreakers.md` §2.6 (the pure calendar pass) with the
product flow: how organisers get from "entrants registered" to "fixtures on a timetable".
Two entry modes, one editing surface.

## 1. Two options at division launch

After stage graph + entrants are set, the division offers exactly two primary actions:

### A. **Start tournament** (quick-start — today's v1 behaviour, preserved)
For club nights and same-day events. One click:
1. Generate fixtures for the first stage (05 §2.1–2.5).
2. Auto-slot *sequence only* — round order, court rotation; `scheduled_at` left null or
   set to rolling "now + round × matchMinutes" if `roundMinutes` configured.
3. Division → `active`, first-round fixtures → ready to score immediately.
No timetable editing, no publish step. Schedule can still be opened later (mode B tools
work on a started division).

### B. **Schedule** (plan-first — for leagues, weekend carnivals, multi-division events)
1. Generate fixtures (same generators — generation and slotting stay decoupled).
2. **Auto-schedule pass** (05 §2.6): inputs `{startAt, matchMinutes, gapMinutes,
   courts/venues[], perEntrantMinRest, blackouts[], sessionWindows[]}` → proposed
   `(fixture → datetime, court)` assignments + conflict list. Pure, deterministic,
   re-runnable.
3. **Drag-and-drop editor** (§2) to adjust.
4. **Publish schedule** — division event `schedule_published`; fixtures visible on the
   public dashboard schedule tab; `.ics` feeds go live; notifications (later, Inngest).
5. **Start tournament** becomes the second, separate action — scoring opens only after
   explicit start (`division_events: division_started`). Schedule ≠ started: an
   organiser can publish a timetable weeks ahead.

State machine:
```
setup ──start-now──────────────▶ active (unscheduled/rolling)
setup ──schedule→publish→start─▶ scheduled ▶ active (timetabled)
```

## 2. Drag-and-drop schedule board

One editing surface used by both modes (before or during play):

- **Grid**: columns = courts/venues (or days in week view), rows = time slots
  (`matchMinutes + gapMinutes` granularity). Fixture cards show round, entrants (or
  "Winner of QF1" for TBD feeds), division colour when the board spans a whole
  competition (multi-division view — doc 06 §4.3).
- **Drag** card → new slot: optimistic move + live re-validation. Violations render as
  badges on affected cards, never hard blocks (organisers know things the solver doesn't):
  - `conflict.court` — two fixtures, same court+time (this one *does* block — physically impossible)
  - `warn.rest` — entrant below `perEntrantMinRest`
  - `warn.person_overlap` — person rostered in two divisions playing simultaneously
  - `warn.order` — fixture scheduled before a fixture that feeds it (bracket dependency;
    blocks for direct feeds)
  - `warn.blackout` — inside a blackout window
- **Pin/lock** 🔒 per card: locked assignments survive re-running auto-schedule
  ("re-flow remaining" button = auto pass over unlocked fixtures only, treating locked
  ones as fixed obstacles).
- **Bulk tools**: shift round ±N minutes, swap two courts, clear day.
- Every edit = `division_events: schedule_edited {fixture, from, to}` — auditable, and
  the public dashboard/ics invalidate from the same write.

## 3. Data model deltas (extends doc 07)

```sql
alter table fixtures add column
  schedule_source text not null default 'none'
    check (schedule_source in ('none','auto','manual')),   -- manual = pinned/locked
  schedule_locked boolean not null default false;

create table schedule_settings (          -- per division (or competition-level default)
  division_id uuid primary key references divisions(id) on delete cascade,
  org_id uuid not null,
  config jsonb not null default '{}'      -- startAt, matchMinutes, gapMinutes, courts[],
                                          -- perEntrantMinRest, blackouts[], sessionWindows[]
);
```
`courts[]` live in config (labels), venues stay on fixtures. Later stages (knockout fed
from groups) schedule with TBD entrants — cards render feed labels; rest/overlap warnings
recompute automatically when entrants resolve.

Publish-gating (PROMPT-17): `divisions.status` gains the `scheduled` state (§1
machine), and `public_fixtures_v` nulls `scheduled_at/venue/court_label` while a
division is still in `setup` — so the public schedule tab, `/api/v1/public/...
/schedule` and the `.ics` feed reflect the published timetable only, from the
same view. Quick-start divisions jump straight to `active`, unaffected.

## 4. Engine/API surface (extends doc 08 §3)

```
GET/PUT /api/v1/divisions/{id}/schedule-settings
POST  /api/v1/stages/{id}/schedule/auto        # run/re-run pure pass; body {only_unlocked: true}
                                               # → {assignments, conflicts[]}; nothing persisted
POST  /api/v1/stages/{id}/schedule/apply       # persist an assignment set (from auto or editor)
PATCH /api/v1/fixtures/{id}                    # single move: {scheduled_at, court_label, schedule_locked}
POST  /api/v1/divisions/{id}/schedule/validate # full conflict report (board load + after external edits)
POST  /api/v1/divisions/{id}/publish-schedule
POST  /api/v1/divisions/{id}/start             # the "start tournament" action (both modes end here)
```
Auto pass runs `@seazn/engine` `scheduling/calendar.ts` — the engine stays pure; persist
is a separate step (propose → review → apply, same pattern as fixture generation).

PROMPT-17 implementation notes (deviations from the sketches above):
- Body field is `only_unlocked` (house snake_case JSON), not `onlyUnlocked`.
- Blocking writes (conflict.court, direct-feed warn.order) are rejected with
  `409 SCHEDULE_CONFLICT` carrying the conflict list; warnings ride along in
  200 responses and render as badges.
- A bulk apply appends ONE `schedule_applied {source, moves[]}` division event
  (each move still records `{fixture, from, to}`); single PATCH moves append
  `schedule_edited {fixture, from, to}` as specified.
- Session-window violations are reported under the `warn.blackout` code with
  detail "outside session windows" — the complement of the windows is treated
  as blackout time, keeping the §2 taxonomy closed.
- `warn.order` is emitted for direct winner/loser feeds (which block);
  non-direct (transitive) order warnings are a later refinement.
- `schedule_settings` also carries `tz` (§6 DST note) and `updated_at`.

## 5. Entitlements (extends doc 10)

| feature_key | Community | Pro |
|---|---|---|
| quick-start + basic auto (sequence, single court list) | ✓ | ✓ |
| `scheduling.constraints` (rest, blackouts, sessions, multi-court solver) | ✗ | ✓ |
| `scheduling.board` (drag-and-drop editor) | view-only | ✓ |
| multi-division board (competition-wide) | ✗ | ✓ |

## 6. Edge cases

- Re-generate fixtures after schedule edits (entrant withdrew): regeneration preserves
  assignments of unchanged fixtures (match by round+seq), orphans reported.
- Mid-play reschedule (rain): move remaining fixtures only; decided fixtures immutable.
- DST boundary in `sessionWindows` — store venue-local tz on schedule_settings.
- Two organisers editing the board: last-write-wins per fixture + realtime board refresh
  (`division:{id}` topic); no long-lived locks.
