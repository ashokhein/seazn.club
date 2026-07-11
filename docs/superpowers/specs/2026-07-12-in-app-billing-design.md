# In-app billing management (kill the portal redirect)

2026-07-12 · branch `feat/billing-in-app-manage`

## Problem

Upgrading is already in-page (Stripe Embedded Checkout), but everything after —
adding/replacing a card, switching monthly↔annual, cancelling, invoices — bounces
the owner to the Stripe-hosted Customer Portal. Requirement: the owner never
leaves seazn.club. Invoices are the one exception: we link to Stripe's hosted
invoice page / PDF so we never render or store payment documents ourselves.

PCI posture stays SAQ A: card entry happens only inside Stripe's PaymentElement
iframe (SetupIntent flow); card data never touches our servers. Invoice
downloads are Stripe-hosted URLs.

## What replaces the portal

One page — `/o/[org]/settings/billing` — grows three owner-only sections for
orgs with a Stripe customer:

1. **Payment method.** Shows the default card (brand · last4 · exp) fetched
   server-side. "Add card" / "Replace card" opens PaymentElement in SetupIntent
   mode (`payment_method_types: ["card"]`, `usage: "off_session"` — cards only,
   so no redirect-based methods; 3DS runs in Stripe.js's in-page modal). On
   `confirmSetup` success the client posts the SetupIntent id; the server
   verifies it (status `succeeded`, customer matches the org), sets
   `invoice_settings.default_payment_method`, and detaches the previous default
   so exactly one card is on file. Trialing orgs see this as "Add a card to
   keep Pro" (replaces the old portal CTA — `billingCtaLabel` keeps its label,
   new target).

2. **Plan.** Current interval (derived live from the subscription item's price
   id vs `plans.stripe_price_id_monthly/annual`) + a switch to the other
   interval. Clicking "Switch" first calls the preview endpoint:
   `invoices.createPreview({ customer, subscription, subscription_details: {
   items: [{ id, price: newPrice }], proration_behavior: "always_invoice",
   billing_cycle_anchor: "now", proration_date } })`. We show: amount due today
   (or credit), the unused-time credit line, and the new renewal date/amount.
   Confirming applies `subscriptions.update` with the *same* `proration_date`
   (Stripe's documented contract for preview == actual). Then `syncSubscription`
   + entitlement invalidation inline (webhook remains the backstop). Trialing
   subs switch price with `proration_behavior: "none"` — nothing has been paid;
   preview shows first charge at trial end.
   - If the immediate invoice needs SCA, the route returns
     `{ requiresAction, clientSecret }` and the client runs
     `stripe.confirmCardPayment` in-page, then re-syncs.
   - Both directions switch immediately with `billing_cycle_anchor: "now"` +
     `always_invoice`: upgrade nets unused monthly time against the annual
     charge; downgrade turns unused annual time into a customer credit balance
     consumed by future monthly invoices. One code path, always previewed,
     nobody loses money. (Deliberately no subscription-schedules machinery.)

3. **Cancel / resume + invoices.** "Cancel at period end" / "Resume" toggles
   `cancel_at_period_end` (in-app confirm dialog, existing `useConfirm`), syncs
   inline. Invoice history lists up to 24 non-draft invoices (date, number,
   total, status) with "View" → `hosted_invoice_url` and "PDF" →
   `invoice_pdf` (both Stripe-hosted, open in new tab).

Removed: `ManageBillingButton`, `POST /api/billing/portal`.
`downgradeToCommunity`'s error copy ("cancel via Manage billing") is updated to
point at the in-app cancel.

## Endpoints (owner-gated, same `handler`/`HttpError` conventions as checkout)

| Route | Does |
| --- | --- |
| `POST /api/billing/payment-method/setup` | SetupIntent for the org's customer → `client_secret` |
| `POST /api/billing/payment-method` | verify SetupIntent, set default PM, detach old |
| `GET /api/billing/plan-change/preview?interval=` | createPreview → `{ dueToday, credit, currency, renewsAt, renewalAmount, prorationDate }` |
| `POST /api/billing/plan-change` | update sub items (pinned prorationDate), sync, maybe `{ requiresAction, clientSecret }` |
| `POST /api/billing/cancel` | body `{ resume?: boolean }` → toggle `cancel_at_period_end`, sync |

Page data (card summary, interval, invoice list) is fetched server-side in the
page component (best-effort; Stripe outage degrades to sections hidden, page
still renders).

## Pure core (unit-tested, no Stripe/DB)

`lib/billing-manage.ts`:
- `buildSetupIntentParams(customerId)`
- `buildPlanChangePreviewParams(a)` / `buildPlanChangeParams(a)` — shared shape,
  trial handling (`proration_behavior: "none"`, no anchor reset), pinned
  `proration_date`
- `summarizePlanChangePreview(invoice)` → dueToday / credit / renewal
- `invoiceRows(invoices)` → display rows, drops drafts, keeps hosted URLs
- `paymentMethodSummary(customer|pm)` → brand/last4/exp or null
- `intervalForPrice(sub, plan)` → "monthly" | "annual" | null

## Tests

- Vitest on every pure helper above (fail-without-change per repo rule).
- Smoke (`scripts/smoke.ts`): pro path asserts billing page renders the three
  manage sections; free path asserts they're absent.
- Manual: Playwright screenshots desktop + 390 px; add-card + switch-interval
  exercised against Stripe test mode (4242… card).

## Out of scope

Tax-id editing, billing-address editing, multi-card wallets, subscription
schedules, pausing. The `business` plan stays hidden.
