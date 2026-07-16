# PROMPT-60 — Entrant identity (crest/badge) + bulk enrolment

**Sport-agnostic.** An entrant crest and inline roster loading are shared across
every sport — a football club badge, a cricket team logo, a tennis pair's photo,
a board-game team mark. No sport-specific behaviour; render the badge wherever an
entrant is shown, for all sports.

**Read first:**
- `apps/web/src/server/usecases/entrants.ts` — `createEntrants`, `insertMembers`,
  `EntrantMemberInput`, the entrant `STAGE_COLS`/`COLS` select lists,
  `dropPositions` (sport-position cleaning). Crest column + inline members land
  here.
- `apps/web/src/server/api-v1/schemas.ts` — `CreateEntrant` (`kind`,
  `display_name`, `team_id`, `seed`, `members`, `copy_roster_from_entrant_id`),
  `EntrantMemberInput` (`person_id`, `squad_number`, `default_position_key`,
  `is_captain`, `roles`). Add `badge_url` + inline-person member variant.
- `apps/web/src/app/api/v1/divisions/[id]/entrants/route.ts` — the create route
  (also handles CSV import multipart). New-person members flow through here.
- `apps/web/src/app/api/v1/persons/route.ts` + `usecases/persons` — the
  per-person create being batched away.
- Entrant render surfaces (badge must appear in all): `components/v2` board
  (`EntityCard`, bracket/knockout view, standings table), the public division
  pages under `app/(public)/…/divisions/**` (standings/entrants/schedule), and
  the export `DocModel` roster/standings builders
  (`packages/engine/src/exports/build.ts`) so crests reach PDFs too.
- Migrations live at **repo root** `db/migration/deltas` (Flyway). Take the next
  free `V###` — check for contention with in-flight branches (v5-i18n used
  V282) before numbering.

**Depends:** none (independent of PROMPT-59). **Migration:** one column add.

## Context

Loading and showing a real field of teams is far harder than it should be:

- **No entrant crest.** `entrants` has no image column. The only path to a team
  logo is `teams.logo` via a club under Pro `clubs.hierarchy`, uploaded through
  the bulk multipart logo endpoint — i.e. build a club tree and upload N images
  just to show a badge. There is no lightweight per-entrant crest and no way to
  reference an existing image URL. Any "teams with logos" competition (leagues,
  cups, national teams with flags) pays this tax.

- **No bulk person-create.** A full roster is one `POST /api/v1/persons` per
  player; `members` only take a pre-existing `person_id`. The WC demo issued
  1248 sequential person calls. This is slow and awkward for every roster sport.

## Task

### 1. Entrant crest / badge (schema + render)

- **Migration:** add `entrants.badge_url text null` (a URL or a storage ref —
  keep it a plain string; validating/hosting is out of scope, an external or
  already-uploaded URL is fine). Sport-neutral, no club required.
- **Schema:** add `badge_url: z.string().url().max(1000).nullish()` to
  `CreateEntrant` and to the entrant PATCH; include it in the entrant `COLS`
  select + returned shape.
- **Create/update:** persist it in `createEntrants` and the entrant PATCH.
- **Render (all sports, everywhere an entrant appears):** show the badge next to
  the entrant name — `EntityCard`, the board, the knockout/bracket nodes,
  standings tables, and the public division pages. Fallback to the current
  initials/monogram when `badge_url` is null (no layout shift). Thread it into
  the export `DocModel` (roster + standings) so branded PDFs show crests too.
- Precedence: an entrant's own `badge_url` wins; else fall back to the linked
  `teams.logo` if present; else monogram. (One resolver, reused by every
  surface.)

### 2. Inline new-person members (bulk enrolment)

Let `CreateEntrant.members[]` accept a **new person inline** as an alternative
to `person_id`, so a whole team + roster is one request:

```ts
// EntrantMemberInput: either an existing person…
{ person_id: Uuid, squad_number?, default_position_key?, is_captain?, roles? }
// …or a new one created in the same transaction:
{ new_person: { full_name: string, consent?: {} },
  squad_number?, default_position_key?, is_captain?, roles? }
```

- In `createEntrants`/`insertMembers`, create the `new_person` rows in the same
  transaction, then link them exactly as existing members (positions still
  cleaned by `dropPositions` per the division's sport). Dedupe within a request
  by `full_name` if desired, but do **not** merge with existing org persons
  (explicit `person_id` remains the way to reuse).
- Keep the existing `person_id` path unchanged (back-compat).
- Cap roster size per entrant sensibly (reuse whatever bulk `members` cap
  exists; national-squad sizes ~26 must pass).

Optional companion: accept a batch body on `POST /api/v1/persons` (array →
array) for callers that create persons up front. Nice-to-have; the inline-member
path is the primary fix.

## Tests (regression — each fails without its change)

- `entrants` usecase test: create a team entrant with `badge_url` → persisted +
  returned; PATCH updates it; resolver precedence (badge_url > teams.logo >
  monogram). Run for at least two sports to prove neutrality.
- Inline-member test: `POST …/entrants` with `members` mixing `person_id` and
  `new_person` → new persons created in the same tx, all linked, positions
  cleaned per sport; existing-person path still works.
- A render test/snapshot: `EntityCard` (or standings row) shows the badge when
  present and the monogram when absent.

## Non-goals

- No image upload/hosting pipeline, no resizing/CDN — `badge_url` is a string the
  caller supplies (external URL or an already-hosted asset). Upload UX can be a
  later prompt.
- No club-hierarchy changes; the crest is deliberately club-independent so free
  orgs get it.
- No person-merge/claim changes.

## Help / docs pass (mandatory)

Update `content/help/*` for entrants/rosters: how to set a team crest and how to
enrol a team with its roster in one go — sport-neutral wording, same PR.
