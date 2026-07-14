# PROMPT-57 — Official onboarding: invite → claim → officiating lane in /me

**Read first:**
- `apps/web/src/server/usecases/officials.ts` — the officials model in full
  (`OfficialRow`: `person_id, entrant_id, display_name, role_keys[],
  home_pool_id, max_per_day`), CRUD, import, `engineInput` (note it already
  joins `person_id` → `entrant_members` for the plays-while-reffing rule),
  auto-assign. You add `email` + claim linkage here.
- `apps/web/src/server/usecases/invites.ts` and
  `apps/web/src/server/usecases/person-claims.ts` — **the exact rail to reuse.**
  Player onboarding (PROMPT-53) already does invite-by-email → tokenised claim →
  stamp `person_id`. Officials get the same, not a new mechanism.
- `apps/web/src/app/claim/[token]/page.tsx`, `apps/web/src/app/api/invites/**`,
  `apps/web/src/app/api/claims/**`, `apps/web/src/app/api/v1/persons/[id]/claim-invites/**`
  — claim/accept surfaces.
- `apps/web/src/app/me/page.tsx` — the player portal you extend with an
  *Officiating* lane (decision: officials live in `/me`, one identity).
- `apps/web/src/app/api/v1/me/assigned-fixtures/route.ts` and
  `me/fixtures/[id]/availability` — assigned fixtures already return for a
  person; availability RSVP already exists for players (reuse its shape).
- `apps/web/src/app/api/v1/fixtures/[id]/officials/route.ts` +
  `fixtures/[id]/device-links/**` — assignment write source + the score-pad
  device links you surface to the assigned official.
- `apps/web/src/lib/email-templates/claim-invite.ts` + `invite.ts` +
  `index.ts` — email pattern.
- `design/v11/README.md` (scope + non-goals).

**Depends:** none (parallel-safe with v10). **Consumed by:** v12 rota.
**Migration:** one delta, next free `V###` after v10's (verify contention).

## Context

An `officials` row is a capability the organiser conjures; there is no person
attached unless `person_id` is set, and nothing ever sets it from the official's
side. Players solved the identical problem in PROMPT-53: an organiser creates a
`person`, invites an email, the recipient claims a token, and `person_id` binds
to their user — after which `/me` shows their matches and availability. **v11 is
that same rail pointed at `officials`, plus the assignment-response and
availability state a referee actually needs.** No new claim mechanism, no new
portal app.

The engine already reads `fixture_officials` (assignments) and respects
`locked`. v11 adds a **response** dimension (an official can accept or decline a
specific assignment) and a **blackout** dimension (dates they're unavailable),
both of which the organiser sees on the console and — as a later nicety, not
this prompt — the auto-assigner could consume. For v11, a decline **flags**;
it does not auto-reassign (non-goal).

## Task

### 1. Model + migration (`V###`)

- `officials.email` (nullable text) — the invite target; and confirm the claim
  binds `officials.person_id` (already exists) via the person-claim rail.
- `fixture_officials.response` (`'pending'|'accepted'|'declined'` default
  `'pending'`) + `responded_at`, `decline_reason` (nullable). Backfill existing
  rows to `'accepted'` (they were manually placed — treat as agreed, so no
  console lights up red on deploy).
- `official_availability` — `id, org_id, official_id, date, status
  ('unavailable' default), note, created_at`, unique `(official_id, date)`.
  RLS + grants mirroring `officials` (copy the newest `db/migration/deltas`
  grant block). Entitlement: the officiating **portal is free** (community) —
  onboarding a volunteer ref must not require Pro; only the pre-existing
  `officials.auto` / `officials.roles_multi` gates stay Pro.

### 2. Invite + claim (reuse the person-claim rail)

- In `usecases/officials.ts`, add `inviteOfficial(auth, officialId, email)`:
  set `officials.email`, ensure a linked `person` (create if
  `person_id` null, mirroring how player invites create the person), and mint a
  claim invite through **`usecases/invites.ts` / `person-claims.ts`** — do not
  fork a parallel token system. Role of the invite = official (so the claim
  landing copy says "claim your officiating profile", not "your player
  profile").
- Send the invite email via a `claim-invite`-style template, addressed to the
  official's email, deep-linking the existing `claim/[token]` flow. The claim
  handler already stamps `person_id`; assert it also works when the person is an
  official (add the officiating variant of the claim landing copy in
  `claim/[token]/page.tsx`).
- API: `POST api/v1/officials/[id]/invite` (v1 envelope, `requireResourceAuth`
  "official"/"org" "write"). Surface an **Invite** action per official in the
  officials manager UI (wherever `officials` are listed in the console).

### 3. Officiating lane in `/me`

- Extend `me/page.tsx` (and the data loader behind it): when the signed-in
  person is linked to any `officials` row, show an **Officiating** section:
  - **My assignments** from `me/assigned-fixtures` filtered to official
    assignments (join `fixture_officials` where `official_id` ∈ the person's
    officials), each with competition/division, court, time (respect the user's
    timezone — the two-lane always-labelled display from the timezone wave),
    role, and `response` state.
  - **Accept / Decline** per assignment → `PATCH
    api/v1/me/assigned-fixtures/[id]/response` writing `fixture_officials
    .response`/`responded_at`/`decline_reason` (guard: only the assigned
    official's own person may write; only `pending`→ transitions allowed, plus
    re-accept of a prior decline before matchday).
  - **Availability** — a compact date picker writing `official_availability`
    via `POST/DELETE api/v1/me/availability/officiating` (reuse the player
    availability RSVP component shape).
  - **Score this match** — for an assigned, not-yet-final fixture, surface the
    existing **device link** (`fixtures/[id]/device-links`) so the official
    reaches the score pad with no separate login (reuse the link mint; don't
    invent a new one).
  - **Download my rota** — link to `/me/rota.pdf` (the route is added in v12;
    here just render the link, disabled/"coming soon" if v12 hasn't landed, so
    v11 is shippable alone).

### 4. Organiser-side visibility + notifications

- On the fixture/officials console, show each assignment's `response`
  (pending/accepted/declined + reason) — a declined assignment is a **flag** for
  a manual re-pick (no auto-reassign).
- **Emails** (`email-templates/`, register + chrome-pin as usual): on assign,
  `official-assigned` (fixtures/times/role, accept-decline CTA to `/me`); on a
  schedule change to an assigned fixture, `official-assignment-changed`. Address
  the official's email; owner-addressed copies (if any) resolve via
  `org_members.role='owner'`.

### 5. Cross-cutting (mandatory)

- **Help** (`content/help/**`): "Officials / referees" page — inviting an
  official, what the official sees in `/me`, accept/decline, availability,
  scoring from a device link.
- **Smoke** (`scripts/smoke.ts`): pro + free paths — create official, invite,
  claim as a second user, see the assignment in `/me`, accept it, mark a
  blackout date, open the device link; free org proves the portal isn't
  Pro-gated.
- **Tests** (fail-without-it):
  - invite creates/links a person and mints a claim through the shared rail
    (not a new token table); claim stamps `person_id` on the official.
  - response transitions: pending→accepted, pending→declined(+reason),
    illegal transitions rejected, only the assigned official's person may write.
  - backfill: pre-existing `fixture_officials` become `accepted` (no console
    regression).
  - availability unique per (official,date); delete clears it.
  - `/me` shows officiating only when linked; a pure player sees no lane.

## Acceptance

- `npm run typecheck`, unit suites, smoke green; help registry green.
- Documented run: organiser invites `ref@example.com` → claim as that user →
  `/me` shows the assigned fixture with Accept/Decline → decline with a reason →
  organiser console shows the flag → no auto-reassign fired.
- A person who is both a player and an official sees both lanes under one login.
- Deploying against existing data lights up **zero** false decline flags
  (backfill = accepted).

## Gotchas (do not relearn)

- **Reuse `person-claims`/`invites` — do not fork a token system.** The 1h-vs-24h
  link-TTL bug and the email-address-bound accept fix already live there; a
  parallel path would re-introduce both.
- Owner-addressed email → `org_members.role='owner'`, never `created_by`.
- `engineInput` in `officials.ts` already resolves `person_id`→entrants for the
  plays-while-reffing rule; your `email`/response columns must not disturb that
  join or the `COLS` tuple used across CRUD (add columns deliberately, update
  `COLS` + inserts together — the SQL uses an explicit column tuple).
- Times in `/me` use the user-timezone two-lane always-labelled format (don't
  emit a raw host-zone time; Node-ICU emits offsets not `IST` — the timezone
  wave documents the helper to use).
- The officials vitest suites run against real Postgres (`DATABASE_URL` on
  :54329, fresh `createdb`); use random unique names/refs in seeds.
