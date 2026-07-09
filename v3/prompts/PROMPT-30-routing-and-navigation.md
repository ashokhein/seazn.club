# PROMPT-30 — Hierarchical Routing (`/o/[org]/c/[comp]/d/[div]`), Breadcrumbs, Back Button

**Read first:** `v3/01-routing-and-navigation.md` (normative); `engine/08-api-design.md`
(API stays id-based); `engine/README.md` v1-cutover redirect precedent. Preamble: PROMPT-00.
House rules: regression test per change; extend `scripts/smoke.ts`; `tsc` + unit before push.

## Task
1. **Slugs & constraints** (v3/01 §2): unique `(org_id, slug)` on competitions,
   `(competition_id, slug)` on divisions; dedupe backfill migration (`-2` suffix);
   `slug_history` table + rename-redirect behaviour (console + `/shared`).
2. **Route builder:** `lib/routes.ts` typed builders for every console path; ESLint rule
   banning string-built console hrefs; codemod all `<Link>`/`redirect()` call sites.
3. **New route tree** under `app/o/[orgSlug]/…` per v3/01 §2 (move, don't duplicate,
   the existing page components); fixture pages keyed by per-division ordinal `f/[no]`.
4. **Auth from URL:** `requireOrgPage(orgSlug)` — membership check from path, sets
   `seazn_org` cookie as side effect; `postAuthLanding` → `/o/[slug]` for single-org users.
5. **Legacy 301s:** `/competitions/[id]`, `/divisions/[id]`, `/fixtures/[id]` resolve the
   slug chain and permanent-redirect; hit counter log line.
6. **`<Breadcrumbs>` + back button** in console layout per v3/01 §3–4: derived from
   params, org segment = org switcher, mobile collapse `‹ parent`, chevron 44px,
   `aria-label="Back to {parent}"`.

## Acceptance
- Unit: route builder outputs; slug dedupe; redirect resolution incl. renamed slugs.
- E2E: login (magic-link `login_url`) lands on `/o/[slug]`; deep-link to a division in a
  non-active org works in a second tab without corrupting the first (two-tab test);
  legacy `/divisions/[id]` 301s; breadcrumb links each level; back button reaches parent.
- Lint fails on a hardcoded `/o/` href; `npm test` + `tsc` green; smoke.ts updated;
  update `engine/README.md` + `v3/README.md` status.
