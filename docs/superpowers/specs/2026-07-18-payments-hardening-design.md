# Payments hardening — deep-dive audit, gaps & plan (2026-07-18)

Audit of every money surface: Pro subscription billing, Event Pass, entry-fee
Connect rail, sponsor monetization, disputes/refunds, webhooks, and the /admin
tooling. Method: full read of `lib/billing.ts`, `lib/entitlements.ts`,
`usecases/billing-events.ts`, `usecases/registrations.ts` (2180 lines),
`usecases/sponsors.ts`, `usecases/stripe-connect.ts`,
`usecases/billing-manage.ts`, `usecases/entitlement-freeze.ts`,
`usecases/platform-revenue.ts`, pass/checkout routes, V112/V118/V270–V273/V283
migrations, plus live FK inspection on the dev DB.

**Ranked verdict:** the entry-fee rail is the most mature (v9 dispute recovery,
duplicate/late-payment refunds, evidence pack). The gaps cluster in four
places: (1) destructive lifecycle actions that erase money records, (2) dispute
coverage that exists ONLY for entry fees, (3) Event Pass has no
refund/revoke lifecycle, (4) no admin-wide payments console.

---

## 1. How Event Pass works today (asked)

**Purchase**: `/api/billing/pass-checkout` (owner-only) → embedded one-time
Checkout (`mode:"payment"`, metadata `{org_id, competition_id,
pass_key:"event_pass"}`), price from `plans.stripe_price_id_onetime`
($39 / £33 / €39). Guards: comp must belong to org; org must be `community`
(Pro 400s); one pass per competition (PK).

**Linkage**: paid session → `recordPassPurchase` (webhook + reconcile-on-return,
idempotent `on conflict (competition_id) do nothing`) → row in
`competition_passes (competition_id PK, org_id, stripe_payment_intent)`.

**Effect**: entitlement resolver order = org override → **pass (community orgs
only, only when a `competitionId` is in scope)** → plan → deny. Pass matrix
(V270): 10 divisions/comp, 32 entrants/div, advanced formats, paid
registration (5% platform fee), branding, exports, realtime. The passed comp is
also bought OUT of `competitions.max_active` (create-quota + freeze selector
both exclude it) for its lifetime. Under Pro the pass is deliberately moot; it
revives if the org later downgrades.

**Delete**: `competition_passes.competition_id references competitions(id) ON
DELETE CASCADE` — deleting the competition **silently destroys the pass**. The
org paid £33, keeps nothing, gets no refund, and the app retains zero record
(only the Stripe payment survives). `deleteCompetition` guards ONLY on score
events — a passed comp with no recorded play deletes freely. Exposure note
(owner review 2026-07-18): the console UI deliberately offers NO
competition-delete button — the reachable surface is
`DELETE /api/v1/competitions/[id]` (owner/admin session, or an API key with
competition write scope; the route is not in NEVER_KEY_ROUTES). See P0-1.

**Archive**: `status='archived'` leaves all rows intact. Archived comps don't
count against quota anyway, so an archived passed comp = pass parked but
recoverable (unarchive works; freeze exclusion still applies). Archive is safe;
delete is the hazard.

**"Create divisions in a loop" abuse**: bounded. Division create calls
`withinLimit(org, 'divisions.per_competition.max', n+1, competitionId)` so the
pass grants at most **10 concurrent divisions × 32 entrants**. Deleting a
division to create another keeps the concurrent cap. The real loop is
*sequential competitions*: archive comp → create new one (archived comps are
quota-free by design) — but each new comp needs its own pass for lifted
features, which is revenue, not abuse. Two genuine wrinkles:
- `members.max = 5` in the pass matrix is a **dead row**: `members.max` is
  resolved org-wide (no competitionId), so the pass branch never fires — the
  pricing page promises 5 members that enforcement never grants (community
  stays at 3).
- A downgraded ex-Pro org keeps charging cards on divisions configured while
  Pro (gate is at settings-write time only) at the 5% default fee — an Event
  Pass price undercut. Probably acceptable (platform still earns 5%); should be
  an explicit decision. See P2 items.

---

## 2. Findings — ranked, with real-world failure stories

### P0 — money records can be destroyed / money kept without service

**P0-1 · Competition delete cascades paid money records.**
*(Reclassified P1-severity at owner review 2026-07-18: no console UI offers
competition delete — deliberate — so the surface is the API route only. Guard
stays in the plan as cheap defense-in-depth.)*
`deleteCompetition` checks only score events. Divisions cascade on comp delete,
and `registrations` cascade on division delete — so the divisions.ts guard
("delete blocked while `payment_intent_id` unrefunded", divisions.ts:263) is
**bypassed** when deleting the whole competition. Live-proven on the dev DB
(2026-07-18, rolled-back transaction): delete of a draft comp removed a `paid`
registration carrying a payment_intent AND its competition_passes row in one
statement. Reachable today via `DELETE /api/v1/competitions/[id]` — owner/admin
session or a competition-write API key (route absent from NEVER_KEY_ROUTES), so
a leaked/over-scoped key or an automation bug can erase money records. Story:
integration script cleans up "test" comps by slug pattern, matches a real one
holding 30 × £20 paid entries → payment_intent ids, refunded_cents, dispute
flags all gone; refunds become Stripe-dashboard archaeology; a later
`charge.dispute.created` webhook finds no row and silently no-ops — dispute
unanswered, platform eats it. Same delete kills the Event Pass row. Sponsor
placements scoped to the comp cascade too (paid `sponsor_orders` survive —
org-scoped — but their placement dies).
**Fix**: `deleteCompetition` must 409 when any of: a competition_passes row,
registrations with `payment_intent_id` not fully refunded, or paid
sponsor_orders scoped (via their package) to this comp. Copy mirrors the
score-events message: "archive it instead". Additionally add
`DELETE /competitions/:id` to NEVER_KEY_ROUTES — destructive + money-adjacent
is the existing bar for that list. Fully-refunded rows may still cascade —
once no live money remains, losing the audit ledger with the comp is
acceptable, same as today.

**P0-2 · Sponsor chargebacks are invisible.**
`charge.dispute.created/closed` dispatch to `handleRegistrationDispute` only;
a sponsor-order intent matches no registration → **no-op**. Story: sponsor pays
£2,500 gold package, marketing lead leaves, CFO disputes the card charge. Today:
no owner alert, no flag in the console, logo stays live on the public board,
nobody files evidence, dispute auto-loses, the transfer is NOT recovered — the
platform is debited £2,500 + £20 fee while the club keeps £2,375. This is the
exact v9 entry-fee scenario at 10–100× the amounts.
**Fix**: extend the dispute handlers to match `sponsor_orders` by
payment_intent: created → order `disputed` flag + owner email + placement
`pending`; lost → order status flip + `recoverDisputedTransfer` (reuse —
identical destination-charge math) + placement `inactive`; won → clear.
Evidence-pack generator for sponsor orders (package, invoice email
reconstruction, click stats of the live placement).

**P0-3 · Event Pass has no refund/revoke lifecycle and a double-charge window.**
(a) Refund a pass in the Stripe dashboard → `charge.refunded` handlers cover
registrations + sponsors only → the pass row stays, org keeps the lifted comp
forever, money returned. (b) `pass-checkout` sets no idempotency key and
`recordPassPurchase` is `do nothing` on conflict: two owners (or two tabs)
completing checkout for the same comp = second payment succeeds, records
nothing, refunds nothing — silent double charge (registrations solved this
class with duplicate-intent auto-refund).
**Fix**: `charge.refunded` (full) on a pass intent → delete/void the pass row
(+ invalidate entitlements + owner email; if the comp is now over-quota the
freeze machinery already handles it lazily). Pass purchase: record
`stripe_payment_intent`; on webhook seeing a paid pass-shaped session whose
comp already holds a DIFFERENT intent → auto-refund the newcomer (mirror
`confirmPaidRegistration` duplicate branch).

### P1 — plan/billing correctness & liability

**P1-4 · Disputes on PLATFORM charges (Pro subscription, Event Pass) are
ignored.** Same dispatch gap: intent matches no registration → nothing. Story:
org runs a season on Pro, disputes the £16 sub charge each month, keeps full
entitlements; nobody notices without opening the Stripe dashboard. **Fix**:
dispute on a subscription invoice charge → flag org (`subscriptions.disputed_at`),
staff alert email, policy switch (auto-suspend Pro on dispute-created or on
lost — recommend: created = alert only; lost = immediate `community` +
override-block). Pass charge dispute lost → revoke pass (P0-3 rail).

**P1-5 · Stale/foreign subscription events can silently downgrade a paying
org.** `handleSubscriptionDeleted` flips to community WITHOUT checking the
event's subscription id equals the stored `stripe_subscription_id` (cancel →
period lapse → resubscribe (new sub id) → a late retry/replay of the old sub's
`deleted` event downgrades the now-paying org). Similarly `syncSubscription`
maps an unknown price id to `plan_key='community'` (`planKeyForPrice` null
fallback) — a price migration/grandfather in Stripe that isn't in `plans`
would downgrade every org it touches on the next `subscription.updated`.
**Fix**: deleted-handler guards on sub-id match; syncSubscription keeps the
existing plan_key + writes a `billing_events`-style anomaly (staff alert) when
the price is unknown.

**P1-6 · `past_due` keeps full Pro forever.** The resolver reads `plan_key`
only; `invoice.payment_failed` sets status past_due but entitlements never
degrade. Bounded only by the Stripe dashboard dunning config ("cancel after N
retries" — a deploy-checklist item, not code). Story: card expires silently;
org runs a whole season on unpaid Pro. **Fix**: read-time grace like
`comped_until`: past_due older than 14 days (subscriptions.updated_at) resolves
community; billing page banner + `retryOpenInvoice` already exist for recovery.

**P1-7 · Stuck webhook events stall money until a human replays.** By design a
recorded-but-failed event is REFUSED on Stripe retry (fast-path ACK) and waits
on /admin/billing-events. Story: transient DB blip during
`payment_intent.succeeded` → sponsor paid but not activated; nobody watches
the admin tab; sponsor emails angrily two days later. **Fix**: hourly cron
sweep (`/api/cron/registrations` pattern) auto-replays `received` events older
than 10 min (handlers are idempotent — that's the invariant of this codebase)
+ staff email when a row stays stuck after 3 attempts.

**P1-8 · Connect account health is a single bit.** Only `charges_enabled` is
mirrored. Not mirrored: `payouts_enabled`, `requirements.currently_due`,
`disabled_reason`. Story: Stripe pauses payouts for KYC re-verification; club
keeps selling entries (charges still enabled), money piles up unreachable,
club blames the platform. Also: account rejected/closed → checkout mint 500s
(raw Stripe error). No admin view exists of any of this; reversal-on-dispute
failures (insufficient balance, debits disabled) are audited per-registration
but surfaced nowhere.
**Fix**: widen `syncConnectAccount` (payouts_enabled, disabled_reason,
requirements count), org-side banner on the Connect settings page ("Stripe
needs more information — resume onboarding"), admin Connect-health list, and
graceful 503 on checkout mint when the account is dead.

### P2 — polish, policy, compliance

- **P2-9 partial sponsor refunds unrecorded**: `handleSponsorChargeRefunded`
  requires `charge.refunded === true` (full). Dashboard partial refund → order
  stays `paid`, no refunded_cents column exists. Add `refunded_cents` +
  monotonic sync (mirror registrations).
- **P2-10 downgraded org keeps card intake** on divisions configured under
  Pro/pass (submit checks `registration.enabled` only). Decide: (a) accept
  (5% default fee earns) — document; or (b) `publicRegistrationInfo` +
  `submitRegistration` require `registration.paid` when method=stripe →
  divisions show `payments_unavailable`. Recommend (b) for pricing integrity:
  it's what makes Event Pass worth buying twice.
- **P2-11 pass matrix dead row**: drop `members.max` from event_pass seeds or
  make the pricing table footnote it; today the pricing page over-promises.
- **P2-12 tax**: platform checkouts enable `automatic_tax` — verify a Stripe
  Tax registration is active per sold-into country (without one Stripe
  calculates nothing while the org believes tax is on). Entry-fee/sponsor
  destination charges have NO tax handling at all; sponsorship is B2B and
  clubs will ask for VAT invoices — needs a decision (Stripe Tax on connected
  charges vs. explicit "prices are tax-inclusive, clubs own their VAT" ToS
  line + invoice field for the club's VAT number).
- **P2-13 sponsor order hygiene**: pending orders never expire (Checkout
  session dies at 24h; order row lingers), no cancel/void action, no re-send
  invoice. Add cancel + re-send + auto-expire sweep.
- **P2-14 no pass admin tools**: no grant (support goodwill), no revoke, no
  "move pass to another competition" (created-the-wrong-comp support ticket is
  inevitable — today the answer is "buy again").

### Downgrade & proration matrix (asked: "does downgrade work seamlessly incl. prorate?")

| Path | Today | Verdict |
|---|---|---|
| Monthly ⇄ annual switch | `always_invoice`, pinned `proration_date` shared by preview+apply (preview == contract), SCA via confirmation_secret, stale-preview 400 | ✅ solid, prorated both directions |
| Cancel (Stripe-billed) | `cancel_at_period_end`; Pro until period end; webhook flips community; resume supported | ✅ works; **no proration/refund by policy** |
| Annual cancel day 2 | Keeps Pro 363 days, zero refund | ⚠️ policy gap — churn/complaint driver; propose admin "cancel now + prorated refund" goodwill tool (below), not self-serve |
| Comped downgrade | in-app immediate, 400 if Stripe sub exists | ✅ |
| Trial | one per org (`trial_used_at`), no-card 14d, cancel at end | ✅ |
| Post-downgrade data | nothing deleted; freeze selectors (comps > quota, members > quota) lazy at read; passed comp survives + revives pass | ✅ good story |
| Post-downgrade card intake | keeps working on stripe-method divisions | ⚠️ P2-10 decision |
| past_due | full Pro indefinitely (dashboard dunning dependent) | ⚠️ P1-6 |
| Stale deleted event | can downgrade a resubscribed org | ⚠️ P1-5 |

---

## 3. /admin/payments console (asked) — design

One staff surface owning every money knob. New tab group `/admin/payments`
(existing pages fold in as tabs where noted). All actions ride
`staff_audit_log` like existing admin writes; Stripe stays the source of truth
— the console is a lens + a small set of guarded verbs.

1. **Overview** — MRR/ARR from active subs, application-fee revenue (reuse
   `platformRevenue`), open disputes count, stuck webhook count, Connect
   accounts needing attention. The "is money healthy" one-pager.
2. **Transactions** — unified search (org / email / payment_intent / ref_code)
   across registrations, sponsor orders, passes, subscription invoices; row
   actions: refund (full/partial, the existing per-domain paths), open in
   Stripe, view audit trail.
3. **Disputes** — all flagged rows (regs + sponsors + platform charges after
   P0-2/P1-4), evidence-pack download, outcome + recovery status.
4. **Subscriptions** — per-org plan/status/trial/interval/currency; verbs:
   comp plan (exists as entitlement-override), extend/grant trial, cancel now
   **with prorated refund** (the goodwill tool: `invoices.createPreview`-style
   unused-time math → refund + immediate cancel), force resync from Stripe.
5. **Passes** — list with comp/org/intent; verbs: grant (no charge, reason
   required), revoke (with optional refund), move to another competition
   (same org; guard: target has no pass).
6. **Plans & pricing** — read-only render of `stripe-plans.json` matrix vs.
   live Stripe prices (drift detector), platform fee editor (exists —
   move here), per-plan `registration.fee_percent` editor writing
   `plan_entitlements`, coupons tab (exists — fold in).
7. **Connect** — account health list (charges/payouts/requirements/
   disabled_reason after P1-8), balances via `balance.retrieve` per account,
   negative-balance flags, dispute-recovery failures.
8. **Webhooks** — existing /admin/billing-events + auto-retry status (P1-7).

Ship as: existing pages re-homed under a `/admin/payments` layout with tabs;
net-new = Overview, Transactions, Disputes, Passes verbs, Subscriptions verbs,
Connect health.

---

## 4. Out-of-the-box ideas (brainstorm)

- **Pass → Pro credit ladder**: within 30 days of a pass purchase, upgrading
  to Pro applies the pass price as a one-time coupon. Kills the "wasted my
  £33" objection at the exact moment an org outgrows one comp.
- **Season Pass bundle**: 3 passes for the price of 2 as a `plans` row —
  pure config in the existing matrix machinery.
- **Org credit ledger**: small `org_credits` table consumed at checkout
  (Stripe customer balance for subs; discounted session for one-times) —
  the substrate for goodwill, referral rewards, and cancel-now refunds
  without cash leaving.
- **Auto-file dispute evidence**: the evidence pack already exists — submit it
  via `stripe.disputes.update(evidence)` automatically at T-48h before the
  response deadline if the organiser hasn't acted. Turns the worst inbox
  moment into a no-op. (Platform account owns the dispute surface — allowed.)
- **Refund-policy disclosure on the public register panel** (each division's
  `refund_lock_at` rendered as "free cancellation until X") — disclosed policy
  is also dispute evidence that WINS cases.
- **Payout digest email to clubs** (weekly: collected, fees, payouts, upcoming)
  — Connect Express has no real dashboard; this becomes the club's statement
  and cuts "where's my money" support.
- **Dispute-risk metadata for Radar**: stamp org age + first-charge flag on
  payment intents; platform-level Radar rules can then 3DS-challenge risky
  first charges.
- **Installment entry fees** (2×/3× via future-dated invoices) for expensive
  leagues — big differentiator, meaningful build; park behind demand signal.

---

## 5. Phased plan

Each prompt = one PR, regression tests per change, smoke extended (pro + free),
help pages updated in the same PR (house rules).

- **PROMPT-72 — Money-integrity guards (P0-1, P0-3)**: comp-delete 409s
  (pass / unrefunded regs / paid comp-scoped sponsor orders), pass
  refund→revoke via charge.refunded, pass duplicate-payment auto-refund,
  pass-checkout idempotency. Migration: none (uses existing columns).
- **PROMPT-73 — Dispute parity (P0-2, P1-4)**: sponsor dispute lifecycle +
  recovery + evidence pack; platform-charge dispute flags + policy
  (lost sub dispute → community); `subscriptions.disputed_at` migration
  (V-number: check main at build time — v12/v15 branches also hold V285).
- **PROMPT-74 — Billing correctness (P1-5, P1-6, P2-10, P2-11)**: sub-id guard,
  unknown-price freeze+alert, past_due 14-day read-time grace, stripe-method
  intake gate on downgrade, drop dead pass row.
- **PROMPT-75 — Webhook + Connect robustness (P1-7, P1-8)**: stuck-event
  auto-replay cron + staff alert; Connect health sync (payouts_enabled,
  requirements, disabled_reason) + org banner + graceful checkout 503.
  Migration: organizations columns.
- **PROMPT-76 — /admin/payments console v1**: layout + Overview +
  Transactions + Disputes + Subscriptions verbs (comp/extend-trial/resync;
  cancel-now-with-refund) + Passes verbs (grant/revoke/move) + fold-in of
  billing-events/revenue/coupons/fee.
- **PROMPT-77 — Policy & polish (P2-9, P2-12, P2-13)**: sponsor
  refunded_cents + partial sync; sponsor order cancel/re-send/expire;
  tax decision implementation; pass→Pro credit + refund-policy disclosure
  (quick growth wins from §4).

## 6. Decisions (owner, 2026-07-18)

1. P2-10 post-downgrade card intake: **CLOSE** — stripe-method divisions show
   `payments_unavailable` once the org loses `registration.paid`.
2. Sub-dispute policy: created → staff alert only; **lost → auto-downgrade**
   to community + staff notified.
3. Tax on connected charges: **ToS clause — clubs own their VAT** + VAT-number
   field on sponsor invoices. No Stripe Tax build on destination charges now.
4. Cancel-now prorated refund: **staff-only** /admin goodwill tool. No
   self-serve.
5. /admin/payments fold-in: existing pages move under the new layout with
   redirects from old paths (same pattern as the Payments→Connect rename).

## 7. Pricing decisions (owner, 2026-07-18 addendum)

Executed as Task 14 of the hardening plan — strictly AFTER Task 8's
unknown-price guard (a repriced sub must never silently downgrade) and after
the Pro Plus branch lands (supersedes its D2 annual ×10).

| | Monthly | Annual (≈30% off, never <30%) |
|---|---|---|
| Pro | **$19** / €18 / £15 / A$28 / ₹1,399 | **$159** / €149 / £125 / A$235 / ₹11,499 |
| Pro Plus | $39 / €37 / £33 / A$59 / ₹2,999 (unchanged) | **$327** / €309 / £277 / A$495 / ₹24,999 |

- Event Pass CUT (owner 2026-07-18): **$29** / €29 / £25 / A$45 / ₹1,999.
- Pro AI amendment (amends pro-plus D4): Pro KEEPS `scheduling.ai`, capped
  5 generations/division (new key `scheduling.ai.runs_per_division.max`);
  Pro Plus unlimited; `officials.auto` still moves to Pro Plus per D4.
  Implemented in V287 (this wave merges after pro-plus). Plan Task 15.
- Wave execution: subagent-driven, **opus + xhigh effort** subagents
  (owner override of the sonnet default), auto-start when V286 lands.
- Existing subscribers keep their current price (no forced migration);
  `plans` keeps ONE price id per interval, so old ids resolve through the
  Task 8 plan-preserving guard.
- Sized-based/per-unit pricing REJECTED for now (tiers already size-gate);
  future direction if wanted: add-on packs as subscription line items writing
  `org_entitlement_overrides`.
- Marketing copy flips "2 months free" → "Save 30%" wherever the annual
  toggle renders (4 locales).
