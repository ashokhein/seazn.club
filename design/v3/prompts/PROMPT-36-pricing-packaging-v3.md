# PROMPT-36 — Pricing & Packaging v3: Plan Matrix, Event Pass, Multi-Currency, Marketing, Funnel

**Read first:** `v3/07-pricing-packaging-v3.md` (normative); `v3/11-gaps-and-decisions.md`
gaps 1, 2, 5, 6, 13 (normative for this prompt); `engine/10-pro-entitlements.md`;
billing-map memory gotchas (`ui_mode: "embedded_page"` — do NOT rename; reconcile-on-return;
`stripe:sync` lookup keys). Preamble: PROMPT-00.

## Task
1. **Plan matrix** (v3/07 §2): update `plan_entitlements` seed to the v3 numbers (orgs,
   active comps, divisions/comp, entrants/div, members, badge removal, fee %); new
   entitlement keys where missing; grandfather existing over-cap free orgs via
   `entitlement_overrides` backfill migration; freeze machinery must honour new keys.
2. **Event Pass** (v3/07 §3): `competition_passes` table; resolution order org-override →
   comp-pass → plan → deny with `competition_id` context in `checkFeature()` + cache key
   `ent:<org>:<comp>:<feature>`; one-time Stripe checkout (embedded + reconcile-on-return,
   `stripe-plans.json` + sync extension for one-time price); `<UpgradeGate>` two-button
   variant ($39 pass / $20 Pro) on every in-competition 402; Pro-org purchase blocked;
   passes survive downgrade. **Quota semantics (v3/11 gap 1):** a passed competition is
   exempt from the org-level active-competition quota; `charge.refunded` /
   `charge.dispute.created` webhooks set `revoked_at` → comp re-enters quota (freeze
   machinery); passes never carry to duplicated/next-edition comps.
3. **Multi-currency + annual** (v3/07 §4): `currency_options` on all prices (USD/EUR/GBP/
   INR/AUD, set price points from doc); org-country selection + pricing-page switcher;
   `subscriptions.currency`; annual toggle default-on with "billed yearly — save 17%".
   **Tax (v3/11 gap 2):** Stripe Tax on all checkouts (`automatic_tax`), tax-inclusive
   display EU/UK/AU/IN, exclusive US; **INR = Event Pass only** (no INR subscriptions —
   RBI e-mandate); `/help/billing` states entry-fee tax is the organiser's.
4. **Marketing** (v3/07 §5): home hero rewrite + three-offer pricing teaser; pricing page
   three columns rendered **from `plan_entitlements` data**, currency switcher, FAQ; zero
   "Business" mentions (PROMPT-32 grep gate covers).
5. **Start funnel** (v3/07 §6): `/start` 3-step wizard (no auth) with live format-preview
   recommendation; `funnel_drafts` {payload, single-use token, 7d expiry};
   `POST /api/funnel/start` → magic link carrying draft token; post-auth draft →
   org(if-none)+comp+division creation → land in comp. **One creation path (v3/11 gap
   13):** wizard is a skin over the same use-cases `/onboarding` calls; `/onboarding`
   detects a pending draft and short-circuits into it.
6. **Analytics** (v3/11 gap 5): `product_events` table (org_id nullable, anon_id, name,
   props jsonb, 90d retention) + `track()` server helper; seed events (`funnel.*`,
   `gate.hit`, `pass.purchased`, `sub.*`, `registration.submitted`, `share.clicked`,
   `embed.loaded`); `/admin/metrics` weekly counts + funnel conversion.
7. **Jobs** (v3/11 gap 6): pg-boss on existing Postgres, worker process group in
   fly.toml, wrapped in `server/jobs.ts` (enqueue/schedule + handler registry); v3 jobs:
   funnel +24h reminder, draft expiry.
8. **In-app billing — kill the Customer Portal** (v3/07 §7): `GET /api/billing/summary`
   (plan, payment methods, upcoming invoice, invoice list); `POST /api/billing/{cancel,
   resume,interval,setup-intent,default-payment-method,retry-invoice}`; plan card with
   cancel-at-period-end state; interval switch with upcoming-invoice proration preview
   before confirm; PaymentElement card add (SetupIntent, handles 3DS via `confirmSetup`),
   default/remove management; AddressElement + VAT/GST ID feeding `automatic_tax`;
   in-app invoice list (Stripe-hosted `invoice_pdf` links allowed); dunning banner from
   `invoice.payment_failed`, cleared by `invoice.payment_succeeded`, retry via
   `invoices.pay`; consume `customer.subscription.updated` for cancel-state sync.
   Delete `/api/billing/portal` + all portal links (env-flag safety hatch for one
   release, then remove). Cancel flow reuses the freeze preview + ConfirmDialog danger;
   one-question cancel-reason → `product_events`.

## Acceptance
- Unit matrix: entitlement resolution (override × pass × plan) for free/pass/pro incl.
  cache invalidation on pass purchase; `buildEmbeddedCheckoutParams` currency/one-time
  snapshots (keep pure + unit-tested).
- Unit: passed comp exempt from org active-comp quota; refund webhook revokes pass and
  re-enters quota; duplicated comp carries no pass (gap 1). Checkout params include
  `automatic_tax`; INR subscription attempt rejected with clear message (gap 2).
- E2E: hit division cap on free → two-button gate → pass checkout (test mode or SQL
  analogue per test-infra memory) → reconcile on return lifts gate for that comp only;
  funnel wizard → magic-link `login_url` → lands inside created competition; pricing page
  switches currency and shows no Business column.
- In-app billing e2e (Stripe test mode): cancel → "Pro until {date}" → resume; interval
  switch shows proration preview before charging; card add with 3DS test card succeeds;
  simulated `invoice.payment_failed` webhook raises the banner, `payment_succeeded`
  clears it; **no response anywhere links to `billing.stripe.com`** (portal gone).
- smoke.ts: free, event-pass, and pro paths (house rule); `npm test` + `tsc` green;
  `stripe:sync` idempotent re-run documented; update v3/README status.
