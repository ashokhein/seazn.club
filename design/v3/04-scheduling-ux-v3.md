# v3/04 — Scheduling UX v3: Multi-Division Board & Division Schedule Page

Extends engine/12 (scheduling UX) and Jul3/03/04 (undo, constraints). This doc is purely
presentational — the scheduler, constraints and history engines are done; the *views*
collapse under real load (intake #13: "5 divisions… ugly"; #14: division schedule page
"lots of things").

## 1. Diagnosis

The competition schedule board renders every division's fixtures in one undifferentiated
timeline. At 1–2 divisions it works; at 5+ it becomes a wall: no grouping, no colour
identity, filters absent, conflicts invisible until you scroll, and on mobile it's
unusable (drag-and-drop only).

## 2. Competition board v3 (intake #13)

**Model the venue, not the list.** Organisers think in *courts × time*; divisions are an
overlay, not the axis.

```
            Court 1        Court 2        Court 3        Court 4
 09:00   ┌──────────┐   ┌──────────┐   ┌──────────┐
         │▍U16B #3  │   │▍U16G #1  │   │▍Open #7  │      ← ▍ = division hue (v3/03 §1)
 09:40   └──────────┘   └──────────┘   └──────────┘
         ┌──────────┐        ⚠ rest    ┌──────────┐
 10:20   │▍U16B #4  │      conflict    │▍U18B #2  │
```

- **Axes:** rows = time slots, columns = courts/pitches (falls back to a single "Unassigned
  venue" column when no venues configured). Day tabs across the top for multi-day events.
- **Division identity:** 3px hue bar + short code chip (`U16B`) on every fixture block —
  same hue as the division's card (v3/03). Legend row doubles as the **division filter**:
  tap chips to isolate any subset; state in the URL (`?d=u16b,u16g`) so views are shareable.
- **Density modes:** `Board` (grid above) · `Agenda` (chronological list grouped by
  time — the mobile default and the ≥8-division fallback) · `By division` (swimlane per
  division, collapsible — the current mental model, kept for those who want it).
- **Conflicts surfaced, not buried:** constraint violations (Jul3/04) render as a badge
  count in the header → tapping opens a side panel listing each violation with a "jump to
  fixture" link. Blocks with violations get a red corner tick.
- **Unscheduled tray:** docked right (desktop) / bottom sheet (mobile) with per-division
  grouping and a count pill; drag out to place, or tap-to-assign on mobile (tap fixture →
  tap slot) since HTML5 DnD is hostile on touch.
- Locking/undo affordances from Jul3/03 stay where they are (pins, history panel).

## 3. Division schedule page fix list (intake #14)

Enumerated so "lots of things" becomes checkable:

1. **Round grouping:** fixtures grouped under round/leg headers (R1, R2… or Swiss round
   n) with the round's date range; today's flat list loses structure the engine has.
2. **Timezone honesty:** all times rendered in the competition timezone with a one-time
   "Times shown in {tz}" caption; no browser-local surprises.
3. **Unscheduled section** pinned at top with count + "Auto-schedule remaining" CTA,
   instead of interleaving TBD rows.
4. **Status at a glance:** every row shows the status chip vocabulary (v3/03 §1); decided
   rows show the score inline; `in_play` rows float to a "Now playing" strip on top.
5. **Inline reschedule:** tap time → time picker popover (writes through the normal
   schedule endpoint, undo-able via Jul3/03) — no navigation to the board for one change.
6. **Bye/void clarity:** byes render as ghost rows ("R2 · Dev has a bye"), voided fixtures
   struck through with reason.
7. **Mobile:** agenda layout, sticky day headers, tap-to-assign (no drag).
8. **Print/share:** "Print schedule" uses the Jul3/06 DocModel timetable export rather
   than `window.print()` CSS luck.

## 4. Acceptance sketch

Seed (memory: demo-data recipe) a competition with 5 divisions × mixed kinds; board must:
filter to any division subset in ≤2 taps, show zero horizontal page scroll on 390px
(board scrolls internally, v3/02 pattern 4), surface an injected rest-conflict as badge +
panel, and place an unscheduled fixture via tap-to-assign on mobile emulation.

Related: [[v3/02]] patterns, [[v3/03]] chips/hues, Jul3/03 undo, Jul3/04 constraints,
engine/12 quick-start vs plan-first flows (unchanged).
