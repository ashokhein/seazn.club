# PROMPT-53 — Player accounts: claim, player home, availability, consent

**Read first:** `design/v2/prompts/PROMPT-20-tier1-features.md` §20c (normative origin)
and `design/v2/16-future-features.md` §1.3;
`db/migration/v2-engine/tables/V204__persons.sql` (`persons.user_id` + `consent` jsonb
ALREADY exist — claim fills them, no persons migration needed),
`V213__entrant_members.sql` + `V215__lineups.sql` (person ↔ entrant ↔ lineup chain);
`apps/web/src/server/usecases/persons.ts` (extend, don't fork);
`apps/web/src/lib/auth.ts` (session/`getCurrentUser`, magic-link login);
`apps/web/src/app/api/users/me/route.ts` (account surface — player home is NOT this) and
`api/v1/me/assigned-fixtures/route.ts` (existing cross-org "me" query precedent);
`apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx`
(public card whose consent flags flip);
`apps/web/src/app/(public)/r/[ref]/ticket.png/route.tsx` (QR rendering precedent);
`apps/web/src/server/api-v1/schemas.ts` + `usecases/registrations.ts` (existing
DOB/guardian-consent shapes — reuse vocabulary);
`apps/web/src/lib/email-templates/compose.ts` (invite email on courtside template);
`apps/web/src/lib/routes.ts` (register every new page — raw hrefs are lint-banned);
`apps/web/src/lib/messages.ts` (i18n — all new strings through it).
**Depends:** nothing pending. Migration **V276** (V275 = advisor indexes).

## Context

Every surface today is organiser-operated; players are `persons` rows with no login.
`persons.user_id` (V204) is the designed seam and has never been filled. This prompt
ships the last PROMPT-20 tier-1 feature: a person claims their row, gets a cross-org
player home, RSVPs availability that organisers see in the lineup picker, self-checks-in
via QR, and owns their consent flags. Player accounts are **all plans, free included**
(growth loop — every claimed player is a future organiser).

## Task

1. **Schema V276** (`db/migration/deltas/V276__player_accounts.sql`), house RLS/org
   pattern:
   - `person_claims`: id, org_id, person_id FK, email, token (unique, hashed at rest
     like device links), invited_by, expires_at, claimed_at, revoked_at. Partial unique
     index: one OPEN claim per person (`where claimed_at is null and revoked_at is null`).
   - `fixture_availability`: fixture_id FK, person_id FK, status in
     ('in','out','maybe'), note text, updated_at; unique (fixture_id, person_id).
2. **Claim flow**:
   - Organiser console (people page): "Invite to claim" → email via `compose.ts`
     template + copyable link; QR for the same link on the person's console detail
     (print-at-the-club path).
   - `/claim/[token]`: magic-link login if logged out → confirm identity → set
     `persons.user_id`, stamp `claimed_at`. Token expired/revoked/claimed → clear error
     states. Staff unlink (sets `user_id` null, revokes claim) — audited via the
     existing history pattern.
3. **Player home `/me`** (console shell, NOT org-scoped):
   - `GET /api/v1/me/fixtures` — all persons where `user_id = me` → `entrant_members`
     → entrants → upcoming fixtures across orgs; plus recent results and teams.
     Mirror the `assigned-fixtures` query/auth shape.
   - RSVP buttons (in/out/maybe + note) writing `fixture_availability`.
   - Consent card: claimed player edits own `consent` flags (overrides org defaults);
     save triggers tag revalidation so the public player card flips immediately.
   - **Guardian gate (decision — confirm with owner at kickoff):** if `dob` says
     under 16, consent stays read-only for the player; organiser-set values hold.
     Full guardian-link accounts are out of scope.
4. **Organiser availability grid**: in the lineup picker, per-person availability chip
   for the fixture (✓/✗/? + note tooltip); unclaimed persons show "—". No layout
   rework — chips into the existing picker rows.
5. **QR self check-in**: fixture-scoped signed token (device-links signing approach) →
   `/f/[token]/checkin` marks lineup presence for the claimed person; organiser sees it
   in the lineup picker. Unclaimed person scanning → claim-first interstitial.
6. **Closing pass (mandatory)**: `content/help/*.md` (player-accounts page + organiser
   invite section), `scripts/smoke.ts` extended (pro + free: invite → claim → RSVP →
   grid shows it), i18n keys via `messages.ts`, new pages in `routes.ts`.

## Acceptance

- E2E (Playwright, magic-link `login_url` trick): invite → claim → RSVP → organiser
  grid shows chip → QR check-in marks presence. Second claim attempt on a claimed
  person fails clean.
- Consent flip by player revalidates the public card (assert name/photo appears and
  disappears); **unclaimed persons unaffected everywhere** (public card, exports,
  lineup picker) — regression-tested.
- Unit: claim token lifecycle (expire/revoke/reuse), one-open-claim index, cross-org
  `/me/fixtures` isolation (user A never sees user B's persons), guardian gate by dob.
- `npx tsc --noEmit` + unit suite green BEFORE push; screenshots desktop + 390px for
  `/me` and the grid.

## Out of scope

Guardian-link accounts (full sub-account flows), player-to-player messaging, push
notifications, profile merging across orgs, per-org PWA manifest (parked follow-up —
see memory), availability-aware auto-scheduling (feeds PROMPT-41 later).
