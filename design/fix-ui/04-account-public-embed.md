# UX Audit — Account (/me) + Public + Embed pages

Viewports: desktop 1440x900, mobile 390x844. Server: localhost:3000.
Pages covered: `/me` (empty + filled), `/my-matches` (empty), public competition page
(`/shared/[org]/[comp]`, desktop + mobile), public fixture/scorebug page
(`/shared/[org]/[comp]/[div]/fixtures/[id]`). Screenshots in `screenshots/04-*`.

Earlier attempt at this file was blocked by a shared-Playwright-browser collision across
parallel audit forks — that infra issue is now resolved (see `02-console-org.md` gotchas: stale
`SingletonLock` file was the cause). This is a full redo, not a continuation of the earlier
partial pass.

---

### [medium] `/me` — desktop — empty-state message stays visible and wrong even after the user IS rostered onto a team
**What I saw:** Tested with a claimed player account (`ashokhein+ref2-v11@gmail.com`, "Noah
Petit") that initially had no team/entrant membership at all — page correctly showed only the
"Nothing here yet. When an organiser rosters you into a team or draw, your matches land on this
page." card, and nothing else. After rostering the same account onto an existing entrant (Riverside Sports Club, Badminton
Singles A) directly in the dev DB to test the filled path (reverted after this screenshot),
`/me` now shows a new "MY TEAMS"
section listing "Asha · Badminton Singles A · Riverside Sports Club" — correct — but the
"Nothing here yet... When an organiser rosters you..." card ABOVE it is unchanged and still
claims the user hasn't been rostered. See `screenshots/04-me-filled-desktop.png`. The message
conflates two different things: "not rostered onto any team" vs. "rostered, but no fixtures
scheduled yet" — only the first should show this copy.
**Fix prompt:** In the `/me` page component (`apps/web/src/app/me/page.tsx`), the empty-message
condition is likely keyed off `upcoming.length === 0 && results.length === 0` without checking
whether the user has any entrant/team memberships at all. Split the condition: if the user has
0 team memberships, show the current "get rostered" message; if they have ≥1 team membership
but 0 fixtures, show a different message (e.g. "You're on a team — matches will appear here
once your organiser schedules them") so the copy matches what's actually true.

### [low] `/me` — desktop, empty state — excessive dead space below the empty-state card
**What I saw:** With zero team memberships, the page renders header + one centered white card,
with everything below ~290px of a 900px viewport left as empty cream background — no
illustration, no secondary content. Feels unfinished relative to the rest of the app's polish.
**Fix prompt:** Add a lightweight empty-state illustration/icon above the message in `/me`'s
zero-membership branch, or vertically center the whole empty-state block in the viewport
instead of pinning it to the top.

### [OK] `/my-matches` — empty state, correctly scoped
**What I saw:** For an account with no scorer-role assignments, `/my-matches` shows "Nothing
assigned to you right now. Your organiser assigns matches — when they do, they show up here
ready to score." This is a genuinely different empty state from `/me` (scorer assignments vs.
player roster) and its copy accurately reflects the account's actual state — no bug.

### [medium] Public pages — mobile 390px — nav links ("Live scores · Schedules · Standings") disappear entirely, same pattern as marketing site
**What I saw:** At mobile width, the public org header only shows the org name/logo — the
"Live scores · Schedules · Standings" nav row from desktop (`screenshots/04-public-comp-desktop.png`)
is completely gone on mobile (`screenshots/04-public-comp-mobile.png`), no hamburger/menu
replaces it. This mirrors the marketing-site mobile nav gap already flagged in
`01-marketing-auth.md` — likely the same shared header component or the same missing pattern
implemented twice.
**Fix prompt:** Add a mobile nav affordance (hamburger/drawer, or convert to a bottom tab bar
given this is a spectator-facing scoreboard page) for Live scores/Schedules/Standings, matching
whatever fix is applied to the marketing header in `01-marketing-auth.md`.

### [medium] Floating help/chat FAB overlaps public-page content too — confirms it's a global-layout bug, not console-only
**What I saw:** Same bottom-left circular "N" FAB flagged as high-severity in `02-console-org.md`
and `03-console-division.md` also appears on public spectator pages, logged out, with no
console/account context at all. On mobile (`screenshots/04-public-comp-mobile.png`) it visibly
clips into the "Badminton Doubles" division card's sport-name label ("...minton" instead of
"Badminton"). This confirms the FAB is mounted at the root layout level (present on marketing,
console, and public routes alike) rather than being console-specific.
**Fix prompt:** Same fix as recommended in `01-marketing-auth.md` — this is one shared,
root-layout-level component; fixing its positioning once should resolve it across all three
audit files (marketing, console, public/account).

### [low] Public fixture (scorebug) page — "Time TBD" label looks odd on a fixture that's already LIVE
**What I saw:** The live Summit Athletic vs Oakwood United fixture page shows "Time TBD"
directly under the heading, while the scorebug below it clearly shows `LIVE` with a real
in-progress score. See `screenshots/04-public-fixture-desktop.png`. "Time TBD" reads as if the
match hasn't started, contradicting the live scorebug directly beneath it.
**Fix prompt:** Suppress the "Time TBD" subheading (or replace it with something like "Started"
+ elapsed time, if available) once a fixture's status is live/in-progress — the scheduled-time
label only makes sense pre-match. Likely in the fixture header component under
`shared/[org]/[comp]/[div]/fixtures/[id]/page.tsx`.

### [medium] TV slideshow/noticeboard view also shows the floating help FAB, obscuring the slide counter
**What I saw:** `/slideshow/competitions/[id]` (the auto-advancing noticeboard view meant for an
unattended TV/monitor display) still renders the bottom-left "N" help/chat FAB, which overlaps
the slide-counter text ("5" of presumably "1/5") in the bottom-left corner. See
`screenshots/05-slideshow.png`. Beyond the usual overlap issue, this view is explicitly designed
to run unattended on a screen nobody is meant to interact with — a clickable chat launcher has no
purpose here at all, unlike on interactive console/marketing pages.
**Fix prompt:** Beyond the general FAB-positioning fix already recommended elsewhere, consider
suppressing the FAB entirely on `/slideshow/*` and other kiosk/TV-display routes — it shouldn't
render at all on a route meant for a public unattended screen, not just be repositioned.

### [note, demo-data only] "Partners" section shows a sponsor named literally "test"
**What I saw:** Both the desktop and mobile public competition pages show a "Partners" section
with a link labeled "test" (`screenshots/04-public-comp-desktop.png`). This is leftover seed/demo
data, not a UI defect — flagging only in case it's mistaken for a rendering bug when reviewing
screenshots. No fix needed unless the demo dataset itself is being cleaned up.

## Login mechanics (for whoever continues this audit)
Dev-mode `POST /api/auth/magic-link` with `{"email": "..."}` returns `login_url` directly in the
JSON response (no real email needed, and no password field exists in the actual `/login` UI) —
navigate to that URL to authenticate as any account. Magic-link tokens expire quickly; request a
fresh one via curl each time rather than reusing an old link.

## Not reached this pass
`/r/[ref]` short-link redirect, poster.pdf generation output, `/slideshow/competitions/[id]`
auto-advancing slideshow, embed widgets (`<iframe>` embed snippets referenced in Settings →
Embeds, not directly navigated to), `/score/[token]` scorer-only entry link, public schedule
board and standings tabs (`Schedules`/`Standings` nav links on the public header, only the
competition-overview and one fixture page were checked), free-tier (Northside) equivalents of
all public pages, and the "Show my name/photo publicly" toggles' actual effect on the public
page (toggled but not verified against the public entrant listing).

## Summary
- Checked: `/me` (empty + filled, via a temporary DB-level test fixture, reverted after),
  `/my-matches` (empty), public competition page (desktop + mobile), one public fixture/scorebug
  page (desktop)
- Severity counts: 3 medium (stale empty-state copy, missing mobile public nav, FAB overlap
  confirmed cross-cutting), 2 low (empty-state dead space, "Time TBD" on a live match), 1
  demo-data note
- Top priority: **(1)** the FAB overlap fix already recommended elsewhere — this file adds
  confirmation it reproduces on logged-out public pages too, raising its priority as a
  site-wide fix, **(2)** the `/me` stale empty-state-copy bug is a real, reproducible logic
  bug worth a quick fix, **(3)** missing mobile nav on public pages, matching the marketing-site
  finding — likely fixable together
