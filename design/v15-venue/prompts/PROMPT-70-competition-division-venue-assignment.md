# PROMPT-70 — Assign venues to competitions & divisions

**Goal:** an editor assigns one or more venues (from the org library) to a
**competition**, and a subset of those to each **division**. A second venue on
either is gated behind the existing `scheduling.multi_division` Pro entitlement.
This is the data PROMPT-71's scheduler reads.

**Read first:**
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/settings/page.tsx` — the competition
  Settings page; add the "Venues" section here.
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` — division page
  with the `EDIT_TABS = [...TABS, "settings"]` tab system and
  `@/components/v2/division-settings.tsx` (`DivisionSettings`); the division venue
  picker goes into the division **settings** tab. Read how that tab renders.
- `apps/web/src/server/usecases/venues.ts` (PROMPT-68) — `listVenues`,
  `VenueWithCourts`.
- `apps/web/src/lib/entitlements.ts` — `hasFeature(orgId, key)`,
  `requireFeature(orgId, key)`. Gate key = **`scheduling.multi_division`**
  (already seeded in V114 — confirm via `grep scheduling.multi_division
  db/migration/deltas`). Read how an existing Pro-gated action calls
  `requireFeature` server-side AND how the UI reflects a disabled/upgrade state
  (v11 role-chips `free=swap/multi=Pro` is the closest UI precedent; sponsor
  perimeter-board Pro-gate is another).
- `apps/web/src/lib/feature-copy.ts` — the upgrade-chip copy source, if used.
- `apps/web/src/server/api-v1/http.ts`, `.../auth.ts`, an existing PATCH route
  (e.g. a division-settings mutation) for the route shape.
- `apps/web/src/lib/i18n-keys.ts` + dictionaries — add `venue.assign.*` keys,
  fill en/fr/es/nl.
- `apps/web/src/lib/help.ts` + `content/help/scheduling/*` — the scheduling help
  section the new "multiple venues" article joins.

**Depends:** PROMPT-68 (schema + usecases), PROMPT-69 (a venue library exists to
assign from). **No migrations** — the join tables shipped in V285.

## Context

A venue in the library does nothing until a competition claims it. This prompt
is the join: `competition_venues` and `division_venues`, plus the two console
pickers that write them, plus the one place the plan matters — you may run a
**single** venue on any plan (the common club case), but spanning **two+**
grounds is the Pro "multi-division/multi-venue" capability, so the second venue
add is gated. The subset rule (a division can only use venues its competition
has) is enforced in the usecase, not the DB.

## Decisions

- **Assignment usecases** live in `venues.ts` (or a sibling
  `venue-assignment.ts` if `venues.ts` is already large):

```ts
export function listCompetitionVenues(auth: Auth, competitionId: string): Promise<VenueWithCourts[]>;
export function setCompetitionVenues(auth: Auth, competitionId: string, venueIds: string[]): Promise<void>;
export function listDivisionVenues(auth: Auth, divisionId: string): Promise<VenueWithCourts[]>;
export function setDivisionVenues(auth: Auth, divisionId: string, venueIds: string[]): Promise<void>;
```

  - `setCompetitionVenues`: replace-set semantics (delete rows not in the list,
    insert new). If `venueIds.length > 1`, call `requireFeature(auth.orgId,
    "scheduling.multi_division")` first — throws `PaymentRequiredError` if not
    entitled.
  - `setDivisionVenues`: **must be a subset** of the competition's venues —
    validate against `listCompetitionVenues(comp of this division)`; reject a
    venue id not in that set with a 422. Same `>1 ⇒ requireFeature` gate.
- **Gate placement:** server-side `requireFeature` is the source of truth. The
  UI *also* disables the "add another venue" control for non-entitled orgs and
  shows the upgrade chip (defence-in-depth; never rely on UI alone).
- **Pickers:** competition Settings gets a multi-select of library venues;
  division Settings gets a multi-select constrained to the competition's chosen
  venues (options outside the comp set are not shown). Reuse the venue-panel
  visual vocabulary (venue name + court count chip).
- **No court-level assignment** — assigning a venue brings **all** its courts.
  (Per-court opt-out is a future spec.)

## Files

- **Modify** `apps/web/src/server/usecases/venues.ts` (or new
  `venue-assignment.ts`) — the four assignment usecases
- **Create** `apps/web/src/server/usecases/__tests__/venue-assignment.test.ts`
- **Create** `apps/web/src/app/api/v1/competitions/[id]/venues/route.ts`
  (GET list, PUT set)
- **Create** `apps/web/src/app/api/v1/divisions/[id]/venues/route.ts`
  (GET list, PUT set)
- **Modify** `apps/web/src/app/o/[orgSlug]/c/[compSlug]/settings/page.tsx` +
  a `<CompetitionVenues>` island — the competition picker
- **Modify** `apps/web/src/components/v2/division-settings.tsx` — the division
  picker (constrained subset)
- **Modify** `apps/web/src/server/api-v1/schemas.ts` — `SetVenues = z.object({
  venueIds: z.array(z.string().uuid()).max(50) })`
- **Modify** `apps/web/src/lib/i18n-keys.ts` + dictionaries — `venue.assign.*`
- **Create** `apps/web/content/help/scheduling/multiple-venues.md` + register slug
- **Modify** `scripts/smoke.ts` — assign flows on pro AND the free-gate on community
- **Modify** `openapi/openapi.yaml` — the two new paths

## Interfaces (consumed / produced)

- **Consumes** (68): `listVenues`, `VenueWithCourts`, `Auth`;
  (entitlements) `requireFeature`, `hasFeature`, `PaymentRequiredError`.
- **Produces** (71 consumes): `listDivisionVenues(auth, divisionId)` returning
  `VenueWithCourts[]` — **the exact call PROMPT-71's scheduler config-gen uses**
  to get a division's courts and their venue open-hours.

## Build steps (TDD, bite-sized)

- [ ] **Step 1 — Failing assignment test.** Create
  `venue-assignment.test.ts` (DB-backed, `skipIf(!HAS_DB)`; seed org + a
  competition + division + two venues):

```ts
it("assigns venues to a competition and reads them back", async () => {
  const { auth, compId, v1, v2 } = await seedCompWithVenues();
  await setCompetitionVenues(auth, compId, [v1.id]);         // 1 venue = free
  expect((await listCompetitionVenues(auth, compId)).map((x) => x.id)).toEqual([v1.id]);
});

it("gates a 2nd venue behind scheduling.multi_division", async () => {
  const { authCommunity, compId, v1, v2 } = await seedCompWithVenues({ plan: "community" });
  await setCompetitionVenues(authCommunity, compId, [v1.id]);           // ok
  await expect(setCompetitionVenues(authCommunity, compId, [v1.id, v2.id]))
    .rejects.toBeInstanceOf(PaymentRequiredError);
});

it("allows 2+ venues on a pro org", async () => {
  const { authPro, compId, v1, v2 } = await seedCompWithVenues({ plan: "pro" });
  await setCompetitionVenues(authPro, compId, [v1.id, v2.id]);
  expect((await listCompetitionVenues(authPro, compId))).toHaveLength(2);
});

it("rejects a division venue that isn't on its competition (422)", async () => {
  const { authPro, compId, divId, v1, v2 } = await seedCompWithVenues({ plan: "pro" });
  await setCompetitionVenues(authPro, compId, [v1.id]);       // comp has only v1
  await expect(setDivisionVenues(authPro, divId, [v2.id])).rejects.toThrow(/not on/i);
});
```

- [ ] **Step 2 — Run, watch it fail.**
  Run: `DATABASE_URL=$DATABASE_URL npx vitest run apps/web/src/server/usecases/__tests__/venue-assignment.test.ts`
  Expected: FAIL — functions undefined.

- [ ] **Step 3 — Implement the four usecases.** Replace-set with a transaction:
  `delete from competition_venues where competition_id=$1 and venue_id <> all($2)`
  then `insert … on conflict do nothing`, `org_id = auth.orgId`. The `>1` gate
  calls `requireFeature`. `setDivisionVenues` first loads the division's
  competition, computes the allowed set from `competition_venues`, and rejects
  any `venueId` outside it with a 422-mapped error (use the repo's validation
  error class — grep how other usecases throw 422).

- [ ] **Step 4 — Run green.**
  Run: same as Step 2 → PASS (all 4).

- [ ] **Step 5 — API routes.** `competitions/[id]/venues/route.ts` and
  `divisions/[id]/venues/route.ts`: `GET` → `list*Venues`; `PUT` →
  `parseBody(req, SetVenues)` → `set*Venues` → `reply(204)`. Auth `read`/`write`.
  Add `SetVenues` to `schemas.ts`.

- [ ] **Step 6 — Competition picker island.** `<CompetitionVenues>`: multi-select
  of `listVenues(auth)` results; PUTs to `/api/v1/competitions/[id]/venues`.
  When `!hasFeature(org, "scheduling.multi_division")`, disable adding a second
  and render the upgrade chip (reuse `feature-copy`). Mount in comp
  `settings/page.tsx`.

- [ ] **Step 7 — Division picker.** In `division-settings.tsx` add a Venues block
  whose options are the **competition's** venues (fetch via
  `/api/v1/competitions/[compId]/venues` or pass down from the server page).
  Same second-venue gate. PUTs to `/api/v1/divisions/[id]/venues`.

- [ ] **Step 8 — i18n.** Add `venue.assign.title`, `.compHint`, `.divHint`,
  `.addAnother`, `.proOnly`, `.notOnComp` etc. to `i18n-keys.ts` + all four dicts.
  Run: `npx vitest run apps/web/src/lib/__tests__` → parity PASS.

- [ ] **Step 9 — Help + registry.** `content/help/scheduling/multiple-venues.md`
  (assign to a competition, narrow per division, that it's a Pro capability,
  cross-link `getting-started/venues` and the board article). Register slug.
  Run: `npx vitest run apps/web/src/server/__tests__/help-content.test.ts` → PASS.

- [ ] **Step 10 — Smoke (pro + free gate).** `scripts/smoke.ts`: on **pro**,
  assign 2 venues to a competition + narrow a division to 1 and assert reads; on
  **community**, assert the 2nd-venue assign is rejected with payment-required.
  Run: `npm run smoke` → new steps PASS.

- [ ] **Step 11 — openapi + verify + commit.** Add both paths to
  `openapi/openapi.yaml`; run the drift test.
  Run: `npx tsc -p apps/web --noEmit` → 0; `DATABASE_URL=$DATABASE_URL npx vitest run` → green.
  ```bash
  git add apps/web/src/server/usecases apps/web/src/app/api/v1/competitions \
          apps/web/src/app/api/v1/divisions \
          apps/web/src/app/o apps/web/src/components/v2/division-settings.tsx \
          apps/web/src/server/api-v1/schemas.ts apps/web/src/lib \
          apps/web/src/dictionaries apps/web/content/help/scheduling/multiple-venues.md \
          scripts/smoke.ts openapi/openapi.yaml
  git commit -m "feat(venues): assign venues to competitions/divisions, multi-venue Pro gate"
  ```

## Non-goals

- No scheduler consumption yet (PROMPT-71). No per-court assignment. No moving
  fixtures between venues. Assignment does not retro-tag existing fixtures.

## Done when

- Competition Settings assigns library venues; Division Settings narrows to a
  subset; both PUT through the v1 API.
- `setCompetitionVenues`/`setDivisionVenues` enforce the subset rule and the
  `scheduling.multi_division` gate server-side (4 tests incl. gate + 422).
- UI disables the 2nd venue + shows upgrade chip for community orgs.
- i18n parity, help (bidirectional), openapi drift, smoke (pro assign + free
  gate) all green. `tsc` clean. Committed.
