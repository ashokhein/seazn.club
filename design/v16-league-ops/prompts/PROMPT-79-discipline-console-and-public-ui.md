# PROMPT-79 — Discipline: console, pad, public & /me surfaces

**Goal:** every SPEC-1 surface — Division Settings → Discipline tab (rules
editor), the Discipline panel (pending queue / active / history / manual
form), entrant chips, the score-pad soft warning, the public suspensions
strip, the `/me` card, both emails — plus the spec's closing passes (i18n
4-locale, help article, smoke, mobile screenshots).

**Read first:**
- `design/v16-league-ops/SPEC-1-discipline-suspensions.md` — "UI surfaces",
  "Design direction", "Emails".
- `design/v16-league-ops/README.md` — wave-wide design + **mobile acceptance
  criterion** (390×844 primary, ≥44px targets, screenshot both viewports).
- `apps/web/src/server/usecases/discipline.ts` — PROMPT-78's interfaces;
  consume exactly `getDisciplineRules` / `putDisciplineRules` /
  `listSuspensions` / `createManualSuspension` / `decideSuspension` /
  `activeSuspensionsByEntrant` / `publicSuspensions`.
- The division Settings tab pattern (v8): find the existing tab component
  via the division settings page under
  `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/` — mirror its tab
  registration, panel layout, and save flow.
- `apps/web/src/components/` — PlusReveal (Pro Plus disclosure, #125),
  entrants panel (badge chips precedent #130), score pads under
  `components/v2/pads/` (banner placement), officiating-lane.tsx (`/me` lane
  card idiom, #122).
- Public division page under `apps/web/src/app/(public)/shared/…/[divisionSlug]/`
  — standings strip placement; `public_person_name` consent helper usage in
  the stats table.
- `apps/web/src/lib/i18n-keys.ts` + `apps/web/src/dictionaries/en/ui.json`
  (fr/es/nl parity gate). `apps/web/src/emails/compose.ts` + an existing
  transactional email as template. `apps/web/content/help/` +
  `apps/web/src/lib/help.ts` slug registry. `scripts/smoke.ts` idioms.

**Depends:** PROMPT-78 merged. **No migrations.**

## Design contract (from SPEC-1 "Design direction" — binding)

- Signature: **card glyph** — small rounded-rect swatch tilted ~8°, yellow
  `#FBBF24` / red `#ef4444`, leading suspension rows, entrant chips, pad
  banner. One shared component: `components/discipline/card-glyph.tsx`.
- Served progress = **match pips** (`● ● ○`), one per match. Component:
  `components/discipline/serve-pips.tsx`. Never a percent bar.
- Pending rows: amber left border, "Pending review" eyebrow (Barlow
  Condensed caps). Confirm = primary, Waive = quiet, side by side.
- Pad banner: night bg, glyph, ONE sentence, dismissible, readable at a
  glance on mobile. Console tokens `.app-*`; public strip `--ps-*` zebra
  rhythm matching standings.
- Forms use `.input`/`.label` defaults (division-wizard look). Reduced
  motion respected (glyph static); visible focus on confirm/waive.

## Files

- **Create** `apps/web/src/components/discipline/card-glyph.tsx`
- **Create** `apps/web/src/components/discipline/serve-pips.tsx`
- **Create** `apps/web/src/components/discipline/rules-editor.tsx`
- **Create** `apps/web/src/components/discipline/discipline-panel.tsx`
- **Create** `apps/web/src/components/discipline/suspension-chip.tsx`
  (entrant chip + popover naming names)
- **Create** `apps/web/src/components/discipline/pad-suspension-banner.tsx`
- **Modify** division Settings page — register the Discipline tab (hidden
  when `getDisciplineRules` returns null; PlusReveal when 403)
- **Modify** division console page — mount `discipline-panel` beside the
  entrants panel
- **Modify** entrants panel — render `suspension-chip` from
  `activeSuspensionsByEntrant`
- **Modify** the pad shell (where sport pads mount) — banner when a recorded
  event's person has an active suspension (data via the existing pad
  bootstrap payload; extend it, don't add a client fetch)
- **Modify** public division page — "Suspensions" strip under standings from
  `publicSuspensions` (renders nothing when empty)
- **Modify** `/me` page — own-suspensions card (superuser read via
  person_claims, mirror the officiating lane's data path)
- **Modify** `apps/web/src/emails/compose.ts` — `suspensionConfirmed`,
  `suspensionServed` (courtside template, system font stack — PR #134)
- **Modify** `decideSuspension` call site server-side to send the email on
  confirm; the served flip inside `detectSuspensions` sends
  `suspensionServed` (claimed persons only — no person_claims row, no email)
- **Modify** `apps/web/src/lib/i18n-keys.ts` + all four `ui.json` +
  `emails.json` dictionaries
- **Create** `apps/web/content/help/divisions/discipline.md` + register slug
- **Modify** `scripts/smoke.ts` — pro path: enable rules → seed 5 yellows →
  pending appears → confirm → active listed + public strip shows it (seed
  BEFORE checking — empty-doc false-green lesson); free path: rules PUT 403,
  Settings tab shows PlusReveal
- **Create** `apps/web/e2e/discipline.spec.ts`

## Build steps

- [ ] **Step 1 — Components first, tests first.** Vitest component tests
  (existing jsdom convention — note some suites run node-env without jsdom;
  put component tests where other component tests live): `serve-pips`
  renders M pips with N filled + accessible label "2 of 3 matches served"
  (i18n key); `card-glyph` renders color by prop, `aria-hidden` (decorative,
  the row text carries meaning). FAIL → implement → PASS.
- [ ] **Step 2 — Rules editor.** Rows over `sportColors` from
  `getDisciplineRules` (accumulation: color select / count / ban_matches;
  dismissal: color / ban_matches; add/remove row). Prefill sport defaults
  when the rules doc is empty — defaults come from a
  `defaultRulesFor(sportColors)` helper in the component module, football
  shape per SPEC-1. Save via PUT; disable toggle. Test: renders from a
  rules doc; save posts the edited doc verbatim.
- [ ] **Step 3 — Discipline panel.** Three sections (Pending / Active /
  History) + "Record suspension" form (person picker over division squad —
  reuse the entrants panel's member query rail). Confirm/waive/adjust wire
  to `decideSuspension`; `triggerVoided` renders the hint chip "trigger card
  was voided". e2e covers the flow end-to-end (Step 7).
- [ ] **Step 4 — Chips, pad banner, public strip, /me card** per the Files
  list. Pad banner: extend the pad bootstrap payload with
  `activeSuspensions: {personId, personName, served, total}[]` (server-side
  join, no client fetch); show banner when an attributed event's person
  matches; sentence: "{name} is suspended ({served} of {total} served) —
  recording anyway".
- [ ] **Step 5 — Emails.** `suspensionConfirmed` + `suspensionServed` in
  compose.ts; render test pins subject + key strings per locale (mirror
  email-html-templates.test.ts patterns, system font stack asserted).
- [ ] **Step 6 — i18n + help.** Every string a typed key, en/fr/es/nl filled
  (parity test green). Help article: what discipline does, rule examples,
  the voided-trigger behavior, consent note for public names. Slug registry
  bidirectional (`help-content.test.ts`).
- [ ] **Step 7 — e2e** (`discipline.spec.ts`): pro org → enable rules →
  score 5 attributed yellows across fixtures (magic-link login, SQL pro-flip
  per test-infra conventions) → pending row → confirm → entrant chip
  visible + public strip line + pad banner on next attributed event.
  Mobile: run the panel + pad-banner assertions in the mobile e2e project
  (mind its concurrency gotcha).
- [ ] **Step 8 — Smoke** per Files list. Run full smoke locally.
- [ ] **Step 9 — Screenshot-verify** (Playwright MCP, both viewports
  390×844 + desktop): Settings tab, panel with all three sections, entrant
  chip popover, pad banner, public strip, /me card. Fix anything that reads
  cramped BEFORE calling done.
- [ ] **Step 10 — Verify + commit.** `tsc` + unit + parity + e2e + smoke.
  Commit: `feat(discipline): console rules/panel, pad warning, public strip, /me, emails`.
