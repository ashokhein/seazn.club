# UX Audit — Competition + Division drill-down pages

Scope: `/o/[org]/c/[comp]` (competition detail, divisions list), `/o/[org]/c/[comp]/d/[div]` tabs
(Rencontres/Fixtures, Classement/Standings, Statistiques/Stats, Participants). Account: Riverside
Sports Club (pro, French locale), competitions "Summer League 2026" (live, filled) and "Summer
Smash Demo" (draft, empty/near-empty divisions). Viewports: desktop 1440x900, mobile 390x844.
Screenshots in `screenshots/03-*`.

---

### [high] Division fixtures list — mobile 390px — fixture rows overlap their own status badges/buttons
**What I saw:** On the Rencontres (fixtures) tab at mobile width, each fixture row's team names
("Riverside FC contre Summit Athletic") render UNDERNEATH the row's own "Non Planifié" / "Décidé"
/ "Afficher" badges and buttons instead of stacking below them — text and interactive controls
visually collide, both are barely readable. See `screenshots/03-division-fixtures-mobile.png`
(Tour 1/2/3 rows). This is the exact fixture list an organiser needs on-site during a live
match, so it's high severity despite low visual polish elsewhere on the same page. The floating
help/chat FAB (already flagged in `02-console-org.md` as a systemic bug) also sits directly on
top of the "Tour 1" section header here.
**Fix prompt:** Find the fixture row component in the division detail page (likely
`o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsz` fixtures-tab sub-component, or a shared
`FixtureRow`). At the mobile breakpoint it needs to switch from a side-by-side flex layout
(team names left, badges/buttons right, both same line) to a stacked layout (team names on
their own line, badges/buttons wrapping to a second line below), rather than letting them
overlap when the row runs out of horizontal space. Verify with real device width after fixing
that "Score"/"Modifier l'heure"/"Déplanifier" buttons are all tappable without overlapping text.

### [medium] Division tab bar — mobile 390px — 2 of 5 tabs (Statistiques, Paramètres) are scrolled off-screen with no visual affordance
**What I saw:** The tab row (Participants/Rencontres/Classement/Statistiques/Paramètres) is
horizontally scrollable on mobile (confirmed via DOM: `scrollWidth` 563px vs `clientWidth`
358px) but there's no fade/shadow/arrow hinting more tabs exist past "Classement" — it looks
like only 3 tabs are available unless a user thinks to swipe the tab bar itself.
**Fix prompt:** Add a scroll-affordance to the tab row (a right-edge fade-out gradient mask, or
a small chevron/arrow) so users know Statistiques and Paramètres are reachable by swiping. This
compounds with the sticky-tab-bar bug already flagged in `02-console-org.md` (settings pages) —
likely the same shared tab-row component used across settings and division pages, so fixing the
component once should cover both.

### [medium] Competition-level tie-break legend leaks English, same pattern as elsewhere
**What I saw:** On the Classement (Standings) tab, the tie-break cascade caption reads
`Cascade de départage : points → head-to-head → head-to-head difference → head-to-head scoring
→ goal/run difference → goals/run scored → fair play → drawing of lots (par défaut du sport)` —
only the first 3 words and the final parenthetical are French; the entire tie-break criteria
list in between is untranslated English. See `screenshots/03-division-standings-desktop.png`.
Also the standings table column headers (`TEAM`, `P`, `W`, `L`, `GF`, `GA`, `GD`, `PTS`) stay in
English abbreviations while everything else on the page is French — this one may be intentional
(sport-stat abbreviations are often left universal/English even in localized apps) but "TEAM"
specifically reads oddly next to fully-French labels elsewhere on the same card.
**Fix prompt:** Locate the tie-break cascade caption (likely built by joining an array of
tie-break rule names — `pts/h2h/h2h-diff/h2h-scoring/goal-diff/goals-scored/fair-play/lots` —
with arrows) and route each rule name through the `ui` message catalog (`msgFor`/`useMsg()`)
the same way the rest of the standings page is localized, rather than using raw English rule
names. Confirm with the team whether `TEAM`/`P`/`W`/`L`/`GF`/`GA`/`GD`/`PTS` column headers
should also be localized or are intentionally kept as universal stat abbreviations.

### [medium] Division card title truncates even with ample horizontal space
**What I saw:** On the competition detail page (`/o/[org]/c/summer-smash-demo`), the division
card titled "Open Singles" renders as "Open Sin…" with a mid-word ellipsis, even though the
page only has 2 division cards on a 1440px-wide row with hundreds of pixels of empty space to
the right. See `screenshots/03-comp-empty-divisions-desktop.png`. There's no `title` attribute
for a hover tooltip either, so the full name isn't recoverable without opening the division.
**Fix prompt:** The division card title element likely has a fixed `max-width` or `truncate`
class sized for a worst-case (many-cards) layout rather than sizing to its actual card width.
Let the title truncate only when the card grid is actually full-width/many-cards, or at minimum
add `title="{division.name}"` so the full name is available on hover regardless.

### [high] Cricket T20 (Autumn Cup 2026) — rounds displayed out of chronological order
**What I saw:** On the Rencontres tab, the League phase groups fixtures into "Tour 1" (dated Jul
21), "Tour 2" (dated Jul 21 – Jul 22), and "Tour 3" (dated **Jul 20**) — Tour 3's two fixtures are
both scheduled to kick off on Jul 20, a full day BEFORE Tour 1 and Tour 2's matches, yet it's
displayed last. See `screenshots/05-cricket-t20-header.png`. Confirmed via the full accessibility
tree (not just visual): Tour 1 fixtures = "Jul 21, 2026, 7:28 PM UTC" / "11:28 PM UTC"; Tour 2 =
"Jul 22, 2026, 7:28 PM UTC" / "Jul 21, 2026, 9:28 PM UTC"; Tour 3 = "Jul 20, 2026, 9:28 PM UTC" /
"11:28 PM UTC" — independently re-confirmed with a standalone headless Playwright script logging
in via magic-link and reading the same DOM. An organiser relying on round order to know "what's
next" would be misled — Tour 3 already happened before Tour 1 even started.
**Fix prompt:** This is either (a) a scheduling bug where "Planifier"/auto-schedule assigned
Tour 3's kickoff times without respecting round sequence, or (b) a display bug where rounds are
sorted by round-generation-order (an internal `round_number` field) instead of by their actual
scheduled `kickoff_at` time. Check the round-robin fixture generator and the scheduling
assignment step (`apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]` fixtures logic, or
whatever service handles "Planifier"/bulk-schedule) — either the generator should assign times in
round order, or the fixtures list should sort/label rounds by actual earliest-fixture time rather
than a fixed round index. Given this is demo-seeded data, verify whether the seed script created
this inconsistency (in which case only the seed needs fixing) or whether the real
scheduling/generation code path can produce this for real organisers (in which case the product
bug needs fixing too).

### [OK] Division fixtures tab (desktop) — round/phase structure is clear and functional
Football Division 1's Rencontres tab (`screenshots/03-division-fixtures-desktop.png`) shows a
clean "1. League" phase card with round groupings (Tour 1/2/3), live status pill on the
in-progress match, and consistent action buttons (Score/Modifier l'heure/Déplanifier) per
unplayed fixture. Fully French, no leaks found on this tab at desktop width.

### [OK] Division Statistiques (stats) tab — empty state is clear and correctly localized
For a division scored at result-only granularity (no ball-by-ball data), the Stats tab shows a
single clear explanatory message in French instead of a blank table — good empty-state pattern,
matches the project convention of explaining absence rather than just leaving a gap.

### [medium] Registrations panel — page heading and breadcrumb leak English inside an otherwise French page
**What I saw:** `/o/[org]/c/[comp]/d/[div]/registrations` (Cricket T20) renders "Registrations —
Cricket T20" as its H1 and "Registrations" as the last breadcrumb segment, in plain English,
while every other label on the same page (Ouverture et fermeture, Capacité, Paiement, Formulaire
d'inscription, Confirmé/En attente/Liste d'attente/Tous, Exporter en CSV, Enregistrer les
paramètres) is correctly in French. See `screenshots/05-registrations-panel.png`. Same pattern
as the other i18n gaps already logged in `02-console-org.md` and `03-console-division.md` — this
page appears to have been missed from the same translation pass that covered the rest of the
division/settings shell.
**Fix prompt:** Locate the Registrations page's H1 and breadcrumb-segment strings (likely
`o/[orgSlug]/c/[compSlug]/d/[divSlug]/registrations/page.tsx`) and route them through the `ui`
message catalog like the panel body already is, adding the missing key to fr/es/nl.

### [high] Registrations panel — mobile 390px — floating FAB overlaps the primary "Save settings" button
**What I saw:** The bottom-left "N" FAB sits directly on top of the left portion of the
"Enregistrer les paramètres" (Save settings) button — the single most important action on this
page (it commits registration-window/capacity/payment changes). See
`screenshots/05-registrations-mobile.png`. This is a more consequential instance of the
already-flagged systemic FAB-overlap bug: here it risks a missed or partial tap on a save action,
not just visual clutter.
**Fix prompt:** Same root fix as the other FAB-overlap findings — but flag this specific
instance as evidence the bug isn't just cosmetic; it can sit on top of primary form-submit
buttons anywhere a page's content runs close to the bottom-left corner on mobile.

### [low] Registrations panel — mobile — public registration link input shows almost no usable text
**What I saw:** The registration link textbox on mobile renders wide enough for only
`http://loc` before being cut off, next to Copy/Open/QR buttons that still work but give the
organiser no way to actually read/verify the link visually. Low severity since Copy/Open still
function correctly.
**Fix prompt:** Consider stacking the link text above its action buttons on narrow viewports
(full-width single line) instead of keeping them on the same row, so the link is at least
partially legible before truncating.

### [medium] Group-stage "Générer les matchs" gives a misleading success message when it generates nothing
**What I saw:** On "Open Singles" (Summer Smash Demo, Groups + Knockout format, 2 entrants,
draft), clicking "Générer les matchs" on the Group stage phase shows a green success-styled
banner: "Rien de nouveau à générer — les matchs sont à jour" ("Nothing new to generate — matches
are up to date"). But the phase card directly below it still reads "Aucun match pour l'instant —
générez-les une fois les participants inscrits" (no matches yet). Reloading the page confirms
this isn't a stale-UI artifact — zero fixtures actually exist after clicking "Générer les
matchs" and getting the green "up to date" message. See `screenshots/05-bracket-generate.png`.
The banner's phrasing implies success/no-op-because-already-done, when what actually happened is
likely "can't generate — not enough entrants for a group stage" or "entrants aren't assigned to
groups yet" (this division only has 2 of a presumably larger required entrant count).
**Fix prompt:** Find the fixture-generation handler for group-stage phases (likely under the
same route/service the division fixtures tab posts to). When generation is skipped because a
precondition isn't met (too few entrants, entrants not yet allocated to groups, etc.), surface
the actual reason instead of the generic "matches are up to date" success message — e.g. "Add at
least N entrants to this group stage before generating matches" or "Assign entrants to groups
first." The current copy actively misleads an organiser into thinking there's nothing left to do.

## Not reached this pass
Participants tab (add/remove/seed entrants), division Paramètres (settings) tab, Registrations
modals beyond the main panel (waitlist promotion, individual entrant edit), a fully-populated
knockout/groups bracket visualization (the one Groups+Knockout division available in this demo
dataset had too few entrants to actually generate fixtures — see finding above — so the bracket
UI itself, once matches exist, was not seen), schedule board (`/c/[comp]/schedule`)
drag-and-drop, and the free-tier (Northside) equivalent of all of the above. Also did not verify
the "Afficher"/"Score" fixture detail modals' content, only that their buttons are present.

## Summary
- Checked: competition detail (filled + near-empty), division fixtures/standings/stats tabs
  (desktop + mobile for fixtures)
- Severity counts: 1 high (mobile fixture-row overlap), 3 medium (tab overflow affordance,
  i18n leak in tie-break legend, premature title truncation), 2 confirmed-OK
- Top priority: **(1)** mobile fixture-row overlap — blocks readable/usable on-site scoring
  workflow, the core "matchday" use case, **(2)** the recurring FAB-overlap and tab-bar issues
  already flagged in `02-console-org.md` reproduce here too, confirming they're shared-layout
  bugs rather than page-specific — fix once, verify across both files' affected pages
