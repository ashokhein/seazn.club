# Billing groups — remaining work

Branch `feat/billing-groups`, rebased on `feat/event-pass-e2e-and-entitlement-gaps` (134beecf).
Spec: `docs/superpowers/specs/2026-07-21-billing-groups-design.md`. Migration: V310.

Status 2026-07-21: rounds 3+4 committed (`ffb16eaf`). Round-5 review in flight — three findings
listed under §1.

## Verification baseline (reproduce before trusting any green)

```bash
cd apps/web
DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" \
DATABASE_SSL=disable DB_SCHEMA=seazn_billing_v \
rtk proxy npx vitest run
```

- Current at `ffb16eaf`: **2517 passed / 1 failed / 9 skipped**. Billing suites alone (with
  `src/lib/__tests__/billing-groups.test.ts`): 63 passed, 0 skipped. `tsc --noEmit` clean.
- Without `DATABASE_URL` the 50 billing tests SKIP and vitest still exits 0. Always read the
  skipped count, never the failure count alone.
- Fresh schema needs `npm run sync:sports` (same env) or `funnel.test.ts` fails on the
  sports catalog — environmental, not code.
- `pass-scoping-guard.test.ts` is deliberately red on the base branch; its 6 sites are all
  base's. Do not weaken it.

## 1. In flight — round-5 findings

- [ ] **Blocker: `cancelGroupIfEmpty` still has the race its comment claims to close**
      (`billing-groups.ts:348`). Its "emptiness test and status flip are ONE statement, so
      there is no window" is false. In READ COMMITTED the statement snapshot is taken at
      statement START; the CTE's `for update` blocks on the group lock attach holds, and when
      attach commits, the `not exists` on `organizations` is still evaluated against the
      original snapshot. EPQ does not help — and attach never UPDATEs the subscriptions row
      (it takes the lock and writes `organizations`), so there is no updated tuple to trigger
      EPQ at all. **Reproduced against real Postgres**: `UPDATE 1`, group `canceled` with a
      live org in it. Fix (also verified: `UPDATE 0`): transaction, `for update` as statement
      one, org count as a SEPARATE statement — a new statement gets a new snapshot. Keep
      claim-before-Stripe, rollback-on-refusal, `not_empty`, and Stripe outside the txn.
- [ ] **Major: account deletion discards `cancelBillingGroup`'s new `false`**
      (`app/api/users/me/route.ts:130`). On a failed Stripe cancel the subscription stays live
      and the user is anonymised anyway, so `owner_user_id` points at a deleted user, every
      billing route 403s, and nobody can ever cancel it — the exact outcome the comment above
      that loop says the code prevents. The sweep cannot see it either (its predicate is
      `quantity_paid <> org count`). Fail the deletion rather than destroy the data.
- [ ] Minor: `payment_method_types: ["card"]` on the transfer SetupIntent
      (`billing-groups.ts:815`) — Stripe guidance is to omit it. Drop it or justify it.

Done in `ffb16eaf`: renewal records the INVOICED seats (invoice line, pre-write item as
fallback); renewal true-up moved under `syncGroupQuantity`'s lock so `quantity_paid` is never
written ahead of Stripe; `groupOrgLimit`/`assertWithinGroupCap` split (pool acquisition inside
a transaction deadlocked all DB access at `DB_POOL_MAX`=5); `createOrgForUser` counts under the
group lock and syncs quantity; Stripe `apiVersion` pinned + `timeout: 10_000` +
`maxNetworkRetries: 0` (a retried item update is a retried charge) + `lock_timeout`/
`statement_timeout` on both lock-over-network transactions; transfer offer burned before the
handover.

## 1b. CI gap (found 2026-07-21, wider than this branch)

CI's database job runs `npm test --workspace apps/web -- run src/server` and nothing else
(`.github/workflows/ci.yml:192`). The other unit job has no `DATABASE_URL`. So **22 DB-gated
test files outside `src/server` never execute in CI** — 18 in `src/lib/__tests__`, plus 4
under `src/app`. They skip and the job goes green.

- [x] Extend the CI database job to the DB-gated suites outside `src/server` (`a194e9a5`).
      New step runs `src/lib src/app`; `pass-scoping-guard.test.ts` is EXCLUDED rather than
      fixed — its 6 sites are base's deliberate work queue. Delete the exclude when the Event
      Pass scoping sweep lands. Verified with the workflow's own command: 125 files / 763
      tests pass.
- [x] Make the local skip loud (`a194e9a5`): `apps/web/vitest.globalSetup.ts` warns once when
      `DATABASE_URL` is absent, names the skipped count as the number to trust, and gives the
      opt-in command. Silent when the DB is configured.
- [x] Decided: do NOT auto-load `.env.local` in vitest. Its `DATABASE_URL` is the local DEV
      database (`seazn` :5432, schema `seazn_club` = another session's) and these suites mutate
      rows. Documented in the globalSetup file so the next person does not "helpfully" add it.

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

- [ ] **BLOCKER for everything in this section: nothing exposes the group id.**
      `POST /api/billing/group/attach` requires `subscription_id`, and no endpoint returns it.
      `GET /api/orgs/[id]/subscription` deliberately projects `o.id as org_id` and returns
      plan/status only — it dropped `stripe_customer_id` because ORG_ROLES lets any member of
      any org in the group read it. So attach is currently uncallable from a browser, and the
      smoke path below could not test re-attach either. Needs `GET /api/billing/groups` —
      groups the user PAYS for (`groupIdsOwnedBy`), with org count, plan, and seats paid. Gate
      it on the payer, not on org membership.
- [ ] Place `billing.extra-org` tip beside the attach control
- [ ] Freed-slot tip now that `quantity_paid` is written
- [ ] Playwright verification desktop AND mobile
- [ ] Grep changed UI text across e2e (both phases) before merging; scope assertions to a
      container

## 4. Closing passes

- [x] OpenAPI regen — ran `npm run openapi:gen`, **no diff**. Correct, not a miss: the spec is
      built from the `/api/v1` Zod contract registry (`api-v1/openapi.ts`), and the new routes
      are console routes under `/api/billing/*` and `/api/cron/*`, which have never been in it.
      The CI drift gate is clean.
- [x] Help: `content/help/billing/groups.md` gained "Handing the group to a new payer" (the
      two-phase transfer, why the card does not travel, offers being single-use and expiring,
      and the honest note that there is no inbox for pending offers) plus a Common Question on
      the payer deleting their account.
- [x] `scripts/smoke.ts`: asserts the second org inherits the PAYER'S plan and resolves the
      group's entitlements while keeping its own per-org quotas — nothing else in smoke would
      have noticed that regressing, since every other org has its plan forced by `setPlan`.
      Plus the `/api/cron/billing-quantity` secret gate, mirroring the billing-events block.
      NOT covered: attach/detach round trip, blocked on the missing endpoint in §3.
- [x] Deploy runbook: `docs/superpowers/runbooks/billing-groups-deploy.md` — V310 ordering,
      `CRON_SECRET` + two scheduling options (neither committed; a recurring outbound job is
      the operator's call), verification, and the fact that there is no rollback.
- [ ] Update `HANDOFF.md`

## 5. Open decisions / deferred

- [ ] Transfer offer discovery: the SetupIntent is returned only to the OFFERER, so the
      recipient cannot find it. Needs a "pending offers for me" listing. This is the cost of
      the no-schema offer design.
- [x] Dashboard-edit blind spot documented in the spec (`fe777a3f`): if someone edits quantity
      in the Stripe dashboard while `quantity_paid == live org count`, no predicate notices.
      Equally blind under a mirror column, so a mirror was rejected; only an unconditional
      daily scan closes it, and that is declined until it actually happens.
- [ ] Freeze `fee_percent` per competition at first paid entry (C3) — the 8%→2% swing is 4x
      worse after V309's fee ladder.
- [ ] `runEvent` still stamps `billing_events.org_id` from metadata.
- [ ] Community cap stays 1; revisit on fee data now that V309 charges free orgs 8%.

## Standing constraints

Never call the real Stripe API (mock only). Never run `npm run stripe:sync` (mutates a real
account). Never bare `git stash` / `git stash pop` (stack shared across worktrees). No
repo-wide formatters (no prettier config — churns other sessions' files). `seazn_club` is
another session's schema; this branch uses `seazn_billing_v`.
