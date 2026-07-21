# Billing groups — remaining work

Branch `feat/billing-groups`, rebased on `feat/event-pass-e2e-and-entitlement-gaps` (134beecf).
Spec: `docs/superpowers/specs/2026-07-21-billing-groups-design.md`. Migration: V310.

Status 2026-07-21: round 3 implemented but **uncommitted**. Round-4 review in flight.

## Verification baseline (reproduce before trusting any green)

```bash
cd apps/web
DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" \
DATABASE_SSL=disable DB_SCHEMA=seazn_billing_v \
rtk proxy npx vitest run
```

- Current: **2512 passed / 2 failed / 9 skipped**.
- Without `DATABASE_URL` the 50 billing tests SKIP and vitest still exits 0. Always read the
  skipped count, never the failure count alone.
- Fresh schema needs `npm run sync:sports` (same env) or `funnel.test.ts` fails on the
  sports catalog — environmental, not code.
- `pass-scoping-guard.test.ts` is deliberately red on the base branch; its 6 sites are all
  base's. Do not weaken it.

## 1. In flight

- [ ] Round-4 review of the round-3 diff (running).
- [ ] **Bound the lock hold.** `syncGroupQuantity` holds `FOR UPDATE` on the group across two
      Stripe round trips. `lib/stripe.ts` sets no `timeout` and no `maxNetworkRetries`
      (stripe-node default 80s each); `lib/db.ts` sets no `statement_timeout`. Worst case
      ~160s of held lock per call, blocking every attach/detach/transfer/sweep on that group
      against a 60-connection budget.
- [ ] Pin Stripe `apiVersion` (currently unpinned; latest `2026-06-24.dahlia`).
- [ ] Commit round 3 by explicit path. Never `git add -A` — it has twice swept other agents'
      work into the wrong commit on this branch.

## 1b. CI gap (found 2026-07-21, wider than this branch)

CI's database job runs `npm test --workspace apps/web -- run src/server` and nothing else
(`.github/workflows/ci.yml:192`). The other unit job has no `DATABASE_URL`. So **22 DB-gated
test files outside `src/server` never execute in CI** — 18 in `src/lib/__tests__`, plus 4
under `src/app`. They skip and the job goes green.

- [ ] Extend the CI database job to the DB-gated suites outside `src/server`.
      Turning them on makes `pass-scoping-guard.test.ts` a hard CI failure (its 6 sites are
      base's deliberate work queue) — decide: fix those 6 first, or exclude that one file
      with a comment pointing at the sweep.
- [ ] Make the local skip loud: print a summary when DB suites skip, so `exit 0` with
      everything skipped stops reading as a pass.
- [ ] Do NOT auto-load `.env.local` in vitest. Its `DATABASE_URL` is the local DEV database
      (`seazn` :5432, schema `seazn_club` = another session's). These suites mutate rows.

Affected on this branch, verified passing locally (35 tests) but unenforced by CI:
`entitlements-sql-parity.test.ts` (the tie between `lib/entitlements.ts` and V310's
`org_has_feature`) and `billing-groups.test.ts`.

## 2. Admin panel (agreed next, not started)

Staff actions now hit a GROUP, not an org. Each surface needs to say how many orgs a change
affects.

- [ ] `/admin/entitlements`
- [ ] `/admin/orgs` + `admin-org-actions.tsx`
- [ ] `admin-plan-panel.tsx` — a staff plan grant now moves every org in the group
- [ ] `/admin/billing-events`
- [ ] `/admin/revenue` — **per-org revenue arithmetic breaks once a group holds two orgs**
- [ ] `/admin/coupons`

## 3. UI + visual verification (explicitly requested, not started)

- [ ] Place `billing.extra-org` tip beside the attach control
- [ ] Freed-slot tip now that `quantity_paid` is written
- [ ] Playwright verification desktop AND mobile
- [ ] Grep changed UI text across e2e (both phases) before merging; scope assertions to a
      container

## 4. Closing passes

- [ ] OpenAPI regen (CI drift gate) — attach/detach/transfer/accept/revoke/cron routes
- [ ] Help pages for the new operations
- [ ] `scripts/smoke.ts` group path (pro + free)
- [ ] Deploy note: schedule `POST /api/cron/billing-quantity` (external scheduler, not in
      repo — same shape as `/api/cron/billing-events`), plus `CRON_SECRET`
- [ ] Deploy note: V310
- [ ] Update `HANDOFF.md`

## 5. Open decisions / deferred

- [ ] Transfer offer discovery: the SetupIntent is returned only to the OFFERER, so the
      recipient cannot find it. Needs a "pending offers for me" listing. This is the cost of
      the no-schema offer design.
- [ ] Document the dashboard-edit blind spot in the spec: if someone edits quantity in the
      Stripe dashboard while `quantity_paid == live org count`, no predicate notices. Equal
      under a mirror column, so a mirror was rejected; only an unconditional scan closes it.
- [ ] Freeze `fee_percent` per competition at first paid entry (C3) — the 8%→2% swing is 4x
      worse after V309's fee ladder.
- [ ] `runEvent` still stamps `billing_events.org_id` from metadata.
- [ ] Community cap stays 1; revisit on fee data now that V309 charges free orgs 8%.

## Standing constraints

Never call the real Stripe API (mock only). Never run `npm run stripe:sync` (mutates a real
account). Never bare `git stash` / `git stash pop` (stack shared across worktrees). No
repo-wide formatters (no prettier config — churns other sessions' files). `seazn_club` is
another session's schema; this branch uses `seazn_billing_v`.
