# PROMPT-33 — Scheduling UX v3: Multi-Division Board + Division Schedule Page

**Read first:** `v3/04-scheduling-ux-v3.md` (normative); `engine/12-scheduling-ux.md`;
`engine/Jul3/03` (undo/locking), `engine/Jul3/04` (constraints — violation data source).
Preamble: PROMPT-00. **Depends:** PROMPT-31 (patterns), PROMPT-32 (chips/hues).

## Task
1. **Board v3** (v3/04 §2): courts × time grid, day tabs, single "Unassigned venue"
   fallback column; division hue bar + short-code chip per block; legend-as-filter with
   URL state (`?d=`); density modes Board / Agenda / By-division (persist per user);
   Agenda = mobile default.
2. **Conflicts panel:** violation badge count in header → side panel listing Jul3/04
   violations with jump-to-fixture; red corner tick on offending blocks.
3. **Unscheduled tray:** right dock / mobile bottom sheet, grouped per division with
   counts; drag-to-place (desktop) + tap-to-assign (tap fixture → tap slot) on touch.
4. **Division schedule page** (v3/04 §3, all 8 items): round grouping w/ date ranges;
   competition-timezone rendering + caption; pinned unscheduled section + auto-schedule
   CTA; status chips + inline scores + "Now playing" strip; tap-time inline reschedule
   (undo-able); bye/void ghost rows; mobile agenda w/ sticky day headers; print via
   Jul3/06 timetable export.
5. Keep all existing lock/undo/checkpoint affordances wired (no regression).

## Acceptance
- E2E on seeded 5-division comp (demo-data recipe): filter to 2 divisions in ≤2 taps
  (URL reflects it, shareable); injected rest-violation appears as badge + panel + jump;
  tap-to-assign schedules a fixture on 390px emulation; no page-level horizontal scroll.
- Division page: rounds grouped; reschedule → undo restores; timezone caption asserts
  competition tz, not browser tz (set TZ in test).
- `npm test` + `tsc` green; smoke.ts: board render + one reschedule on pro path; update
  v3/README status.
