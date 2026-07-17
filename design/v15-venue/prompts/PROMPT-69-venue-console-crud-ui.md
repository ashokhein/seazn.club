# PROMPT-69 — Venue console: manage venues & their courts

**Goal:** a console surface at `/o/[orgSlug]/settings/venues` where an editor
lists, creates, edits and deletes venues, and manages each venue's courts
(add / reorder / kind / surface). Fully i18n'd, help documented.

**Read first:**
- `apps/web/src/app/o/[orgSlug]/settings/page.tsx` and its siblings
  `settings/payments/page.tsx`, `settings/billing/page.tsx` — venues is a new
  **settings sub-page** in exactly this family. Copy the page scaffold (server
  component, `requireOrgPage`/auth guard, heading, back-link, the settings
  sub-nav if one exists).
- `apps/web/src/components/v2/division-settings.tsx` — the **closest existing
  pattern** for an editor CRUD panel with tabs/rows, danger-zone delete with a
  confirm, and the app `.input`/`.label` form styling. Mirror its structure and
  its `ConfirmProvider`/confirm-dialog usage for delete.
- `apps/web/src/components/nav.tsx` — the org nav; and how `settings` sub-pages
  are linked from `settings/page.tsx`. Add the "Venues" entry alongside
  payments/billing there (NOT a new top-level nav item).
- `apps/web/src/lib/routes.ts` — `orgVenues(org)` added in PROMPT-68; use it.
- `apps/web/src/server/usecases/venues.ts` (PROMPT-68) — `listVenues`,
  `createVenue`, `updateVenue`, `deleteVenue`, `addCourt`, `updateCourt`,
  `removeCourt`, and the `Venue`/`VenueCourt`/`VenueWithCourts` types.
- `apps/web/src/lib/i18n-keys.ts` — the typed `ui`-namespace key union; add the
  new `venue.*` keys here. `apps/web/src/dictionaries/*` (en/fr/es/nl) — fill all
  four (parity test is a gate). Precedent: any recent `ui.*` block.
- The i18n memory gotchas: `/o` layout serialises the full `ui` dict into page
  HTML → any smoke/e2e substring check on `/o` must target **markup**, not
  labels; console islands read locale via `useMsg()`/`msg()` seeded by the
  layout's `DictProvider`.
- `feedback_consistent_inputs` memory: every form shares the division-wizard
  input look — use `.input`/`.label`, no `text-xs` shrink.
- `apps/web/src/lib/help.ts` (`HELP_ARTICLE_SLUGS` + `helpUrl`) and
  `apps/web/src/server/__tests__/help-content.test.ts` (bidirectional registry
  gate). `apps/web/content/help/` for the new article.

**Depends:** PROMPT-68 merged (usecases + API + `orgVenues`). **No migrations.**

## Context

PROMPT-68 gave venues a body but no face. This prompt is the management face:
the place an organiser sets up "Riverside — 4 indoor wood courts, open 09:00–
22:00" once, and never retypes it. Everything here is org-scoped editor-only;
nothing touches scheduling yet (PROMPT-70/71) — but the courts an editor adds
here are exactly the scheduler's future grid columns, so getting the court
editor right (clear names, order, kind/surface) is the point.

## Decisions

- **Route:** `/o/[orgSlug]/settings/venues` (server page) — a sibling of the
  existing settings sub-pages, linked from `settings/page.tsx`. Editor-gated
  like the other settings pages (reuse the same guard).
- **Layout:** left = venue list (cards); selecting/opening a venue reveals its
  edit form + a **Courts** sub-panel (rows: name, kind select, surface select,
  drag-or-arrow reorder → `sortOrder`). "Add venue" opens a form on its own
  card (not a modal), matching the directory-tab rebuild pattern from v11
  (invite/add-forms lifted out of rows into their own card).
- **Client island** (`venues-panel.tsx`) does the mutations against the v1 API
  (`POST/PATCH/DELETE /api/v1/venues*`, `/venue-courts/*`), optimistic where
  cheap, revalidate on success. Server page does the initial `listVenues` read.
- **Delete = danger confirm** (`ConfirmProvider`), copy: "Delete <name>? Its
  courts are removed. Competitions using it lose the link." Hard delete
  (PROMPT-68 semantics: fixtures keep their `court_label`, lose `venue_court_id`).
- **Empty state**: a one-line explainer + "Add your first venue" — this is many
  orgs' first encounter with the concept.
- **No free/pro gate here** — the library itself is free; the multi-venue gate
  lands in PROMPT-70 at assignment time.

## Files

- **Create** `apps/web/src/app/o/[orgSlug]/settings/venues/page.tsx` (server)
- **Create** `apps/web/src/components/v2/venues-panel.tsx` (client island)
- **Modify** `apps/web/src/app/o/[orgSlug]/settings/page.tsx` — link to Venues
- **Modify** `apps/web/src/lib/i18n-keys.ts` — add `venue.*` key union members
- **Modify** `apps/web/src/dictionaries/en.json|fr.json|es.json|nl.json` — the
  `venue.*` strings, all four (exact filenames per the repo's dict layout)
- **Create** `apps/web/content/help/getting-started/venues.md` (or the right
  section) — the help article
- **Modify** `apps/web/src/lib/help.ts` — register the new slug
- **Create** `apps/web/src/components/v2/__tests__/venues-panel.test.tsx` — the
  component/interaction regression test
- **Modify** `scripts/smoke.ts` — a venue-management step

## Interfaces (consumed / produced)

- **Consumes** (PROMPT-68): `listVenues`, `createVenue`, `updateVenue`,
  `deleteVenue`, `addCourt`, `updateCourt`, `removeCourt`, `VenueWithCourts`,
  `VenueKind`, `VenueSurface`.
- **Produces**: `<VenuesPanel initial={VenueWithCourts[]} orgSlug={string} />`
  — PROMPT-70 does NOT reuse this, but the help slug `getting-started/venues`
  is cross-linked from PROMPT-70/71 articles.

## Build steps (TDD, bite-sized)

- [ ] **Step 1 — Add the i18n keys (types first).** In `i18n-keys.ts` add to the
  `ui` union:

```ts
  | "venue.title" | "venue.subtitle" | "venue.add" | "venue.empty" | "venue.emptyCta"
  | "venue.name" | "venue.address" | "venue.openFrom" | "venue.openTo" | "venue.notes"
  | "venue.courts" | "venue.courtName" | "venue.kind" | "venue.surface" | "venue.addCourt"
  | "venue.kind.indoor" | "venue.kind.outdoor"
  | "venue.surface.grass" | "venue.surface.hard" | "venue.surface.clay"
  | "venue.surface.wood" | "venue.surface.astro" | "venue.surface.other"
  | "venue.save" | "venue.delete" | "venue.deleteConfirm"
```

- [ ] **Step 2 — Fill all four dictionaries.** Add the `venue.*` strings to
  `en/fr/es/nl`. English first; translate the rest (surface/kind names are
  vocabulary — translate them). Run the parity gate:
  Run: `npx vitest run apps/web/src/lib/__tests__` (the i18n parity test)
  Expected: PASS — 4-way parity, no missing keys.

- [ ] **Step 3 — Write the failing panel test.** Create
  `venues-panel.test.tsx`. Use the repo's component test setup (jsdom, the
  render helper other `components/v2/__tests__` use; mock `fetch`).

```tsx
it("shows the empty state then reveals the add-venue form", async () => {
  render(<VenuesPanel initial={[]} orgSlug="riverside" />);
  expect(screen.getByText(/add your first venue/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /add venue/i }));
  expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
});

it("lists a venue with its courts and their surface", () => {
  const v = { id: "1", orgSlug: "x", name: "Riverside", slug: "riverside",
    address: null, lat: null, lng: null, openFrom: "09:00", openTo: "22:00",
    timezone: null, notes: null, createdAt: "", updatedAt: "",
    courts: [{ id: "c1", venueId: "1", orgId: "o", name: "Court 1",
               kind: "indoor", surface: "wood", sortOrder: 1 }] };
  render(<VenuesPanel initial={[v as never]} orgSlug="riverside" />);
  expect(screen.getByText("Riverside")).toBeInTheDocument();
  expect(screen.getByText("Court 1")).toBeInTheDocument();
  expect(screen.getByText(/wood/i)).toBeInTheDocument();
});
```

- [ ] **Step 4 — Run it, watch it fail.**
  Run: `npx vitest run apps/web/src/components/v2/__tests__/venues-panel.test.tsx`
  Expected: FAIL — `VenuesPanel` not found.

- [ ] **Step 5 — Build `venues-panel.tsx`.** Client island: venue cards + add
  form + per-venue edit form + courts sub-panel (rows with kind/surface `select`
  and add-court row), delete via `ConfirmProvider`. Mutations hit the v1 API;
  on success re-fetch or `router.refresh()`. Use `useMsg()` for every string,
  `.input`/`.label` styling. Keep the file focused — if it grows past ~250 lines,
  split the courts sub-panel into `venue-courts-editor.tsx`.

- [ ] **Step 6 — Run the panel test green.**
  Run: `npx vitest run apps/web/src/components/v2/__tests__/venues-panel.test.tsx`
  Expected: PASS (both).

- [ ] **Step 7 — Build the server page + link it in.**
  `settings/venues/page.tsx`: guard as editor, `const venues = await
  listVenues(auth)`, render `<VenuesPanel initial={venues} orgSlug={orgSlug} />`
  inside the settings shell. In `settings/page.tsx`, add a link/card to
  `routes.orgVenues(orgSlug)` with `t(dict, "venue.title")`.

- [ ] **Step 8 — Help article + registry.** Write
  `content/help/getting-started/venues.md` (what a venue is, courts, open hours,
  that assigning to a competition comes next — cross-link the scheduling
  article). Register its slug in `apps/web/src/lib/help.ts`.
  Run: `npx vitest run apps/web/src/server/__tests__/help-content.test.ts`
  Expected: PASS (registry ↔ disk both directions).

- [ ] **Step 9 — Extend smoke.** In `scripts/smoke.ts` add, on the **pro** org
  path: create a venue via the API, add two courts, assert `listVenues` returns
  it with both courts ordered. (Free-path venue management is identical — no gate
  here — so a single assertion that a community org can also create a venue
  suffices; the gate smoke lands in PROMPT-70.)
  Run: `npm run smoke` (or the documented smoke invocation)
  Expected: the new venue steps print PASS.

- [ ] **Step 10 — Verify + commit.**
  Run: `npx tsc -p apps/web --noEmit` → 0.
  Run: `npx vitest run apps/web/src/components apps/web/src/lib apps/web/src/server/__tests__` → green.
  ```bash
  git add apps/web/src/app/o/'[orgSlug]'/settings/venues \
          apps/web/src/components/v2/venues-panel.tsx \
          apps/web/src/components/v2/__tests__/venues-panel.test.tsx \
          apps/web/src/app/o/'[orgSlug]'/settings/page.tsx \
          apps/web/src/lib/i18n-keys.ts apps/web/src/dictionaries \
          apps/web/content/help/getting-started/venues.md apps/web/src/lib/help.ts \
          scripts/smoke.ts
  git commit -m "feat(venues): console CRUD for venues + courts, i18n + help"
  ```

## Non-goals

- No competition/division assignment (PROMPT-70). No map, no address autocomplete
  (the `address` field is a plain text input this wave). No per-court hours.
- No public-facing venue page.

## Done when

- `/o/[org]/settings/venues` lists/creates/edits/deletes venues and manages
  courts (name/kind/surface/order), styled with `.input`/`.label`, delete behind
  a danger confirm, empty state present.
- Linked from `settings/page.tsx`. All strings via `ui` `venue.*`, en/fr/es/nl
  parity green.
- Help article live + registered (bidirectional test green). Smoke extended.
- `tsc` clean, component + parity + help tests green. Committed.
