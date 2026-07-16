# PROMPT-64 — Presentation mode (venue big-screen slideshow)

**Sport-agnostic.** It composes existing public views (standings, fixtures,
bracket, live score) — all already sport-neutral — into an auto-rotating
full-screen slideshow. No per-sport code.

**Read first:**
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx`
  (competition) and `.../[divisionSlug]/page.tsx` (division) — the two public
  pages the two presentation routes hang off.
- `apps/web/src/server/public-site/data.ts` — `getPublicCompetition`,
  `getPublicDivision` (standings + fixtures per division), `getPublicFixture`,
  `fixtureRealtimeEligible`. The slide data comes from here (extend if a
  "what's live now in this comp/division" selector is missing).
- Reusable slide bodies (already built): `components/public-site/standings-table.tsx`,
  `schedule.tsx` (fixtures + results), `bracket.tsx` (the two-sided tree from
  **PROMPT-62**), `live-score.tsx` + `live-score-data.ts` (in-play).
- `apps/web/src/components/marketing/live-refresh.tsx` — the visibility-aware
  `router.refresh()` pattern to reuse (don't poll a parked tab).
- `apps/web/src/components/marketing/live-wall.tsx` — precedent for a public
  live surface; the floodlit/night styling tokens.

**Depends:** the bracket slide soft-depends on **PROMPT-62**; degrade gracefully
(skip that slide) if the bracket component isn't the two-sided one yet. **Migration:**
none (read-only public views).

## Context

There's a global marketing `/live` wall (all orgs), but **no per-tournament venue
display**. Organisers want to point a projector/TV at a competition and have it
cycle: group tables → fixtures/results → live scores → bracket, unattended, with
whatever is **in play** always surfaced. Two levels are wanted:

- **Division presentation** — one division's slides.
- **Competition presentation** — rotates across all divisions in the competition.

## Task

### 1. Two public presentation routes (no login, shareable)

- `.../shared/[orgSlug]/[competitionSlug]/[divisionSlug]/present/page.tsx`
- `.../shared/[orgSlug]/[competitionSlug]/present/page.tsx`

Both fetch the existing public data (respecting the org's public/consent
settings), build an ordered **slide deck**, and render the shared `<Slideshow>`
(below) full-screen in the floodlit/night theme. `revalidate` like `/live` (30s)
plus a `<LiveRefresh>`-style client refresh.

### 2. Slide deck builder (pure)

A pure function `buildDeck(data, { level })` → ordered slides:

- **Standings** — group/league tables, **smart-paginated so N groups collapse
  into 1–2 slides** (e.g. ≤4 tables per slide), not one slide per group. Uses
  `standings-table.tsx`.
- **Fixtures + results** — upcoming + most-recent, via `schedule.tsx`.
- **In-play** — live matches via `live-score.tsx`; **pinned/priority** (see §3).
- **Bracket** — knockout tree via `bracket.tsx` (skip if none / not yet
  two-sided).
- Competition level: interleave each division's standings/fixtures/bracket, div
  by div, with one shared in-play slide aggregating all live matches.

### 3. `<Slideshow>` client component

`apps/web/src/components/public-site/slideshow.tsx`:

- Auto-advances every `N` seconds (config, default ~12s; per-slide dwell can
  vary — standings longer than a title slide).
- **In-play priority:** when any match is live, the in-play slide is always in
  the rotation and dwells longer; optionally it **interrupts** to the in-play
  slide on a score change. "Show in play" must always win — a screen with live
  action should never be stuck on a static table.
- Visibility-aware refresh (reuse `LiveRefresh`); a score/fixture change refetches
  the deck without a hard reload.
- Kiosk styling: full-bleed, large type, progress dots, no chrome. A small
  play/pause + next/prev on hover (for a human at the screen), auto-hidden.
- Deep-link a starting slide (`?slide=standings`) and pausing (`?auto=0`).

### 4. Entry points

- A **"Present / Full screen"** action on the console division + competition
  pages (and/or the public share menu) that opens the `/present` route.
- The route is a plain public URL an organiser can cast to any screen.

## Tests (regression — each fails without its change)

- `buildDeck` unit: a 12-group division yields ≤2 standings slides (pagination),
  a fixtures slide, an in-play slide only when a match is live, a bracket slide
  only when a knockout exists; competition level interleaves divisions.
- `<Slideshow>` (jsdom): auto-advances on timer; a live match forces the in-play
  slide into rotation and holds it; pause stops advancing; `?slide=` starts there.
- Route test: `/present` renders for a public competition/division and 404s /
  respects visibility when the org isn't public.

## Non-goals

- No editing/scoring from the presentation (read-only view).
- No new realtime transport — reuse the existing public live-score refresh.
- No custom slide authoring/branding editor (deck is derived; branding follows
  the org's existing public theme). A configurable deck can be a later prompt.

## Help / docs pass (mandatory)

`content/help/*`: how to open presentation mode for a division or competition,
cast it to a screen, and that live matches are prioritised. Same PR.
