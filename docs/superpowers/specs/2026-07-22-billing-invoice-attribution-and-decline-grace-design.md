# Durable group-invoice attribution + decline/grace failure paths

**Issue:** #223 (supersedes #214; folds in #206) · **Branch:** `fix/billing-invoice-attribution` (off `main`)
**Date:** 2026-07-22 · **Status:** deep-dive spec. Part A implementable headless now; Part B blocked on an `sk_test` key.

Two billing items were root-caused on `fix/entitlement-and-reconcile-latent-bugs`
but not fixed there. This spec verifies each root cause against `main` and
designs the durable fix for the one that is verifiable headless (**A**), and
documents the analysis + verification plan for the one that needs live Stripe
test mode (**B**).

---

## Part A — Group invoice attributed to one org (durable fix)

### Root cause, re-verified against `main`

The group stamp `metadata.subscription_id` is written by
`buildEmbeddedCheckoutParams` onto **both** the checkout `session.metadata`
**and** `subscription_data.metadata` (`apps/web/src/lib/billing.ts`, the
`const metadata = { org_id, ...(subscriptionId ? { subscription_id } : {}) }`
block, applied at both `metadata:` and `subscription_data.metadata:`). Verified
on `main` (line numbers have drifted from the issue's 184/195 but the fact
holds). So:

- `checkout.session.completed` carries it (session metadata).
- every `customer.subscription.*` carries it (subscription metadata) — Stripe
  copies **subscription_data.metadata** onto the subscription.

**Invoice events do not.** Stripe never copies subscription metadata onto
`invoice.metadata`. The admin page reads live object metadata:

`apps/web/src/app/admin/billing-events/page.tsx`:
```ts
const meta = (e) => (e.data.object as {...}).metadata ?? {};
const metaSubIds = live.map((e) => meta(e).subscription_id)...
const groupLabels = await groupLabelsByIds([...metaSubIds]);
// per row:
const groupLabel = m.subscription_id ? (groupLabels.get(m.subscription_id) ?? null) : null;
```

For an `invoice.payment_succeeded` / `invoice.payment_failed`,
`meta(e).subscription_id` is **undefined** → `groupLabel` is null → the row
falls back to `org_name`, which the ledger populated from `metadata.org_id`
(a single org, or `—`). So the shipped #201 fix is correct for the events that
carry the stamp and **invisible on invoice events** — which are exactly the
recurring "group invoice" the report is about.

### The ingest today

`apps/web/src/server/usecases/billing-events.ts` `runEvent`:
```ts
export async function runEvent(event: Stripe.Event): Promise<void> {
  const orgId = (event.data.object as {...}).metadata?.org_id ?? null;
  await sql`insert into billing_events (id, type, org_id, payload) values (${event.id}, ${event.type}, ${orgId}, ${event})`;
  await processStripeEvent(event);
  await sql`update billing_events set processed_at = now() where id = ${event.id}`;
}
```
`ledgerByIds` / `stuckLedgerEvents` then `left join organizations o on o.id = b.org_id`
for `org_name`. There is **no group column** on the ledger. Schema
(`billing_events`): `id, type, org_id (uuid, FK dropped in V259), payload,
received_at, processed_at, replay_attempts`.

### Durable fix — attribute from the ledger, not from live Stripe metadata

**1. Migration V317** — next free delta (`main` is at V316; confirm no branch
has claimed V317 before writing, per the cross-branch numbering gotcha that
already renumbered V309→V310):

```sql
-- V317__billing_events_subscription_id.sql
alter table billing_events
  add column if not exists subscription_id uuid;  -- the resolved billing group
```

**FK-less on purpose**, matching V259 which dropped `billing_events`' org FK —
the ledger is an append-only audit trail that must survive the deletion of the
thing it references. Null = "unresolved", which falls back to today's behaviour.

**2. Stamp at ingest.** Add a best-effort `resolveEventGroup(event)` dispatcher
in `billing-events.ts` and write its result in the `runEvent` insert. It reuses
the resolvers already in the file — no new resolution logic:

```ts
async function resolveEventGroup(event: Stripe.Event): Promise<string | null> {
  try {
    const obj = event.data.object;
    if (event.type.startsWith("invoice.")) {
      const subId = invoiceSubId(obj as Stripe.Invoice);          // stripe sub id
      if (!subId) return null;
      const [g] = await sql<{ id: string }[]>`
        select id from subscriptions where stripe_subscription_id = ${subId}`;
      return g?.id ?? null;
    }
    if (event.type.startsWith("customer.subscription.")) {
      const r = await resolveGroupForStripeSub(obj as Stripe.Subscription);
      return r.subscriptionId ?? null;
    }
    if (event.type === "checkout.session.completed") {
      const s = obj as Stripe.Checkout.Session;
      return await checkoutGroupId(s, s.metadata?.org_id ?? null);
    }
    return null;
  } catch (err) {
    console.error(`[billing] resolveEventGroup failed for ${event.id}`, err);
    return null;  // best-effort — a null stamp just falls back to org attribution
  }
}
```

`runEvent` insert becomes:
```ts
const orgId = (event.data.object as {...}).metadata?.org_id ?? null;
const groupId = await resolveEventGroup(event);
await sql`insert into billing_events (id, type, org_id, subscription_id, payload)
          values (${event.id}, ${event.type}, ${orgId}, ${groupId}, ${event})`;
```

**Ordering note:** resolution runs *before* `processStripeEvent`. For invoice
events (the actual bug) the group row and its `stripe_subscription_id` already
exist, so resolution is reliable at insert time. For a brand-new subscription's
first `checkout.session.completed`, the stamp reads `session.metadata.subscription_id`
(always present) via `checkoutGroupId`, so it too resolves at ingest. If any
future event type needs a group created *within the same event*, move its stamp
to a post-`processStripeEvent` UPDATE; not needed for the events in scope.

**3. Admin page reads the ledger stamp first.**
- `ledgerByIds` and `stuckLedgerEvents` SELECTs add `b.subscription_id`.
- The page prefers the ledger stamp over live object metadata:
  ```ts
  const subId = ledgerRow?.subscription_id ?? m.subscription_id ?? null;
  const groupLabel = subId ? (groupLabels.get(subId) ?? null) : null;
  ```
- `groupLabelsByIds` is fed the union of ledger `subscription_id`s and metadata
  `subscription_id`s. `groupLabelsByIds` already builds "N organisation(s) ·
  Payer" labels — unchanged.

Attribution now comes from a durable stamp resolved at ingest, not from live
Stripe object metadata that invoice events lack.

### Regression test (headless — no live Stripe)

DB-backed test (ephemeral PG per the local-test-db recipe):
1. Seed a group: one `subscriptions` row with a `stripe_subscription_id` and a
   payer, plus **3** `organizations` pointing at it.
2. Construct an `invoice.payment_succeeded` `Stripe.Event` whose
   `invoice.subscription` (or `invoice.parent`/lines, per `invoiceSubId`) is that
   `stripe_subscription_id`, with **no** `subscription_id` in `invoice.metadata`.
3. Run it through `runEvent` (→ `processStripeEvent`).
4. Assert `billing_events.subscription_id` for the event equals the group id.
5. Assert the admin row renders "3 organisations · <Payer>" (call
   `groupLabelsByIds([groupId])` and check the label, exercising the same code
   path the page uses).

This is the failing-without-it test: on `main` step 4 finds `subscription_id`
null and the label would be a single org.

### Part A acceptance
- [ ] A group **invoice** event shows payer + N organisations in `/admin/billing-events`.
- [ ] Attribution comes from the durable ledger stamp, not live Stripe metadata.
- [ ] Regression test on the invoice-event ingest path (headless).
- [ ] Re-verify on a real test-mode group invoice once an `sk_test` key exists.

---

## Part B — Decline-at-checkout + `incomplete`→`past_due` grace

**Blocked:** needs live Stripe test mode (no `sk_test` key in this env). Captured
with analysis so a keyed session starts cold.

### B1 — Declined card at embedded checkout is unexercised at the UI

Server handlers for `invoice.payment_failed` / `payment_intent.payment_failed`
have unit coverage (`billing-events.ts` `handleInvoicePaymentFailed` ~409, and
`handleSponsorPaymentFailed`), but nothing **types a decline card at the sheet**.
Test-mode cards: `4000000000000002` (generic decline), `4000000000009995`
(insufficient funds).

Plan (when keyed): an e2e that opens the embedded checkout, types a decline
card, and asserts the UI surfaces the failure and the org is **not** granted
Pro. Keep it behind the existing CI Stripe gate (skips without `sk_test`).

### B2 — `incomplete`→`past_due` starts the 14-day grace

`lib/billing.ts` `STATUS_MAP` (verified on `main`):
```ts
incomplete:         "past_due",
incomplete_expired: "canceled",
unpaid:             "past_due",
paused:             "past_due",
```
A checkout where 3DS is never completed leaves the Stripe subscription
`incomplete`, which maps to `past_due` — and `past_due` starts the 14-day
dunning window. So a subscription that **never took a successful payment** can
grant 14 days of Pro.

The intended backstop is `incomplete_expired → canceled` (Stripe expires an
`incomplete` subscription ~23h after creation), plus V313's rule that a
`canceled` subscription conveys nothing. **Open question requiring live test
mode:** does Stripe actually fire `customer.subscription.deleted` (or a
`customer.subscription.updated` to `incomplete_expired`) that our webhook
ingests, and does it arrive before the 14-day grace is meaningfully abused?

Candidate fixes (decide after live confirmation):
1. **Preferred if the event is reliable:** rely on `incomplete_expired → canceled`;
   add a test that an `incomplete_expired` event drops entitlement. Cheapest.
2. **If the event is unreliable / too slow:** distinguish "never paid" from a
   genuine `past_due` after a paid period — do not open the 14-day grace for a
   subscription whose `latest_invoice` never succeeded (map `incomplete` to a
   non-entitling state rather than `past_due`, or gate the grace on a prior
   successful payment).

### Part B acceptance (deferred)
- [ ] A decline card at the embedded checkout is exercised end-to-end and does
      not grant Pro.
- [ ] Confirmed (live) whether `incomplete_expired` fires an ingested event; the
      chosen fix from the two candidates is implemented with a regression test.

---

## For context — already handled on `fix/entitlement-and-reconcile-latent-bugs`
- **#209** entitlements TS/SQL null-bool divergence — fixed + parity regression.
- **#210** `reconcilePassCheckout` return lied on a trace hiccup — fixed + regression.
- **#205** 3DS `requires_action` coverage — `applyPlanChange` true-branch test
  added (interval + retry-invoice route producers remain uncovered; optional
  follow-up).

## Verify (Part A)
```
cd apps/web && npx tsc --noEmit && npx vitest run   # incl. the new ingest regression test
# db:apply the V317 delta against the local test DB first (Flyway)
```

## Sequencing
Part A ships independently and now. Part B stays on this issue as a checklist
item until an `sk_test` key is available; do not block A on B.
