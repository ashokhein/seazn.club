# Billing groups — remaining work

Branch `feat/billing-groups`, rebased on `feat/event-pass-e2e-and-entitlement-gaps` (134beecf).
Spec: `docs/superpowers/specs/2026-07-21-billing-groups-design.md`. Migrations: V310, V311.

Status 2026-07-21: rounds 3+4+5, the payer UI and V311 committed (through `a6c681ad`). Vitest
**2536 passed / 1 failed / 9 skipped** (the 1 is base's deliberate `pass-scoping-guard`). Smoke
**500 passed / 3 failed** (all 3 base's — see §1c).

**Not shippable to a customer yet.** The two named blockers are the recipient's accept UI
(§4b) and the admin panel (§2), where `/admin/revenue` currently computes per-org revenue
arithmetic that a group of two silently makes wrong.

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

## 1. Round-5 findings — ALL FIXED in `6906ba7e`

- [x] **`cancelGroupIfEmpty` still had the race its comment claimed to close**
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
- [x] **Account deletion discarded `cancelBillingGroup`'s `false`**
      (`app/api/users/me/route.ts`). On a failed Stripe cancel the subscription stayed live and
      the user was anonymised anyway, so `owner_user_id` pointed at a deleted user, every
      billing route 403s, and nobody could ever cancel it — the exact outcome the comment above
      that loop says the code prevents. The sweep could not see it either (predicate is
      `quantity_paid <> org count`). Now 503s before the anonymise; every prior step is
      idempotent, so a retry completes the deletion.
- [x] `payment_method_types: ["card"]` dropped from the transfer SetupIntent — it disabled
      dynamic payment methods and would have left a SEPA/Bacs payer unable to accept at all.
      **Loose end CLOSED** (`26b32245`): `finishHandover` listed `{ type: "card" }` only, so a
      departing payer's SEPA/Bacs mandate survived the handover and kept funding a group they no
      longer controlled — exactly the property the two-phase design exists to guarantee. Omitting
      `type` returns every method type on the pinned API version. The test double was complicit
      (it ignored the filter and answered with everything, so correct and broken were
      indistinguishable to it) and now honours `type`.

Done in `ffb16eaf`: renewal records the INVOICED seats (invoice line, pre-write item as
fallback); renewal true-up moved under `syncGroupQuantity`'s lock so `quantity_paid` is never
written ahead of Stripe; `groupOrgLimit`/`assertWithinGroupCap` split (pool acquisition inside
a transaction deadlocked all DB access at `DB_POOL_MAX`=5); `createOrgForUser` counts under the
group lock and syncs quantity; Stripe `apiVersion` pinned + `timeout: 10_000` +
`maxNetworkRetries: 0` (a retried item update is a retried charge) + `lock_timeout`/
`statement_timeout` on both lock-over-network transactions; transfer offer burned before the
handover.

## 1c. Smoke — what running it found (2026-07-21)

Recipe: prod build, server on a port **you have checked is free** (3100 is another session's —
verify with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, a health check will happily answer from
theirs), throwaway schema, then:

```bash
psql "$URL" -c 'drop schema if exists seazn_smokeverify cascade'
DB_SCHEMA=seazn_smokeverify npm run db:apply && npm run sync:sports
SMOKE_BASE=http://127.0.0.1:3111 DB_SCHEMA=seazn_smokeverify npm run test:smoke
```

Now **500 passed / 3 failed**. Fixed here (`ef6ca36a`, `5262c6e9`):

- Four `subscriptions.org_id` reads left over from V310 — the first threw, `main()` caught it,
  and the run printed a tally having silently skipped 22 later checks.
- Teardown aborted on `subscriptions_owner_fk`: groups outlive their orgs, and
  `owner_user_id -> users(id)` has no ON DELETE. **If a hard user-purge job is ever written it
  hits this too** — today nothing hard-deletes users, the account route soft-deletes.
- `/admin/orgs` was a hard 500 on `s.org_id`.

The remaining 3 are the BASE branch's, not this one:

- [ ] `pay card method is Pro-gated on community (402)`
- [ ] `plg free page carries the 'Powered by' attribution CTA`
- [ ] `p72: community card division reads payments_unavailable (P2-10)`

All three are V309 (`134beecf`, base) making `branding` and `registration.paid` free for
community and re-monetising by fee ladder. Its smoke expectations were never updated — smoke
had not been run since. Deliberately NOT changed here: whether each is a stale assertion or
genuinely unfinished V309 work (its own header defers a `stripe-connect.ts` gate simplification
to "a later task") is that change's owner's call, and guessing would mask the difference.

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
- [x] `/admin/orgs` — was a 500 on the dropped `s.org_id`; now joins through
      `organizations.subscription_id` and shows a "group of N" chip beside the plan.
- [ ] `admin-org-actions.tsx` — still needs the group-size warning on destructive actions
- [x] `admin-plan-panel.tsx` — a staff plan grant moves every org in the group. `planPanel` now
      returns `group_org_count` + up to ten other names and the panel renders an amber note
      above the actions; silent at 1. Soft-deleted orgs excluded from both.
- [ ] `/admin/billing-events`
- [x] `/admin/revenue` — **the entry here was wrong; nothing to fix.** It reports Stripe
      APPLICATION FEES from card entry fees, mapped to orgs via `organizations.stripe_account_id`
      (`platform-revenue.ts:103`). That is Connect, which is per-org and which grouping never
      touches. It was never subscription MRR, so a group holding two orgs changes none of its
      arithmetic. Checked rather than assumed, because "revenue" reading as "MRR" is exactly the
      wrong assumption to carry into an admin fix.
- [ ] `/admin/coupons`

## 3. UI + visual verification (explicitly requested, not started)

- [x] **BLOCKER for everything in this section: nothing exposes the group id.**
      `POST /api/billing/group/attach` requires `subscription_id`, and no endpoint returns it.
      `GET /api/orgs/[id]/subscription` deliberately projects `o.id as org_id` and returns
      plan/status only — it dropped `stripe_customer_id` because ORG_ROLES lets any member of
      any org in the group read it. So attach is currently uncallable from a browser, and the
      smoke path below could not test re-attach either. Needs `GET /api/billing/groups` —
      groups the user PAYS for (`groupIdsOwnedBy`), with org count, plan, and seats paid. Gate
      it on the payer, not on org membership.
- [x] Place `billing.extra-org` tip beside the attach control
- [x] Freed-slot tip now that `quantity_paid` is written
- [x] Playwright verification desktop AND mobile
- [x] Grep changed UI text across e2e (both phases) before merging; scope assertions to a
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

## 4b. Gaps I know about and have NOT closed

- [ ] **The RECIPIENT still cannot accept from the app.** The payer's half shipped in
      `ef652e11` (offer from the picker, see the outstanding offer, withdraw it).
      `GET /api/billing/group/transfer` returns offers made TO a user together with the
      SetupIntent `client_secret` they need — but nothing renders a card form, so accepting a
      two-phase offer is still an API call. This needs Stripe Elements, and it is the first
      piece that CANNOT be verified locally under the never-call-real-Stripe rule.
- [ ] **Nothing about Stripe has been validated against a real account.** Every Stripe call in
      this branch is mocked, deliberately (standing rule: never call the real API). So the
      central pricing assumption — a graduated tiered price billing `quantity` = org count,
      tier 1 base + tier 2 half — has never been observed working. Neither has
      `assertPriceBillsQuantity`'s 503 against a genuine legacy per_unit price, nor a real
      proration on attach, nor a renewal invoice cut from a quantity we lowered. First
      staging deploy is the first evidence.
- [ ] **`reconcileGroupQuantities` has never run against real data**, only tests.
- [ ] **No Playwright spec for the group flow.** It was verified by hand (desktop 1440 +
      mobile 390, attach end to end), but nothing guards it in CI. `e2e.yml` is deliberately
      disabled, so a spec would only be a local gate — worth writing anyway.
- [ ] **No component test for `billing-group-panel.tsx`.** Its branching (freed slot vs not,
      at-cap, no candidates, self-hiding) is copy that decides what a customer believes they
      will be charged, and only the endpoint underneath it is tested.
- [ ] **Smoke covers detach but not attach.** Attach is covered by unit tests and one manual
      browser run; the round trip is not in `scripts/smoke.ts`.

## 5. Open decisions / deferred

- [x] Transfer offer discovery — CLOSED by V311 (`5db5dece`). The no-schema design could not
      answer "which offers are mine": the SetupIntent went only to the offerer, so a reload lost
      it and the recipient could never find it. The offer is a row now, single-use enforced by a
      status CAS and one-live-offer by a partial unique index, and `listGroupTransferOffers`
      serves both sides from an index instead of a Stripe round trip per customer.
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
