# HANDOFF

## Status
v10 PROMPT-56 (sponsor CRM & monetization) COMPLETE on `feat/v10-sponsor-crm-build` (worktree `.claude/worktrees/v10-sponsor-crm-build`). Smoke 297/0, engine 845/845, tsc 0, live Playwright demo done (user-reviewed, drove 3 UX revisions).

## Current task
Push + PR (blocked only on doing it).

## Done
- V283 `db/migration/deltas/V283__sponsor_crm.sql` (3 tables, RLS, entitlement seeds, idempotent backfill) + `apps/web/src/server/__tests__/sponsor-crm-migration.test.ts` (commit f0e500d)
- `apps/web/src/server/usecases/sponsors.ts` CRUD/reorder/resolveSponsors + `/api/v1/orgs/[id]/sponsors*` + tiered `components/org-sponsors.tsx` + settings wiring + ui keys ×4 locales (70da563)
- Public tier groups (shared comp page), register masthead, `/s/[sponsorId]` redirect, slideshow/embed resolver feed (e476110)
- Monetization: packages/orders usecases + routes, billing-events payment_intent.succeeded/failed dispatch, sponsor-invoice/receipt emails + dict keys ×4 (71f6d91)
- Slice 5: help `content/help/sharing/sponsors.md` + slug registry; smoke `sponsorsSuite` + 2 v3 blob-era checks updated to resolver policy; sponsor mutations bust public cache (bustPublicSponsors); user-driven UX rework: Sponsors = own settings side tab (?tab=sponsors), single form captures logo+name+link+tier+competition (upload on save), inline row edit, 2/3-col grid; fixed v1-envelope unwrap bug in manager api(); image-contract entry updated

## In progress
- (none)

## Next steps
1. Push branch, open PR: `git push -u origin feat/v10-sponsor-crm-build && gh pr create` (original feat/v10-sponsor-crm branch is locked by hung agent pid 96833 — do not reuse).
2. PR text: test-mode Stripe card sim still manual (smoke keyless: asserts 409 gate + order-before-intent, not paid webhook — that's unit-tested replay-safe); poster route untouched (no sponsor seam — v12 pulls resolver directly).
3. After merge: stg deploy needs V283 migrate; Stripe webhook endpoint must subscribe payment_intent.succeeded/payment_failed.

## Key decisions
- 2026-07-16: free plan keeps flat partner strip (CRUD + public render un-gated); tiers/per-comp/monetize = Pro keys sponsors.tiers/sponsors.monetize (+event_pass rows).
- 2026-07-16: sponsor checkout = hosted Checkout Session (mirrors registrations), intent metadata kind=sponsor; webhook activation guarded by order-status AND order.sponsor_id.
- 2026-07-16: sponsor manager routes console-only (NEVER_KEY_ROUTES), monetization routes never key-accessible (money).
- 2026-07-16: click bump via lib/deferred (after() in prod, inline in vitest).

## Gotchas
- vitest MUST run from apps/web cwd (root cwd = "@/ not found", 0 tests).
- Shared test DB poisons 'generic' sport_variants under full parallel run → ~97 env failures (invalid generic config); use fresh DB (seazn_fresh) + per-file serial runs.
- zsh: words starting with = (e.g. `echo ====`) trigger =cmd expansion — quote them.
- Ephemeral PG: mkdir /tmp/seazn-pg-sock BEFORE pg_ctl start.
- public-image-contract.test.ts pins sponsor <Image> width/height source text — tier map expression c.logo is the accepted pair now.

## Verify
cd apps/web && npx tsc --noEmit && DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_fresh" DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/sponsors.test.ts src/server/usecases/__tests__/sponsor-checkout.test.ts src/app/s/__tests__/route.test.ts
