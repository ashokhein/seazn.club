# PROMPT-81 — Official marks & match reports: console + portal UI

**Goal:** SPEC-3's surfaces — "Rate official" scoreboard-digit tiles on the
fixture officials panel, marks summary on the org official profile, the
report form/drawer on `/me` and the console, the SPEC-1 pending-queue tag
for report-sourced suspensions, the `report_submitted` email — plus closing
passes (i18n, help, smoke, mobile screenshots).

**Read first:**
- `design/v16-league-ops/SPEC-3-official-marks-reports.md` — "UI surfaces",
  "Design direction", "Emails", "Gotchas".
- `design/v16-league-ops/README.md` — mobile acceptance criterion (binding:
  390×844 primary, ≥44px targets, both-viewport screenshots).
- PROMPT-80 interfaces — consume exactly `putMark`/`deleteMark`/
  `orgMarksSummary`/`myMarksAverage`/`getMyReport`/`putMyReport`/
  `submitMyReport`/`fixtureReports`.
- Fixture officials panel (console) — find via the assignment UI from v11
  (`officials` components; the panel showing accept/decline responses).
- `apps/web/src/components/officiating-lane.tsx` — the `/me` lane +
  `completed[]` disclosure (#122) where the report CTA rides.
- Org official profile/roster detail view (v11 roster edit work) — where the
  marks summary block mounts.
- `apps/web/src/components/discipline/discipline-panel.tsx` (PROMPT-79) — 
  pending rows get a `source: report` tag + link to the report drawer.
- compose.ts email conventions; i18n/help/smoke rails as in PROMPT-79.

**Depends:** PROMPT-80 merged; PROMPT-79 merged (card glyph component +
discipline panel tag). **No migrations.**

## Design contract (from SPEC-3 "Design direction" — binding)

- Signature: **mark entry = five scoreboard-digit tap targets** — Barlow
  Condensed numerals 1–5 in scorebug tiles, selected tile lit lime, one tap
  sets. **No star icons anywhere.** Component:
  `components/officials/mark-tiles.tsx`.
- Average = scorebug chip (big numeral, small `avg · n` label):
  `components/officials/mark-badge.tsx`. Official-facing badge renders only
  when `myMarksAverage` returns non-null (≥3 marks); below that show the
  "collecting marks" string.
- Report drawer: night panel; incidents rows led by the PROMPT-79
  `card-glyph` for `red_card`, plain chip otherwise; measure-limited body;
  submitted state = timestamp eyebrow, no success theatrics.
- Mobile-first: tiles ≥44px, report form one-handed ("refs file from the
  car park"). Comment field + forms on `.input`/`.label` defaults.

## Files

- **Create** `apps/web/src/components/officials/mark-tiles.tsx`
- **Create** `apps/web/src/components/officials/mark-badge.tsx`
- **Create** `apps/web/src/components/officials/marks-summary-block.tsx`
- **Create** `apps/web/src/components/officials/report-form.tsx`
  (draft/edit + incident rows + submit; person picker over both entrants'
  squads — the fixture payload already carries both entrant ids; fetch
  members via the existing squad read the discipline manual-form uses)
- **Create** `apps/web/src/components/officials/report-drawer.tsx`
  (console read view)
- **Modify** fixture officials panel — "Rate official" (mark-tiles inline,
  PlusReveal on 403) on accepted+decided rows; submitted-report chip opens
  `report-drawer`
- **Modify** org official profile — `marks-summary-block` (avg badge, count,
  last 5 comments)
- **Modify** `officiating-lane.tsx` — report CTA on `completed[]` rows
  (draft/submitted state chip; **keyed off the completed union, not a date
  window** — #122 lesson) + lane-header `mark-badge`
- **Modify** discipline panel — `source === "report"` rows tagged with a
  link opening `report-drawer`
- **Modify** `compose.ts` — `reportSubmitted` email → org owner/admins
  (fixture line, official name, incident count, deep link); sent inside
  `submitMyReport`'s transaction boundary (after commit — mirror how other
  usecase emails defer to after-commit)
- **Modify** i18n keys + 4 dictionaries (ui + emails)
- **Create/Modify** help: organiser marking article under the officials
  category + reports section in the officiating portal article; slug
  registry both ways
- **Modify** `scripts/smoke.ts` — pro path: decide fixture → PUT mark →
  summary avg updates; free path: mark PUT 403 + report still files (seed
  assignment + decided fixture FIRST — empty-data false-green lesson)
- **Create** `apps/web/e2e/official-marks-reports.spec.ts`

## Build steps

- [ ] **Step 1 — mark-tiles, test first.** Component test: renders five
  tiles, tap fires `onSet(4)`, selected tile carries the lit state +
  `aria-pressed`, keyboard operable (arrow/enter). FAIL → implement → PASS.
- [ ] **Step 2 — mark-badge + marks-summary-block.** Badge renders `4.2`
  + `avg · 17`; summary block lists recent comments with fixture labels.
  Under-3 official-facing state renders the collecting-marks string. Tests
  then implement.
- [ ] **Step 3 — Wire the console panel.** Accepted+decided rows only
  (window enforcement is server-side; the UI simply doesn't render tiles
  otherwise). PlusReveal for community orgs. Delete-mark affordance in a
  row overflow menu.
- [ ] **Step 4 — report-form + drawer + /me CTA.** Draft autosaves on blur
  (PUT), submit confirms once ("Submit report? You can't edit it after."),
  submitted renders read-only with timestamp eyebrow. Incident row: kind
  select, optional person picker, note (required). Drawer = same renderer
  read-only for organisers.
- [ ] **Step 5 — discipline-panel tag** (`report` source chip + drawer
  link) — one small render test in the panel's existing test file.
- [ ] **Step 6 — Email** + render test (subject/locale pins, system stack).
- [ ] **Step 7 — i18n + help closing pass** (parity + slug tests green).
- [ ] **Step 8 — e2e**: organiser rates accepted official after decided
  fixture → summary updates; claimed official (magic-link login) files
  report w/ red_card incident on a discipline-enabled org → pending
  suspension tagged report appears in the panel. Mobile project: mark tiles
  + report form flows.
- [ ] **Step 9 — Smoke** per Files. Run locally.
- [ ] **Step 10 — Screenshots** both viewports: tiles on the panel, profile
  summary, report form (mobile especially), drawer, /me lane badge. Fix
  what reads cramped.
- [ ] **Step 11 — Verify + commit.** `tsc` + unit + parity + e2e + smoke.
  Commit: `feat(officials): mark tiles, marks summary, match reports UI + email`.
