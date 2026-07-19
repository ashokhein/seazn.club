# Clubs & Teams redesign — Directory hub, delegation, public pages, club ops

**Date:** 2026-07-18
**Status:** Approved design, pending implementation plan
**Migration:** V292 (next free after V290 pro_plus_plan)

## 1. Problem

The Directory → Clubs tab is a single crowded panel: create form + bulk logo
grid + clubs table + an inline detail card (teams, squad editor, add-team form)
all stacked on one screen. Backend capabilities exist that the UI never
surfaces: `patchClub` (no rename UI), `clubs.colors` (no UI at all). There is
no club detail route, no public club presence, no club contacts, no way for a
club to manage itself, and no club-scoped operations (bulk enrollment, comms,
export surfacing). Clubs are Pro-only (`clubs.hierarchy`), so Community orgs
cannot use the hierarchy at all. Persistent teams cannot be created standalone
— the UI requires a parent club, and creating a squad member requires the
person to already exist in Directory → Players (tab-hopping).

## 2. Research summary — how the ecosystem models clubs

Four source patterns informed the design:

1. **Governing bodies (FA affiliation).** A club is an official entity with
   key officers (Secretary, Chairman, Treasurer, Welfare Officer) with contact
   details, a stated home ground, kit colours, an affiliation number, and a
   list of active teams per season.
2. **League platforms (LeagueRepublic, FA Full-Time, TeamSideline).** League-
   centric: the club secretary is the contact the league communicates with;
   teams enter divisions, the club groups them.
3. **Club platforms (Pitchero, TeamSnap, SportsEngine).** Club-centric: the
   club is a public identity (aggregated teams/fixtures/results page); players
   belong to a club pool and are drafted into team squads; club-admin vs
   team-admin role split (delegation).
4. **Tournament platforms (Playbook365, Fastbreak).** Entry-centric: a club
   director registers N teams in one cart with one payment; rosters uploaded
   once; self-service entries the organizer approves.

seazn.club already has the structural bones (club → team → entrant per
division, persistent squads auto-seeding entrant rosters, badge/colour cascade
via `team_display_v`). The gaps are profile richness, UX, delegation, club
ops, and public presence.

## 3. Decisions (locked during brainstorm)

| # | Decision |
|---|----------|
| 1 | Scope: all directions — profile+UX rebuild, delegation, club ops, public page+stats. D3 (club-level billing) is design-only (appendix), implemented later. |
| 2 | Delegation auth = claim rail + `/me` lane (same pattern as persons/officials claims — third reuse). No new role machinery. |
| 3 | Tier gating: basics free (clubs, profile, public page with attribution badge), power features Pro (delegation, bulk enroll, comms, stats, bulk logos). |
| 4 | UX architecture = Approach 1: club hub page at `/clubs/[id]`; Directory keeps all three tabs; Clubs tab becomes a thin list renamed "Clubs & Teams". |
| 5 | Ladder model: entrant-only → standalone team → club hierarchy. Each step opt-in; clubs never forced. Standalone team creation un-tied from clubs. |
| 6 | All caps/gates live in `plan_entitlements` (int/bool rows), visible and editable in `/admin/entitlements`; per-org overrides via existing org-page overrides. No code-constant caps. |
| 7 | Caps: Community 2 clubs / 2 teams (org-wide) / squad 20. Pro 20 clubs / 40 teams / squad ∞. Pro Plus ∞ / ∞ / ∞. Defaults are migration inserts, tunable live in admin. |
| 8 | Inline player quick-add from the squad picker (create person + add to squad in one step, fold-match dedupe warning) — removes the "add player first" ordering constraint. |

## 4. Data model (V292)

### 4.1 `clubs` additions

```sql
alter table clubs add column if not exists slug        text;  -- public URL key
alter table clubs add column if not exists home_ground text;  -- free text; v15 venues integration later
alter table clubs add column if not exists website     text;
alter table clubs add column if not exists notes       text;  -- org-private
create unique index if not exists clubs_slug_key on clubs(org_id, slug);
```

- `slug` is generated from the name on first save (same slugify used
  elsewhere), editable, unique per org; conflicts get `-2` suffix suggestion.
- `colors` column already exists — gains a zod shape
  `{home:{primary,secondary}, away?:{primary,secondary}}` and UI. No column
  change.
- `home_ground` is deliberately free text now; when the v15 venue design
  ships, a nullable `venue_id` column can supersede it (kept additive).

### 4.2 New `club_contacts`

```sql
create table if not exists club_contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  club_id    uuid not null references clubs(id) on delete cascade,
  role_key   text not null default 'secretary'
             check (role_key in ('secretary','chairman','treasurer','welfare','manager','other')),
  full_name  text not null,
  email      text,
  phone      text,
  is_primary boolean not null default false,
  user_id    uuid references users(id) on delete set null,  -- claimed account (W3)
  invited_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists club_contacts_club_idx on club_contacts(club_id);
create index if not exists club_contacts_org_idx  on club_contacts(org_id);
```

RLS: same direct tenant policy pattern as V242 (`org_id = current_org_id()`),
force RLS, grant to `app_user`.

### 4.3 Teams

No schema change — `teams.club_id` is already nullable. `createTeam` makes
`clubId` optional (standalone teams). A "move team into club" action is a
plain `update teams set club_id = …`.

### 4.4 Entitlements (V292 inserts)

| Key | Type | Community | Event Pass | Pro | Pro Plus | Enforced at |
|---|---|---|---|---|---|---|
| `clubs.hierarchy` | bool | **true** (was false) | true | true | true | feature on/off |
| `clubs.max` | int | 2 | 2 | 20 | ∞ (null) | createClub, import plan |
| `teams.max` (org-wide incl. standalone) | int | 2 | 2 | 40 | ∞ | createTeam, import plan |
| `teams.squad_max` | int | 20 | 20 | ∞ | ∞ | squad save, quick-add, import plan |
| `clubs.public_page` | bool | true (with attribution badge) | true | true (badge off via existing branding rules) | true | public route |
| `clubs.delegation` | bool | false | false | true | true | invite/claim endpoints, /me lane |
| `clubs.enroll_bulk` | bool | false | false | true | true | wizard endpoint |
| `clubs.comms` | bool | false | false | true | true | contact email endpoints |
| `clubs.stats` | bool | false | false | true | true | stats block (hub + public) |
| `logos.bulk` | bool | false (unchanged) | false | true | true | bulk logo grid |

Notes:
- **Pricing change:** Community goes from zero clubs to 2 clubs / 2 teams.
- Cap checks reuse the existing `withinLimit()` helper (as `import.bulk`
  does). Over-cap → 402 → existing `UpgradeGate`, showing current/limit.
- Event Pass mirrors Community for club keys (pass is per-competition, club
  structure is org-level).
- `featureReason` copy added for every new key so the admin grid's "What it
  gates" column is populated.

### 4.5 Admin: inline plan editing (W1)

`/admin/entitlements` currently renders `plan_entitlements` read-only.
W1 adds inline editing of plan cells (bool toggle / int input with ∞) via an
admin-gated PATCH endpoint that updates `plan_entitlements` and busts the
entitlement cache. Per-org overrides remain on the org page (unchanged).
This fulfils "caps customizable via /admin without deploy".

## 5. Surfaces

### 5.1 Directory → "Clubs & Teams" tab (thin list)

- Search box (name/short-name fold match).
- Club rows: badge, name, short name, team count, primary contact name.
  Click → hub page.
- Unattached team rows (club_id null): badge, name, "standalone" chip,
  division-entry chips. Click → expands the same squad-editor panel used in
  the hub Teams tab, inline in the list (standalone teams get no hub page;
  attaching to a club is the upgrade path).
- Actions: New club, New team (standalone), Import (link to /import).
- The bulk logo grid, inline detail card, squad editor, and add-team form all
  move off this tab into the hub.
- Players and Officials tabs unchanged.

### 5.2 Club hub `/clubs/[id]` (console, new route)

Three tabs:

- **Overview** — profile edit: name, short name, slug, badge upload, colours
  (home/away pickers writing the `colors` jsonb), home ground, website, notes.
  Contacts CRUD: officer role, name, email, phone, primary flag; invite
  button (W3, Pro). Danger zone: delete club (existing semantics — teams
  survive, `club_id` set null).
- **Teams** — team rows (badge, name, entry chips) → expandable squad editor;
  add team under this club; per-team badge upload; "move team into club" /
  "detach from club". **Inline player quick-add:** squad picker input, on no
  match offers "+ Add '<name>' as new player" → creates person (name only) +
  adds to squad in one step; fold-match against existing persons shows a
  soft "did you mean …?" warning first. Person lands in the org-wide register
  as normal (single source of truth).
- **Entries** — read grid: this club's teams × divisions they are entered in,
  linking to division boards. W3 adds the approval inbox here (proposed
  enrollments from club reps). W4 adds the "Enroll into competition" wizard
  button here.

### 5.3 Public club page `/o/[orgSlug]/club/[clubSlug]` (W2)

- Badge, club colours as accent, home ground, website link.
- Teams list; entries across **public/unlisted-competition** data only
  (reads existing public views — `public_entrants_v` already carries
  `team_display` with `club_id`).
- Recent results / standings snippets per entered division.
- Share bar (existing component), attribution badge on free tier (existing
  branding rules), og image.
- Crest chips on public brackets/standings link to the club page.
- Analytics events: `club_page_viewed`, `club_shared` (PostHog registry).

### 5.4 `/me` "My clubs" lane (W3, Pro)

- Appears for users whose `club_contacts.user_id` matches.
- Rep can: edit squads (respecting `teams.squad_max`), upload club/team
  badges, use player quick-add, and **propose** enrolling a team into an
  open division → creates a pending request the org approves/rejects in the
  hub Entries tab. Reps cannot delete clubs/teams, cannot touch other clubs.
- Claim flow mirrors persons/officials: org adds contact with email → Invite
  → Resend email (courtside template) → recipient signs in / registers with
  that email → claims → `user_id` + `claimed_at` set. Invites never change
  existing org roles (additive-accept rule, PR #86).
- Activity feed on the hub: contact-authored changes attributed (who, what,
  when).

### 5.5 Club ops (W4, Pro)

- **D1 Enroll wizard** (hub Entries tab): pick target competition → grid of
  club teams × its divisions → tick cells → one confirm. Rosters auto-seed
  from persistent squads (existing `loadTeamSquad` path). Already-entered
  cells render locked. Result reported per row (created / skipped / failed).
- **D2 Comms:** templated emails to the primary contact — "Fixtures
  published", "Registration open", "Payment reminder" — via existing
  compose.ts / Resend system, sent from division/competition contexts and
  from the hub. Club-filtered participant export surfaced as a hub button
  (backend `participantRows({clubId})` already exists).
- **Stats block (F):** hub + public page — aggregate W/D/L per team from
  finalized fixtures, honours list (division winners where the club's teams
  finished 1st). Pro-gated; public page shows it only when org has
  `clubs.stats`.

## 6. Waves

| Wave | Contents | Migration |
|---|---|---|
| **W1 Foundation** | V292 schema + entitlement rows; thin "Clubs & Teams" list; hub page (Overview/Teams/Entries); patchClub UI; colours UI; contacts CRUD (no invite yet); standalone team create; move/detach team; player quick-add; cap enforcement; admin inline plan editing; help pages; i18n ×4; openapi regen; smoke/e2e | V292 |
| **W2 Public + PLG** | public club page; slug backfill for existing clubs; crest-chip links; share bar + attribution; og image; analytics events | — |
| **W3 Delegation** | contact invite + claim rail; `/me` My clubs lane; propose-enrollment + approval inbox; activity feed | possible small delta (claims/audit) |
| **W4 Ops + stats** | enroll wizard; comms templates; export surfacing; stats/honours block | — |

Each wave = own branch/PR wave, own plan, help-page pass every wave
(standing rule), smoke extended pro + free paths every wave.

## 7. Error handling

- Slug conflict → 409 with suggested `<slug>-2`.
- Duplicate club name → 409 (existing upsert-key behaviour preserved).
- Quick-add fold-match hit → soft warning with existing-person pick; never
  hard-blocks (same-name people are legal).
- Cap exceeded → 402 with feature key; UpgradeGate shows current count vs
  limit; import preview flags over-cap rows before commit.
- Claim: email mismatch or already-claimed contact → 409 (mirror person
  claims).
- Wizard: partial success is per-row reported; already-entered = locked cell,
  never an error; roster seed failures roll back only that row's entrant.
- Public club page for unknown slug or org without `clubs.public_page` → 404.
- Contact email invalid → 400 (repo-wide zod convention; spec originally said 422).

## 8. Testing

- **Unit:** caps (each key, at/over limit), quick-add dedupe fold, slug
  generation/conflict, standalone team create, move/detach, wizard planning
  (locked cells, partial failure), claim state machine, contacts CRUD,
  admin plan PATCH (auth + cache bust).
- **DB tests:** RLS on `club_contacts` (cross-org invisible), V292 idempotent.
- **e2e:** directory list → create club → hub → rename + colours → add team →
  quick-add player into squad → enroll via wizard (W4) → public page renders
  badge/teams (W2) → rep claim + squad edit (W3). Free-tier path: hit club
  cap at 3rd club → UpgradeGate.
- **Smoke:** extend `scripts/smoke.ts` pro + free paths per wave.
- **i18n:** catalog parity en/fr/es/nl for all new keys.
- **Regression rule:** every change ships a test that fails without it.
- **openapi:** regenerate after every schema change (known 3× gotcha).

## 9. Out of scope / deferred

- **D3 club-level billing** — design-only appendix below; implement after the
  payments-hardening wave (PROMPT-72..77) lands.
- v15 venue linkage for `home_ground` (text now, `venue_id` later, additive).
- Club-level PWA/manifest, news/posts on public club page.
- Cross-org clubs (a club spanning multiple orgs) — explicitly not modelled;
  clubs stay org-scoped.
- hi/ta locales (project-wide skip).

## Appendix A — D3 club invoices (design-only, no migration now)

```sql
-- future table, shape agreed so V292 stays compatible
create table club_invoices (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  club_id     uuid not null references clubs(id) on delete restrict,
  status      text not null default 'draft'
              check (status in ('draft','sent','paid','void')),
  currency    text not null,
  total_minor integer not null,
  lines       jsonb not null,  -- [{entrant_id, division_id, description, amount_minor}]
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  sent_at timestamptz, paid_at timestamptz, created_at timestamptz not null default now()
);
```

- One invoice aggregates N team entries for one club; paying it marks the
  linked registrations paid (reuse the existing reconcile-without-webhook
  rail). Refund/dispute semantics follow the payments-hardening decisions.
- `club_contacts` (V292) already provides the billing recipient; nothing in
  this design needs to change for D3 later.
