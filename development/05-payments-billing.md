# 05 — Payments & Billing

## 1. Goal

Monetize via Stripe with minimal custom billing code: self-serve checkout, plan management,
robust webhook reconciliation, and a single **entitlement gate** that the whole app uses to
enable/disable capabilities and enforce limits.

## 2. Current state

- No billing. All orgs equal. No Stripe, no plans, no entitlement checks.
- Org is the tenant boundary (doc 03) → billing attaches to org.

## 3. Principles

1. **Stripe owns money & card data.** We never store PANs (PCI scope stays minimal).
2. **Stripe Checkout + Customer Portal** for self-serve; we don't build payment UI.
3. **Webhooks are the source of truth** for subscription state → mirror into `subscriptions`.
4. **Idempotent, signature-verified** webhook processing.
5. **One gate:** `entitlements.ts` is the only place features/limits are decided.

## 4. Plans & products (Stripe + local)

- Stripe **Products** = Pro, Business (Enterprise is custom/invoiced, no public price).
- Stripe **Prices** = monthly + annual per product.
- Local `plans` + `plan_entitlements` tables (doc 03) hold the entitlement matrix (doc 01).
- Mapping: `plans.stripe_price_id` links a plan to its Stripe price.

## 5. Subscription lifecycle

```
[no sub] ──create checkout──▶ trialing ──trial_end──▶ active
   │                              │                     │
   │                              └── card added ───────┘
   │
 active ──payment fails──▶ past_due ──retries exhausted──▶ canceled/suspended
 active ──cancel (portal)──▶ cancel_at_period_end=true ──period_end──▶ canceled
 suspended ──pay──▶ active
```

- **Trial:** 14 days Pro, no card (doc 01). On `trial_end` without card → downgrade to
  Community (read-only beyond Community limits, never data loss).
- **Dunning:** Stripe Smart Retries; on final failure → `suspended` (writes blocked,
  read-only access retained), email owner + in-app banner.
- **Cancel:** `cancel_at_period_end`; access remains until `current_period_end`.

## 6. Data model

Uses `plans`, `subscriptions`, `plan_entitlements`, `org_entitlement_overrides`,
`usage_counters` from doc 03. Add a webhook event ledger for idempotency:

```sql
CREATE TABLE billing_events (
  id            text PRIMARY KEY,         -- Stripe event id (idempotency key)
  type          text NOT NULL,
  org_id        uuid,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
```

## 7. API surface (new routes, `handler()` pattern)

| Route | Purpose |
|-------|---------|
| `POST /api/billing/checkout` | Create Stripe Checkout Session for `{ plan_key, interval }`; returns redirect URL. Requires `owner`/`billing.manage`. |
| `POST /api/billing/portal` | Create Customer Portal session; returns URL. |
| `GET /api/orgs/[id]/subscription` | Current plan, status, period end, trial end (for UI). |
| `GET /api/orgs/[id]/entitlements` | Resolved entitlements + current usage (UI gating). |
| `POST /api/webhooks/stripe` | Verify signature → enqueue/process events (idempotent). No auth cookie; Stripe signature is the auth. |

## 8. Entitlement gate (`src/lib/entitlements.ts`)

```ts
// resolution: org override → plan entitlement → deny
hasFeature(orgId, featureKey): Promise<boolean>
getLimit(orgId, featureKey): Promise<number | null>   // null = unlimited
withinLimit(orgId, metric, wouldBe): Promise<{ ok: boolean; limit: number|null; current: number }>
requireFeature(orgId, featureKey): Promise<void>       // throws PaymentRequiredError → 402 envelope
```

- **Cache:** Redis `entitlements:{orgId}` (TTL + invalidate on subscription/override change).
- **Enforcement points:**
  - Create tournament → `withinLimit(org,'tournaments.active', current+1)` + `players.max`.
  - Realtime stream connect → `requireFeature(org,'realtime')`.
  - Export, API tokens, branding, leagues, SSO config → `requireFeature(...)`.
- **UI:** read `/entitlements`; show upgrade prompts with the blocked `feature_key` and a CTA
  to `/api/billing/checkout`. Never rely on UI alone — server always enforces.

## 9. Webhook handling detail

Events to handle:

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Link `stripe_customer_id`; set plan; status `trialing`/`active`. |
| `customer.subscription.created/updated` | Upsert `subscriptions` (plan, status, period_end, cancel_at_period_end, trial_end). Invalidate entitlement cache. |
| `customer.subscription.deleted` | Downgrade to Community; set status `canceled`. |
| `invoice.payment_failed` | Status `past_due`; notify. |
| `invoice.payment_succeeded` | Status `active`; clear dunning banner. |

Processing rules:
1. Verify `Stripe-Signature` with webhook secret.
2. `INSERT ... ON CONFLICT (id) DO NOTHING` into `billing_events`; if already present, ack 200.
3. Process inside a transaction; set `processed_at`. Failures → 5xx so Stripe retries.
4. Heavy work deferred to a job; webhook stays fast.

## 10. Enterprise / invoiced billing

- No card flow. Sales creates the subscription manually (Stripe invoice or out-of-band) and
  sets `plan_key='enterprise'` + `org_entitlement_overrides` for the contracted scope.
- Order form / MSA / DPA tracked in CRM, not the app.

## 11. Tax, currency, compliance

- **Stripe Tax** for VAT/GST/sales tax; collect billing address.
- Multi-currency presentment `LATER`; start single currency.
- Invoices/receipts via Stripe; Customer Portal exposes history.
- PCI: SAQ-A posture (Checkout/Portal hosted by Stripe).

## 12. Failure modes

- **Webhook out of order:** always trust the latest `subscription.updated` (compare Stripe
  `current_period_end`/status); don't derive state from event ordering.
- **Redis down:** entitlement cache miss → read from DB (fail safe, slower).
- **Checkout abandoned:** no state change; org stays on prior plan.
- **Refund/chargeback:** handled via Stripe events → status transitions.
- **Counter drift:** nightly reconcile (doc 03 §7).

## 13. Acceptance criteria

- Checkout → active subscription mirrored locally via verified, idempotent webhooks.
- `entitlements.ts` is the sole gate; create-tournament + realtime enforce it server-side.
- Customer Portal handles upgrade/downgrade/cancel/payment method.
- Suspended orgs are read-only, never lose data.
- Enterprise overrides supported without card flow.
- Stripe Tax enabled; invoices accessible.

## 14. Decisions (locked vs open)

**Locked:** flat **per-org** pricing only; no per-seat add-ons.

**Still open:**
1. Final price points + annual discount %.
2. Trial length (14d?) and post-trial downgrade behavior.
3. Launch currency.
