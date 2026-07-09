# v3/01 — Routing & Navigation: `org / comp / div` URLs, Breadcrumbs, Back Button

## 1. Problem

The console uses flat, id-based routes (`/competitions/[id]`, `/divisions/[id]`,
`/fixtures/[id]`) while the public site already uses the correct hierarchy
(`/shared/[orgSlug]/[compSlug]/[divSlug]`). Consequences:

- URLs carry no context; organisers can't tell which org/comp a division link belongs to.
- The "active org" lives in a cookie (`seazn_org`), so two browser tabs on two orgs
  silently corrupt each other — the URL should be the source of truth.
- No breadcrumb trail is derivable from the path; every page invents its own back link
  (or has none — intake #12).

## 2. Target URL scheme

Console mirrors public, under an `/o` prefix to avoid collisions with marketing/app
routes (`/pricing`, `/dashboard`, `/help`, future vanity pages):

```
/o/[orgSlug]                                        org home (competitions list)
/o/[orgSlug]/settings                               org settings
/o/[orgSlug]/c/[compSlug]                           competition overview
/o/[orgSlug]/c/[compSlug]/schedule                  competition schedule board
/o/[orgSlug]/c/[compSlug]/settings
/o/[orgSlug]/c/[compSlug]/d/[divSlug]               division console (tabs stay ?tab=)
/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule
/o/[orgSlug]/c/[compSlug]/d/[divSlug]/registrations
/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[fixtureNo]  fixture detail
```

Decisions:

- **Slugs, not ids.** Slugs already exist for the public site; enforce uniqueness per
  parent (org-wide comp slugs, comp-wide div slugs). Fixtures get a per-division ordinal
  (`f/14`) — human-quotable ("look at match 14").
- **`/o`, `/c`, `/d` segment markers** keep parsing unambiguous and URLs short; the
  public site keeps its marker-less `/shared/...` scheme (prettier for sharing; already
  live and indexed).
- **URL beats cookie.** `requirePageAuth()` gains a variant `requireOrgPage(orgSlug)`
  that authorises membership from the path and *sets* `seazn_org` as a side effect (kept
  only for API routes and legacy redirects). Multi-org tabs become safe.
- **Legacy routes 301.** `/competitions/[id]` → look up slug chain → redirect. Table not
  needed (ids remain resolvable); pattern mirrors the v1 cutover's `v1_slug_redirects`.
  Keep for ≥2 releases; log hits to know when dead.
- **API unchanged.** `/api/v1/*` stays id-based — machine surface, no churn.
- Slug renames: org/comp rename regenerates slug with old-slug redirect row (small
  `slug_history` table shared with the public site, which has the same need).

## 3. Breadcrumbs

One shared `<Breadcrumbs>` in the console layout, derived entirely from route params —
no per-page wiring:

```
Acme Sports  ›  Summer Smash 2026  ›  U16 Boys  ›  Schedule
```

- Each segment links to its level; current segment is plain text.
- Mobile: collapse to `‹ [parent name]` only (doubles as the back affordance, §4).
- Org segment doubles as the org switcher (dropdown chevron) — replaces the separate
  active-org control in the header.

## 4. Universal back button (intake #12)

Simple chevron icon, top-left of the page header, every console page except org home.

- Target = **structural parent** (from the breadcrumb chain), not `history.back()` —
  predictable, works on deep links, never exits the app. Exception: slideshow/score
  token pages keep their own minimal chrome.
- 44×44 px touch target; `aria-label="Back to {parent}"`.
- Desktop shows chevron + parent name on hover; mobile chevron only (per intake: "simple
  back icon only").

## 5. Wireframe (division console header, mobile)

```
┌────────────────────────────────────────┐
│ ‹ Summer Smash 2026                    │   ← breadcrumb-collapse = back button
│ U16 Boys                     [● Live]  │   ← h1 + division status chip
│ Entrants · Fixtures · Standings · Stats│   ← tab bar, horizontal scroll
└────────────────────────────────────────┘
```

## 6. Migration & risks

- Biggest churn is `href` literals. Introduce `lib/routes.ts` route-builder
  (`routes.division(org, comp, div)`) and forbid string-built console hrefs via lint rule;
  the codemod then touches every `<Link>` once.
- Slug uniqueness backfill: existing comps/divisions already have slugs from the public
  site work; add DB unique constraints `(org_id, slug)` / `(competition_id, slug)` and a
  dedupe migration (`-2` suffix) before switching.
- E2E: memory's magic-link `login_url` trick still lands on `/dashboard`; `postAuthLanding`
  updates to `/o/[orgSlug]` when the user has exactly one org.

Related: engine/08 (API design — untouched), v3/02 (mobile header), v3/03 (cards link via
route builder).
