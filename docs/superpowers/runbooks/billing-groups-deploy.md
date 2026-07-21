# Deploying billing groups (V310)

Branch `feat/billing-groups`. Spec: `docs/superpowers/specs/2026-07-21-billing-groups-design.md`.

This one has an ordering trap in it. Read §2 before touching anything.

## 1. What ships

- **V310** (`db/migration/deltas/V310__billing_groups.sql`) — `subscriptions` stops being
  keyed by org. It gains `owner_user_id`, `quantity_paid` and its own identity; `organizations`
  gains `subscription_id`; `subscriptions.org_id` is dropped. The subscription row IS the
  billing group. No new table, so `comped_until`, the 14-day `past_due` grace and
  `trial_used_at` keep working untouched. Backfills the payer from `org_members` (owner),
  falling back to `organizations.created_by`.
- **Stripe Connect is untouched.** `organizations.stripe_account_id` stays per-org. Grouping
  who pays for the software moves no money into or out of anybody's bank account. If anything
  in a deploy step appears to touch Connect, stop — it is the wrong step.
- New routes: `POST /api/billing/group/attach`, `/detach`, `/transfer`, `/transfer/accept`,
  `/transfer/revoke`, and `POST /api/cron/billing-quantity`.
- Tiered prices in `apps/web/src/config/stripe-plans.json` — graduated, tier 1 at the plan
  rate, tier 2+ at half. `quantity` is the org count.

## 2. The ordering trap: existing subscribers are on a flat price

`scripts/stripe-sync.ts` never mutates a live price (Stripe forbids it) — it mints a
REPLACEMENT and archives the old one. **Existing subscriptions keep their original price id
on purpose**, so nobody is repriced mid-term. That is correct, and it means:

> Every customer who subscribed before this deploy is on a `per_unit` price, which bills
> `quantity x base`. A graduated price bills tier 1 + half for the rest. They are different
> amounts, and Stripe will happily charge the wrong one.

`assertPriceBillsQuantity` (`apps/web/src/lib/billing.ts:50`) is the guard: any attempt to put
quantity > 1 on a non-tiered price throws a 503 naming the group, rather than silently
charging full rate for every extra org. So the failure mode after deploy is **an existing
paying customer cannot add a second organisation** and gets a "contact support" message.

That is the deliberate, safe outcome — not a bug to patch under pressure. Migrating those
subscriptions onto the tiered price is a separate, deliberate operation per customer, and it
reprices them, so it needs their agreement first. Greenfield today: verify against real data
before assuming there are none.

## 3. Order of operations

1. **Migrate the database.** `npm run db:apply` (Flyway, incremental). V310 is additive then
   destructive in one file — it drops `subscriptions.org_id` at the end, so the app must not
   be running old code against it afterwards.
2. **Deploy the app.** Old code reads `subscriptions.org_id`, which no longer exists. Keep the
   gap between steps 1 and 2 short.
3. **Sync Stripe prices**, once per environment, pointing explicitly at that environment:
   ```
   node --env-file=apps/web/.env.local --experimental-strip-types scripts/stripe-sync.ts
   ```
   Idempotent — prices are matched by `lookup_key`, so re-running never duplicates. **This
   mutates a real Stripe account.** Never run it from an agent session, and never against prod
   from a machine whose `.env.local` you have not just read.
4. **Set `CRON_SECRET`** if it is not already set (it is shared with `/api/funnel/remind` and
   `/api/internal/revalidate`), and schedule the sweep — see §4.
5. **Smoke the group path** — see §5.

## 4. Schedule the reconcile sweep

`POST /api/cron/billing-quantity`, header `x-cron-secret: $CRON_SECRET`. Daily is enough.

**This is not optional.** Stripe cuts every renewal invoice from the subscription item's own
quantity and reads nothing from our database at cycle time, so a drift that is never corrected
over-bills or under-bills for ever. Drift is silent by nature: an attach or detach whose sync
failed, an org created into a paid group during a Stripe outage, a renewal whose sync threw.
Nothing raises anything a person would see.

Idempotent — it writes only where Stripe and the org count actually disagree — so a missed run
costs nothing and a double run costs nothing.

Two ways to schedule it, neither yet committed; pick one:

- **GitHub Actions**, copying `.github/workflows/funnel-reminders.yml` exactly (it already
  handles the missing-secret skip and fails loud on non-200). Change the schedule to daily and
  the path to `/api/cron/billing-quantity`.
- **An external scheduler**, which is how `/api/cron/billing-events` and
  `/api/cron/registrations` are already driven — neither has a workflow in this repo.

Whichever, the secret has to be set in BOTH places:

```
gh secret set CRON_SECRET                                # the scheduler
flyctl secrets set -c fly.stg.toml CRON_SECRET=<same>    # the app
```

Watch the response. `{ checked, corrected, failed }` — a steady non-zero `corrected` means
something upstream is failing its sync and the sweep is papering over it. A non-zero `failed`
names each group in the logs.

## 5. Verify after deploy

- A group holding one org bills exactly what it did before. Check an invoice, not a page.
- Attach a second org: bill goes up by half the plan rate, prorated; the second org's plan,
  limits and entry-fee rate change immediately.
- Detach it: no credit, no refund, the item quantity comes down, next invoice is the smaller
  one. Re-attaching inside the same period charges nothing.
- An existing pre-deploy subscriber attaching a second org gets the 503 from §2. Confirm the
  message names support and the log line names the group.
- `POST /api/cron/billing-quantity` with a wrong secret → 401; with none configured → 503.

## 6. Rollback

V310 drops `subscriptions.org_id`; there is no down migration. Rolling the APP back without
rolling the database back does not work. If the app must come back, restore the database from
the pre-migration snapshot — take one at step 1 and confirm it exists before running Flyway.

Stripe prices do not roll back either: archived prices stay archived, and existing
subscriptions were never moved, so a rollback leaves the price catalogue ahead of the app.
That is harmless — the catalogue is read by lookup key — but re-running `stripe-sync` after a
rollback will mint replacements again. Don't.
