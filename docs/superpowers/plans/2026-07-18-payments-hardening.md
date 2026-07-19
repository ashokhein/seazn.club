# Payments Hardening Wave Implementation Plan (PROMPT-72..75)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P0/P1 money gaps from `docs/superpowers/specs/2026-07-18-payments-hardening-design.md`: destructive-delete guards, Event Pass refund/duplicate lifecycle, sponsor + platform-charge dispute parity, subscription-sync correctness, past_due grace, downgrade intake gate, stuck-webhook auto-replay, Connect health.

**Architecture:** All changes ride existing rails — the `billing_events` dispatch table, `withTenant`/superuser split, destination-charge refund shape (`reverse_transfer` + `refund_application_fee`), and the cron-secret sweep pattern. One migration file for the whole wave. No new services.

**Tech Stack:** Next.js app router, postgres.js tagged SQL, stripe-node v22 (API 2026-06-24.dahlia), vitest (DB-backed), smoke.ts harness.

## Global Constraints (house rules — every task inherits these)

- Branch in a worktree: `git worktree add .claude/worktrees/payments-hardening -b feat/payments-hardening origin/main` — never checkout in the main repo dir. Copy `.env.local` from the main checkout (worktrees don't inherit it).
- **Migration number = V291, and this wave MERGES AFTER the Pro Plus tier
  branch** (`worktree-pro-plus-tier` owns `V290__pro_plus_plan.sql`, plan
  `docs/superpowers/plans/2026-07-18-pro-plus-tier-plan.md`). Same V-number
  contention pattern as PR #84/#85 — state the ordering in the PR body. At
  build time verify `ls db/migration/deltas | tail -1`: if V290 is not yet on
  main, coordinate before applying V291 locally (Flyway rejects out-of-order).
- Pro Plus coordination: that branch adds a `pro_plus` plan row + matrix.
  Task 8's unknown-price guard PROTECTS its rollout (unsynced price no longer
  downgrades orgs); Task 9/10 must treat any non-community plan generically —
  never hardcode `'pro'`.
- Every code change ships a regression test that fails without it.
- Stripe calls NEVER inside a `sql.begin` transaction.
- `v1()` and `handler()` wrap responses in `{ok,data}` — client fetches must unwrap.
- vitest runs from `apps/web` cwd against a FRESH test DB per run (`docs` in [[project_local_test_db]]; shared DB poisons sport_variants). Commands below assume `cd apps/web` and `DATABASE_URL` pointing at the test DB.
- i18n: any new UI string lands in en+fr+es+nl `ui.json` (parity-tested); new email strings in all four `emails` catalogs.
- Help pages update in the SAME PR (mandatory closing pass).
- Extend `scripts/smoke.ts` with pro + free paths for each feature (keyless-degrade aware: no STRIPE_SECRET_KEY in CI smoke).
- Server-side error copy is English (existing pattern), i18n only for UI/emails.
- Email sends are fire-and-forget (`.catch(() => {})` or `deferred()`), never blocking a webhook ACK.

## File Structure (wave map)

- Create: `db/migration/deltas/V291__payments_hardening.sql` (all wave DDL)
- Create: `apps/web/src/app/api/cron/billing-events/route.ts` (stuck-event sweep)
- Create: `apps/web/src/lib/email-templates/sponsor-dispute-alert.ts`, `sponsor-dispute-lost.ts`, `pass-revoked.ts`
- Modify: `apps/web/src/server/usecases/competitions.ts` (delete guards)
- Modify: `apps/web/src/server/api-v1/key-scopes.ts` (NEVER_KEY_ROUTES)
- Modify: `apps/web/src/lib/billing.ts` (pass revoke + duplicate refund + sync guards)
- Modify: `apps/web/src/server/usecases/billing-events.ts` (dispatch: pass refund, sponsor/platform disputes, stuck-sweep helpers)
- Modify: `apps/web/src/server/usecases/sponsors.ts` (dispute lifecycle + evidence)
- Modify: `apps/web/src/server/usecases/registrations.ts` (share dispute-recovery core)
- Modify: `apps/web/src/lib/entitlements.ts` (past_due grace)
- Modify: `apps/web/src/server/usecases/stripe-connect.ts` (health sync)
- Modify: `apps/web/src/app/api/billing/pass-checkout/route.ts` (idempotency)
- Modify: `apps/web/src/components/org-payment-instructions.tsx` region (Connect banner) + `apps/web/src/app/o/[orgSlug]/settings/connect/page.tsx`
- Tests: colocated `__tests__` next to each usecase; smoke suite `p72` in `scripts/smoke.ts`

---

### Task 0: Worktree + migration V291

**Files:**
- Create: `db/migration/deltas/V291__payments_hardening.sql`

**Interfaces:**
- Produces: columns used by every later task — `sponsor_orders.disputed_at timestamptz`, `sponsor_orders.dispute_id text`, `subscriptions.disputed_at timestamptz`, `subscriptions.dispute_id text`, `organizations.stripe_payouts_enabled boolean`, `organizations.stripe_disabled_reason text`, `organizations.stripe_requirements_due int`, `billing_events.replay_attempts int`.

- [ ] **Step 1: Create worktree, pull, verify numbering**

```bash
git -C /Users/ashokhein/github/seazn.club pull origin main
git -C /Users/ashokhein/github/seazn.club worktree add .claude/worktrees/payments-hardening -b feat/payments-hardening origin/main
cp /Users/ashokhein/github/seazn.club/apps/web/.env.local .claude/worktrees/payments-hardening/apps/web/.env.local
cp /Users/ashokhein/github/seazn.club/.env.local .claude/worktrees/payments-hardening/.env.local 2>/dev/null || true
ls .claude/worktrees/payments-hardening/db/migration/deltas | tail -1
```
Expected: `V290__pro_plus_plan.sql` (Pro Plus merged first — required). If the tail is below V290, STOP: merge order violated, coordinate before proceeding.

- [ ] **Step 1b: Carry the uncommitted Payments→Connect rename into this branch**
  (owner decision 2026-07-18: bundle into the wave PR). The main checkout holds
  it uncommitted; the new `connect/` page dirs are untracked:

```bash
cd /Users/ashokhein/github/seazn.club
git add -N 'apps/web/src/app/o/[orgSlug]/settings/connect' apps/web/src/app/settings/connect
git diff HEAD > /tmp/rename-connect.patch
cd .claude/worktrees/payments-hardening
git apply /tmp/rename-connect.patch
git add -A
git commit -m "feat(settings): rename Payments page to Connect (redirects kept)"
```

Then verify: `npx tsc --noEmit` from `apps/web` in the worktree (was green in
the main checkout: tsc 0, product-tour 8/8, smoke gained a legacy-redirect
check). After the wave PR MERGES, discard the now-duplicate working-tree copy
in the main checkout (`git checkout -- .` + delete the untracked connect dirs)
— not before.

- [ ] **Step 2: Write the migration**

```sql
-- V291 (payments hardening wave, spec 2026-07-18): dispute flags for sponsor
-- orders + platform subscriptions, Connect health mirror, webhook retry
-- counter, and the dead Event Pass members.max row (org-wide key can never
-- resolve through the comp-scoped pass branch — pricing page over-promised).
alter table sponsor_orders
  add column if not exists disputed_at timestamptz,
  add column if not exists dispute_id  text;

alter table subscriptions
  add column if not exists disputed_at timestamptz,
  add column if not exists dispute_id  text;

alter table organizations
  add column if not exists stripe_payouts_enabled  boolean not null default true,
  add column if not exists stripe_disabled_reason  text,
  add column if not exists stripe_requirements_due int not null default 0;

alter table billing_events
  add column if not exists replay_attempts int not null default 0;

delete from plan_entitlements
  where plan_key = 'event_pass' and feature_key = 'members.max';
```

- [ ] **Step 3: Apply + verify**

```bash
npm run db:apply
psql "$DATABASE_URL" -Atc "set search_path=seazn_club; select count(*) from plan_entitlements where plan_key='event_pass' and feature_key='members.max'"
```
Expected: migrate OK, count `0`.

- [ ] **Step 4: Commit**

```bash
git add db/migration/deltas/V291__payments_hardening.sql
git commit -m "feat(db): V291 payments hardening columns + drop dead pass members.max row"
```

---

### Task 1: Competition-delete money guards (P0-1)

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts` (`deleteCompetition`)
- Test: `apps/web/src/server/usecases/__tests__/competitions-delete-money.test.ts`

**Interfaces:**
- Consumes: existing `deleteCompetition(auth, id)`; tables `competition_passes`, `registrations`, `sponsor_orders`+`sponsor_packages`.
- Produces: `deleteCompetition` throws `HttpError(409)` with copy listed below; smoke/e2e rely on the strings.

- [ ] **Step 1: Write the failing test**

```ts
// competitions-delete-money.test.ts — seed helpers exist in test-utils
// (mkOrg/mkComp/mkDivision patterns used by division-delete tests; copy the
// local seeding style of __tests__/divisions.test.ts).
import { describe, it, expect } from "vitest";
import { sql } from "@/lib/db";
import { deleteCompetition } from "@/server/usecases/competitions";

// authFor(orgId): build the same AuthCtx literal the sibling suites build.

describe("deleteCompetition money guards", () => {
  it("409s when the competition holds an Event Pass", async () => {
    const { auth, compId, orgId } = await seedCompWithDivision();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_test_pass')`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Event Pass"),
    });
  });

  it("409s when a registration has unrefunded card money", async () => {
    const { auth, compId, divId, orgId } = await seedCompWithDivision();
    await sql`insert into registrations
      (division_id, org_id, status, display_name, contact_email, amount_cents,
       payment_intent_id, refunded_cents, guardian_consent, answers, roster, access_token_hash)
      values (${divId}, ${orgId}, 'paid', 'P', 'p@x.test', 2000, 'pi_reg', 0,
              false, '{}', '[]', 'h')`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409 });
  });

  it("409s when a paid sponsor order is scoped to this comp via its package", async () => {
    const { auth, compId, orgId } = await seedCompWithDivision();
    const [pkg] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
      values (${orgId}, ${compId}, 'Gold', 25000, 'gbp', 'gold') returning id`;
    await sql`insert into sponsor_orders
      (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status, paid_at)
      values (${orgId}, ${pkg.id}, 'S', 's@x.test', 25000, 'gbp', 'paid', now())`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409 });
  });

  it("still deletes when money is fully refunded", async () => {
    const { auth, compId, divId, orgId } = await seedCompWithDivision();
    await sql`insert into registrations
      (division_id, org_id, status, display_name, contact_email, amount_cents,
       payment_intent_id, refunded_cents, guardian_consent, answers, roster, access_token_hash)
      values (${divId}, ${orgId}, 'withdrawn', 'P', 'p@x.test', 2000, 'pi_reg2', 2000,
              false, '{}', '[]', 'h2')`;
    await deleteCompetition(auth, compId);
    const [gone] = await sql`select 1 from competitions where id = ${compId}`;
    expect(gone).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/server/usecases/__tests__/competitions-delete-money.test.ts`
Expected: FAIL — first three tests get successful deletes (no 409).

- [ ] **Step 3: Implement guards in `deleteCompetition`**

Insert after the score-events guard, before the `delete`:

```ts
    // Money guards (payments-hardening spec P0-1): a delete would CASCADE
    // paid registrations, the Event Pass, and comp-scoped sponsorship —
    // erasing the app's only record of live money. Archive is always allowed.
    const [pass] = await tx`
      select 1 from competition_passes where competition_id = ${id} limit 1`;
    if (pass) {
      throw new HttpError(409, "competition has an Event Pass — archive it instead");
    }
    const [liveMoney] = await tx`
      select 1 from registrations r
      join divisions d on d.id = r.division_id
      where d.competition_id = ${id}
        and r.payment_intent_id is not null
        and r.refunded_cents < r.amount_cents
      limit 1`;
    if (liveMoney) {
      throw new HttpError(
        409,
        "competition has card payments that are not fully refunded — refund them or archive it instead",
      );
    }
    const [paidSponsor] = await tx`
      select 1 from sponsor_orders o
      join sponsor_packages p on p.id = o.package_id
      where p.competition_id = ${id} and o.status = 'paid'
      limit 1`;
    if (paidSponsor) {
      throw new HttpError(
        409,
        "competition has a paid sponsorship — refund the order or archive it instead",
      );
    }
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/server/usecases/__tests__/competitions-delete-money.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/competitions.ts apps/web/src/server/usecases/__tests__/competitions-delete-money.test.ts
git commit -m "feat(competitions): block delete while pass/unrefunded/sponsor money exists"
```

---

### Task 2: `DELETE /competitions/:id` → NEVER_KEY_ROUTES

**Files:**
- Modify: `apps/web/src/server/api-v1/key-scopes.ts` (NEVER_KEY_ROUTES array)
- Test: `apps/web/src/server/api-v1/__tests__/key-scopes.test.ts` (classification table)

**Interfaces:**
- Produces: API keys can no longer call the delete; sessions unaffected.

- [ ] **Step 1: Add the failing expectation**

In `key-scopes.test.ts` find the classification assertions (the enumeration proves every route consciously classified) and move/assert `"DELETE /competitions/:id"` into the never-key set:

```ts
expect(NEVER_KEY_ROUTES).toContain("DELETE /competitions/:id");
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/server/api-v1/__tests__/key-scopes.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add to `NEVER_KEY_ROUTES` (alphabetical/grouped placement beside other destructive routes):

```ts
  // Destructive + money-adjacent (payments-hardening P0-1): deleting a
  // competition cascades registrations/passes; console has no button —
  // keys must not have one either.
  "DELETE /competitions/:id",
```

Then reconcile the enumeration: if the route was previously listed in a scoped table, remove it there; run the test — the enumeration test tells you the exact leftover.

- [ ] **Step 4: Run full key-scopes suite** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): competition delete is never key-accessible"`

---

### Task 3: Event Pass refund → revoke (P0-3a)

**Files:**
- Modify: `apps/web/src/lib/billing.ts` (add `revokePassForRefundedCharge`)
- Modify: `apps/web/src/server/usecases/billing-events.ts` (`charge.refunded` dispatch)
- Create: `apps/web/src/lib/email-templates/pass-revoked.ts`
- Test: `apps/web/src/lib/__tests__/billing-pass-revoke.test.ts`

**Interfaces:**
- Consumes: `competition_passes.stripe_payment_intent` (written since V271).
- Produces: `revokePassForRefundedCharge(charge: Stripe.Charge): Promise<boolean>` exported from `lib/billing.ts`; dispatch calls it alongside the two existing `charge.refunded` handlers.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { sql } from "@/lib/db";
import { revokePassForRefundedCharge } from "@/lib/billing";
import type Stripe from "stripe";

const chargeFor = (intent: string, refunded: boolean) =>
  ({ payment_intent: intent, refunded }) as unknown as Stripe.Charge;

describe("revokePassForRefundedCharge", () => {
  it("deletes the pass when its charge is fully refunded", async () => {
    const { orgId, compId } = await seedOrgWithComp(); // sibling-suite seeding style
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r1')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r1", true))).toBe(true);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeUndefined();
  });

  it("ignores partial refunds and non-pass charges", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r2')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r2", false))).toBe(false);
    expect(await revokePassForRefundedCharge(chargeFor("pi_other", true))).toBe(false);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify fail** — export missing.

- [ ] **Step 3: Implement in `lib/billing.ts`**

```ts
/**
 * charge.refunded for an Event Pass (dashboard refunds included): a FULLY
 * refunded pass charge revokes the pass — money back means the comp rejoins
 * the quota (the freeze machinery handles any overage lazily). Partial
 * refunds leave the pass; owner outreach is a support flow, not code.
 */
export async function revokePassForRefundedCharge(charge: Stripe.Charge): Promise<boolean> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent || !charge.refunded) return false;
  const [revoked] = await sql<{ org_id: string; competition_id: string }[]>`
    delete from competition_passes where stripe_payment_intent = ${intent}
    returning org_id, competition_id`;
  if (!revoked) return false;
  await invalidateOrgEntitlements(revoked.org_id);
  return true;
}
```

Dispatch (`billing-events.ts`, `charge.refunded` case) gains a third call:

```ts
      await revokePassForRefundedCharge(event.data.object as Stripe.Charge);
```

Owner email: `pass-revoked.ts` template (subject "Your Event Pass was refunded", body: comp name + "the competition returns to your plan's active-competition allowance"). Fire from a small wrapper in billing-events after a `true` return, using `currentOwnerEmail`-style lookup (copy the org_members owner query from registrations.ts:1178 — created_by is a trap). Template registered in `lib/email.ts` beside `sendSponsorRefundEmail`; keys added to all four `emails` catalogs.

- [ ] **Step 4: Run tests + emails parity** — pass-revoke test PASS; `npx vitest run src/lib/__tests__/i18n-parity.test.ts` (or the catalog parity suite name in repo) PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(pass): full refund revokes the Event Pass (webhook + dashboard)"`

---

### Task 4: Pass duplicate-payment auto-refund + checkout idempotency (P0-3b)

**Files:**
- Modify: `apps/web/src/lib/billing.ts` (`recordPassPurchase` conflict handling)
- Modify: `apps/web/src/app/api/billing/pass-checkout/route.ts` (idempotency key)
- Test: `apps/web/src/lib/__tests__/billing-pass-duplicate.test.ts`

**Interfaces:**
- Produces: `recordPassPurchase` returns `{ recorded: boolean; duplicateIntent: string | null }`; callers (webhook `handleCheckoutCompleted`, `reconcilePassCheckout`) refund `duplicateIntent` when set. Signature change is internal to billing.ts + billing-events.ts.

- [ ] **Step 1: Failing test**

```ts
describe("recordPassPurchase duplicates", () => {
  it("first purchase records; second DIFFERENT intent reports a duplicate", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    const a = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_a" });
    expect(a).toEqual({ recorded: true, duplicateIntent: null });
    const b = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_b" });
    expect(b).toEqual({ recorded: false, duplicateIntent: "pi_b" });
    const same = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_a" });
    expect(same).toEqual({ recorded: false, duplicateIntent: null }); // replay, not duplicate
  });
});
```

- [ ] **Step 2: Run to verify fail** (returns void today).

- [ ] **Step 3: Implement**

```ts
export async function recordPassPurchase(args: {
  orgId: string;
  competitionId: string;
  paymentIntent?: string | null;
}): Promise<{ recorded: boolean; duplicateIntent: string | null }> {
  const [inserted] = await sql<{ competition_id: string }[]>`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent)
    values (${args.competitionId}, ${args.orgId}, ${args.paymentIntent ?? null})
    on conflict (competition_id) do nothing
    returning competition_id`;
  if (inserted) {
    await invalidateOrgEntitlements(args.orgId);
    return { recorded: true, duplicateIntent: null };
  }
  const [existing] = await sql<{ stripe_payment_intent: string | null }[]>`
    select stripe_payment_intent from competition_passes
    where competition_id = ${args.competitionId}`;
  const dup =
    args.paymentIntent && existing?.stripe_payment_intent !== args.paymentIntent
      ? args.paymentIntent
      : null;
  return { recorded: false, duplicateIntent: dup };
}
```

Webhook caller (`handleCheckoutCompleted` pass branch) and `reconcilePassCheckout` both do:

```ts
      const res = await recordPassPurchase({ orgId, competitionId, paymentIntent });
      if (res.duplicateIntent) {
        // Second tab / second owner paid for an already-passed comp — send it
        // straight back (registrations' duplicate contract). Stripe OUTSIDE tx.
        try {
          await getStripe().refunds.create(
            { payment_intent: res.duplicateIntent },
            { idempotencyKey: `pass-dup-refund-${res.duplicateIntent}` },
          );
        } catch { /* surfaces in Stripe dashboard; never blocks the ACK */ }
      }
```

`pass-checkout/route.ts`: pass `{ idempotencyKey: \`pass-checkout-${orgId}-${competition_id}\` }` as the second arg to `checkout.sessions.create` — retries of the same click reuse one session (a NEW deliberate purchase after refund-revoke changes nothing: session create params identical is fine, Stripe idempotency scopes to key+params and expires in 24h).

- [ ] **Step 4: Run tests** — duplicate suite PASS; existing `billing-checkout`/pass tests still PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(pass): duplicate payment auto-refunds; checkout minting idempotent"`

---

### Task 5: Shared dispute-recovery core (refactor, no behavior change)

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (extract; keep export)
- Create: `apps/web/src/server/usecases/dispute-recovery.ts`
- Test: existing `registrations` dispute tests stay green (that IS the test).

**Interfaces:**
- Produces: `recoverDisputedTransfer(dispute: Stripe.Dispute, opts: { auditNote: (type: string, extra: Record<string, unknown>) => Promise<void> }): Promise<{ recoveredCents: number; already: boolean }>` in `dispute-recovery.ts` — the charge→transfer→reversal math verbatim from registrations.ts:1210-1268 (metadata `dispute_id` replay guard, `min(share, unreversed)` cap, idempotency key `dispute-reversal-{id}`). `registrations.ts` keeps a thin wrapper building its audit closure; Task 6 consumes the same core for sponsors.

- [ ] **Step 1: Move the math** — cut the body of `recoverDisputedTransfer` into `dispute-recovery.ts`, parameterizing ONLY the audit sink (registration_id/org context live in the closure the caller builds). No logic edits.
- [ ] **Step 2: Run the dispute suites** — `npx vitest run src/server/usecases/__tests__/registrations-dispute*.test.ts` → PASS unchanged.
- [ ] **Step 3: Commit** — `git commit -am "refactor(disputes): extract transfer-recovery core for reuse"`

---

### Task 6: Sponsor dispute lifecycle (P0-2)

**Files:**
- Modify: `apps/web/src/server/usecases/sponsors.ts` (`handleSponsorDispute`)
- Modify: `apps/web/src/server/usecases/billing-events.ts` (dispute dispatch adds sponsor call)
- Create: `apps/web/src/lib/email-templates/sponsor-dispute-alert.ts`, `sponsor-dispute-lost.ts`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-dispute.test.ts`

**Interfaces:**
- Consumes: V291 `sponsor_orders.disputed_at/dispute_id`; Task 5 `recoverDisputedTransfer`.
- Produces: `handleSponsorDispute(dispute: Stripe.Dispute, phase: "created" | "closed"): Promise<void>` exported from sponsors.ts; dispatch calls it after `handleRegistrationDispute` for both dispute event types (each no-ops on the other's intents — same pattern as `charge.refunded`).

- [ ] **Step 1: Failing tests**

```ts
describe("handleSponsorDispute", () => {
  it("created: flags the order and takes the placement to pending", async () => {
    const { orderId, sponsorId } = await seedPaidSponsorOrder("pi_sp_d1"); // order paid + active sponsor row
    await handleSponsorDispute(disputeFor("pi_sp_d1", "dp_1"), "created");
    const [o] = await sql`select disputed_at, dispute_id from sponsor_orders where id = ${orderId}`;
    expect(o.dispute_id).toBe("dp_1");
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("pending");
  });

  it("closed lost: order refunded-state, placement inactive", async () => {
    const { orderId, sponsorId } = await seedPaidSponsorOrder("pi_sp_d2");
    await handleSponsorDispute(disputeFor("pi_sp_d2", "dp_2"), "created");
    await handleSponsorDispute(disputeFor("pi_sp_d2", "dp_2", "lost"), "closed");
    const [o] = await sql`select status from sponsor_orders where id = ${orderId}`;
    expect(o.status).toBe("refunded");
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("inactive");
    // Recovery ran (keyless test env: recoverDisputedTransfer catches and
    // audits — assert it didn't throw and the order flip stuck).
  });

  it("closed won: flag cleared, placement re-activated", async () => {
    const { orderId, sponsorId } = await seedPaidSponsorOrder("pi_sp_d3");
    await handleSponsorDispute(disputeFor("pi_sp_d3", "dp_3"), "created");
    await handleSponsorDispute(disputeFor("pi_sp_d3", "dp_3", "won"), "closed");
    const [o] = await sql`select disputed_at from sponsor_orders where id = ${orderId}`;
    expect(o.disputed_at).toBeNull();
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("active");
  });

  it("ignores non-sponsor intents", async () => {
    await expect(
      handleSponsorDispute(disputeFor("pi_not_sponsor", "dp_4"), "created"),
    ).resolves.toBeUndefined();
  });
});

const disputeFor = (intent: string, id: string, status = "needs_response") =>
  ({ id, payment_intent: intent, amount: 25000, status, charge: "ch_x" }) as unknown as Stripe.Dispute;
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `handleSponsorDispute`**

```ts
export async function handleSponsorDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<void> {
  const intent =
    typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!intent) return;
  const [order] = await sql<
    (SponsorOrderRow & { org_id: string })[]
  >`select ${sql(ORDER_COLS as unknown as string[])}, org_id, disputed_at, dispute_id
    from sponsor_orders where payment_intent_id = ${intent}`;
  if (!order) return; // not a sponsor charge

  if (phase === "created") {
    await sql`update sponsor_orders set disputed_at = now(), dispute_id = ${dispute.id}
              where id = ${order.id}`;
    if (order.sponsor_id) {
      await sql`update sponsors set status = 'pending' where id = ${order.sponsor_id}`;
    }
    const owner = await currentOrgOwnerEmail(order.org_id); // org_members role='owner', NOT created_by
    if (owner) {
      void sendSponsorDisputeAlertEmail({
        to: owner,
        orgName: (await orgName(order.org_id)) ?? "your organisation",
        packageName: await packageName(order.package_id),
        sponsorName: order.sponsor_name,
        amountCents: dispute.amount,
        currency: order.currency,
      }).catch(() => {});
    }
    bustPublicSponsors(order.org_id);
    return;
  }
  if (dispute.status === "won") {
    await sql`update sponsor_orders set disputed_at = null where id = ${order.id}`;
    if (order.sponsor_id) {
      await sql`update sponsors set status = 'active' where id = ${order.sponsor_id}`;
    }
    return;
  }
  if (dispute.status === "lost") {
    await sql`update sponsor_orders set status = 'refunded' where id = ${order.id}`;
    if (order.sponsor_id) {
      await sql`update sponsors set status = 'inactive' where id = ${order.sponsor_id}`;
    }
    const recovery = await recoverDisputedTransfer(dispute, {
      auditNote: (type, extra) => staffNote(order.org_id, type, { order_id: order.id, ...extra }),
    });
    if (!recovery.already) { /* owner email sponsor-dispute-lost w/ recoveredCents */ }
  }
}
```

Replace the `...`/comment stubs with the full email sends when implementing — templates take `{to, orgName, packageName, sponsorName, amountCents, currency, recoveredCents?}` mirroring `sendSponsorRefundEmail`'s shape; `staffNote` = tiny helper inserting into `staff_audit_log` (actor = null system row — follow the column list of existing staff audit inserts in admin usecases). Public revalidate after placement flips: `bustPublicSponsors(order.org_id)` (already in sponsors.ts).
Dispatch wiring in billing-events.ts:

```ts
    case "charge.dispute.created":
      await handleRegistrationDispute(event.data.object as Stripe.Dispute, "created");
      await handleSponsorDispute(event.data.object as Stripe.Dispute, "created");
      break;
    case "charge.dispute.closed":
      await handleRegistrationDispute(event.data.object as Stripe.Dispute, "closed");
      await handleSponsorDispute(event.data.object as Stripe.Dispute, "closed");
      break;
```

- [ ] **Step 4: Run suite + emails parity ×4** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(sponsors): dispute lifecycle — flag, placement, recovery, owner emails"`

---

### Task 7: Platform-charge disputes — Pro subscription + pass (P1-4, decisions §6.2)

**Files:**
- Modify: `apps/web/src/server/usecases/billing-events.ts` (`handlePlatformDispute`)
- Test: `apps/web/src/server/usecases/__tests__/platform-dispute.test.ts`

**Interfaces:**
- Consumes: V291 `subscriptions.disputed_at/dispute_id`; Task 3 `revokePassForRefundedCharge` pattern (pass lookup by intent).
- Produces: `handlePlatformDispute(dispute, phase)` called LAST in both dispute cases (after registration + sponsor handlers, which return without writes on platform charges).

- [ ] **Step 1: Failing tests** — four cases, fully written in the suite:
  1. created on a charge whose `customer` matches `subscriptions.stripe_customer_id` → `disputed_at`+`dispute_id` stamped, no plan change;
  2. closed lost on same → `plan_key='community'`, `status='canceled'`, entitlements invalidated (probe `hasFeature` after);
  3. closed won → `disputed_at` cleared, plan untouched;
  4. lost dispute on a PASS intent (`competition_passes.stripe_payment_intent` match) → pass row deleted.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

```ts
/** Disputes on PLATFORM charges (decisions 2026-07-18 §6.2): created = flag +
 *  staff alert; lost on a subscription charge = auto-downgrade; lost on a
 *  pass charge = revoke the pass. Registration/sponsor handlers already
 *  no-op'd (no matching rows) before this runs. */
async function handlePlatformDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<void> {
  const intent =
    typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  const charge = dispute.charge;
  const customer =
    typeof charge === "object" && charge
      ? (typeof charge.customer === "string" ? charge.customer : charge.customer?.id)
      : null;
  // Pass charge?
  if (intent) {
    const [pass] = await sql<{ org_id: string }[]>`
      select org_id from competition_passes where stripe_payment_intent = ${intent}`;
    if (pass) {
      if (phase === "closed" && dispute.status === "lost") {
        await sql`delete from competition_passes where stripe_payment_intent = ${intent}`;
        await invalidateOrgEntitlements(pass.org_id);
      }
      await notifyStaffDispute("event_pass", pass.org_id, dispute, phase);
      return;
    }
  }
  if (!customer) return;
  const [sub] = await sql<{ org_id: string }[]>`
    select org_id from subscriptions where stripe_customer_id = ${customer}`;
  if (!sub) return;
  if (phase === "created") {
    await sql`update subscriptions set disputed_at = now(), dispute_id = ${dispute.id},
              updated_at = now() where org_id = ${sub.org_id}`;
  } else if (dispute.status === "won") {
    await sql`update subscriptions set disputed_at = null, updated_at = now()
              where org_id = ${sub.org_id}`;
  } else if (dispute.status === "lost") {
    await sql`update subscriptions set plan_key = 'community', status = 'canceled',
              updated_at = now() where org_id = ${sub.org_id}`;
    await invalidateOrgEntitlements(sub.org_id);
  }
  await notifyStaffDispute("subscription", sub.org_id, dispute, phase);
}
```

`notifyStaffDispute` = staff email to `STAFF_ALERT_EMAIL` env (fallback: skip) + `staff_audit_log` row. NOTE: `charge.dispute.*` events carry `charge` as an id string — when `customer` is needed, retrieve the charge (`getStripe().charges.retrieve`) OUTSIDE any tx; keyless envs skip (guard on `process.env.STRIPE_SECRET_KEY`, mirroring platform-revenue's guard) — the pass branch works keyless since it matches by intent.

- [ ] **Step 4: Run suite** — PASS. Also rerun sponsor+registration dispute suites (ordering unchanged).
- [ ] **Step 5: Commit** — `git commit -am "feat(billing): platform-charge disputes — flag, staff alert, lost=downgrade/revoke"`

---

### Task 8: Subscription-sync correctness (P1-5)

**Files:**
- Modify: `apps/web/src/server/usecases/billing-events.ts` (`handleSubscriptionDeleted`)
- Modify: `apps/web/src/lib/billing.ts` (`syncSubscription` unknown-price guard)
- Test: `apps/web/src/lib/__tests__/billing-sync-guards.test.ts`

**Interfaces:**
- Produces: no signature changes; behavior only.

- [ ] **Step 1: Failing tests** (write fully):
  1. `handleSubscriptionDeleted` with event sub id ≠ stored `stripe_subscription_id` → plan_key unchanged (seed sub row with `sub_new`, fire deleted for `sub_old`).
  2. `syncSubscription` with a price id not in `plans` → existing `plan_key` PRESERVED (seed `pro` row, sync a sub whose price is `price_unknown`, expect still `pro`, status still synced).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

`handleSubscriptionDeleted` first lines:

```ts
  const orgId = stripeSub.metadata?.org_id;
  if (!orgId) return;
  // Stale-event guard (P1-5): only the CURRENTLY stored subscription may
  // downgrade the org — a late-delivered deleted for a replaced sub must not
  // touch a resubscribed org.
  const [current] = await sql<{ stripe_subscription_id: string | null }[]>`
    select stripe_subscription_id from subscriptions where org_id = ${orgId}`;
  if (current?.stripe_subscription_id && current.stripe_subscription_id !== stripeSub.id) return;
```

`syncSubscription`: replace `${planKey ?? "community"}` insert value with a resolved constant and change the upsert:

```ts
  const knownPlanKey = priceId ? await planKeyForPrice(priceId) : null;
  // Unknown price (grandfathered/migrated in Stripe but not in `plans`):
  // keep the org's current plan instead of silently downgrading; the
  // stripe:sync drift is a staff problem, not the customer's.
  ...
      plan_key = coalesce(${knownPlanKey}, subscriptions.plan_key, 'community'),
```

(insert branch value: `${knownPlanKey ?? "community"}` — a brand-new row with an unknown price still lands community; only EXISTING plans are preserved. Log `console.error("syncSubscription: unknown price", priceId)` for staff grep.)

- [ ] **Step 4: Run suite + existing billing-sync tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "fix(billing): stale deleted-event + unknown-price no longer downgrade paying orgs"`

---

### Task 9: past_due read-time grace (P1-6)

**Files:**
- Modify: `apps/web/src/lib/entitlements.ts` (`resolveFromDb` plan CASE)
- Test: `apps/web/src/lib/__tests__/entitlements-pastdue.test.ts`

**Interfaces:**
- Produces: none new — resolver behavior: `status='past_due'` for >14 days resolves as community (mirrors `comped_until` read-time flip; 5-min cache bounds staleness).

- [ ] **Step 1: Failing tests**: seed pro sub `status='past_due', updated_at=now()-'20 days'` → `hasFeature(org,'exports')` false; `updated_at=now()-'2 days'` → true (grace holds).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — extend the CASE in `resolveFromDb`:

```sql
    select case
      when s.comped_until is not null and s.comped_until <= now()
           and s.stripe_subscription_id is null then 'community'
      -- past_due grace (spec P1-6): dunning gets 14 days, then reads degrade
      -- until an invoice succeeds (which flips status back to active).
      when s.status = 'past_due' and s.updated_at <= now() - interval '14 days'
           then 'community'
      else coalesce(s.plan_key, 'community')
    end as plan_key
```

- [ ] **Step 4: Run suite + full entitlements tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(entitlements): past_due degrades to community after 14-day grace"`

---

### Task 10: Close post-downgrade card intake (P2-10, decision §6.1)

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (`publicRegistrationInfo`, `submitRegistration`)
- Test: `apps/web/src/server/usecases/__tests__/registrations-intake-gate.test.ts`

**Interfaces:**
- Consumes: `hasFeature(orgId, "registration.paid", competitionId)` — competitionId keeps Event-Pass comps OPEN.
- Produces: `closed_reason: "payments_unavailable"` now also when entitlement gone; submit throws 402.

- [ ] **Step 1: Failing tests** (write fully):
  1. community org (no pass), division method=stripe fee>0, charges_enabled=true → `publicRegistrationInfo` division `open:false, closed_reason:"payments_unavailable"`;
  2. same org with an Event Pass on the comp → open:true;
  3. `submitRegistration` on case 1 → rejects with `status: 402`;
  4. offline divisions unaffected.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — `publicRegistrationInfo`: compute once per comp before the map:

```ts
  const paidEntitled = await hasFeature(comp.org_id, "registration.paid", comp.id);
```

and extend `paymentsBroken`:

```ts
    const paymentsBroken =
      r.payment_method === "stripe" && r.fee_cents > 0 &&
      (!comp.charges_enabled || !paidEntitled);
```

`submitRegistration`, beside the existing charges_enabled 503:

```ts
  if (useStripe) {
    await requireFeature(ctx.org_id, "registration.paid", ctx.competition_id);
  }
```

(`requireFeature` throws `PaymentRequiredError` → 402. In-flight rows are untouched: `resumeRegistrationCheckout` + sweep reminders keep honoring snapshots — spec's "mid-flight money completes" contract.)

- [ ] **Step 4: Run suite + existing registration suites** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(registrations): card intake closes when registration.paid lapses (pass comps stay open)"`

---

### Task 11: Stuck-webhook auto-replay cron (P1-7)

**Files:**
- Create: `apps/web/src/app/api/cron/billing-events/route.ts`
- Modify: `apps/web/src/server/usecases/billing-events.ts` (`sweepStuckEvents`)
- Test: `apps/web/src/server/usecases/__tests__/billing-events-sweep.test.ts`

**Interfaces:**
- Consumes: V291 `billing_events.replay_attempts`; existing `replayEvent` (trust anchor = `stripe.events.retrieve`).
- Produces: `sweepStuckEvents(limit?: number): Promise<{ replayed: number; failed: number; alerted: number }>`; route guarded by `x-cron-secret` (copy the header check verbatim from `app/api/cron/registrations/route.ts`).

- [ ] **Step 1: Failing tests**: seed `billing_events` rows (received 20 min ago, no processed_at, attempts 0) with a stubbed `stripe.events.retrieve` (vi.mock `@/lib/stripe`) whose handler is a no-op type → after sweep: `processed_at` set. Second row where retrieve throws → `replay_attempts` incremented, `processed_at` null. Third row at `replay_attempts=3` → skipped (alert path counted).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

```ts
/** Auto-heal stuck events (spec P1-7): handlers are idempotent by contract,
 *  so replaying a `received` row is always safe. 3 attempts, then staff
 *  alert once (attempts capped so the sweep stays quiet). */
export async function sweepStuckEvents(limit = 25): Promise<{
  replayed: number; failed: number; alerted: number;
}> {
  if (!process.env.STRIPE_SECRET_KEY) return { replayed: 0, failed: 0, alerted: 0 };
  const rows = await sql<{ id: string; replay_attempts: number }[]>`
    select id, replay_attempts from billing_events
    where processed_at is null and received_at < now() - interval '10 minutes'
      and replay_attempts < 4
    order by received_at limit ${limit}`;
  let replayed = 0, failed = 0, alerted = 0;
  for (const row of rows) {
    if (row.replay_attempts >= 3) {
      await sql`update billing_events set replay_attempts = replay_attempts + 1 where id = ${row.id}`;
      /* staff email once (attempts hits 4 → filtered out next sweep) */ alerted++;
      continue;
    }
    try {
      const event = await getStripe().events.retrieve(row.id);
      await replayEvent(event);
      replayed++;
    } catch {
      await sql`update billing_events set replay_attempts = replay_attempts + 1 where id = ${row.id}`;
      failed++;
    }
  }
  return { replayed, failed, alerted };
}
```

Route: POST, `x-cron-secret` check, calls `sweepStuckEvents()`, returns counts. Deploy note for PR body: schedule hourly beside `/api/cron/registrations`.

- [ ] **Step 4: Run suite** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(webhooks): stuck billing events auto-replay with capped attempts + staff alert"`

---

### Task 12: Connect health sync + org banner (P1-8)

**Files:**
- Modify: `apps/web/src/server/usecases/stripe-connect.ts` (`syncConnectAccount`, `connectStatus`)
- Modify: `apps/web/src/components/org-payment-instructions.tsx` (banner render — it already fetches connect status)
- Modify: 4× `dictionaries/*/ui.json` (2 new keys)
- Test: `apps/web/src/server/usecases/__tests__/stripe-connect.test.ts` (extend)

**Interfaces:**
- Consumes: V291 org columns.
- Produces: `ConnectStatusRow` gains `payouts_enabled: boolean; disabled_reason: string | null; requirements_due: number` — consumed by the Connect settings page banner.

- [ ] **Step 1: Failing test** — extend the existing suite: `syncConnectAccount` with an account literal `{ id, charges_enabled: true, payouts_enabled: false, requirements: { currently_due: ["individual.id_number"], disabled_reason: "requirements.pending_verification" } }` → org row mirrors all three; `connectStatus` returns them.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

```ts
export async function syncConnectAccount(account: Stripe.Account): Promise<void> {
  await sql`
    update organizations
    set stripe_charges_enabled  = ${account.charges_enabled === true},
        stripe_payouts_enabled  = ${account.payouts_enabled === true},
        stripe_disabled_reason  = ${account.requirements?.disabled_reason ?? null},
        stripe_requirements_due = ${account.requirements?.currently_due?.length ?? 0}
    where stripe_account_id = ${account.id}`;
}
```

`connectStatus` reads + returns the three columns. Banner in the Connect settings surface (amber card, shown when `connected && (!payouts_enabled || requirements_due > 0)`): i18n keys `connect.attention.title` = "Stripe needs more information" / `connect.attention.body` = "Payouts are paused until onboarding is completed — resume it below." (translate ×4). Resume = the existing onboarding button (accountLinks flow already handles partial onboarding).

- [ ] **Step 4: Run suite; tsc** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(connect): mirror payouts/requirements health + owner banner"`

---

### Task 13: Smoke + help + final verify

**Files:**
- Modify: `scripts/smoke.ts` (new `p72Suite`)
- Modify: `apps/web/content/help/registration/card-payments.md` (§ disputes: sponsor + platform coverage, pass refund note), `apps/web/content/help/billing/event-pass.md` (refund revokes pass; duplicate auto-refund; delete blocked), `apps/web/content/help/billing/downgrade.md` (past_due grace, card intake closes, pass comps stay open)
- Test: the smoke run itself.

**Interfaces:** consumes the 409 copy from Task 1 and the 402 from Task 10.

- [ ] **Step 1: Write `p72Suite`** (keyless-safe, SQL-seeded like `setConnect`):
  - seed pass row on a pro-org comp via SQL → `DELETE /api/v1/competitions/:id` → expect 409 body containing "Event Pass";
  - key-auth attempt on the same route → 403 (NEVER_KEY);
  - community org + stripe-method division (SQL-flip settings) → public registration info shows `payments_unavailable`; same div on a passed comp → open;
  - `POST /api/cron/billing-events` with wrong secret → 401, right secret → `{replayed:0,...}` shape.
  Wire into `main()` beside the other suites, both pro and free sessions.
- [ ] **Step 2: Run smoke locally** — `npm run smoke` (dev server up; `rm -rf apps/web/.next` first if phantom 404s). Expected: all checks green, count grows.
- [ ] **Step 3: Update the three help pages** (concrete sentences, organiser voice, link disputes section from sponsor page).
- [ ] **Step 4: Full verify** — from `apps/web`: `npx tsc --noEmit && npx vitest run` (fresh test DB) then smoke. All green.
- [ ] **Step 5: Commit + PR**

```bash
git add -A && git commit -m "feat(payments): hardening wave — smoke p72 + help"
gh pr create --title "feat(payments): hardening wave (PROMPT-72..75)" --body "Spec: docs/superpowers/specs/2026-07-18-payments-hardening-design.md ... deploy notes: V291 (merges AFTER pro-plus V290), schedule /api/cron/billing-events hourly, STAFF_ALERT_EMAIL env.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 14: Reprice — Pro $19 + 30% annual on Pro & Pro Plus (spec §7)

**ORDERING:** runs only after Task 8 is merged-in on this branch AND the Pro
Plus branch is on main (its `proPlusPrice` table + stripe-plans.json entries
must exist to be edited). Supersedes pro-plus D2 annual amounts.

**Files:**
- Modify: `apps/web/src/config/stripe-plans.json` (amounts below)
- Modify: `apps/web/src/lib/currency.ts` (`proPrice`, `proPlusPrice` set points)
- Modify: `scripts/stripe-sync.ts` (verify amount-drift behavior — see Step 2)
- Modify: pricing/marketing copy keys ("2 months free" → "Save 30%") ×4 locales
- Test: existing currency/pricing unit tests pin amounts — update expectations.

**Amounts (minor units):**

| lookup_key | usd | eur | gbp | aud | inr |
|---|---|---|---|---|---|
| seazn_pro_monthly | 1900 | 1800 | 1500 | 2800 | 139900 |
| seazn_pro_annual | 15900 | 14900 | 12500 | 23500 | 1149900 |
| seazn_pro_plus_monthly | 3900 | 3700 | 3300 | 5900 | 299900 |
| seazn_pro_plus_annual | 32700 | 30900 | 27700 | 49500 | 2499900 |
| seazn_event_pass (one-time) | 2900 | 2900 | 2500 | 4500 | 199900 |

- [ ] **Step 1: Update `stripe-plans.json` + `lib/currency.ts`** to the table.
- [ ] **Step 2: Verify `stripe:sync` handles amount changes.** Stripe price
  amounts are immutable — the script must CREATE a new price for a changed
  amount, transfer the `lookup_key` (`transfer_lookup_key: true`), and write
  the new id into `plans.stripe_price_id_*`. If it only updates
  `currency_options`, extend it: compare `unit_amount` + each currency option;
  on drift, create replacement price with `transfer_lookup_key: true`, then
  archive (`active: false`) the old price. Old ids stay resolvable-safe via
  Task 8 (existing subs keep their price; plan_key preserved).
- [ ] **Step 3: Test** — update pinned amounts in the pricing/currency unit
  tests; add one test: `proPrice("annual","usd")*1 <= 19*12*0.7*100` style
  ≥30%-discount assertions for all four annual cells ×5 currencies.
- [ ] **Step 4: Copy** — annual-toggle badge/copy keys to "Save 30%" (en/fr/es/nl);
  help `billing/plans.md` amounts refreshed.
- [ ] **Step 5: Run** `npx tsc --noEmit && npx vitest run` + smoke pricing page
  check; commit `feat(pricing): Pro $19 + 30% annual (pro, pro_plus)`.
- [ ] **Step 6: Deploy note in PR body** — run `npm run stripe:sync` per env
  (test + prod keys) AFTER db:apply; existing subscribers keep old prices (no
  migration); verify checkout shows new amounts per currency.

---

### Task 15: Pro keeps AI scheduling, capped 5 runs/division (amends pro-plus D4)

Owner decision 2026-07-18: instead of removing `scheduling.ai` from Pro
entirely (pro-plus D4), Pro keeps it capped at **5 AI schedule generations per
division**; Pro Plus unlimited. Community stays without. This wave merges
AFTER pro-plus, so V291 carries the amendment.

**Files:**
- Modify: `db/migration/deltas/V291__payments_hardening.sql` (append)
- Modify: the AI-schedule generation usecase (locate: `grep -rn "scheduling.ai" apps/web/src/server` — the `requireFeature(orgId, "scheduling.ai", …)` call site in the schedule-generation path)
- Test: colocated `__tests__` beside that usecase.

- [ ] **Step 1: Migration append** (same V291 file, before first apply):

```sql
-- Pro AI cap (owner 2026-07-18, amends pro-plus D4): Pro keeps AI scheduling,
-- 5 generations per division; Pro Plus unlimited; community none.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('pro',      'scheduling.ai',                       true, null),
  ('pro',      'scheduling.ai.runs_per_division.max', null, 5),
  ('pro_plus', 'scheduling.ai.runs_per_division.max', null, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
```

- [ ] **Step 2: Failing test** — Pro org, division with 5 recorded AI runs →
  6th generation rejects 402 with key `scheduling.ai.runs_per_division.max`;
  Pro Plus org unlimited. Run-counting source: the schedule-generation
  audit event the usecase already writes (find the `competition_events`
  type it inserts; if it writes none, add one in the same commit —
  `schedule.ai_generated` with `division_id` payload — and count those).
- [ ] **Step 3: Implement** — beside the existing `requireFeature(...,"scheduling.ai")`
  call: count prior runs for the division, then
  `withinLimit(orgId, "scheduling.ai.runs_per_division.max", n + 1, competitionId)`
  → `PaymentRequiredError` on breach.
- [ ] **Step 4: Tests green; commit** `feat(scheduling): Pro AI capped at 5 runs/division (pro_plus unlimited)`.
- [ ] **Step 5: Pricing-page row** — matrix renders from `plan_entitlements`;
  verify the new int key surfaces sensibly (label copy ×4 locales if the
  pricing table names it).

---

### Task 16: Smoke — 4-plan user matrix (owner ask 2026-07-18)

Four fresh users, one per plan, created through the same HTTP surface smoke
already uses; each asserts the features that distinguish its tier. Runs AFTER
Task 15 (AI cap live) and Task 14 (pricing untouched by this task — no Stripe
needed; keyless-degrade aware).

**Files:**
- Modify: `scripts/smoke.ts` (new section `smokePlanMatrix()` wired into main after existing sections)

**Interfaces:**
- Consumes: existing smoke helpers (HTTP register/login, org+comp+division creation idioms, SQL plan-flip pattern already used for the pro path); `plan_entitlements` matrix incl. V291 rows (`scheduling.ai.runs_per_division.max` pro=5, pro_plus=unlimited); `competition_passes` (PK=competition_id) for the pass persona.
- Produces: smoke stays green in CI (keyless) and locally with keys; per-plan assertion block other waves can extend.

- [ ] **Step 1: Personas.** Register 4 users with the run-unique suffix idiom smoke already uses: `smoke-community-<ts>@`, `smoke-pro-<ts>@`, `smoke-proplus-<ts>@`, `smoke-pass-<ts>@`. Each creates one org (+ one competition with one division where assertions need one).
- [ ] **Step 2: Plans.** community = default (no-op). pro / pro_plus = the existing SQL subscription-flip idiom smoke uses for its pro path, with `plan_key='pro'` / `'pro_plus'`. pass = community org + SQL insert into `competition_passes (competition_id, org_id, stripe_payment_intent)` values `(comp, org, 'pi_smoke_pass_<ts>')` (mirrors recordPassPurchase).
- [ ] **Step 3: Assertions per persona** (entitlement-resolution + HTTP status level, following existing smoke assertion idioms; every check runs AFTER its data is seeded — no false-greens):
  - community: `exports.branded` denies (plain export path OK), a Pro-gated surface 402/403s (e.g. branded export or AI schedule), upgrade path visible where smoke already checks CTAs.
  - pro: branded export allowed; `scheduling.ai` allowed and `scheduling.ai.runs_per_division.max` resolves 5; `officials.per_fixture.max` unlimited (null).
  - pro_plus: `api.write` grants (key with write scope creatable where smoke exercises keys, else entitlement resolve check); `scheduling.ai.runs_per_division.max` unlimited; `registration.fee_percent` resolves 1.
  - event_pass: passed competition resolves a comp-scoped pro feature (e.g. `formats.advanced`) true INSIDE that comp; a second unpassed comp in the same org denies it; an org-wide key (`members.max`) still resolves community values (the dead-row fix from V291).
- [ ] **Step 4: Wire + run.** Call `smokePlanMatrix()` from main; run full smoke locally against dev server; ALL existing sections must stay green. Commit `feat(smoke): 4-plan user matrix (community/pro/pro_plus/event_pass)`.

---

### Task 17: Wave e2e suite — every change browser/API-proven (owner ask 2026-07-18)

Owner requirement: e2e coverage for ALL wave changes. One Playwright spec
file exercising each task's outcome through the running app (browser where a
surface exists, signed webhook POST + UI assertion where the trigger is a
Stripe event). Runs LAST (after T16), before the final whole-branch review.

**Files:**
- Create: `e2e/payments-hardening.spec.ts` (root e2e project, existing conventions: magic-link `login_url` trick, SQL pro-flip helper, dev server boot per e2e README/config)
- Modify (if needed): e2e server-boot env to include a known `STRIPE_WEBHOOK_SECRET=whsec_e2e_payments` so tests can sign synthetic events

**Interfaces:**
- Consumes: `stripe.webhooks.generateTestHeaderString({ payload, secret })` (stripe lib, already a repo dep) to POST signed events to the real webhook route; T1 409 strings; T2 NEVER_KEY_ROUTES; T3/T4 pass lifecycle; T6/T7 dispute handlers; T9 grace copy; T10 intake close; T12 banner; T15 402.
- Produces: `npx playwright test payments-hardening` green = wave's user-visible contract pinned.

- [ ] **Step 1: Harness.** Follow existing e2e boot (dev server + DB env). Add `STRIPE_WEBHOOK_SECRET` to the e2e server env if absent. Helper `postSignedEvent(evt)` → POST `/api/stripe/webhook` (locate exact route via `git grep -rn "constructEvent" apps/web/src/app/api`) with `stripe-signature: generateTestHeaderString`. Assert 200.
- [ ] **Step 2: T1/T2 guards.** Owner session (magic-link login): seed comp+pass via SQL, browser/API DELETE attempt → all THREE 409 strings asserted (satisfies the T13-REQUIREMENT from T1 review). API-key DELETE `/api/v1/competitions/:id` → barred (403/absent).
- [ ] **Step 3: T3/T4 pass lifecycle.** Seed passed comp (SQL insert mirroring smoke idiom) → post signed `charge.refunded` (full) → billing/org UI no longer shows the pass; gated feature 402s again. Duplicate-intent case: post second `checkout.session.completed`/`charge.succeeded` shape per T4 dispatch path → auto-refund recorded (assert via billing_events/DB + no second pass row).
- [ ] **Step 4: T6 sponsor dispute.** Seed paid sponsor order + active placement (SQL, smoke idiom) → signed `charge.dispute.created` → public page no longer renders the placement; `closed` lost → sponsor_orders reflects lost + placement stays pulled; `closed` won (fresh order) → placement restored.
- [ ] **Step 5: T7 platform disputes.** Pro org (SQL pro-flip): signed `charge.dispute.created` (sub customer) → org billing UI still Pro + flag set; `closed lost` (matching dispute_id) → billing UI shows Community. Pass org: dispute lost → pass revoked in UI.
- [ ] **Step 6: T8-T12/T15 surfaces** (extend as those tasks land; keep one `test.describe` per task): T9 past_due grace banner copy; T10 downgraded org's stripe-method division no longer renders card intake (registration page shows offline/closed state); T12 Connect health banner on org settings when payouts disabled (SQL-flip org columns); T15 Pro org 6th AI run → 402 surface in console (or API 402 if console flow too deep — assert response + UI error copy).
- [ ] **Step 7: Run.** Full new spec green locally + existing e2e suite untouched-green. Commit `test(e2e): payments-hardening wave outcomes end-to-end`.

---

### Task 18: Pro Plus e2e retrofit (owner ask 2026-07-18 — previous session's surfaces)

e2e coverage for the pro-plus tier wave (#125, merged without full browser
e2e). Same conventions as Task 17; separate spec file; runs after Task 17.

**Files:**
- Create: `e2e/pro-plus-tier.spec.ts`

**Interfaces:**
- Consumes: V290 matrix (pro_plus grants incl. api.write/officials.auto/scheduling.ai unlimited, fee 1%, unlimited scale); V291 amendment (pro scheduling.ai capped 5); quota keys `officials.per_fixture.max` (community 1/pro ∞), `schedule.checkpoints.max` (1/5/∞); PlusReveal disclosure component; `/admin/entitlements` staff surface; plan-change/billing UI.
- Produces: pro_plus tier contract pinned in browser.

- [ ] **Step 1: Personas via SQL plan-flip** (e2e helper exists): community, pro, pro_plus orgs + owner sessions.
- [ ] **Step 2: Billing surface.** pro_plus org billing page shows Pro Plus plan name + price; plan-change UI offers expected moves (no dead 'business' remnants).
- [ ] **Step 3: Quota gates in browser.** community org: adding 2nd official to a fixture blocked (1/fixture); pro org: officials unlimited; community 2nd schedule save point blocked vs pro 5 vs pro_plus unlimited (assert gate copy/402 surfaces, not just API).
- [ ] **Step 4: Moved-up features.** pro org: officials.auto + api.write surfaces show upgrade gate (moved to pro_plus); pro_plus org: same surfaces work. Pro org scheduling.ai ALLOWED (V291 amendment) — cap surface covered in Task 17 Step 6.
- [ ] **Step 5: PlusReveal + /admin/entitlements.** PlusReveal disclosure renders where pro_plus features are gated; superadmin session loads /admin/entitlements and shows the pro_plus column incl. V291 cap row.
- [ ] **Step 6: Run.** Spec green + existing e2e untouched-green. Commit `test(e2e): pro-plus tier surfaces (retrofit)`.

---

## Self-review notes

- Spec coverage: P0-1→T1/T2, P0-2→T5/T6, P0-3→T3/T4, P1-4→T7, P1-5→T8, P1-6→T9, P1-7→T11, P1-8→T12, P2-10→T10, P2-11 dead row→T0. Deferred BY DESIGN to later plans: P2-9 partial sponsor refunds, P2-12 tax ToS clause, P2-13 order hygiene, P2-14 pass admin verbs, PROMPT-76 console, PROMPT-77 growth items.
- Sponsor "evidence pack" (spec P0-2 fix list) intentionally NOT in this wave — it needs the PROMPT-76 console surface to live on; noted for the console plan.
- Types: `recordPassPurchase` return-shape change touches exactly billing.ts callers (billing-events.ts, reconcilePassCheckout) — Task 4 lists both.
- ToS §5 wording covers entry-fee chargebacks; sponsor recovery extends the same clause — PR body flags terms review for the owner (same flag pattern as v9).
