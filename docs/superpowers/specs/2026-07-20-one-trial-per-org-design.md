# One trial per organisation — closing the leaks

Date: 2026-07-20
Status: design approved, not yet implemented
Branch: `worktree-fix-trial-stamp-and-nav-org`

## Problem

`subscriptions.trial_used_at` (V277) is meant to guarantee that an org gets the
14-day Pro trial exactly once. It does not. The column is stamped in one place
only — `syncSubscription`, and only when the Stripe subscription carries a
`trial_end` — while V277's own backfill treated *any* org that had ever held a
subscription as trial-spent. Code and backfill have disagreed since V277
shipped, and every leak below follows from that gap.

A second, unrelated defect surfaced while enumerating: `assertCheckoutAllowed`
lets an org in dunning open a second checkout.

### Paths to Pro, and what each does to the stamp

| Path | Stamps today | Second trial after downgrade |
|---|---|---|
| Self-serve checkout, first time (14d trial) | yes | no |
| Self-serve checkout, returning (0d) | already stamped | no |
| Staff grant/extend trial | yes (fixed 2026-07-20, commit `f0637762`) | no |
| Staff Comp to Pro | **no** | **yes** |
| Subscription created in the Stripe dashboard, no trial | **no** | **yes** |
| Direct SQL / dev flip | no | yes |
| Event Pass ($29) | n/a — not Pro | n/a |

### Dead state in `extendTrial`

Entitlements resolve on `plan_key` (plus `comped_until` and the past_due grace).
`status` and `trial_end` grant nothing. So "Extend trial +7d" on a Community org
writes `status='trialing'` and `trial_end`, leaves `plan_key='community'`, and
conveys **no Pro at all** — the panel prints "trial ends …" and that string is
the entire effect. Nothing expires on day 7 either, because nothing was granted.

### Verified: `trial_end` on an active paying subscription

Probed against test mode on a $19/mo subscription charged for 20 Jul → 20 Aug:

```
before:  status active    trial_end null        period_end 2026-08-20
update:  trial_end = now + 7d, proration_behavior: "none"
after:   status trialing  trial_end 2026-07-27  period_end 2026-07-27
         invoices: paid 0 subscription_update | paid 1900 subscription_create
         next due: 429 at 2026-07-27
```

Stripe accepts it, but the paid period is **truncated** from 20 Aug to 27 Jul and
the next invoice previews at 429 instead of 1900. (1900 × 7/31 = 429.03, so that
looks like a 7-day proration — the arithmetic is inference, the 429 is Stripe's.)
One run, one configuration; the truncation is unambiguous.

## Design

Read `trial_used_at` as **"this org has already had Pro"**, not "this org ran a
trial", and stamp on every route that grants Pro. The guarantee then has no
exceptions: *an org gets Pro for free exactly once.*

### 1. `syncSubscription` stamps on first sync of any subscription

`trial_used_at = coalesce(subscriptions.trial_used_at, excluded.trial_used_at, now())`.
Closes the dashboard-created / invoice-billed leak. Still never cleared by a
cancel, downgrade, or replay.

### 2. `compToPro` stamps

A comp is free Pro — that is the free ride. Forward-only; see Backfill.

### 3. `extendTrial` — three arms on `stripe_subscription_id` + `status`

| Org state | Behaviour |
|---|---|
| Stripe sub, `trialing` | unchanged: push `trial_end` into Stripe and mirror locally |
| Stripe sub, `active` | **400** — "use a coupon or credit in Stripe". Justified by the probe above |
| No Stripe sub | grant real Pro: `comped_until = trial_end = now + Nd`, stamp `trial_used_at` |

The no-Stripe arm lifts `plan_key` to `'pro'` **only when it is currently
`'community'`** — granting days to an org already comped at `pro_plus` must not
demote it. Expiry rides the existing resolver branch
(`comped_until <= now() and stripe_subscription_id is null → community`), so
there is no job to write and nothing to sweep.

Repeat grants stack, as today: the base is the existing `trial_end` when it is
still in the future, so +7 then +7 lands 14 days out.

### 4. `assertCheckoutAllowed` also 409s on `past_due`

A live `stripe_subscription_id` in dunning can currently mint a *second*
subscription through checkout. Block `trialing`, `active`, and `past_due`; leave
terminal `canceled` allowed.

Caveat to honour in the message: `STATUS_MAP` folds Stripe's `incomplete` into
`past_due`, so an org whose first payment never confirmed lands here too. The
409 must point at retry-invoice / update-card (both already exist) so the state
is recoverable rather than a lockout.

### 5. Admin "Restore trial"

Clears `trial_used_at`. Reason required, `logStaffAction` audited, same shape as
the other panel actions. Without an undo, staff reach for raw SQL the first time
a comp turns into a real deal.

### 6. Backfill: none

Pre-launch, so there are no production trials to repair. V303 was written,
verified (gap 16 → 0 in a rolled-back transaction) and then dropped in commit
`8bd78ec0`. This work ships **no migration**.

## Pro Plus

Already correct. Pro → Pro Plus never touches checkout: `applyPlanChange` calls
`subscriptions.update` with a pinned proration date, then `syncSubscription`,
whose coalesce keeps the existing stamp. A Community org clicking "Go Pro Plus"
gets the 14-day trial, since `checkoutTrialDays` is plan-agnostic. The stamp is
per-org, not per-plan, so an org that trials Pro cannot later trial Pro Plus —
which is what "one trial per organisation" means.

## Testing

- `admin-plan.test.ts` — grant on a Community org resolves Pro immediately;
  lapses to community once `comped_until` passes; a grant on a comped `pro_plus`
  org does not demote it; the `active` Stripe arm 400s.
- `billing-checkout.test.ts` — `assertCheckoutAllowed` 409s on `past_due`,
  allows `canceled`, allows a null subscription id.
- `billing-sync-trial.test.ts` — a subscription with no `trial_end` still stamps
  on first sync; a replay does not re-date the stamp.
- New DB-backed test for Restore trial: clears the stamp, writes an audit row,
  and a subsequent `checkoutTrialDays` returns 14.
- No e2e — every path here is server-side and admin-only.

## Out of scope

- "Skip the trial, bill me now" for first-time buyers. Today the billing page
  renders one CTA and `checkoutTrialDays` returns 14 whenever the stamp is null,
  so an org that wants to pay from day one cannot. Real gap, separate feature.
- Comp to `pro_plus` — staff can only comp `pro`.
- `extendTrial` leaves `plan_key` untouched on Stripe orgs by design; the
  Community dead state is what item 3 fixes.
