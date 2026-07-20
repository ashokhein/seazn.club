# One trial per organisation — closing the leaks, plus checkout presentation

Date: 2026-07-20
Status: design approved, not yet implemented
Branch: `worktree-fix-trial-stamp-and-nav-org`

Items 1–6 close the trial-stamping leaks. Items 7–8 are the checkout surface —
folded in here at the user's request because they touch the same two builders in
`lib/billing.ts` and the same billing page.

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

### 3. `extendTrial` — arms on *live* subscription + status

**The branch key is not `stripe_subscription_id` alone.** A cancelled
subscription keeps its id on the row forever, so keying off the column would send
a long-departed customer down the Stripe arm and call `subscriptions.update` on a
dead subscription. The org counts as Stripe-billed only when
`stripe_subscription_id is not null AND status in ('trialing','active','past_due')`
— the same liveness test item 4 uses. Factor it into one shared predicate so the
two cannot drift.

| Org state | Behaviour |
|---|---|
| Live sub, `trialing` | unchanged: push `trial_end` into Stripe and mirror locally |
| Live sub, `active` | **400** — "use a coupon or credit in Stripe". Justified by the probe above |
| Live sub, `past_due` | **400**, same reason — the subscription owns the billing timeline, and pushing `trial_end` onto a dunning sub muddles the grace window that `status_changed_at` anchors |
| No live sub (incl. `canceled` with a stale id) | grant real Pro: `comped_until = trial_end = now + Nd`, stamp `trial_used_at` |

The 400 arms must write **nothing** — no local row update, no Stripe call. A
partial write here is the expensive failure, so the guard runs before both.

**The non-live arm must not fake liveness.** Writing `status = 'trialing'`
unconditionally is wrong: on a departed org (cancelled subscription, stale id)
the row then satisfies the liveness rule itself, which (a) stops the
comp-expiry branch below from ever firing, so the grant runs forever, (b) sends
the NEXT grant down the Stripe arm against a dead subscription, and (c) makes
`assertCheckoutAllowed` 409 the org out of ever buying. Set the status only when
there is no subscription id at all — a cancelled status must stand:
`status = case when stripe_subscription_id is null then 'trialing' else status end`
(and gate `status_changed_at` the same way). Corrected 2026-07-20 during
implementation, after the original spec text reintroduced the very hole the
next paragraph exists to close.

**The grant must be able to expire.** The resolver's comp-expiry branch reads
`comped_until <= now() **and s.stripe_subscription_id is null**`. A cancelled
subscription keeps its id, so granting days to a departed customer would produce
a `comped_until` that never fires — free Pro forever. Widen that branch to
`(s.stripe_subscription_id is null or s.status = 'canceled')`. It is a pure
addition to the existing `case`, but it sits in the cached entitlement hot path,
so it needs its own test at the boundary.

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

### 7. Checkout branding

Verified against test mode on 2026-06-24.dahlia: Checkout Sessions accept
`branding_settings`, and this account has set no branding at all
(`{"icon":null,"logo":null,"primary_color":null,"secondary_color":null}`), which
is why checkout renders Stripe defaults today. Accepted and echoed back:

```js
branding_settings: {
  background_color: "#150b36",   // hex
  button_color:     "#a3e635",   // hex
  border_style:     "rounded",   // rounded | rectangular | pill
  font_family:      "inter",
  display_name:     "Seazn Club",
  icon: null, logo: null,        // Stripe File ids, uploaded separately
}
```

Set it in `buildEmbeddedCheckoutParams` **and** `buildPassCheckoutParams`, so the
Event Pass matches — code is versioned and cannot drift between test and live the
way Dashboard branding can. Both builders are pure, so the block is unit-testable
alongside the existing param assertions.

Two constraints on record:

- `font_family` is a fixed list of 25 (`default, be_vietnam_pro, bitter,
  chakra_petch, hahmlet, inconsolata, inter, lato, lora, m_plus_1_code,
  montserrat, noto_sans_jp, noto_sans, noto_serif, nunito, open_sans, pridi,
  pt_sans, pt_serif, raleway, roboto, roboto_slab, source_sans_pro,
  titillium_web, ubuntu_mono, zen_maru_gothic`). **Barlow Condensed is not
  available**, so checkout cannot match the brand type; `inter` is the closest
  neutral.
- It is a token set, not CSS — colours, radius, font, logo. No layout or spacing
  control. Full control would need `ui_mode: "elements"` (the API reports
  `custom` as retired: *"The ui_mode value `custom` is no longer supported. Use
  `elements` instead"*), which means owning the payment UI. Rejected as
  disproportionate.

### 8. Embedded checkout in a modal

No Stripe constraint — `<EmbeddedCheckoutProvider>` + `<EmbeddedCheckout />`
mount inside a dialog. Reuse `apps/web/src/components/modal.tsx` rather than
adding a primitive. Three things to get right:

- the Stripe iframe self-resizes, so the modal needs a flexible height, not a
  fixed one;
- the provider must not remount on re-render, or the session restarts — keep
  `clientSecret` above the modal and mount the provider once it resolves, which
  is the pattern `billing-actions.tsx` already uses;
- full-screen at 375px; the mobile e2e gate runs at 375×667 and 390×844.

**Visual sign-off gate:** items 7–8 change how a paid surface looks, so build
them, screenshot inline vs modal at 1440×900 and 375×667, and get the user's pick
before merging. Do not choose the palette unilaterally.

## Pro Plus

Already correct. Pro → Pro Plus never touches checkout: `applyPlanChange` calls
`subscriptions.update` with a pinned proration date, then `syncSubscription`,
whose coalesce keeps the existing stamp. A Community org clicking "Go Pro Plus"
gets the 14-day trial, since `checkoutTrialDays` is plan-agnostic. The stamp is
per-org, not per-plan, so an org that trials Pro cannot later trial Pro Plus —
which is what "one trial per organisation" means.

## Testing

The invariant under test is one sentence: **an org gets Pro for free exactly
once, and only a staff member with a reason can give it back.** Every case below
is a way that sentence could be false.

### Stamping — `billing-sync-trial.test.ts` (DB-backed)

1. Subscription with **no** `trial_end` stamps on first sync — the
   dashboard-created / invoice-billed leak. *Fails today.*
2. Replaying the same event does not re-date an existing stamp.
3. A later trialing sync over an existing stamp keeps the **original** date.
4. Cancel → resync leaves the stamp intact.
5. A **re-buy** (new `stripe_subscription_id`) clears `disputed_at`/`dispute_id`
   as designed but must **not** clear `trial_used_at` — the two live in the same
   upsert, so one careless `excluded.` reference breaks it.
6. Unknown price (plan drift) still stamps — the plan-key coalesce must not
   short-circuit the stamp.

### `compToPro` / `adminDowngrade` — `admin-plan.test.ts` (DB-backed)

7. `compToPro` stamps; a second comp does not re-date it.
8. comp → `adminDowngrade` → `checkoutTrialDays` returns **0**. This is the
   user-reported symptom; it must be 0, not 14.

### `extendTrial` — `admin-plan.test.ts` (DB-backed)

9. Community org: `plan_key` becomes `pro`, `comped_until` and `trial_end` both
   land at now+N, stamp set, and `hasFeature(orgId, "api.access")` is true
   immediately.
10. Clock-controlled lapse: write a past `comped_until`, invalidate, and the org
    resolves community again — proving the grant self-expires with no job.
11. Two grants stack from the existing future `trial_end` (+7 then +7 = 14 days
    out), `comped_until` tracks `trial_end`, and the stamp keeps its first date.
12. Grant on an org comped at `pro_plus` does **not** demote it to `pro`; the
    window still extends.
13. **Stale-id loophole:** `stripe_subscription_id` set but `status='canceled'`
    takes the *local grant* arm — no Stripe call. Assert the Stripe mock was
    never invoked.
14. Live `trialing` sub: Stripe updated, `comped_until` left null, `plan_key`
    untouched.
15. Live `active` sub: 400, **and** assert the row is byte-identical afterwards
    and the Stripe mock was never called.
16. Live `past_due` sub: same 400, same no-write assertions.
17. Day bounds still enforced: 0 and 366 both 400.

### `assertCheckoutAllowed` — `billing-checkout.test.ts` (pure)

18. `past_due` + live id → 409. *Fails today.*
19. `canceled` + id → allowed (a departed customer must be able to return).
20. `active` and `trialing` + id → 409 (existing behaviour, keep pinned).
21. Null `stripe_subscription_id` → allowed at every status, including
    `past_due` — a comped org degraded by the grace window must not be locked out
    of its first purchase.
22. The 409 message names the recovery path (retry invoice / update card), so the
    `incomplete → past_due` folding is not a dead end.

### Restore trial — new DB-backed test + route test

23. Clears the stamp; a following `checkoutTrialDays` returns 14.
24. Writes a `staff_audit_log` row carrying the reason.
25. Empty reason → 400.
26. Non-staff caller → 403 (route level).
27. Restore → `extendTrial` re-stamps, so the hatch is not a permanent bypass.

### Branding — `billing-checkout.test.ts` (pure)

28. Both `buildEmbeddedCheckoutParams` and `buildPassCheckoutParams` carry the
    `branding_settings` block.
29. `font_family` is asserted against the allowed-value list, so a typo fails a
    unit test rather than a live checkout.
30. Existing assertions still hold with branding present — `trialDays: 0` emits
    no trial block and no `payment_method_collection`, `trialDays: 14` emits both.

### Modal — e2e

31. Upgrade opens a `role="dialog"` / `aria-modal` container with the Stripe
    iframe inside it.
32. Dismiss and reopen mounts a working checkout again — guards the
    remount-restarts-the-session trap.
33. `expectNoHorizontalScroll` at 375×667, per the existing mobile gate.

### Known, accepted

A TOCTOU window remains between `assertCheckoutAllowed` and the Stripe call: two
tabs racing can still mint two subscriptions. Same class as the AI run-cap race
and accepted on the same grounds; closing it needs a row lock or an idempotency
key on session creation, which is its own piece of work.

## Out of scope

- Pre-creating the Stripe **customer** at org signup. Explored and dropped: it
  would fix the null-`stripe_customer_id` dead ends (portal 400s, address/tax-id
  rails bail), but it mints junk customers for every org that never buys. If
  revisited, create lazily on first visit to a billing surface, not at signup.
- "Skip the trial, bill me now" for first-time buyers. Today the billing page
  renders one CTA and `checkoutTrialDays` returns 14 whenever the stamp is null,
  so an org that wants to pay from day one cannot. Real gap, separate feature.
- Comp to `pro_plus` — staff can only comp `pro`.
- `extendTrial` leaves `plan_key` untouched on Stripe orgs by design; the
  Community dead state is what item 3 fixes.
