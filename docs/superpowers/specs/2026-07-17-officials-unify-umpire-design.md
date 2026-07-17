# Design: unify umpires on the officials system

- **Date:** 2026-07-17
- **Status:** Approved (design) — pending spec review, then implementation plan
- **Related memory:** v11 official onboarding (#111), doc 13 scorer role (PROMPT-18)

## Problem

There are three overlapping ways to get a human running the score pad:

1. **Hand-in device** — organiser mints a device link (`DeviceLinkPanel`, fixture
   page) → `/score/[token]` → `DeviceScorePad` (stripped: append + undo-own only,
   no lineups/finalize). Account-less.
2. **Invite-Umpire** (`InviteScorer`, division page) — one-tap QR mints an org
   invite `role=scorer` division-scoped → accept → account + `scorer_assignments`
   + `scorer`-role membership → `/my-matches` → full `FixtureConsole` board.
3. **Officials** (v11) — person-based roster in Directory → per-fixture
   `fixture_officials` assignment → claim rail → `/me` officiating lane →
   accept/decline → "Score this match" mints a **device link** (stripped pad).

Three concepts for one job is muddy. Invite-Umpire is the worst offender: it mints
an account + a blanket division seat but leaves **no roster identity** — a
scorer-member who exists nowhere in the Directory. Officials (the richest model:
roles, accept/decline, conflicts, blackouts, busy-elsewhere, auto-propose) score
through the **stripped** device pad instead of the full board.

## Goals

- Officials are the single "umpire" concept. A claimed official scores through the
  **full** `FixtureConsole` board, reached from `/my-matches`.
- Remove Invite-Umpire (`InviteScorer`).
- Keep the hand-in device link untouched as the account-less path.
- Surface declined / schedule-conflicted officials where organisers work.
- Officials schedule list reads sensibly (assignable matches first).

## Non-goals

- No change to the hand-in device link, `/score/[token]`, or `DeviceScorePad`.
- No new division-scope "official covers whole division" model in this cut
  (deferred — see Known gaps).
- No removal of `scorer` role / `scorer_assignments` machinery — still load-bearing
  for the viewer-additive path and `/my-matches`.

## Key decisions

- **2026-07-17: Option 2 (read-union), not Option 1 (dual-write).** An official's
  accepted `fixture_officials` row IS the scoring authority. We do NOT copy
  officials into `scorer_assignments` / `org_members`. `fixture_officials` stays
  the single source of truth. Rationale: no sync/cleanup code, decline auto-revokes
  authority, no members-list leak. Cost: teach 3 auth read/gate points to
  recognize accepted officials (higher auth blast radius — treat as security work).
- **2026-07-17: officials never become org members.** Resolves the members-list
  leak by construction.
- **2026-07-17: in_play sits at the BOTTOM** of the officials schedule list with
  decided (finalized/cancelled). This is an assignment view; live/done need no
  assigning. Revisitable.
- **2026-07-17: division-wide seat deferred**, not built. Auto-propose already
  spreads an official across the schedule organiser-side; the only residual
  friction (official accepting each fixture) gets a fast-follow "accept all".

## Feature A — officials → full board (Option 2, read-union)

Single source of truth: `fixture_officials` where `response = 'accepted'`. Teach
three existing scorer read/gate points to also recognize an accepted official for
a fixture. No writes to `scorer_assignments` or `org_members`.

### A1. `/my-matches` list — `scorers.ts` `listAssignedFixtures`
UNION the user's accepted `fixture_officials` assignments into the returned set, so
an official's matches appear in `/my-matches` with no `scorer_assignments` row.
Reuse the existing `AssignedFixture` shape (org/comp/div slugs, fixture_no,
scheduled_at, venue_tz, status, sport_key/module_version for the sport-aware label,
home/away names). Pin the official rows through `persons.user_id = me` and
`officials.person_id`. De-dup if the same fixture is covered by both a
scorer_assignment and an official row (unlikely, but guard).

### A2. Fixture-console page auth — `page-auth.ts` `requireFixturePage` and `requireResourcePageAuth`
Today the `if (!membership) notFound()` fires immediately, so it must be
**restructured**: a non-member (or a member whose role cannot score) falls through
to an official check before any 404, not after.

- Look up an **accepted covering `fixture_officials`** row for `(user, fixture)`.
- If found: render with `canScore = true`, `canEdit = false`. Synthesize
  `auth = { orgId, via: "session", userId, role: "official", keyId: null }` — the
  tenant door opens by `orgId` in `withTenant` (membership is a page-auth concept,
  not RLS), so the page's RLS-bounded reads work.
- If not found: `notFound()` (existing behavior — never leak existence).
- `requireResourcePageAuth`: officials pass **only** for `kind === "fixture"`;
  every other kind still 404s them (they get the score view and nothing else).

### A3. Score WRITE gate — `scorers.ts` `requireScorable`
The event-record API gate. Add: an accepted official on this fixture passes
(returns the `FixtureScope`). Without this, the board renders but every score
submission 403s. Mirror the existing `scorerCovers` branch: look up accepted
`fixture_officials` for `(auth.userId, fixtureId)`; if present, return scope. Keep
the existing editor/api-key/scorer/viewer branches. Officials get the same
`scorer_can_finalize` / `scorer_can_enter_lineups` capability config the scope
carries (they are the umpire — same rights as a scorer seat).

### A4. `/me` officiating lane — `officiating-lane.tsx`
Repoint `openScorePad()` from the device-link mint to a navigation to
`routes.fixture(org_slug, competition_slug, division_slug, fixture_no)` (the full
board). The `MyOfficiatingAssignment` read must carry the slugs + fixture_no
(extend `getMyOfficiating` in `me-officiating.ts` if absent). Drop the
`assigned-fixtures/[id]/score-link` device-mint call for officials. (The route +
`mintMyScoreLink` can be removed or left dormant — remove to avoid dead code.)

### A5. Security scoping (critical for Option 2)
- The synthesized `role: "official"` context must grant **only** the fixture score
  view + score writes. No org nav, no editor actions, no other resource kinds.
- `canEdit` is always false for officials.
- A **declined** or **pending** official must NOT pass any gate (only `accepted`).
- Verify `withTenant(orgId)` reads under the synthesized context cannot reach
  rows outside `orgId`.

## Feature B — reorder officials schedule list

`officials-panel.tsx` `FixtureLite` has **no `status` field** today and the table
renders `fixtures` in raw server order.

- Add `status` to `FixtureLite`; thread it from the schedule page's `fixtures`
  array into the `OfficialsPanel` `fixtures` prop.
- Sort before render:
  - **Top group:** `status === 'scheduled'`, ordered by `scheduled_at` asc, nulls
    last.
  - **Bottom group:** `in_play` + `finalized` + `cancelled`, ordered by
    `scheduled_at` asc.
- Pure client-side sort in the panel (no API change).

## Feature C — remove Invite-Umpire

- Delete `src/components/v2/invite-scorer.tsx`.
- Remove its import + usage in
  `src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (~line 168).
- **Keep** `scorer` role, `scorer_assignments`, `scorerCovers`, `createAssignment`,
  `/my-matches`, the viewer-additive path — all still used.
- **Keep** the generic `/api/orgs/[id]/invites` route + accept path (used by team
  invites for other roles); only the UI entry point for `role=scorer` goes away.
- Remove `inviteScorer.*` i18n keys if unused after removal.

## Feature D — surface declined / conflicted officials (both surfaces)

Board conflicts are produced **server-side** by the schedule validate usecase
(`/api/v1/divisions/[id]/schedule/validate` → `{ conflicts: BoardConflict[] }`),
flow through `use-board-actions` → `conflictsByFixture` → tile ticks
(`fixture-block.tsx`) + `ConflictsPanel` + badge count. Ride that pipeline.

### D1. Schedule board (new conflict codes)
Emit two new `BoardConflict` codes from the validate usecase, both `blocking:false`
(amber/warn):

- `official_declined` — any `fixture_officials.response = 'declined'` on the
  fixture. Detail = official name + reason if present.
- `official_unavailable` — an **accepted or pending** assigned official is on a
  blackout date (`official_availability`) or busy-elsewhere for the fixture's
  scheduled time (the derived cross-org read already used by `busyElsewhere`).

Register labels/help: `board/types.ts` `CONFLICT_LABEL` + `CONFLICT_HELP`, and i18n
`board.conflict.official_declined` / `official_unavailable` (+ help keys), with
**fr/es/nl parity** (repo rule — new UI strings need all four).

### D2. Fixture page (assigned-officials strip)
Add a compact "Officials" strip to `f/[no]/page.tsx`, reading `fixture.officials`
(denormalized cache — already carries `official_id`, `name`, `role`, `response`,
`decline_reason`). Render each assigned official with a status chip:

- accepted → lime, pending → amber, **declined → red "Declined" badge** (+ reason
  tooltip), unavailable → amber "Conflict" badge.
- Visible to editors/organisers; keep it out of the scorer/official chrome
  (`isScorer` view stays minimal).

## Known gaps / deferred

- **Division-wide official seat.** Invite-Umpire's blanket "one scorer, all
  division matches" is not replicated. Mitigation available today: OfficialsPanel
  auto-propose/apply spreads an official across the schedule. Fast-follow (separate
  spec): an "accept all pending" action on the `/me` lane so a league scorekeeper
  accepts once.

## Testing (repo standing rules)

- **Regression (fails without the change):**
  - accepted official → appears in `/my-matches`, opens `FixtureConsole`, can
    submit a score event (A1/A2/A3).
  - **declined official → fixture page 404** and **score write 403** (A5 negative —
    security-critical).
  - **not-assigned user → 404 / 403** unchanged.
  - Feature B: mixed-status fixture list sorts scheduled-first, in_play/decided
    last.
  - Feature D: validate usecase emits `official_declined` when a response is
    declined.
- **Smoke (`scripts/smoke.ts`):** add official invite → claim → accept →
  `/my-matches` full-pad path (pro + free). Drop the InviteScorer step.
- **Help (`content/help/*.md`):** officials now the umpire/scoring path; remove
  Invite-Umpire mention; document decline/conflict signals.
- **e2e/unit:** remove or redirect InviteScorer specs; add officials-scoring e2e.

## File-touch map

| Area | File | Change |
|---|---|---|
| A1 | `server/usecases/scorers.ts` | UNION accepted officials into `listAssignedFixtures` |
| A2 | `server/page-auth.ts` | non-member accepted-official branch in `requireFixturePage` + `requireResourcePageAuth` |
| A3 | `server/usecases/scorers.ts` | accepted-official branch in `requireScorable` |
| A4 | `components/me/officiating-lane.tsx`, `server/usecases/me-officiating.ts` | repoint score action to `routes.fixture`; carry slugs+fixture_no; drop device-mint |
| B | `components/v2/officials-panel.tsx`, schedule page | add `status` to `FixtureLite`; sort |
| C | `components/v2/invite-scorer.tsx` (del), `.../d/[divSlug]/page.tsx` | remove component + usage; prune i18n |
| D1 | schedule `validate` usecase, `components/v2/board/types.ts`, i18n `board.conflict.*` | new conflict codes + labels/help (4-locale parity) |
| D2 | `.../f/[no]/page.tsx` | assigned-officials strip with status chips |
| tests | `scripts/smoke.ts`, `content/help/*.md`, e2e/unit | per standing rules |
