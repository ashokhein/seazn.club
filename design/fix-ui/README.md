# UX/QA Audit — Index & Consolidated Priorities

Full manual Playwright pass across marketing + console + account + public/embed surfaces,
desktop (1440x900) and mobile (390x844), logged-out and logged-in, empty and filled data
states. Scope excluded `/admin` and `/games` per request. Screenshots in `screenshots/`.

## Files
- [`01-marketing-auth.md`](01-marketing-auth.md) — home, login/signup, pricing, formats,
  scheduling (+ interactive demo), use-cases, discover, live, help, developers, legal, `/start`
  funnel
- [`02-console-org.md`](02-console-org.md) — org home, new-competition wizard, settings tabs,
  directory, import (most thorough pass — 20 screenshots, 13 findings)
- [`03-console-division.md`](03-console-division.md) — competition detail, division
  fixtures/standings/stats tabs, Registrations panel
- [`04-account-public-embed.md`](04-account-public-embed.md) — `/me`, `/my-matches`, public
  competition + fixture (scorebug) pages, slideshow
- [`05-import-schedule-freetier.md`](05-import-schedule-freetier.md) — Import wizard
  upload/mapping, schedule board drag-and-place, free-tier spot-check

`00-audit-log.md` is a leftover raw-notes stub from before the per-area files existed; no
content of its own, safe to ignore/delete.

## Cross-cutting bugs (found on 4+ pages, across marketing/console/public — fix once, verify everywhere)

### 1. Floating help/chat FAB (bottom-left "N" bubble) overlaps content — HIGH
Found on: console org home + new-competition wizard + settings (mobile), division fixtures
(mobile), Registrations panel (mobile — overlaps the primary Save button), marketing home +
pricing (both viewports), public competition page (mobile), the TV slideshow/noticeboard view
(which shouldn't show an interactive FAB at all). This is a single root-layout-level component —
fix its positioning/z-index once (reserve bottom margin on content containers, move to
bottom-right, and suppress entirely on kiosk/slideshow routes) and it resolves across every file
in this audit. **Start here — highest ratio of impact to effort, and the widest blast radius of
any finding in this pass.**

### 2. English/French i18n leaks — MEDIUM–HIGH, systemic, found on 10+ distinct pages
The Riverside demo account's console renders in French, but leaks raw English in:
- "Next: Now: X vs Y" fixture-preview line (org home + competition/division cards) — two bugs
  stacked: (a) both "Next:" and "Now:" labels render together when they shouldn't, (b) the
  labels aren't localized.
- New-competition wizard: entirely English except one sub-block.
- Settings tabs (Organization/Team/API/Billing): mostly English body under French tab labels.
  Sponsors tab is the one correctly-localized reference implementation — use it as the template.
- Standings tie-break legend: English rule names inside a French caption.
- Registrations panel: H1 and breadcrumb segment ("Registrations") stay English.
- Schedule board: breadcrumb segment ("Schedule") and weekday-date tabs ("Fri 10 Jul") stay
  English.
- Import wizard: row-validation error messages and a raw `DIVISION_NOT_FOUND`-style badge.
- **Root cause pinpointed for one instance, likely explains others**: `/start` funnel's clickwrap
  legal notice renders the literal string `legal.notice.body` — traced to
  `start/page.tsx` wrapping its `DictProvider` in the narrow `marketing` namespace dict instead
  of the full `ui` catalog `LegalNotice` expects (`01-marketing-auth.md` has the full trace with
  file/line references). Worth checking whether other leaks above share this same
  wrong-DictProvider-scope root cause rather than each needing individually-added translation
  keys.

### 3. Mobile primary navigation silently disappears — MEDIUM
Marketing header (Formats/Scheduling/Pricing/Use cases) and public spectator-page header (Live
scores/Schedules/Standings) both drop their nav links entirely at 390px width, with no
hamburger/drawer replacement. Same gap, two different headers — likely fixable with one shared
mobile-nav pattern.

## Core-workflow bugs worth fixing soon (not cosmetic — these block real tasks)
- **Import wizard can't actually import into an existing division** — the Division-column
  matcher appears to require the division's URL slug, not its display name, so pasting in what
  the UI shows everywhere else fails with a wrong "division does not exist" error. Compounded by
  a second bug where 2 of 4 CSV columns silently fail to auto-map even when their names exactly
  match known field options. Two stacked high-severity bugs in one core feature —
  `05-import-schedule-freetier.md`.
- **Cricket T20 rounds display out of chronological order** — "Tour 3" is dated a day before
  "Tour 1"/"Tour 2", verified via full accessibility tree and independently re-confirmed with a
  standalone headless Playwright script — `03-console-division.md`.
- **Group-stage "Générer les matchs" shows a misleading "up to date" success message** when it
  actually generated zero fixtures (too few entrants) — organiser has no idea anything's wrong —
  `03-console-division.md`.
- **Settings tab bar (mobile) vanishes on scroll** — sticky offset collision, `02-console-org.md`
- **Product tour modal covers the empty-state CTA it explains**, brand-new org — `02-console-org.md`
- **Division fixture rows overlap their own status badges/buttons on mobile** — breaks the core
  matchday scoring workflow — `03-console-division.md`
- **`/me` empty-state message stays wrong after the user is actually rostered** onto a team but
  has no fixtures yet — `04-account-public-embed.md`
- **Registrations panel (mobile): FAB sits on top of the primary Save button** — see FAB
  cross-cutting note above, but flagged again here since it's blocking a save action specifically.

## Lower-priority / cosmetic
Truncated competition/division titles with no tooltip (`02-console-org.md`,
`03-console-division.md`), Pro-tier billing page sparser than free-tier equivalent, "Time TBD"
label on an already-live public fixture, dead whitespace on `/me` empty state, "test"-named
sponsor in demo data, E2E/seed-test records (dozens of "Discoverfest"/"Showcase Cup" entries)
publicly visible on `/discover` and `/live` (verify this doesn't reproduce on staging/prod — may
just be dev-DB seed pollution), registration-link input barely legible on mobile.

## Not reached (documented per-file, not guessed at)
Registrations modals beyond the main panel (waitlist promotion, individual entrant edit), a
fully-populated knockout/groups bracket visualization (no demo division had enough entrants),
embed widgets (no dedicated embeds/sharing tab found at org-settings level — may live elsewhere),
`/r/[ref]` short links, `/score/[token]` scorer link, Import wizard's final commit step, and a
full systematic free-tier (Northside) walkthrough (only spot-checked 2 pages — confirmed the
FAB overlap and billing-gating patterns match, but this account happens to be English-locale so
it can't be used to catch i18n regressions).
