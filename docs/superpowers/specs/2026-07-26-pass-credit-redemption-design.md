# Event Pass → Pro credit: redemption model

Status: design agreed 2026-07-26. Supersedes the v3/07 D12 behaviour described
in `apps/web/src/server/usecases/pass-credit.ts`.

## Why

The credit is minted when a Pro/Pro Plus checkout is **opened**, not when a
subscription **starts** (`api/billing/checkout/route.ts:78`). Three defects fall
out of that single choice. All three were reproduced against live Stripe (test
mode) on 2026-07-25/26, not inferred:

| Defect | Evidence |
| --- | --- |
| Credits stack without limit | two passes → `credited/-5000/2` — balance −£50, two balance transactions |
| Credit never expires | the 30-day window is read only at mint (`pass-credit.ts:214`); nothing re-checks it, and Stripe never expires a customer balance |
| Credit survives a pass refund | `charge.refunded` revokes the pass and claws back the 25 AI credits (`lib/billing.ts:854-882`) but never touches the £ balance |

The stacking case is the expensive one: five passes is £125 of credit — a free
year of Pro — while the org keeps five competitions permanently upgraded.

The refund case is not exotic. A pass upgrades ONE competition; Pro upgrades
everything, so "I bought a pass last week and just went Pro, can I have the
pass money back?" is an ordinary support request. Granting it today returns £25
cash on top of £25 already returned as credit, and the refund looks clean to
support because the org is on Pro and loses nothing visible.

## Product decisions

1. **The credit is a redemption, not a discount.** Buying a pass and then
   subscribing means the pass money comes back as subscription credit. It is
   the refund.
2. **Minted at subscription start**, not at checkout open.
3. **One pass credit per billing group, ever.** Per group, not per org: a group
   is one Stripe customer, and a per-org cap would let a group collect £25 per
   org it adds.
4. **A redeemed pass is still refundable**, but through an admin action that
   refunds the right amount — not a blind Dashboard refund.
5. **No expiry job.** Minting at subscription start makes the existing 30-day
   window mean what the marketing already says: subscribe within 30 days of
   buying the pass, or the pass earns nothing.

## Design

### 1. Move the grant to subscription start

`creditPassTowardSubscription` moves out of `POST /api/billing/checkout` and
into the subscription-created path in `server/usecases/billing-events.ts`.

It must hang off **both** arms that learn a subscription started, not just the
webhook: `checkout.session.completed` / `customer.subscription.created`, and the
reconcile-on-return path the billing page uses when no webhook arrives. Wiring
only the webhook would silently drop the credit in exactly the environments
where webhooks are not configured. The redemption row makes this safe — whichever
arm runs first wins, and the second is a no-op on the unique constraint.

Consequences, all wanted:

- an abandoned checkout mints nothing, so there is no orphan credit sitting on
  a Community org and no stale "pays future invoices automatically" line
- `netPaidForIntent` re-reads Stripe at redemption time, so a pass refunded
  before the org subscribes yields nothing, with no new code
- the 30-day window now gates subscribing

Ordering risk, measured rather than assumed: the credit must land before the
first invoice is drawn. On the trial path — the majority, and the default for a
first-time org — completion is 14 days ahead of invoice #1, so there is no
contest.

On the spent-trial (no-trial) path this IS a real behaviour change, not a
neutral one. Today the grant runs before the checkout session is even created,
so the credit already sits on the customer when Checkout collects invoice #1.
Under this design the grant runs from the subscription-created webhook /
reconcile-on-return, both of which fire AFTER the session has completed — and a
no-trial Checkout Session creates and pays its first invoice as part of
completing the session, before either hook can run. So for this path the credit
now lands one invoice later than it used to: invoice #1 is paid at full price,
and the credit reduces invoice #2 instead. No money is lost, and we already
verified (2026-07-25) that Checkout never showed a discount on `amount_total`
for this path anyway, so nothing visible at the checkout step changes — only
which invoice the credit first appears on.

This only bites the minority of buyers who have already spent their one trial
before buying a pass and upgrading — checkoutTrialDays() gives every
first-time org (the common pass-buyer) the 14-day path, where there is no
regression at all. Acceptable, but state it plainly rather than claim nothing
changed; task 2's implementation must add a live test pinning WHERE the credit
lands on the no-trial path under the new timing, not assume it.

`orgHoldsAnyPass` / `requireCard` stay in the checkout route. That gate is about
collecting a card during a trial and is unrelated to when money is credited.

### 2. Durable local record

`pass-credit.ts:32` states that the Stripe balance-transaction metadata is the
ONLY record and nothing is written locally. That was sufficient for "once per
pass intent". It cannot carry a lifetime cap (the `alreadyCredited` scan is
bounded to 1000 transactions and `created >= purchased_at`, and fails closed),
and support cannot see it.

New table, group-keyed:

```
pass_credit_redemptions
  subscription_id   uuid  not null references subscriptions(id)  -- the GROUP
  org_id            uuid  not null   -- which org earned it
  competition_id    uuid  not null
  payment_intent    text  not null unique
  amount_minor      int   not null
  currency          text  not null
  redeemed_at       timestamptz not null default now()
  reversed_at       timestamptz
  reversed_minor    int
```

`unique (subscription_id) where reversed_at is null` enforces the cap in the
database rather than in a Stripe scan. The row survives deletion of the
`competition_passes` row, which is what makes the refund path work at all.

### 3. Stamp the pass PaymentIntent

Support refunds in the Stripe Dashboard, so the warning has to live on the
object they are looking at. On redemption, update the pass PaymentIntent:

- `metadata.redeemed_as_account_credit = <ISO date>`
- `metadata.redeemed_amount_minor`, `metadata.redeemed_subscription_id`
- description suffix: `— redeemed as account credit`

Best-effort: a failed stamp must not fail the redemption.

### 4. Admin pass refund

New action on `/admin/orgs/[id]`, next to the existing plan levers. Computes:

```
consumed   = redeemed amount − unspent credit still on the customer
cash_back  = pass paid − consumed
```

- credit untouched → refund the full pass, reverse the whole credit
- partly consumed → refund the remainder, reverse only the unspent part
- fully consumed → refund nothing; the money already came back as Pro

Then revokes the pass through the existing `revokePassForRefundedCharge` path
(which also claws back the 25 AI credits), writes `reversed_at`, and audits via
`logStaffAction`. Refuses when a refund already exists for the intent.

### 5. Webhook backstop

Dashboard refunds cannot be prevented, so `charge.refunded` keeps working and
gains one step: if a `pass_credit_redemptions` row exists for the intent,
reverse the **unspent** portion with a positive balance transaction, idempotent
on `pass-credit-reversal-${intent}`. Never push the customer into debt — the
consumed portion is absorbed and raises a staff alert, matching the rule
`recordPackRefund` already follows for the AI wallet.

### 6. Copy — the cap must be stated wherever the credit is promised

A lifetime, per-group cap is a term of the offer. Today no surface says it, and
two of them actively imply the opposite ("in full", with no mention of how many
times). Every place that promises the credit states the limit:

| Surface | File | Change |
| --- | --- | --- |
| Event Pass help — "Does the pass count toward Pro?" | `content/help/billing/event-pass.md:63` | add: one pass credit per billing group, ever; the deadline is **subscribing** within 30 days of buying the pass, not opening a checkout |
| Billing groups help | `content/help/billing/groups.md` | the cap is per group, so orgs sharing a subscription share the one credit |
| Upgrade-moment paywall | `components/upgrade-gate.tsx:68` (`creditLine`) | same sentence, same limit |
| Competition upgrade page | dict key `upgrade.credit`, rendered at `c/[compSlug]/upgrade/page.tsx:598` | same |
| Billing page credit line | dict key `billing.credit` | stop promising "future invoices" unconditionally — it renders on `isPayer && creditMinor > 0` (`settings/billing/page.tsx:299`) with no subscription check |

Note `creditLine` in `upgrade-gate.tsx` is a hardcoded English template literal,
not a dict key — unlike the upgrade page beside it. Either it gains a key or it
stays hardcoded, but it must not drift from `upgrade.credit`; a test should pin
the two together.

Every user-facing string here ships in all four locales (en/es/fr/nl), with
`gen-keys` + `i18n:check` clean.

## Phasing

Two shippable units. Phase 1 stops the bleeding and is worth merging alone:

- **Phase 1 — the money model.** §1 grant timing, §2 redemption table, §5
  webhook backstop, §6 copy. Closes stacking, the forever-credit and the
  blind-Dashboard-refund leak.
- **Phase 2 — the staff tool.** §3 PaymentIntent stamp and §4 the admin refund
  action. Depends on the Phase 1 table; without it there is nothing to compute
  a refund against.

## Testing

Red first, in this order:

1. two passes on one group → one credit, balance −£25 not −£50
   (`pass-credit-stack.live.test.ts`, currently red by construction)
2. abandoned checkout mints nothing — customer balance 0
3. subscription start mints exactly once; a second subscription start does not
   re-mint
4. pass refunded after partial consumption → unspent reversed, consumed absorbed,
   customer never in debt
5. admin refund arithmetic across the three cases (untouched / partial / fully
   consumed)
6. the existing live suites on this branch keep passing unchanged — they encode
   what Stripe does with the balance, which this design does not alter

Live suites run against Stripe test mode with `BILLING_LIVE=1`; the trial-path
timing is already covered end to end by `pass-credit-clock.live.test.ts`.

## Out of scope

- expiry of unspent credits (no job; the 30-day window now does this job)
- refund UI for organisers — pass refunds stay staff-only
- anything about the 25 AI credits, which already claw back correctly
