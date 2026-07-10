# PROMPT-30 Hierarchical Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the organiser console from flat id routes (`/competitions/[id]`, `/divisions/[id]`, `/fixtures/[id]`) to slug hierarchy `/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[fixtureNo]`, with breadcrumbs, universal back button, legacy 301s, and URL-beats-cookie auth.

**Architecture:** Slug chain resolved once per request by cached helpers in `server/page-auth.ts`; pages keep using ids internally. One new layout `app/o/[orgSlug]/layout.tsx` owns Nav + Breadcrumbs + active-org cookie sync (client POST — Server Components cannot set cookies in Next 16). Old routes become auth-checked `permanentRedirect` stubs. `lib/routes.ts` builders are the only legal href source (ESLint enforced).

**Tech Stack:** Next 16 App Router (params are Promises; middleware = `src/proxy.ts`), postgres.js, Flyway deltas (`db/migration/deltas`), vitest (+ephemeral PG :54329 for DB suites), Playwright.

## Global Constraints

- Regression test per change; extend `scripts/smoke.ts`; `tsc` + unit green before push (memory house rules).
- API `/api/v1/*` stays id-based — untouched.
- Public `/shared/...` scheme unchanged (only gains slug-history redirect fallback).
- Slideshow/score-token pages keep their own chrome — do not move.
- DB unique indexes on `competitions(org_id, slug)` / `divisions(competition_id, slug)` ALREADY EXIST (V207/V209) — no dedupe backfill.
- Local dev DB: `apps/web/.env.local` DATABASE_URL, schema `seazn_club` (always `set search_path=seazn_club` in psql).
- Branch: `feat/v3-routing-prompt-30` stacked on `feat/v3-ui-prompt-32-31`.

## Scope decisions (locked)

- Move under `/o/[orgSlug]`: dashboard (→ org home), competitions/new, competitions/[id]{,settings,schedule,divisions/new}, divisions/[id]{,schedule,registrations}, fixtures/[id] (→ `f/[no]`), settings{,billing}.
- Stay put (cookie-scoped, future prompt): clubs, people, players, import, directory, my-matches, orgs/new, onboarding, admin, slideshow, score.
- Multi-org landing: everyone lands `/o/[activeOrgSlug]`; `/dashboard` becomes legacy 301.
- `new` is a reserved comp/div slug (static `/c/new`, `/d/new` routes win over dynamic).
- Fixture numbers renumber on regenerate — acceptable, they're per-division ordinals not permalinks.

---

### Task 1: Migration V263 — `slug_history` + `fixtures.fixture_no`

**Files:**
- Create: `db/migration/deltas/V263__routing_slugs.sql`
- Modify: `apps/web/src/server/usecases/history.ts:139,218` (add `fixture_no` to restore column lists — verify snapshot includes it first: `grep -n "snapshot" apps/web/src/server/usecases/history.ts`)
- Test: `apps/web/src/server/usecases/__tests__/fixture-no.test.ts` (DB-backed, :54329 recipe)

**Interfaces:**
- Produces: table `slug_history(entity_type, parent_id, old_slug, entity_id, created_at)`; column `fixtures.fixture_no int not null`, unique `(division_id, fixture_no)`, BEFORE INSERT trigger auto-assigns max+1 per division under `pg_advisory_xact_lock`.

- [ ] **Step 1: failing test** — insert two fixtures without fixture_no in one statement → numbered 1,2; explicit fixture_no preserved; unique violation on dup; second division starts at 1.
- [ ] **Step 2: migration SQL**

```sql
-- Console slug routing (v3/01): rename history + human fixture ordinals.
-- slug_history is a lookup table read before tenant context exists (org slug
-- resolution, public /shared) — no RLS, same as organizations.
create table slug_history (
  entity_type text not null check (entity_type in ('org','competition','division')),
  parent_id   uuid,          -- org_id for competitions, competition_id for divisions, null for orgs
  old_slug    text not null,
  entity_id   uuid not null,
  created_at  timestamptz not null default now()
);
create unique index slug_history_lookup_key
  on slug_history (entity_type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), old_slug);

alter table fixtures add column fixture_no int;
update fixtures f set fixture_no = t.rn
from (select id, row_number() over (partition by division_id
        order by round_no, seq_in_round, created_at, id) as rn from fixtures) t
where f.id = t.id;
alter table fixtures alter column fixture_no set not null;
create unique index fixtures_division_no_key on fixtures (division_id, fixture_no);

create function assign_fixture_no() returns trigger language plpgsql as $$
begin
  if new.fixture_no is null then
    perform pg_advisory_xact_lock(hashtext('fixture_no:' || new.division_id::text));
    select coalesce(max(fixture_no), 0) + 1 into new.fixture_no
      from fixtures where division_id = new.division_id;
  end if;
  return new;
end $$;
create trigger fixtures_assign_no before insert on fixtures
  for each row execute function assign_fixture_no();
```

- [ ] **Step 3: apply to test DB, run test → pass; `npm run db:apply` on local dev DB**
- [ ] **Step 4: history.ts restore paths carry fixture_no (undo keeps URLs); rerun engine-db undo tests**
- [ ] **Step 5: commit** `feat(db): slug_history + per-division fixture_no (PROMPT-30)`

### Task 2: Slug hygiene — per-parent dedupe, reserved `new`, rename regenerates slug

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts` (create ~L106-111: global-uniqueness bug → per-org check + `-2..-n` suffix loop + reserve `new`; update ~L168: name PATCH regenerates slug, old slug → `slug_history` row; explicit slug PATCH also records history)
- Modify: `apps/web/src/server/usecases/divisions.ts` (same, parent = competition_id)
- Modify: org rename usecase (find: `grep -rn "update organizations" apps/web/src/server`) — same, parent null; orgs slug global unique.
- Test: `apps/web/src/server/usecases/__tests__/slug-hygiene.test.ts`

**Interfaces:**
- Produces: `uniqueSlug(tx, base, taken: (s) => Promise<boolean>)` helper; every rename writes `slug_history`; creates never 409 on slug collision (auto-suffix).

- [ ] Failing tests: same-name comp in two orgs both get clean slug; same-name twice in one org → `x`, `x-2`; comp named "New" → slug `new-2`; rename writes history row + new slug; old slug row points at entity.
- [ ] Implement; run suite; commit `fix(slugs): per-parent dedupe + rename history (PROMPT-30)`

### Task 3: `lib/routes.ts` v2 — slug builders

**Files:**
- Modify: `apps/web/src/lib/routes.ts` (full rewrite, breaking signatures)
- Test: `apps/web/src/lib/__tests__/routes.test.ts`

**Interfaces (produces — exact, later tasks depend on these):**

```ts
routes.orgHome(org)                      // /o/{org}
routes.orgSettings(org, tab?)            // /o/{org}/settings[?tab=]
routes.billing(org)                      // /o/{org}/settings/billing
routes.competitionNew(org)               // /o/{org}/c/new
routes.competition(org, comp)            // /o/{org}/c/{comp}
routes.competitionSettings(org, comp)
routes.competitionSchedule(org, comp)
routes.divisionNew(org, comp)            // /o/{org}/c/{comp}/d/new
routes.division(org, comp, div, tab?)    // ?tab= preserved
routes.divisionSchedule(org, comp, div)
routes.divisionRegistrations(org, comp, div)
routes.fixture(org, comp, div, no: number)  // .../f/{no}
routes.slideshowCompetition(id) / slideshowDivision(id)  // unchanged, id-based
routes.shared(orgSlug, compSlug?, divSlug?)              // unchanged
```

- [ ] Failing test asserting each output; implement; `dashboard()` and old id builders DELETED (tsc will flag all call sites — fixed in Tasks 5–8). Commit (tsc red is expected mid-stack; do NOT push).

### Task 4: Slug resolvers + `requireOrgPage` family

**Files:**
- Create: `apps/web/src/server/slug-resolve.ts`
- Modify: `apps/web/src/server/page-auth.ts`
- Test: `apps/web/src/server/__tests__/slug-resolve.test.ts`

**Interfaces (produces):**

```ts
// slug-resolve.ts — React cache()d, one query each; slug_history fallback
// returns { renamedTo: string } so callers permanentRedirect.
orgBySlug(slug): Promise<{ id, name, slug } | { renamedTo } | null>
compBySlug(orgId, slug): Promise<{ id, name, slug } | { renamedTo } | null>
divBySlug(compId, slug): Promise<{ id, name, slug } | { renamedTo } | null>
fixtureByNo(divisionId, no): Promise<{ id } | null>
breadcrumbNames(orgId): Promise<{ comps: Record<string,string>, divs: Record<string,string> }> // divs key `${compSlug}/${divSlug}`

// page-auth.ts additions (all redirect /login unauth; notFound on non-member
// or broken chain — existence never leaks; scorer: fixture page allowed via
// scorerCovers, other pages notFound; layout passes allowScorer)
requireOrgPage(orgSlug, opts?: { allowScorer?: boolean }): Promise<PageAuth>
requireCompetitionPage(orgSlug, compSlug): Promise<PageAuth & { competition }>
requireDivisionPage(orgSlug, compSlug, divSlug): Promise<PageAuth & { competition, division }>
requireFixturePage(orgSlug, compSlug, divSlug, no): Promise<PageAuth & { competition, division, fixtureId, canScore }>
```

Renamed-slug behaviour: helpers call `permanentRedirect(rebuiltUrl)` internally when any level returns `renamedTo`.

- [ ] Failing tests (DB-backed): resolve happy chain; renamed comp slug → redirect target; cross-org chain (org A slug + org B comp) → null/notFound; fixtureByNo.
- [ ] Implement; suite green; commit.

### Task 5: Move the route tree under `app/o/[orgSlug]`

**Files (git mv — history preserved):**

| From | To |
|---|---|
| `app/dashboard/page.tsx` | `app/o/[orgSlug]/page.tsx` |
| `app/competitions/new/` | `app/o/[orgSlug]/c/new/` |
| `app/competitions/[id]/page.tsx` | `app/o/[orgSlug]/c/[compSlug]/page.tsx` |
| `app/competitions/[id]/settings/` | `.../c/[compSlug]/settings/` |
| `app/competitions/[id]/schedule/` | `.../c/[compSlug]/schedule/` |
| `app/competitions/[id]/divisions/new/` | `.../c/[compSlug]/d/new/` |
| `app/divisions/[id]/page.tsx` | `.../d/[divSlug]/page.tsx` |
| `app/divisions/[id]/schedule/` | `.../d/[divSlug]/schedule/` |
| `app/divisions/[id]/registrations/` | `.../d/[divSlug]/registrations/` |
| `app/fixtures/[id]/page.tsx` | `.../d/[divSlug]/f/[no]/page.tsx` |
| `app/settings/page.tsx` | `app/o/[orgSlug]/settings/page.tsx` |
| `app/settings/billing/` | `app/o/[orgSlug]/settings/billing/` |

- Create: `app/o/[orgSlug]/layout.tsx` (Nav + Breadcrumbs slot + `<ActiveOrgSync>`; `requireOrgPage(orgSlug, { allowScorer: true })`)
- Create: `apps/web/src/components/active-org-sync.tsx` (client; props `{ orgId, activeOrgId }`; useEffect → `fetch("/api/orgs/active", { method: "POST", body: JSON.stringify({ org_id: orgId }) })` once when mismatch)
- Modify each moved page: params `Promise<{ orgSlug, compSlug?, divSlug?, no? }>`; swap `requirePageAuth`/`requireResourcePageAuth` → Task 4 helpers; delete per-page `<Nav />`; hrefs via Task 3 builders (slugs now in scope from params/helpers).
- Modify `apps/web/src/server/usecases/fixtures.ts`: add `fixture_no` to fixture SELECT column lists (panels need it for links).
- Modify `apps/web/src/lib/auth.ts`: `getUserOrgs` must return `slug` (add to select if absent).

- [ ] Move + rewire one vertical at a time (org home → comp pages → division pages → fixture → settings), `npx tsc --noEmit` after each vertical; components that link (entity-card callers, v2/stages-panel, schedule boards) receive slugs via props.
- [ ] Unit suite green. Commit per vertical.

### Task 6: Legacy 301 stubs + `postAuthLanding` + Nav

**Files:**
- Create: `apps/web/src/server/legacy-routes.ts` — `legacyPath(kind: "competition"|"division"|"fixture", id): Promise<string>`: `getCurrentUser` → `resourceOrg(kind, id)` → membership else `notFound()` → build slug-chain URL via routes.\*; `console.log("[legacy-route]", kind, id)` hit counter.
- Create stub pages (each: await params, `permanentRedirect(await legacyPath(...))`): `app/competitions/[id]/page.tsx` (+settings/schedule/divisions/new → same target sub-path), `app/divisions/[id]/{page,schedule/page,registrations/page}.tsx`, `app/fixtures/[id]/page.tsx`, `app/dashboard/page.tsx` (→ active-org `routes.orgHome`), `app/settings/{page,billing/page}.tsx` (→ org-scoped), `app/competitions/new/page.tsx`.
- Modify: `apps/web/src/lib/auth.ts` `postAuthLanding` — `/dashboard` targets become `routes.orgHome(target.slug)`; scorer `/my-matches` + onboarding + safeNext unchanged.
- Modify: `apps/web/src/components/nav.tsx` — links via builders; Settings link needs active-org slug (Nav already fetches org).
- Test: `apps/web/src/server/__tests__/legacy-routes.test.ts`; update `apps/web/e2e/auth.setup.ts` (`/dashboard` → `/o/` wait).

- [ ] TDD legacyPath; stubs; tsc + suite; commit.

### Task 7: Breadcrumbs + back button + org switcher merge

**Files:**
- Create: `apps/web/src/components/breadcrumbs.tsx` (client). `useParams()` for `{ orgSlug, compSlug, divSlug, no }` + `usePathname()` tail (`schedule|settings|registrations|billing` → title-case; `f/[no]` → `Match {no}`; `new` → `New`). Props: `{ orgName, orgs: {name, slug}[], names: breadcrumbNames result }`. Org segment = dropdown (orgs → plain `<Link href={routes.orgHome(slug)}>`; ActiveOrgSync fixes cookie on arrival) — replaces separate org chip in Nav under /o. Mobile (`sm:hidden`): collapse to `‹ {parentName}`. Back chevron: 44×44px tap target, `aria-label="Back to {parent}"`, target = structural parent from chain, hidden on org home. Desktop hover shows parent name.
- Modify: `app/o/[orgSlug]/layout.tsx` (pass names map), `nav.tsx` (drop org chip under /o — Nav gains `hideOrgChip` prop or crumb renders below header bar).
- Test: `apps/web/src/components/__tests__/breadcrumbs.test.tsx` (vitest + testing-library, pattern from PROMPT-32 ui tests): renders chain links each level, current segment plain text, back aria-label.

- [ ] TDD; wire; visual check (`npm run dev`, mobile viewport screenshot via Playwright MCP); commit.

### Task 8: Codemod remaining hrefs + ESLint ban

**Files:**
- Modify: every remaining `href`/`redirect`/`router.push` with string console paths. Find: `grep -rEn '["`]/(o/|competitions|divisions|fixtures|dashboard|settings)' apps/web/src --include="*.tsx" --include="*.ts" | grep -v "api/"`.
- Modify: `apps/web/eslint.config.mjs` — add `no-restricted-syntax` entries (Literal + TemplateLiteral, href attrs + redirect/permanentRedirect/push/replace args, pattern `^\/(o\/|competitions\/|divisions\/|fixtures\/|dashboard)`), message: "Build console hrefs with routes.* from @/lib/routes." Scope `files: ["src/**/*.tsx", "src/**/*.ts"]`, exclude `src/lib/routes.ts`, `src/server/legacy-routes.ts`, legacy stub pages, e2e.
- Test: lint self-check — plant `<Link href="/o/x">` in scratch file → `npx eslint` fails; remove.

- [ ] Codemod; lint clean; `tsc` clean (first fully-green point of the stack); full unit suite; commit.

### Task 9: E2E — routing spec + suite sweep

**Files:**
- Create: `apps/web/e2e/routing.spec.ts`:
  1. login (helpers magic-link) lands on `/o/{slug}`;
  2. two-tab: tab A on org A division; tab B deep-links org B division (second membership via helpers SQL) → both render their own org after reload of A;
  3. `GET /divisions/{id}` → 308/301 → slug URL;
  4. breadcrumb: each level navigates; back button reaches parent (`aria-label`);
  5. renamed comp slug old URL → redirected.
- Modify: existing specs asserting `/dashboard`/id URLs (grep `waitForURL|toHaveURL` in `apps/web/e2e/`) — legacy gotos may stay (301 covers), URL assertions updated.

- [ ] Run `npx playwright test routing.spec.ts` then full e2e; fix fallout; commit.

### Task 10: smoke.ts + docs + status

**Files:**
- Modify: `scripts/smoke.ts` — after existing comp/div creation (both pro + free paths): magic-link `login_url` → capture session cookie → `GET /o/{org}/c/{comp}/d/{div}` expect 200; `GET /divisions/{id}` with cookie expect redirect chain to same URL.
- Modify: `design/v3/README.md` status row PROMPT-30; `design/v2/README.md` (routing cutover note — file the prompt calls `engine/README.md`); memory file for session learnings.

- [ ] Run smoke against dev server; update docs; final `tsc` + unit + lint; commit; push branch.
