# PROMPT-31 — Mobile & Responsive Overhaul (all console views)

**Read first:** `v3/02-mobile-responsive-overhaul.md` (normative); `v3/03-ui-system-refresh.md`
§3 (bottom-sheet modal); `v3/11-gaps-and-decisions.md` gaps 3, 11, 12, 15. Preamble:
PROMPT-00. **Depends:** PROMPT-32 only (primitives — build §3 sheet variant there first
or here, don't build twice); runs on pre-PROMPT-30 routes, components survive the later
route move (v3/11 gap 3). Do not run alongside PROMPT-30/33.

## Task
1. **Primitives** (v3/02 §2): `<ResponsiveTable>` (table→card under `sm`), sticky bottom
   action bar (safe-area aware), dialog→bottom-sheet behaviour, console-layout
   `overflow-x` guard with per-widget `overflow-x-auto` + edge fade, input font-size ≥16px.
2. **Org settings** (v3/02 §3.1): members table → cards with `⋯` menu; sticky section
   tabs; stacked forms.
3. **Billing** (v3/02 §3.2): plan card → invoices cards; full-bleed embedded checkout at
   375px (the reported break); trial callout full-width.
4. **Division console** (v3/02 §3.3): scrollable tab bar; entrants cards; standings
   sticky first column inside scroll container; score entry as bottom sheet.
5. **Sweep** (v3/02 §3.5): dashboard, competitions, clubs, people/players, import,
   registrations, my-matches, onboarding, admin — apply patterns only.
6. **Viewport gate** (v3/02 §4 + v3/11 gap 12): Playwright `mobile` project (375×667,
   390×844), `expectNoHorizontalScroll` on every audited route **plus public surfaces**
   (`/shared/*` dashboard/standings/schedule, registration, `/r/[ref]`, `/help`, pricing,
   home; slideshow exempt), page smokes (settings save, invoice render, score sheet
   submit); axe-core scan failing on serious/critical (v3/11 gap 11, WCAG 2.1 AA bar);
   LCP < 2.5s Fast-3G on public dashboard + registration (v3/11 gap 15); wire into CI
   smoke job.

## Acceptance
- `mobile` e2e project green on all audited routes; horizontal-scroll assertion fails if
  any page regresses (prove by reverting one fix locally).
- Embedded checkout completes on 375px emulation (Stripe test mode / SQL-flip fallback
  per test-infra memory).
- No dedicated mobile pages — same components, responsive patterns only.
- `npm test` + `tsc` green; smoke.ts unchanged paths still pass; update v3/README status.
