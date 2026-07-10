# v3/02 — Mobile & Responsive Overhaul

## 1. Problem

Organisers run tournaments from the sideline on a phone; the console was built desktop-first.
Named offenders from intake: **org settings** (#1), **payment detail view** (#3), and "all
mobile views" (#2). Root causes are systemic, not per-page: data tables with fixed column
counts, side-by-side flex rows that never wrap, dialogs sized in `px`, actions placed
top-right (thumb-unreachable), and no viewport regression gate so fixes rot.

Strategy: define **five reusable patterns**, apply them page-by-page in priority order,
and add a Playwright viewport suite so regressions fail CI.

## 2. The five patterns

1. **Table → card list under `sm`.** Every data table gets a stacked card rendering
   (primary line = entity name, secondary = 2–3 key fields, actions in overflow `⋯` menu).
   Implement once as `<ResponsiveTable columns rows renderCard>`; tables opt in.
2. **Sticky bottom action bar.** Primary page action (Save, Generate, Start) docks to a
   safe-area-aware bottom bar on mobile (`env(safe-area-inset-bottom)`), inline on desktop.
3. **Dialog → bottom sheet.** The shared modal (v3/03 §3) renders as a bottom sheet under
   `sm` — full-width, drag-handle, max-height 85vh, internal scroll.
4. **No horizontal scroll, ever (page level).** `overflow-x-hidden` guard on the console
   layout; anything genuinely wide (schedule board, brackets, standings) scrolls inside
   its own `overflow-x-auto` container with a visible edge-fade affordance.
5. **Touch targets ≥44px, forms full-width.** Inputs stack single-column under `sm`;
   tap targets padded; font-size ≥16px on inputs (blocks iOS zoom-on-focus).

Tokens: keep the existing Tailwind v4 setup (`--breakpoint-xs: 30rem` already defined);
the work is applying patterns, not inventing breakpoints.

## 3. Page-by-page audit (priority order)

### 3.1 Org settings (`/settings`, intake #1)
427-line page: account section, members table, org rename, API keys, danger zone.
- Members table → pattern 1 (card: name/email, role chip, `⋯` for role-change/remove).
- Section nav becomes sticky top tabs on mobile (Account · Members · Organisation · API ·
  Danger) instead of one long scroll with desktop-width rows.
- Role selects and invite form stack; invite button full-width.

### 3.2 Billing / payment detail (`/settings/billing`, intake #3)
- Plan card first (current plan, renewal date, CTA per `billingCtaLabel()`), then invoices.
- Invoice table → pattern 1 (date + amount primary, status chip, PDF link).
- Embedded Stripe checkout: container must be full-bleed on mobile (`w-full`, no fixed
  min-width parent); test at 375px — this is the reported breakage.
- Trial banner ("Add a card to keep Pro →") becomes a full-width callout above the plan card.

### 3.3 Division console (`/divisions/[id]`, all tabs)
- Tab bar: horizontal scroll with edge fade (no wrapping into two rows).
- Entrants tab: table → cards; bulk-import buttons into a `⋯` menu.
- Standings: this one **stays a table** (comprehension depends on columns) inside pattern-4
  scroll container; freeze the first column (`position: sticky; left: 0`).
- Fixtures list: already list-like; enforce patterns 2/5 (score entry = bottom sheet).

> **Implementation note (PROMPT-31, 2026-07-10):** entrants (and the other v2
> panels) kept their tables inside pattern-4 scroll containers instead of a card
> rewrite — the rows embed roster editors whose card form is a bigger redesign;
> `<ResponsiveTable>` exists for the next table that opts in. Score entry stayed
> on the fixture page (its dialogs now render as bottom sheets via the shared
> modal); the dedicated score-sheet bottom sheet folds into v3/04's board work.

### 3.4 Schedule board — deferred to v3/04 (its own redesign; mobile agenda view there).

### 3.5 Remaining sweep
Dashboard, competitions list (cards via v3/03 §2), clubs, people/players, import wizard,
registrations panel, my-matches, onboarding, admin. Each gets the patterns; none gets a
bespoke design.

## 4. Regression gate

- Playwright project `mobile` (existing e2e conventions per test-infra memory): iPhone SE
  375×667 + iPhone 14 390×844.
- Shared assertion helper `expectNoHorizontalScroll(page)`
  (`document.documentElement.scrollWidth <= clientWidth`) run on every audited route,
  logged-in via the magic-link `login_url` trick.
- Per-page smoke: settings save, invoice list render, score entry sheet open/submit.
- CI: add the `mobile` project to the existing smoke job.

## 5. Out of scope (tracked elsewhere)

Offline scoring PWA + installability = engine/16 §1.2 / PROMPT-20b (memory: 20b is next
in the PROMPT-20 sequence anyway — this doc deliberately does not duplicate it).

Related: [[v3/03]] primitives used by the patterns; [[v3/01]] header/breadcrumb on mobile.
