# v3/11 — In-app billing management (kill the portal redirect)

2026-07-12 · branch `feat/billing-in-app-manage` · implements intake #32 /
v3/07 §7 ("the organiser never leaves seazn.club for billing")

## Problem

Upgrading is already in-page (Stripe Embedded Checkout), but everything after —
adding/replacing a card, switching monthly↔annual, cancelling, invoices — bounces
the owner to the Stripe-hosted Customer Portal. Requirement: the owner never
leaves seazn.club. Invoices are the one exception: we link to Stripe's hosted
invoice page / PDF so we never render or store payment documents ourselves
(a document download, not a portal session).

PCI posture stays SAQ A: card entry happens only inside Stripe's PaymentElement
iframe (SetupIntent flow); card data never touches our servers.

## What replaces the portal

`/o/[org]/settings/billing` becomes the complete billing home. Owner-only
sections, shown when the org has a Stripe customer:

1. **Payment methods.** Lists saved cards (brand · last4 · exp), marks the
   default. "Add card" opens PaymentElement in SetupIntent mode
   (`payment_method_types: ["card"]`, `usage: "off_session"`). Cards only in
   this release: every non-card method Stripe would offer (UPI, BECS…) is
   redirect-based, which would break the never-leave-the-site rule; 3DS runs in
   Stripe.js's in-page modal. On `confirmSetup` success the client posts the
   SetupIntent id; the server verifies it (status `succeeded`, customer matches
   the org) and sets `invoice_settings.default_payment_method`. Non-default
   cards can be set default or removed (detach). Trialing orgs see "Add a card
   to keep Pro" (existing `billingCtaLabel` copy, new in-app target).

2. **Plan.** Current plan, interval (derived live from the subscription item's
   price id vs `plans.stripe_price_id_monthly/annual`), price + currency,
   renewal date — or "Pro until {period end}" when cancelling. Switch interval:
   preview first via `invoices.createPreview({ customer, subscription,
   subscription_details: { items: [{ id, price }], proration_behavior:
   "always_invoice", billing_cycle_anchor: "now", proration_date } })`, showing
   the exact delta — "You'll be charged £132.40 today, then £160/yr" (or "£X
   credit applies to future invoices" on downgrade). Confirming calls
   `subscriptions.update` with the *same pinned* `proration_date` (Stripe's
   documented preview==actual contract), then `syncSubscription` + entitlement
   invalidation inline (webhook stays as backstop).
   - `always_invoice` + `billing_cycle_anchor: "now"` both directions: one code
     path, the promised "today" copy is literally true, annual→monthly unused
     time becomes customer credit balance consumed by future invoices.
     (Deliberately no subscription-schedules machinery.)
   - Trialing subs switch price with `proration_behavior: "none"` — nothing has
     been paid; copy shows first charge at trial end.
   - SCA on the immediate invoice: update uses `payment_behavior:
     "allow_incomplete"` + expands `latest_invoice.confirmation_secret`; if the
     invoice is open with a secret, the route returns `{ requiresAction,
     clientSecret }` and the client runs `stripe.confirmCardPayment` in-page,
     then re-syncs.
   - `past_due` blocks interval switch (fix the card first).
   - Stale pinned `proration_date` (renewal raced the preview) → Stripe 400 →
     client shows "Prices changed — review again" and re-previews.

3. **Cancel / resume.** `cancel_at_period_end` toggle, ConfirmDialog (danger)
   stating the exact end date, with a one-question reason select that lands in
   analytics (`captureServer`). Resume clears the flag. Comped-Pro's existing
   in-app downgrade stays; the two downgrade paths now live on one surface.

4. **Invoices.** Up to 24 non-draft invoices: date, number, total, status chip.
   "View" → `hosted_invoice_url`, "PDF" → `invoice_pdf` (Stripe-hosted, new
   tab). An `open` invoice row leads with **Pay now** (in-app retry, below).

## Renewal — what happens without us, and every failure path

Renewal is Stripe-driven: at `current_period_end` Stripe generates the cycle
invoice and charges the customer's default payment method **off-session,
automatically**. We never initiate the charge. Our job is only to keep the
mirror truthful and give the owner an in-app fix when the charge fails.

| Scenario | Stripe does | We do |
| --- | --- | --- |
| Happy renewal | charges default PM, `invoice.payment_succeeded` + `customer.subscription.updated` | webhooks already sync status + `current_period_end`; nothing new |
| Card declined | Smart Retries per dashboard config, `invoice.payment_failed` | status→`past_due` (existing webhook) → BillingBanner "Payment failed — Update payment"; card section replaces the card; **Retry payment** button calls `invoices.pay` on the open invoice |
| SCA required off-session | invoice stays `open`, PI `requires_action` | invoice list "Pay now" → in-app `confirmCardPayment` with the invoice `confirmation_secret`; hosted invoice link is the fallback |
| Retries exhausted | per dashboard: cancel sub → `customer.subscription.deleted` | existing webhook flips to community |
| Trial end, card on file (added via our new flow) | converts + first charge (renewal #0) | nothing — customer default PM is used |
| Trial end, no card | cancels (checkout's `missing_payment_method: "cancel"`) | existing webhook flips to community |
| `cancel_at_period_end` set | deletes at period end | existing webhook; page shows "Pro until {date}" |
| Downgrade credit | renewal invoices consume the credit balance until exhausted | show "Credit balance: £X — applies to future invoices" on the plan card so £0 invoices aren't confusing |
| Webhook missed (endpoint down at renewal time) | nothing reaches us; DB goes stale ("Renews {past date}") | **lazy re-sync**: billing page pull — when `current_period_end` < now or status is `past_due`, fetch the sub live and `syncSubscription` (same webhook-optional philosophy as `reconcileCheckout`) |

Deploy checklist (dashboard, not code): Smart Retries ON, failed-payment
emails ON, "cancel subscription after all retries fail" chosen deliberately,
prod webhook endpoint live (`STRIPE_WEBHOOK_SECRET`).

Considered and deferred: `invoice.upcoming` renewal-reminder email via the
existing Resend templates (nice, not needed for portal removal);
AddressElement + VAT id editing (v3/11 gap 2 ties it to automatic_tax);
non-card payment methods (redirect flows); pause; multi-currency price
switching (renewals keep the subscription currency automatically).

## Endpoints (owner-gated, `handler`/`HttpError` conventions)

| Route | Does |
| --- | --- |
| `POST /api/billing/setup-intent` | SetupIntent for the org's customer → `client_secret` |
| `POST /api/billing/default-payment-method` | verify SetupIntent → set customer default (body `{setup_intent_id}`), or `{payment_method_id}` to promote an existing card |
| `POST /api/billing/remove-payment-method` | detach a non-default card |
| `GET /api/billing/interval/preview?interval=` | createPreview → `{ dueToday, credit, currency, renewsAt, renewalAmount, prorationDate }` |
| `POST /api/billing/interval` | apply switch (pinned prorationDate), sync, maybe `{ requiresAction, clientSecret }` |
| `POST /api/billing/cancel` | body `{ resume?: boolean, reason?: string }` → toggle `cancel_at_period_end`, sync, log reason |
| `POST /api/billing/retry-invoice` | `invoices.pay` the latest open invoice (after card fix); returns `confirmation_secret` when SCA needed |

Page data (cards, interval, invoices, credit balance) is fetched server-side in
the page component — no summary API round trip; mutations `router.refresh()`.
Stripe outage degrades to sections hidden; the page still renders.

Removed: `ManageBillingButton` + every portal link. `/api/billing/portal`
stays for exactly one release behind `BILLING_PORTAL_FALLBACK=1` (404 without
it), then dies. `downgradeToCommunity`'s error copy now points at in-app
cancel.

## Pure core (unit-tested, no Stripe/DB) — `lib/billing-manage.ts`

- `buildSetupIntentParams(customerId)`
- `buildIntervalPreviewParams(a)` / `buildIntervalChangeParams(a)` — shared
  shape, trial handling, pinned `proration_date`
- `summarizeIntervalPreview(invoice)` → dueToday / credit / newPeriodEnd
- `invoiceRows(invoices)` → drops drafts, keeps hosted URLs, open-first flag
- `paymentMethodRows(pms, defaultId)` → brand/last4/exp/default flag
- `intervalForPrice(priceId, plan)` → "monthly" | "annual" | null
- `needsRenewalResync(sub)` → the lazy re-sync predicate

## Tests

- Vitest on every pure helper (fail-without-change per repo rule).
- Smoke (`scripts/smoke.ts`): pro path asserts billing page renders the manage
  sections; free path asserts absence.
- Manual: Playwright screenshots desktop + 390px; add-card + interval switch
  against Stripe test mode (4242…).

## Trade-off, stated (from v3/07 §7)

We own ~6 small billing screens Stripe used to host, and their edge cases (3DS
re-auth on card add, dunning states). Bounded by server-side page fetch +
Elements; the env-flag portal hatch covers one release of unknown unknowns.
