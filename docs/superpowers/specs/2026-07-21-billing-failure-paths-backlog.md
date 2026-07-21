# Billing failure paths — coverage backlog

Opened 2026-07-21 during the Event Pass branch. **Not Event Pass work** — this is
pre-existing subscription-billing coverage. Queued deliberately rather than folded in,
to keep `feat/event-pass-e2e-and-entitlement-gaps` scoped.

Every card number below is a Stripe test card. The repo currently contains exactly one:
`4242424242424242`.

---

## 1. 3DS / `requires_action` — no coverage at all (highest priority)

Three routes return `{ requires_action, client_secret }`:

- `src/app/api/billing/plan/route.ts:12` — in-app plan change
- `src/app/api/billing/interval/route.ts:11` — monthly↔annual switch
- `src/app/api/billing/retry-invoice/route.ts:5` — dunning recovery
- producer: `server/usecases/billing-manage.ts:722-733` (retrieves the invoice with
  `expand: ["confirmation_secret"]` and hands the client secret back)

The only test touching this asserts the **false** branch:

```
src/server/usecases/__tests__/billing-manage-plan.test.ts:190
  expect(result).toEqual({ requires_action: false });
```

Untested: that the client does anything with `client_secret`, that confirmation re-syncs,
that a user who abandons the 3DS challenge is left in a recoverable state.

**Why it matters beyond test hygiene:** SCA makes this the *normal* path for European
cards, and Indian card mandates require it. A silent no-op on `requires_action` looks to
the user like "I clicked upgrade and nothing happened" while Stripe holds an unconfirmed
PaymentIntent.

Cards: `4000002500003155` (3DS required, succeeds), `4000008400001629` (3DS required,
then declines), `4000000000003220` (3DS2 challenge).

## 2. Declined card — server side only, nothing at the UI

Handled and unit-tested server-side:
- `server/usecases/billing-events.ts:442` `invoice.payment_failed`, `:494`
  `payment_intent.payment_failed`
- `lib/__tests__/billing-grace-anchor.test.ts:105` — repeated dunning retries do NOT move
  the grace anchor (the `status_changed_at` guard in `lib/billing.ts:537`)
- `server/usecases/__tests__/sponsor-checkout.test.ts:278` — a pending order fails

Never exercised: a decline at the actual checkout UI. Unknown whether the embedded sheet
recovers, what the buyer is told, and whether a stranded pending row is left behind.

Cards: `4000000000000002` (generic decline), `4000000000009995` (insufficient funds),
`4000000000000069` (expired), `4000000000000127` (wrong CVC).

## 3. Disputes — deliberately webhook-driven; leave as is

`e2e/payments-hardening.spec.ts` T6/T7 drive synthetic signed `charge.dispute.created` /
`.closed` events, including "Event Pass: a lost dispute revokes the pass" (`:678`) and
replay idempotency (`:719`). The real dispute card (`4000000000000259`) is NOT used and
should not be — a real dispute takes days to close, and the webhook IS the integration
surface. Dispute *handling* is proven; dispute *origination* is not, by choice.

---

## 4. DEFECT — a canceled subscription can resolve as Pro — **FIXED 2026-07-21**

Fixed in this branch at the owner's direction (§4 only; §§1-2 and 5 remain queued).
`orgPlanKey` now carries a `canceled` arm, guarded on a running comp; regression suite
`src/lib/__tests__/entitlements-canceled-plan.test.ts` (6 cases). Proof it fails without
the arm: `expected 'pro' to be 'community'` on 2 of the 6.

No data repair was done, deliberately — pre-launch, no customers, and the owner wipes
schema and test data before prod. The 618 already-poisoned rows below are seed data.

Original write-up follows.

**Not hypothetical. Read the code path before dismissing it.**

`orgPlanKey` (`src/lib/entitlements.ts:92-127`) degrades on exactly two arms — a lapsed
`comped_until`, and `status = 'past_due'` older than 14 days. Everything else falls to
`else coalesce(s.plan_key, 'community')`. **There is no arm for `status = 'canceled'`.**

A canceled org resolves as community only because the `customer.subscription.deleted`
handler explicitly writes `plan_key = 'community'` (`billing-events.ts:187`, and the
lost-dispute path at `:404`).

But `syncSubscription` (`lib/billing.ts:502`) writes plan_key from the *price*:

```sql
plan_key = coalesce(${knownPlanKey}, subscriptions.plan_key, 'community')
```

A canceled Stripe subscription still carries its price, so `knownPlanKey = 'pro'`.

**The leak:** `needsRenewalResync` (`lib/billing-manage.ts:367`) returns true for ANY
`past_due` row. So — dunning exhausts, Stripe cancels, the `deleted` webhook is missed
(the self-heal exists *because* webhooks get missed) → the org's row still says
`past_due` → owner opens the billing page → `getBillingOverview` (`billing-manage.ts:132`)
retrieves the live canceled subscription → `syncSubscription` writes
`status = 'canceled'` **and `plan_key = 'pro'`** → the resolver's else arm returns Pro.

And it never self-heals: `needsRenewalResync` returns false for `canceled`
(`billing-manage.ts:368`, asserted at `billing-manage.test.ts:384`). **Free Pro, forever.**

The 14-day grace does not save it — that arm requires `status = 'past_due'`, and the row
is now `canceled`.

Contrast `STATUS_MAP` (`lib/billing.ts:252-261`), which is *correct* here: `unpaid`,
`paused` and `incomplete` all map to `past_due`, so those DO hit the grace arm and degrade
on schedule. The hole is `canceled` specifically.

**Candidate fixes** (pick one, do not do both blindly):
- Add a `when s.status = 'canceled' then 'community'` arm to `orgPlanKey` — makes the
  resolver self-sufficient instead of depending on one webhook handler having run.
- Or have `syncSubscription` force `plan_key = 'community'` when the mapped status is
  `canceled`.

The first is safer: it fixes every row already poisoned, not just future writes.

**Regression test must fail without the fix:** seed `subscriptions` with
`status = 'canceled', plan_key = 'pro'` and assert `orgPlanKey` returns `community`.

## 5. Also worth a look while in here

- `incomplete → past_due` (`STATUS_MAP:257`): a checkout where 3DS was never completed
  gives the org **14 days of full Pro without a successful payment**. Stripe expires it to
  `incomplete_expired` after 23h, which maps to `canceled` — but see §4 for what
  `canceled` currently does. Worth confirming Stripe actually fires
  `customer.subscription.deleted` on `incomplete_expired`; if it does not, nothing writes
  `plan_key = 'community'`.
- `paused → past_due` (`STATUS_MAP:260`): a deliberately paused subscription starts the
  14-day degrade clock. Probably right (no money, no Pro) but it is an unexamined
  consequence of the mapping, not a decision anyone recorded.
- `billing.spec.ts` "full checkout via the Stripe test flow" is skipped and FAILS under
  `E2E_STRIPE_FULL=1` — it hangs on the return URL. ~10 lines using
  `e2e/event-pass.spec.ts`'s recipe (scroll the sheet, wait for settles).
