# Durable Group-Invoice Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute group **invoice** events to the correct billing group (payer + N organisations) in `/admin/billing-events`, from a durable ledger stamp resolved at ingest — not from live Stripe object metadata, which invoice events lack.

**Architecture:** Add `billing_events.subscription_id` (V317). At ingest (`runEvent`) resolve the event's group best-effort via a `resolveEventGroup` dispatcher that reuses the existing resolvers, and stamp it. The admin page reads the ledger stamp first, falling back to today's live-metadata behaviour. Part B (decline card + `incomplete→past_due` grace) needs a live `sk_test` key and stays a documented checklist.

**Tech Stack:** Next.js (forked build — read `node_modules/next/dist/docs/` before touching routing), TypeScript, postgres.js, Flyway (`db:apply`), Vitest, Stripe SDK types.

## Global Constraints

- Branch `fix/billing-invoice-attribution` off `main`; worktree already created.
- Migration number **V317** — `main` is at V316; before writing, re-confirm no other branch has claimed V317 (the cross-branch numbering gotcha already renumbered V309→V310). If taken, use the next free number and update this plan.
- The stamp is **best-effort**: a null `subscription_id` must fall back to today's org-based attribution; resolution must never throw out of `runEvent`.
- `billing_events.subscription_id` is **FK-less**, matching V259 which dropped the org FK (the ledger is an append-only audit trail that outlives referenced rows).
- Reuse `invoiceSubId`, `resolveGroupForStripeSub`, `checkoutGroupId`, `groupLabelsByIds` — no new resolution logic.
- Regression test is DB-backed (skipped without `DATABASE_URL`), no live Stripe.
- Verify: `cd apps/web && npx tsc --noEmit && npx vitest run` (after `db:apply` of V317 to the local test DB).

---

### Task 1: Migration V317 — `billing_events.subscription_id`

**Files:**
- Create: `db/migration/deltas/V317__billing_events_subscription_id.sql`.

**Interfaces:**
- Produces: column `billing_events.subscription_id uuid null` (the resolved group).

- [ ] **Step 1: Confirm the number is free**

Run: `ls db/migration/deltas/ | sort | tail -3`
Expected: highest is `V316__competition_fee_lock.sql`. If a `V317__*` already exists, bump to the next free number throughout this plan.

- [ ] **Step 2: Write the migration**

Create `db/migration/deltas/V317__billing_events_subscription_id.sql`:

```sql
-- #223: durable group attribution for the billing-events ledger.
-- invoice.* events carry no subscription_id in Stripe object metadata (Stripe
-- never copies subscription metadata onto invoices), so the admin console
-- could not label a recurring GROUP invoice with its payer + org count. We now
-- resolve the group at ingest (runEvent) and stamp it here.
--
-- FK-less on purpose, matching V259 which dropped billing_events' org FK: the
-- ledger is an append-only audit trail that must survive deletion of the group
-- it references. Null = unresolved, which falls back to org-based attribution.
alter table billing_events
  add column if not exists subscription_id uuid;
```

- [ ] **Step 3: Apply it to the local test DB**

Run: `npm run db:apply` (Flyway incremental migrate — see `project_apply_db_destructive.md`; mind the baseline gotcha).
Expected: V317 applies; `\d billing_events` shows `subscription_id`.

- [ ] **Step 4: Commit**

```bash
git add db/migration/deltas/V317__billing_events_subscription_id.sql
git commit -m "feat(billing): V317 add billing_events.subscription_id for durable group attribution (#223)"
```

---

### Task 2: Stamp the resolved group at ingest

**Files:**
- Modify: `apps/web/src/server/usecases/billing-events.ts` — add `resolveEventGroup`; extend `runEvent` insert; add `subscription_id` to `LedgerRow`, `ledgerByIds`, `stuckLedgerEvents`.
- Test: `apps/web/src/server/usecases/__tests__/billing-invoice-attribution.test.ts` (create).

**Interfaces:**
- Consumes: `invoiceSubId(invoice): string | null`; `resolveGroupForStripeSub(sub): Promise<{ subscriptionId: string; via } | null>`; `checkoutGroupId(session, orgId: string): Promise<string | null>` — all already in this file.
- Produces: `LedgerRow` gains `subscription_id?: string | null`; `runEvent` persists it.

- [ ] **Step 1: Write the failing DB-backed test**

Create `apps/web/src/server/usecases/__tests__/billing-invoice-attribution.test.ts`. Mirror the seeding style of `billing-webhook-group-resolution.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { runEvent } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

(HAS_DB ? describe : describe.skip)("durable group-invoice attribution (#223)", () => {
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("an invoice event stamps the ledger with the group behind the Stripe subscription", async () => {
    const s = uniq();
    const stripeSubId = `sub_${s}`;
    const [{ id: payerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`inv-attr-${s}@test.local`}, 'Invoice Payer', true) returning id`;
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, stripe_subscription_id, stripe_customer_id)
      values (${payerId}, 'pro', 'active', ${stripeSubId}, ${`cus_${s}`}) returning id`;
    // three orgs on the one group
    for (let i = 0; i < 3; i++) {
      await sql`insert into organizations (name, slug, created_by, subscription_id)
                values (${`Org ${i} ${s}`}, ${`org-${i}-${s}`}, ${payerId}, ${groupId})`;
    }

    // An invoice event with NO subscription_id in metadata — exactly the shape
    // Stripe sends. invoiceSubId reads invoice.parent.subscription_details.subscription.
    const event = {
      id: `evt_${s}`,
      type: "invoice.payment_succeeded",
      data: { object: {
        object: "invoice",
        metadata: {},
        parent: { subscription_details: { subscription: stripeSubId } },
      } as unknown as Stripe.Invoice },
    } as unknown as Stripe.Event;

    await runEvent(event);

    const [row] = await sql<{ subscription_id: string | null }[]>`
      select subscription_id from billing_events where id = ${event.id}`;
    expect(row.subscription_id).toBe(groupId);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/billing-invoice-attribution.test.ts`
Expected: FAIL — `runEvent` does not write `subscription_id` (column exists after Task 1 but is never populated), so `row.subscription_id` is null.

- [ ] **Step 3: Add `resolveEventGroup`**

In `billing-events.ts`, above `runEvent`:

```ts
/**
 * Best-effort billing GROUP for one event, stamped durably at ingest so
 * attribution does not depend on live Stripe object metadata — which
 * invoice.* events do not carry (Stripe never copies subscription metadata
 * onto an invoice). Reuses the existing resolvers; a throw or a miss returns
 * null, which falls back to org-based attribution. (#223)
 */
async function resolveEventGroup(event: Stripe.Event): Promise<string | null> {
  try {
    const obj = event.data.object;
    if (event.type.startsWith("invoice.")) {
      const subId = invoiceSubId(obj as Stripe.Invoice);
      if (!subId) return null;
      const [g] = await sql<{ id: string }[]>`
        select id from subscriptions where stripe_subscription_id = ${subId}`;
      return g?.id ?? null;
    }
    if (event.type.startsWith("customer.subscription.")) {
      const r = await resolveGroupForStripeSub(obj as Stripe.Subscription);
      return r?.subscriptionId ?? null;
    }
    if (event.type === "checkout.session.completed") {
      const session = obj as Stripe.Checkout.Session;
      return await checkoutGroupId(session, session.metadata?.org_id ?? "");
    }
    return null;
  } catch (err) {
    console.error(`[billing] resolveEventGroup failed for ${event.id}`, err);
    return null;
  }
}
```

- [ ] **Step 4: Stamp it in `runEvent`**

Change the insert in `runEvent`:

```ts
export async function runEvent(event: Stripe.Event): Promise<void> {
  const orgId =
    (event.data.object as { metadata?: { org_id?: string } }).metadata?.org_id ?? null;
  const groupId = await resolveEventGroup(event);
  await sql`
    insert into billing_events (id, type, org_id, subscription_id, payload)
    values (${event.id}, ${event.type}, ${orgId}, ${groupId}, ${JSON.stringify(event.data.object)})
    on conflict (id) do nothing`;
  await processStripeEvent(event);
  await sql`
    update billing_events set processed_at = now() where id = ${event.id}`;
}
```

- [ ] **Step 5: Surface the column on the reads**

Add `subscription_id` to `LedgerRow` and both SELECTs:

```ts
export interface LedgerRow {
  id: string;
  type: string;
  org_id: string | null;
  org_name?: string | null;
  subscription_id?: string | null; // resolved group (#223)
  received_at: string;
  processed_at: string | null;
}
```
In `ledgerByIds` and `stuckLedgerEvents`, add `b.subscription_id` to the column list:
```ts
select b.id, b.type, b.org_id, o.name as org_name, b.subscription_id, b.received_at, b.processed_at
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/billing-invoice-attribution.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the existing billing suites (no regressions)**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/billing-webhook-group-resolution.test.ts src/app/api/billing/groups/route.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/usecases/billing-events.ts apps/web/src/server/usecases/__tests__/billing-invoice-attribution.test.ts
git commit -m "feat(billing): stamp resolved group on the ledger at ingest (#223)"
```

---

### Task 3: Admin page reads the ledger stamp first

**Files:**
- Modify: `apps/web/src/app/admin/billing-events/page.tsx` (~line 91–110, the `groupLabel` resolution).
- Test: extend `billing-invoice-attribution.test.ts` with an admin-label assertion.

**Interfaces:**
- Consumes: `groupLabelsByIds(ids: string[]): Promise<Map<string,string>>` (already at page.tsx:62); `ledgerByIds` now returns `subscription_id`.
- Produces: a row's group label comes from `ledgerRow.subscription_id ?? meta(e).subscription_id`.

- [ ] **Step 1: Write the failing label assertion**

Append to `billing-invoice-attribution.test.ts` (same seeded group):

```ts
it("groupLabelsByIds renders the 3-org group as 'N organisations · Payer'", async () => {
  const { groupLabelsByIds } = await import("@/app/admin/billing-events/page");
  const labels = await groupLabelsByIds([groupId]); // groupId from a shared beforeAll seed
  const label = labels.get(groupId)!;
  expect(label).toMatch(/3 organisations/);
});
```
If `groupLabelsByIds` is not exported, export it from `page.tsx` (it is a plain async helper — add `export`). Restructure the seed into a `beforeAll` so both tests share `groupId`.

- [ ] **Step 2: Run it, verify it fails/needs the export**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/billing-invoice-attribution.test.ts -t "3-org group"`
Expected: FAIL — `groupLabelsByIds` not exported (or label absent).

- [ ] **Step 3: Prefer the ledger stamp on the admin page**

Export `groupLabelsByIds`. In the page body, feed the union of ledger + metadata sub ids to `groupLabelsByIds`, and per row prefer the ledger stamp:

```ts
const ledgerSubIds = [...ledger.values()]
  .map((r) => r.subscription_id)
  .filter((id): id is string => !!id && UUID_RE.test(id));
const groupLabels = await groupLabelsByIds([...new Set([...metaSubIds, ...ledgerSubIds])]);
// per row:
const subId = row?.subscription_id ?? m.subscription_id ?? null;
const groupLabel = subId ? (groupLabels.get(subId) ?? null) : null;
```
(`ledger` is the `ledgerByIds` map already computed on the page; `row = ledger.get(e.id)`.)

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/server/usecases/__tests__/billing-invoice-attribution.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/admin/billing-events/page.tsx apps/web/src/server/usecases/__tests__/billing-invoice-attribution.test.ts
git commit -m "feat(billing): admin billing-events attributes invoices from the ledger stamp (#223)"
```

---

### Part B — deferred checklist (needs `sk_test`, do NOT block Part A)

Not implemented here. Documented in the spec (`§Part B`). When a test-mode key is available:

- [ ] e2e: type a decline card (`4000000000000002`) at the embedded checkout; assert the UI surfaces the failure and no Pro entitlement is granted. Keep behind the existing CI Stripe gate.
- [ ] Confirm (live) whether Stripe fires an ingested event on `incomplete_expired`. If reliable, add a regression that an `incomplete_expired`/`canceled` event drops entitlement (relies on V313). If not, stop `incomplete` from opening the 14-day grace for a subscription that never took a successful payment.

---

## Self-Review

- **Spec coverage:** V317 column (Task 1) ✓; stamp at ingest via reused resolvers (Task 2) ✓; admin reads ledger first (Task 3) ✓; headless regression on invoice ingest + admin label (Tasks 2–3) ✓; Part B captured as deferred checklist ✓; live re-verify noted in acceptance.
- **Placeholder scan:** all code steps carry full code. The Part B items are intentionally checklist-only (blocked on a key) and labelled as such, not silent TODOs.
- **Type consistency:** `resolveEventGroup(event): Promise<string|null>` used verbatim in `runEvent`; `resolveGroupForStripeSub` handled as nullable (`r?.subscriptionId`); `subscription_id` added to `LedgerRow` and both SELECTs consistently; `groupLabelsByIds(ids): Promise<Map<string,string>>` matches page.tsx:62.

## Execution Handoff

Recommend **subagent-driven** — three tight, independently-testable backend tasks with DB-backed regressions; review between each.
