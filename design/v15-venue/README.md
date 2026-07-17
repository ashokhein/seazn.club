# v15 — Venues: a real place, with real courts, that the scheduler understands

**Theme:** today a "venue" is a free-text string you retype on every fixture
(`fixtures.venue`, `fixtures.court_label`) — it navigates no-one, reuses
nothing, and the scheduler never sees it. v15 makes a venue a **first-class,
reusable entity that owns its courts/pitches**, lets a competition run across
**several venues**, and feeds those courts (and each venue's open hours)
straight into the scheduling engine — so "where does this match play, and can
it play there at this time" stops being the organiser's problem.

## The one-line product bet

> Model the place once (its courts, its open window). Assign venues to a
> competition/division. The board fills its columns from the venues and refuses
> to place a match outside a court's venue hours — **no more typing court
> strings, no more clashes across grounds.**

## Scope — this wave (Spec 1 + Spec 2 only)

The full venue vision is ~5 subsystems. v15 ships the **spine**:

1. **Venue library** — org-scoped `venues` + child `venue_courts`
   (name, indoor/outdoor, surface), managed in the console, reused across
   competitions and seasons. Manual entry.
2. **Multi-venue scheduling** — competition→venues and division→venues
   (a division uses a subset of its competition's venues); the scheduler unions
   the assigned venues' courts into its grid and clips every fixture to its
   court's venue open-window.

Deliberately **out of this wave** (each is its own later spec):

- **Auto-fill** from Google Places / OpenStreetMap (address, parking, toilets,
  accessibility). The `address`/`lat`/`lng` columns land now so the enrichment
  pass has somewhere to write — but no external API is called in v15.
- **Public wayfinding surfacing** — venue card + embedded map + facilities on
  the public competition page and `/me`. v15 only lets the richer address flow
  into the existing `.ics` `location` and fixture caption as a free by-product.

## Design decisions (locked in brainstorming, 2026-07-17)

| # | Decision |
|---|----------|
| Binding | **Competition-wide, multi-venue divisions.** `competition_venues` and `division_venues` are M:N; a division's venues must be a subset of its competition's. |
| Open hours | **One default window per venue** (`open_from`/`open_to`). Manual board blackouts / session-windows still override per day. No weekly pattern, no per-date rows. |
| Court depth | **name + kind (indoor/outdoor) + surface** (grass/hard/clay/wood/astro/other). Court hours inherit the venue window (no per-court override in v15). |
| Fixture link | `fixtures.venue_court_id` is **additive & nullable**. Legacy `venue`/`court_label` free-text stays as the denormalised display fallback, backfilled from the venue_court on assignment. No forced data migration. |
| Engine | **Zero engine change.** `packages/engine/src/scheduling/calendar.ts` already supports court-scoped `Blackout`/`SessionWindow` (`court?` field) and a `courts: string[]` list. Multi-venue is pure config generation in `schedule.ts`. |
| Plan gate | A single venue per competition/division is **free on every plan**. Assigning a **second** venue reuses the existing **`scheduling.multi_division`** Pro entitlement (seeded in V114) — no new entitlement key. |
| Migration | **V285** (`db/migration/deltas/V285__venues.sql`) carries all four tables + the `fixtures.venue_court_id` column. Every later prompt in this wave states **No migrations**. |

## Data model (V285)

```
venues                 org-owned library
  id, org_id → organizations
  name, slug             -- slug unique per org
  address text null      -- reserved for the later auto-fill spec
  lat, lng numeric null  --   ""
  open_from, open_to time null   -- the single default window
  timezone text null     -- defaults to org tz at create
  notes text null
  created_at, updated_at

venue_courts           child resources = scheduler grid columns
  id, venue_id → venues, org_id
  name text              -- "Court 1", "Pitch A"
  kind text  check (indoor|outdoor)
  surface text check (grass|hard|clay|wood|astro|other)
  sort_order int
  unique (venue_id, name)

competition_venues     (org_id, competition_id → competitions, venue_id → venues)  unique(competition_id, venue_id)
division_venues        (org_id, division_id → divisions,       venue_id → venues)  unique(division_id, venue_id)

fixtures.venue_court_id  uuid null → venue_courts   -- additive
```

RLS: every table `enable`/`force row level security`, tenant policy
`org_id = current_org_id()`, `grant select, insert, update, delete … to app_user`
(org members manage venues through the tenant connection). Mirrors V284.

## Global constraints (apply to every prompt)

- **This is NOT the Next.js you know** — read the relevant guide in
  `node_modules/next/dist/docs/` before writing route/handler code.
- **Migrations live at the repo root**: `db/migration/deltas/`. `db:apply` is
  incremental Flyway; DB-backed vitest needs `DATABASE_URL` exported or the
  suite crashes (`skipIf(!HAS_DB)`).
- **Every code change ships a regression test that fails without it.**
- **Extend `scripts/smoke.ts`** — a pro path AND a free path — for every feature.
- **i18n parity is enforced**: any new console string is a typed key in
  `apps/web/src/lib/i18n-keys.ts` under the `ui` namespace and must be filled in
  **en / fr / es / nl** (parity test is a gate). hi/ta are skipped.
- **Help closing pass is mandatory on every prompt** — update
  `apps/web/content/help/*` in the same change and keep `HELP_ARTICLE_SLUGS`
  (`apps/web/src/lib/help.ts`) bidirectional-clean (`help-content.test.ts`).
- **Work on a worktree branch** (`.claude/worktrees/v15-venue`), never switch
  branches in the main checkout.
- **Verify before push**: `tsc` + unit + the touched suites, then extend smoke.

## Build order & prompts

Strictly sequential — each depends on the last.

- [PROMPT-68 — Venue library: model, usecases, API](prompts/PROMPT-68-venue-library-model-and-api.md)
  — V285 migration + `venues.ts` usecases + `/api/v1/venues*` + tests. Server only.
- [PROMPT-69 — Venue console: CRUD + court management UI](prompts/PROMPT-69-venue-console-crud-ui.md)
  — `/o/[org]/settings/venues` list/create/edit + court rows + i18n + help.
- [PROMPT-70 — Assign venues to competitions & divisions](prompts/PROMPT-70-competition-division-venue-assignment.md)
  — M:N assignment usecases + comp/division Settings pickers + the
  `scheduling.multi_division` gate on the 2nd venue.
- [PROMPT-71 — Scheduler: multi-venue courts + open-window clipping](prompts/PROMPT-71-scheduler-multi-venue-integration.md)
  — derive `courts[]` + court-scoped blackouts from assigned venues in
  `schedule.ts`; write `venue_court_id`; board reads venue courts; e2e.

## Non-goals (whole wave)

- No Google/OSM/any external call. No facilities flags (parking/toilets). No map.
- No public venue page, no `/me` venue block beyond what already renders.
- No per-court or per-date availability. No weekly hour patterns.
- No bulk venue import. English-only help copy (strings i18n-ready).

## Deploy notes

- **V285** must be applied to staging then prod (direct-connection Flyway;
  IPv4/Fly-side per the standing stg migration constraint).
- No webhook/Connect/env changes. No new entitlement seed (reuses V114's
  `scheduling.multi_division`).
