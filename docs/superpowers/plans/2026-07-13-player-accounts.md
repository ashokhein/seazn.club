# Player Accounts (PROMPT-53) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person claims their `persons` row via an organiser-sent invite, gets a cross-org player home at `/me` (schedule + RSVP + consent), organisers see availability chips in the lineup picker, and players self-check-in via a fixture QR.

**Architecture:** New migration V276 (`person_claims` + `fixture_availability`, house RLS). Claim tokens are random secrets hashed at rest (device-links pattern); check-in tokens are HS256 JWTs signed with `AUTH_SECRET` (stateless, fixture-scoped, die at local midnight). `/me` reads are superuser cross-org queries mirroring `listAssignedFixtures`; organiser-side reads stay inside `withTenant`. Consent writes by the player fire the existing division/competition tag revalidation so the public card flips immediately.

**Tech Stack:** Next 16.2.9 (App Router), postgres.js tagged SQL, zod schemas in `server/api-v1/schemas.ts`, jose JWT, qrcode, Resend via `lib/email.ts` + `lib/email-templates/compose.ts`, vitest (DB-backed suites skip without `DATABASE_URL`), Playwright e2e.

## Global Constraints

- Migration number **V276** (`db/migration/deltas/V276__player_accounts.sql`). V275 = advisor indexes, taken.
- Player accounts are **all plans, free included** — NO `requireFeature` gate on any new surface.
- **Guardian gate (owner-confirmed 2026-07-13): under-16 (by `persons.dob`) sees the consent card read-only**; organiser-set values hold. Server-enforced, not UI-only.
- Every new `/api/v1` route registered in **three** places: `key-scopes.ts` (`NEVER_KEY_ROUTES` — all new routes are session-bound), `openapi.ts` `ROUTES`, and committed `npm run openapi:gen` output (`openapi/v1*.json`).
- Every new page href built in `lib/routes.ts` — raw console hrefs are lint-banned.
- Every new UI string through `lib/messages.ts` (flat dot-namespaced keys).
- `persons.dob` is NEVER in any public or player-facing payload (only the derived lock flag).
- Each change ships with a test that fails without it. `npx tsc --noEmit` + unit suite green BEFORE push (run from `apps/web` cwd — root cwd breaks `@/` aliases).
- Closing pass mandatory: `content/help/*.md`, `scripts/smoke.ts` (pro + free), i18n keys, routes.ts.
- Worktree: `.claude/worktrees/player-accounts`, branch `feat/player-accounts`. Dev servers: `node <root>/node_modules/next/dist/bin/next dev` + `PORT=<n>` (rtk hook swallows `npx next dev`).
- Local test DB recipe: ephemeral PG on :54329 (fall back :54331), `npm run db:apply`, then `DATABASE_URL=... DATABASE_SSL=disable npm test` from `apps/web`.

---

### Task 1: Migration V276 — person_claims + fixture_availability

**Files:**
- Create: `db/migration/deltas/V276__player_accounts.sql`

**Interfaces:**
- Produces tables `person_claims` (token_hash unique, one OPEN claim per person via partial unique index) and `fixture_availability` (PK fixture_id+person_id, status in/out/maybe, `checked_in_at` for QR presence).
- Decision: QR check-in presence lives on `fixture_availability.checked_in_at` (same person+fixture grain) — no third table, lineups untouched.

- [ ] **Step 1: Write the migration**

```sql
-- V276 — Player accounts (PROMPT-53): claim invites + per-fixture availability.
-- persons.user_id + persons.consent exist since V204 — claim only fills them.

-- Claim invites: token hashed at rest (device-links pattern, doc 13 §7).
-- Rows are never deleted — claimed_at/revoked_at/invited_by ARE the audit trail.
create table person_claims (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  person_id   uuid not null references persons(id) on delete cascade,
  email       text not null,
  token_hash  text not null unique,
  invited_by  uuid references users(id) on delete set null,
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index person_claims_person_idx on person_claims(person_id);
create index person_claims_org_idx on person_claims(org_id);
-- One OPEN claim per person: minting revokes the previous invite first.
create unique index person_claims_open_uq on person_claims(person_id)
  where claimed_at is null and revoked_at is null;

alter table person_claims enable row level security;
alter table person_claims force  row level security;
create policy person_claims_tenant on person_claims for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on person_claims to app_user;

-- Player RSVP + QR self-check-in, one row per (fixture, person).
-- Player-side writes go through the superuser connection (cross-org, the
-- player is not an org member); the tenant policy serves organiser reads.
create table fixture_availability (
  fixture_id    uuid not null references fixtures(id) on delete cascade,
  person_id     uuid not null references persons(id) on delete cascade,
  org_id        uuid not null,
  status        text not null check (status in ('in','out','maybe')),
  note          text,
  checked_in_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (fixture_id, person_id)
);
create index fixture_availability_person_idx on fixture_availability(person_id);

alter table fixture_availability enable row level security;
alter table fixture_availability force  row level security;
create policy fixture_availability_tenant on fixture_availability for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on fixture_availability to app_user;
```

- [ ] **Step 2: Apply to the ephemeral test DB** (`npm run db:apply` against :54329 clone) — expect `Successfully applied 1 migration`.
- [ ] **Step 3: Commit** `feat: V276 person_claims + fixture_availability`

### Task 2: Guardian gate helper (pure)

**Files:**
- Create: `apps/web/src/lib/guardian.ts`
- Test: `apps/web/src/lib/__tests__/guardian.test.ts`

**Interfaces:**
- Produces `consentLocked(dob: string | null, now?: Date): boolean` — true iff dob known AND age < 16. Consumed by Task 4 (`setMyConsent`) and Task 8 (`/me` consent card).

- [ ] **Step 1: Failing tests** — cases: null dob → false; 15y364d → true; 16th birthday today → false; 40y → false; invalid date string → false (fail open to *locked*? No: unparseable = treat as unknown = false, organiser data quality issue, matches "dob says under 16").
- [ ] **Step 2: Implement** (date-only math, UTC, birthday boundary exact).
- [ ] **Step 3: `npx vitest run src/lib/__tests__/guardian.test.ts`** green. Commit.

### Task 3: Claim lifecycle usecases

**Files:**
- Create: `apps/web/src/server/usecases/person-claims.ts`
- Test: `apps/web/src/server/usecases/__tests__/person-claims.test.ts` (DB-backed, `describe.skipIf(!DATABASE_URL)`)

**Interfaces:**
- `CLAIM_PREFIX = "pc_"`, `mintClaimSecret()`, `hashClaimToken(secret)` (sha256 hex, device-links pattern).
- `createClaimInvite(auth: AuthCtx, personId: string, email: string): Promise<ClaimRow & { secret: string }>` — 404 unknown person, 409 `ALREADY_CLAIMED` if `persons.user_id` set; auto-revokes prior open claim; 14-day expiry; secret returned once.
- `revokeClaimInvite(auth, personId)` — revokes open claim (idempotent).
- `getOpenClaim(auth, personId): Promise<ClaimRow | null>` — no secret.
- `resolveClaimToken(token: string)` — superuser read; distinct errors `CLAIM_INVALID` / `CLAIM_REVOKED` / `CLAIM_EXPIRED` / `CLAIM_CLAIMED` (all 4xx); returns `{ id, org_id, person_id, person_name, org_name, email }` for the confirm screen.
- `claimPerson(token: string, userId: string)` — transaction: re-resolve, guard person.user_id still null (else `CLAIM_CLAIMED`), set `persons.user_id`, stamp `claimed_at`.
- `unlinkPerson(auth, personId)` — sets `user_id = null`, revokes any open claim; claim rows retained (audit).

- [ ] **Step 1: Failing tests** — create→resolve→claim happy path; second claim on claimed person → `CLAIM_CLAIMED`; expired token → `CLAIM_EXPIRED`; revoked → `CLAIM_REVOKED`; re-invite auto-revokes prior (open-claim partial unique never violated); invite on already-claimed person → 409; unlink clears user_id and revokes; token is stored hashed (raw secret absent from DB).
- [ ] **Step 2: Implement** (mirror `device-links.ts` structure; org writes in `withTenant`, token resolution via superuser `sql`).
- [ ] **Step 3: Run suite** green. Commit.

### Task 4: /me usecases (fixtures, availability, consent)

**Files:**
- Create: `apps/web/src/server/usecases/me.ts`
- Test: `apps/web/src/server/usecases/__tests__/me.test.ts`

**Interfaces:**
- `listMyFixtures(userId): Promise<{ upcoming: MyFixture[]; results: MyResult[]; teams: MyTeam[] }>` — superuser read mirroring `listAssignedFixtures`: `persons.user_id = me` → `entrant_members` → entrants (`status in ('registered','confirmed')`) → fixtures home/away. Upcoming: `status in ('scheduled','in_play')`, unscheduled or `>= date_trunc('day', now())`, soonest first, limit 100, each row carries `person_id`, `availability: {status, note} | null`, `checked_in_at`, org/comp/div names + slugs + `competition_visibility`, entrant + opponent names, `fixture_no`. Results: `status = 'finalized'` newest 10 with `outcome`, `summary`. Teams: distinct entrants with div/comp/org labels.
- `setMyAvailability(userId, fixtureId, { status, note }): Promise<AvailabilityRow>` — resolves MY person in that fixture (403 `NOT_YOUR_FIXTURE` when none); upsert on PK, `updated_at = now()`.
- `listMyPersons(userId): Promise<MyPerson[]>` — per claimed person: id, full_name, org name, consent flags, `consent_locked` (Task 2 helper; dob itself NOT returned).
- `setMyConsent(userId, personId, { public_name, public_photo })` — 404 if person not mine; 403 `CONSENT_LOCKED` when guardian-gated; merges into `persons.consent`; then `fireDivisionRevalidate(divisionId, competitionId)` for every distinct division the person is rostered in (public card + entrant lists flip immediately).
- `checkInToFixture(userId, fixtureId)` — resolves MY person among the fixture's entrants (null → caller shows claim-first interstitial); upsert `fixture_availability` with `checked_in_at = now()`, status kept or defaulted `'in'`.

- [ ] **Step 1: Failing tests** — cross-org isolation (user A with persons in org1+org2 sees both; user B sees none of A's); withdrawn entrant's fixtures excluded; RSVP upsert (in→out overwrite, note kept per write); RSVP against a fixture not mine → 403; consent flip persists + guardian-locked person 403s; unclaimed person untouched by everything; check-in stamps `checked_in_at` and defaults status `in` without clobbering an existing `out`.
- [ ] **Step 2: Implement.** Revalidation via `fireDivisionRevalidate` is try/catch-safe outside request scope already.
- [ ] **Step 3: Run suite** green. Commit.

### Task 5: Check-in token (signed, stateless)

**Files:**
- Create: `apps/web/src/server/usecases/checkin-token.ts`
- Test: `apps/web/src/server/usecases/__tests__/checkin-token.test.ts`

**Interfaces:**
- `mintCheckinToken(fixtureId: string, expiresAt: Date): Promise<string>` — jose `SignJWT({ fid: fixtureId }).setProtectedHeader({ alg: "HS256", typ: "seazn-checkin" })`, same `AUTH_SECRET` key derivation as `lib/auth.ts`.
- `verifyCheckinToken(token: string): Promise<string>` — returns fixtureId; expired/garbage/typ-mismatch → `HttpError(401, …, "CHECKIN_EXPIRED" | "CHECKIN_INVALID")`.
- Expiry: caller passes `endOfLocalDay(new Date(), tz)` re-exported from `device-links.ts` (fixture's division `schedule_settings.tz`, UTC fallback) — same day-of policy as device links.

- [ ] **Step 1: Failing tests** — round-trip; expired → CHECKIN_EXPIRED; tampered/typ-mismatch (a session JWT!) → CHECKIN_INVALID.
- [ ] **Step 2: Implement.** Step 3: green, commit.

### Task 6: API routes + registries + schemas

**Files:**
- Create: `apps/web/src/app/api/v1/persons/[id]/claim-invites/route.ts` (POST create → `{...claim, claim_url}`; DELETE revoke; session editor via existing `requireResourceAuth`-style org resolution used by persons routes — copy the sibling `persons/[id]` route's auth)
- Create: `apps/web/src/app/api/v1/persons/[id]/unlink/route.ts` (POST)
- Create: `apps/web/src/app/api/v1/me/fixtures/route.ts` (GET — `requireUser()` only, mirror `me/assigned-fixtures`)
- Create: `apps/web/src/app/api/v1/me/fixtures/[id]/availability/route.ts` (PUT)
- Create: `apps/web/src/app/api/v1/me/persons/route.ts` (GET)
- Create: `apps/web/src/app/api/v1/me/persons/[id]/consent/route.ts` (PATCH)
- Create: `apps/web/src/app/api/v1/fixtures/[id]/checkin-link/route.ts` (POST — session editor, mints `{ url, expires_at }`)
- Create: `apps/web/src/app/api/claims/[token]/route.ts` (GET status view — non-v1, token IS the auth, like `/api/invites`)
- Create: `apps/web/src/app/api/claims/[token]/accept/route.ts` (POST — `requireUser()` + `claimPerson`)
- Create: `apps/web/src/app/api/checkin/[token]/route.ts` (POST — `requireUser()` + verify + `checkInToFixture`; returns `{ checked_in: true }` or `{ needs_claim: true }`)
- Modify: `apps/web/src/server/api-v1/schemas.ts` — `putAvailabilitySchema` (`status: z.enum(["in","out","maybe"])`, `note: z.string().max(280).nullish()`), `patchMyConsentSchema` (`public_name?: boolean, public_photo?: boolean`), `createClaimInviteSchema` (`email: z.email()`)
- Modify: `apps/web/src/server/api-v1/key-scopes.ts` — add ALL seven v1 routes to `NEVER_KEY_ROUTES` (claim minting = credential minting; /me = session-bound)
- Modify: `apps/web/src/server/api-v1/openapi.ts` ROUTES + run `npm run openapi:gen`, commit JSON
- Test: `apps/web/src/server/api-v1/__tests__/` enumeration suites must stay green (they fail on any unregistered route — that IS the test)

- [ ] Step 1: routes + schemas. Step 2: registries + `npm run openapi:gen`. Step 3: run enumeration + route unit suites, green. Commit.

### Task 7: Claim invite email + organiser console (persons panel)

**Files:**
- Modify: `apps/web/src/lib/email.ts` — `sendClaimInviteEmail(to, { orgName, personName, claimUrl })` on the courtside shell: eyebrow `orgName`, title "Claim your player profile", paragraph + `button("Claim my profile", claimUrl)` + `linkFallback`.
- Modify: `apps/web/src/components/v2/persons-panel.tsx` — per-person row action: unclaimed → "Invite to claim" (email prefill + send) opening a modal that shows the returned one-time link + QR (reuse `invite-scorer.tsx` link+QR modal pattern) + "open invite pending · revoke"; claimed → "Claimed" badge + "Unlink" (ConfirmDialog, `confirm.unlinkPlayer.*` messages).
- Modify: `apps/web/src/lib/messages.ts` — `claim.*` keys.
- Test: email template snapshot in the existing `email-html-templates.test.ts` pattern; panel logic covered by e2e (Task 10).

- [ ] Step 1: email + test. Step 2: panel UI. Step 3: tsc + targeted vitest green. Commit.

### Task 8: /claim/[token] page + /me player home + routes/messages

**Files:**
- Create: `apps/web/src/app/claim/[token]/page.tsx` — server component, `resolveClaimToken`: logged-out → magic-link login CTA (`/login?next=/claim/<token>`, email prefilled); logged-in → identity confirm card (person name, org, claim email vs session email mismatch warning) + accept button → POST accept → redirect `/me?claimed=1`. Distinct error states for invalid/expired/revoked/claimed (each its own copy, no shared vague error).
- Create: `apps/web/src/app/me/page.tsx` + client components under `apps/web/src/components/me/` — console shell like `/my-matches` (app-gantry header, NO org nav, NOT org-scoped).
- Modify: `apps/web/src/lib/routes.ts` — `me: () => "/me"`, `claim: (token) => `/claim/${token}``, `checkin: (token) => `/checkin/${token}``.
- Modify: `apps/web/src/lib/messages.ts` — `me.*` keys.

**Design (frontend-design pass, floodlit-console system):** `/me` is the player's locker room. Signature element: **"Next match" NightStage hero** — the dark stadium-night panel (existing `.app-*` vocabulary) holding the next fixture with the RSVP control rendered as three tactile floodlit buttons (✓ In / ? Maybe / ✗ Out — emerald/amber/zinc, pressed state visibly lit, note field folds out under). Everything below stays quiet and light: "Coming up" list (each row a compact RSVP segmented control + comp/div/org context + public-page link only when the competition is public/unlisted), "Recent results" (scoreline rows), "My teams" chips, and the consent card (two switches, per person/org; guardian-locked → disabled with plain-language line "An organiser manages this until you're 16."). Empty state = invitation: "No matches yet — when an organiser rosters you, they land here." Desktop AND 390px.

- [ ] Step 1: routes + messages. Step 2: /claim page with 4 error states. Step 3: /me page + RSVP client component (optimistic write, rollback on error). Step 4: tsc green; visual check both viewports (screenshots). Commit.

### Task 9: Organiser availability grid + QR check-in surfaces

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx` — fetch fixture availability rows (withTenant) + claimed-person set; pass `availability` map into `FixtureConsole`.
- Modify: `apps/web/src/components/v2/fixture-console.tsx` — thread `availability?: Record<personId, {status, note, checked_in_at}>` through to `LineupEditor`; add "Check-in QR" action (POST checkin-link → link+QR modal, invite-scorer pattern).
- Modify: `apps/web/src/components/v2/lineup-editor.tsx` — per-person chip in lineup rows AND roster chips: ✓ (emerald) / ✗ (red) / ? (amber) with `title={note}`; no row → "—" (zinc, covers unclaimed + no-answer); `checked_in_at` → additional "at venue" dot. Chips only — no layout rework.
- Create: `apps/web/src/app/checkin/[token]/page.tsx` — logged-out → login-with-next; logged-in POST → success state ("You're checked in — the organiser can see you're here") or claim-first interstitial ("This works once you've claimed your player profile — ask the organiser for your invite"). NOTE: page path is `/checkin/[token]` (root `f/` would shadow nothing but reads badly; routes.ts owns the shape; QR encodes absolute URL).
- Test: component-level render test for the chip mapping (`lineup-editor` accepts availability map) or covered via e2e grid assertion; page logic via e2e.

- [ ] Step 1: thread data server→console→editor. Step 2: chips + QR modal. Step 3: checkin page. Step 4: tsc green, visual check grid. Commit.

### Task 10: E2E — full loop + regressions

**Files:**
- Create: `apps/web/e2e/player-accounts.spec.ts` (serial project — creates a user)

Flow (magic-link `login_url` trick; budget: ONE extra magic-link send, stays under 5/5min):
1. Pro storageState: create person (dob adult), entrant + roster them, generate fixtures.
2. Invite to claim → grab `claim_url` from API response (e2e-friendly token precedent).
3. Fresh context: open claim_url → login via magic-link login_url → confirm → land /me.
4. /me shows the fixture → RSVP "out" + note.
5. Organiser context: lineup picker shows ✗ chip + note tooltip; unclaimed teammate shows "—".
6. Mint check-in QR link (API) → player context opens → checked-in state → organiser grid shows at-venue dot.
7. Second claim attempt on same person (new invite impossible → 409; old link → CLAIM_CLAIMED copy).
8. Consent flip: player toggles public_name on → public player card 200s with name; toggles off → 404 again (tag revalidation). Unclaimed person's card stays 404 throughout.

- [ ] Step 1: spec written, runs green locally against dev server (env sourced: `set -a && source .env.local && set +a`). Step 2: full `test:e2e` parallel+serial green. Commit.

### Task 11: Closing pass (mandatory)

**Files:**
- Create: `apps/web/content/help/getting-started/player-accounts.md` (player-facing: claim, /me, RSVP, check-in, consent + guardian line)
- Modify: `apps/web/content/help/entrants/*.md` (or the persons/directory help page — organiser side: invite to claim, QR print path, unlink)
- Modify: `scripts/smoke.ts` — gapSuite extension: invite → claim (API) → RSVP → availability visible in fixture payload, on pro AND free org (feature is all-plans; asserts no 402).
- Verify `npm run openapi:gen` committed, messages sweep, routes sweep.

- [ ] Step 1: help pages. Step 2: smoke extension + local smoke run. Step 3: commit.

### Task 12: Verification before completion

- [ ] `cd apps/web && npx tsc --noEmit` — clean.
- [ ] Full unit suite vs ephemeral DB — green (baseline-compare any pre-existing failures on main first).
- [ ] e2e player-accounts + touched suites — green.
- [ ] Screenshots: `/me` desktop + 390px, lineup grid with chips (Playwright MCP).
- [ ] `superpowers:requesting-code-review` then `superpowers:finishing-a-development-branch` → PR to main.

## Self-Review Notes

- Spec coverage: V276 ✓ (T1), claim flow email+QR+errors+unlink ✓ (T3/T6/T7/T8), /me + RSVP + consent + guardian ✓ (T4/T8), availability grid ✓ (T9), QR self-check-in + interstitial ✓ (T5/T6/T9), closing pass ✓ (T11), acceptance tests ✓ (T3/T4/T10/T12).
- Deviations from spec text, with reasons: (a) presence stored as `fixture_availability.checked_in_at` not a lineups column — person may check in before any lineup exists; same grain, no third table. (b) check-in page path `/checkin/[token]` not `/f/[token]/checkin` — `/f` is not an existing root namespace; routes.ts is the single source anyway. (c) claim/checkin accept endpoints live under `/api/claims/*`, `/api/checkin/*` (non-v1, token-authed) mirroring `/api/invites/[token]/accept` — keeps key-scope enumeration clean.
- Audit for unlink = retained `person_claims` rows (claimed_at/revoked_at/invited_by); `competition_events` is competition-scoped and wrong grain for an org-wide person.
