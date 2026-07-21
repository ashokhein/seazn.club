# Billing groups — one subscription, many organisations

Date: 2026-07-21
Status: design approved, BLOCKED on a dependency — see Sequencing
Branch: `feat/billing-groups`
Depends on: `feat/event-pass-e2e-and-entitlement-gaps` (f223cbfb)

Billing moves off the org and onto a shared group priced by how many orgs it
holds. Stripe Connect stays exactly where it is. Greenfield — no data backfill,
but still a numbered Flyway delta.

## Sequencing — read this first

A concurrent session on `feat/event-pass-e2e-and-entitlement-gaps` is rewriting
the same substrate. It is not adjacent work; it is underneath this. Implementing
against `origin/main` would conflict in the two most delicate files in the change
and would miss two mechanisms entirely.

| Their change | Effect here |
|---|---|
| `V306`, `V307`, `V308` claimed | This spec's migration becomes **V309** |
| `V306__entitlement_resolver_parity.sql` — a `security definer` SQL `org_has_feature(uuid, text, uuid)` mirroring the TS resolver | The org → subscription join must be made **twice**, in TS and in SQL, or `entitlements-sql-parity.test.ts` fails |
| `public_players_v` and `server/public-site/data.ts` call `org_has_feature` | Public pages read entitlements through the SQL resolver, so grouping reaches the public site — not covered below before this was found |
| `assertMayOwnAnotherOrg` rewritten and exported, now calling `getLimit` per owned org | Directly conflicts with the "cap becomes a group property" simplification, over freshly-reasoned code that documents a deliberate behaviour change about lowering overrides |
| `scripts/smoke.ts` +250 lines | Both changes extend the same script |
| `V308` — Event Pass grants player profiles | Pass matrix changed; the E3 reasoning below must be re-checked against it |

**Do not start implementation until that branch merges.** Then rebase, re-read
the resolver in both languages, and revise the Entitlement resolution section
before writing code. The design decisions in this document stand; the
implementation surface described in it is measurably out of date.

## Problem

`subscriptions` is keyed by `org_id` (V023), so every org carries its own
subscription, its own Stripe customer and its own card. `organizations.
stripe_account_id` (V021) makes Connect per-org too.

The pricing page renders `orgs.max_owned` as a plan benefit — "Organisations you
can create: 1 / 3 / ∞" (`lib/pricing-matrix.ts:61`,
`dictionaries/en/marketing.json:109`). A customer reads that as "pay $19 for Pro,
run three orgs." In fact orgs two and three are born `community`
(`lib/auth.ts:243`) and each needs its own $19 subscription. The advertised
benefit is really "permission to create two more free-tier orgs you must then pay
for separately."

The cap is also inverted. `assertMayOwnAnotherOrg` (`lib/auth.ts:192-219`) gates
*creation* of orgs that would each pay us; a Pro customer wanting a fourth paying
org gets a 402.

### Why anyone makes a second org

Not features — money separation. One org is one Connect account is one bank
account. Two clubs sharing an org cannot split entry-fee payouts to two
treasurers. So the second org exists for a *payout* reason, and charging a second
full software subscription for what is really a bank-account boundary is the part
that reads as a rip-off.

Stripe forces per-org Connect (separate legal entity, separate KYC). It does not
force per-org subscriptions. That part is a commercial choice, and this changes
it.

V309 (`community_branding_and_paid_registration`, the concurrent repackaging)
sharpens this considerably. Entry fees are now free for everyone at a
`registration.fee_percent` ladder of **community 8 / pass 5 / pro 2 / pro plus
1**, so a *community* org now has a real payout relationship and a real Connect
account. The pressure to hold a second org therefore reaches the free tier — and
free is capped at one org, so a volunteer running two clubs with two treasurers
must now buy Pro for a reason that has nothing to do with features. That is a
legitimate conversion path, but the 402 copy has to be honest about why.

## The model

`subscriptions` stops being keyed by org and becomes the billing group itself.
Orgs point at it. No new table.

```sql
-- V309: the subscription gains its own identity
-- (V306-V308 are claimed by feat/event-pass-e2e-and-entitlement-gaps)
subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  owner_user_id          uuid not null references users(id),
  plan_key               text not null references plans(key) default 'community',
  status                 text not null default 'active',
  currency               text,
  stripe_customer_id     text,
  stripe_subscription_id text,
  trial_used_at          timestamptz,
  comped_until           timestamptz,
  current_period_end     timestamptz,
  status_changed_at      timestamptz,
  cancel_at_period_end   boolean not null default false,
  quantity_paid          integer not null default 1,
  updated_at             timestamptz not null default now()
)

alter table organizations
  add column subscription_id uuid references subscriptions(id);
create index organizations_subscription_idx on organizations(subscription_id);
```

`quantity_paid` is the only genuinely new column: it records what Stripe has
already been billed for this period, so a removed org's slot stays usable until
renewal (see Pricing).

Every `where org_id = $1` in `lib/billing.ts` and
`server/usecases/billing-manage.ts` becomes `where id = $1` after an
org → subscription lookup. Mechanical. All existing trial, dunning, proration and
grace logic survives untouched.

### One payer, always

A group has exactly one payer, one card, one invoice. What grouping decouples is
*membership* from payment — the payer need not belong to the orgs they fund — not
payment from itself. "Unified bill" and "this org pays its share" are mutually
exclusive, because a subscription charges one payment method.

An org inside a group therefore cannot contribute or pay its slice. To pay for
itself it detaches. Splitting one Stripe invoice between payers is a payments
product and is not built.

Worked example, eight clubs under a county association:

| Arrangement | Invoices | Total/month |
|---|---|---|
| Association funds all eight — Pro Plus, $39 + 7 × $19 | 1 | $172 |
| Every club pays for itself — 8 × Pro at $19 | 8 | $152 |

The gap is the consolidation discount, and it is the same reason detach costs
full price.

### Grouping re-rates the platform fee, not just the bill

This is new since V309 and is the strongest argument for the whole feature.
`registration.fee_percent` resolves from the *group's* plan, so attaching an org
moves its entry-fee cut immediately:

| Org's group | Fee on entries |
|---|---|
| Its own community group | 8% |
| Held by a Pro group | 2% |
| Held by a Pro Plus group | 1% |

So "add a club to your group" is not only "+$9/month", it is also
**"that club's platform fee drops from 8% to 1%"** — a concrete, computable
saving, and the line the attach UI should lead with.

It also makes the federation decision arithmetic rather than taste. Eight clubs
on Pro Plus annually cost $327 + 7 x $163 = **$1,468/year** and pay 1%; the same
eight as separate community orgs cost nothing and pay 8%. The 7-point spread
covers the subscription at roughly **$21,000 of annual entries across the group**
— about $2,600 per club. Below that, staying free and paying the fee is genuinely
cheaper for the customer; above it, grouping wins. Worth saying plainly rather
than hiding, because a federation will work it out anyway.

### Why an extra org is priced per plan

An extra org is **half the plan's base price** — Pro +$9, Pro Plus +$19 (annual
+$79 and +$163). One rule, and it is explainable in a sentence.

The reason it is not a flat $9 everywhere is that after V309 an org slot no
longer buys only software: it also buys a FEE RATE, which is most of what Pro
Plus sells. At a flat $9 a club wanting 1% could buy a slot in someone's Pro Plus
group for $108/year instead of the $468 the tier costs — the same rate, 2.5x
cheaper — and a reseller could sell slots at $20/month, undercutting the tier and
pocketing the difference while the platform gave up seven points of fee on every
entry those clubs took.

Half-price closes most of that. Everything below is in USD — the plan prices are
set in USD and mixing currencies in one comparison makes the break-even read
wrong, which is the standing reason this project prefers currency consistency
over localisation.

A club taking $10,000 of entries a year and wanting the 1% rate:

| Route | Subscription | Fee | Total/year |
|---|---|---|---|
| Own Pro Plus | $468 | $100 | **$568** |
| Group slot at the old flat $9 | $108 | $100 | **$208** |
| Group slot at half price ($19) | $228 | $100 | **$328** |

The gap closes from 2.7x to 1.7x. At $100,000 of entries, owning Pro Plus is
$1,468 against $1,228 as a group slot — within $240, so there is nothing left
worth engineering around. The consolidation discount survives; the arbitrage does
not.

## Pricing

Stripe **graduated tiered price**, one price id per plan per interval. Tier 1 is
the plan base; tiers 2+ are half of it — Pro $9/month and $79/year, Pro Plus
$19/month and $163/year. The table below uses Pro.

| Orgs in group | Stripe computes | Pro/month | Pro/year |
|---|---|---|---|
| 1 | tier 1 | $19 | $159 |
| 2 | tier 1 + tier 2 | $28 | $238 |
| 3 | tier 1 + 2 × tier 2 | $37 | $317 |
| 3 → remove one | tier 1 + tier 2 | $28 | $238 |
| 2 → remove one | tier 1 | $19 | $159 |

**No org is ever flagged as "the extra one."** Quantity is a count. Had we pinned
a $19 price to org A and a $9 price to org B, deleting A would strand B on the
extra-org rate for ever — a sole org quietly paying $9 and $10/month lost. With a
count, removing either org from a pair returns the bill to $19.

`stripe-plans.json` gains the tier structure; `npm run stripe:sync` must be re-run
against test and prod. Community is unchanged and still has no Stripe product.

### Stripe mechanics that are not obvious

Found while implementing; each one silently produces wrong money if missed.

- **`unit_amount` and `billing_scheme: tiered` are mutually exclusive.** Stripe
  rejects both together. The seed keeps a top-level `unit_amount` anyway, because
  `lib/currency.ts` reads it to advertise what a group of ONE pays — so the JSON
  serves two consumers, and the sync script must omit it on the tiered path.
- **There is no `currency_options` inside a `tiers[]` entry.** Per-currency
  ladders live at `currency_options[<cur>].tiers[]`. The seed's nesting is a
  source format that the script transposes; nobody may pass `spec.tiers` to
  Stripe verbatim. The script now throws unless every tier prices every currency.
- **Prices are immutable, so flat → tiered mints a new price and archives the
  old.** Existing subscriptions STAY on the archived flat price. A `per_unit`
  price bills `quantity × base`, so raising quantity on a legacy subscription
  charges N × the full rate rather than base + half per extra org. `lib/billing.ts`
  therefore refuses `quantity > 1` on a non-tiered price rather than overcharging;
  such groups must be migrated to the tiered price first.
- **The plans-table repoint is not transactional with Stripe.** If the process
  dies between creating the new price and updating `plans`, the table points at
  the archived id while the lookup key points at the new one. Checkout keeps
  working (it resolves by price id) but bills the OLD amount until sync re-runs.
  Re-running fixes it; worth knowing during a price rollout.
- **Verify the expand on the first real sync.** It is unconfirmed whether
  `expand: ["data.currency_options"]` returns nested per-currency `tiers`. If it
  does not, the script warns and treats them as unchanged — deliberately, since
  reporting drift would remint a price on every run. Watch the first TEST-mode
  run for `tiers were not expanded`.

### The only sync rule

```
stripe_quantity = max(active_org_count, quantity_paid)

active_org_count = count(*) from organizations
                   where subscription_id = $1
                     and status = 'active' and deleted_at is null
```

- **Increment** — update quantity now, `proration_behavior: 'create_prorations'`,
  charge immediately. Set `quantity_paid` to the new value.
- **Decrement** — no Stripe call. Let renewal true it up, and reset
  `quantity_paid` to the actual count on `invoice.paid`.

A removed org therefore frees a paid slot reusable at no charge until the period
ends — worth up to eleven months on annual, and worth saying out loud in the UI.
No refunds, and nothing to game by cycling orgs.

**Not yet true in code.** Nothing writes `quantity_paid` today, so
`max(active, quantity_paid)` degenerates to the active count and the freed-slot
guarantee does not hold. The attach/detach task owns setting it: raise it when a
quantity increment is charged, and reset it to the actual active count on
`invoice.paid`. Until then, do not put the freed-slot promise in customer-facing
copy — it would be a claim the code does not honour.

Two guards fall out of this:

- Quantity is always *derived by count*, never incremented blindly. Concurrent
  attaches take `select ... for update` on the subscription row.
- Last org leaves → cancel the subscription. Never leave a live sub at quantity 0.

## Entitlement resolution

**The resolver exists twice**, and both copies must change together.

1. `resolveFromDb` (`lib/entitlements.ts:53-124`) — the TypeScript resolver.
2. `org_has_feature(uuid, text, uuid)` — a `security definer` SQL function
   introduced by the concurrent V306, reading `organizations`, `subscriptions`,
   `plan_entitlements`, `org_entitlement_overrides` and `competition_passes`.

`apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts` is the tie between
them and will fail loudly if only one is updated. That is the desired behaviour;
it just means the org → subscription join is written in two languages.

Both join `organizations → subscriptions` via `subscription_id` instead of
`org_id`. The shape of the `case` expression is unchanged — `comped_until`, the
14-day `past_due` grace and the plan fallback all keep working as written.

**The SQL resolver feeds the public site.** `public_players_v` gates on the 2-arg
form of `org_has_feature`, and `server/public-site/data.ts` calls it directly. So
moving billing to groups reaches public pages, not just the console, and the
public views must be re-checked after the join changes. Any view definition that
embeds the old 2-arg call has to be reissued in the same migration.

Priority is unchanged: `org_entitlement_overrides` → competition pass → plan
matrix → deny.

- **Quotas stay per org.** `members.max`, `clubs.max`, `competitions.max_active`
  resolve for the org, not the group. Three Pro orgs get 3 × 15 seats for $37,
  not 15 shared. That headroom is exactly what the $9 buys.
- **`org_entitlement_overrides` stays org-scoped** and stays top priority, so
  staff can still comp or lift a single org without touching group billing.
- **`comped_until` moves to the group.** Per-org comping uses overrides.
- **Event Pass stays community-only and needs no change**, but the earlier claim
  that it "only ever applies in a group of one" was wrong and is corrected here.
  A community group normally holds one org, but the cap is enforced at CREATION
  only — so a five-org Pro group that downgrades becomes a five-org *community*
  group, and the pass branch at `entitlements.ts:109-117` then fires for all
  five.

  That is benign: `competition_passes` is keyed by `(org_id, competition_id)`, so
  each org buys its own pass for its own competition and nothing is shared or
  multiplied. Worth stating explicitly rather than resting on an invariant that
  does not hold, and worth a test — a downgraded multi-org group where one org
  holds a pass must lift that org's competition and no other.

### Cache fan-out — the highest-risk edit

Keys are `ent:<orgId>:*` and `invalidateOrgEntitlements`
(`lib/entitlements.ts:29`) drops exactly one org. After grouping, a plan change,
cancel or dunning transition on the group leaves every *other* org serving stale
entitlements for up to the 300s TTL.

Every billing write must fan out:

```ts
export async function invalidateGroupEntitlements(subscriptionId: string) {
  const orgs = await sql<{ id: string }[]>`
    select id from organizations where subscription_id = ${subscriptionId}`;
  await Promise.all(orgs.map((o) => invalidateOrgEntitlements(o.id)));
}
```

Every call site of `invalidateOrgEntitlements` in billing paths switches to this.
Org-scoped writes (overrides, passes) keep the single-org version.

## Entitlement matrix changes

V310 also reseeds `orgs.max_owned`:

| Plan | Orgs | Was | Cost at cap |
|---|---|---|---|
| community | 1 | 1 | $0 |
| pro | 5 | 3 | $55/mo ($19 + 4 × $9) |
| pro_plus | 10 | ∞ (null) | $210/mo ($39 + 9 × $19) |

Pro reverses V270's 3 → 5 tightening, which makes V270's grandfathering override
rows dead — drop them rather than carry them.

Pro Plus stops being unlimited, so its pricing cell renders `10` instead of `∞`
automatically (`pricing-matrix.ts` derives from `plan_entitlements`). Its
`stripe-plans.json` description currently sells "unlimited seats and scale" —
still true for seats, no longer true for orgs. Reword. An eleventh org becomes an
enterprise conversation rather than a silent reseller.

`assertMayOwnAnotherOrg` simplifies considerably: the cap is now a property of
the group's plan, not a fold over every org the user owns.

**Conflict warning.** That function is being rewritten on
`feat/event-pass-e2e-and-entitlement-gaps` right now — exported for tests, and
reimplemented to call `getLimit` once per owned org so that `comped_until` and
the `past_due` grace are honoured. Their version also documents a deliberate
semantics change: a *lowering* override now bites, where the old raw `union all`
silently discarded it. Do not clobber that reasoning. The group rewrite should
land on top of their version, and the lowering-override semantics survive
unchanged — a group's cap is still resolved through `getLimit`, just once for the
group instead of once per owned org.

### Why community stays at exactly one org

Quotas resolve per org, so allowing a second free org multiplies the free grant:

| Community grant | 1 org | 3 free orgs | Cost |
|---|---|---|---|
| Active competitions | 1 | 3 | $0 |
| Team members | 3 | 9 | $0 |
| Public dashboards | 1 | 3 | $0 |

One active competition is the free tier's entire lever. Allow a second free org
and someone running a four-competition season never upgrades — they click "new
org" four times.

If free multi-club ever becomes a real ask, the alternative is group-scoped
quotas *on community only*, so several free orgs share one competition. That
closes the leak at the cost of a conditional resolver. Not now.

**V309 genuinely weakens this argument and it should not be glossed over.** When
community could not charge entry fees, a free org produced no revenue and the cap
was pure defence. Now a community org pays 8% on every entry, so four free orgs
running four competitions send us 8% of all four — quite possibly more than the
$19 Pro subscription they would otherwise have bought. On revenue alone the cap
is now arguably a *cost*.

Three reasons it still stands, for now:

- The quota multiplication is real regardless of revenue: three free orgs is
  three active competitions, nine members and three public dashboards, and the
  free tier stops meaning anything.
- Subscription revenue is predictable; fee revenue is seasonal and volume
  dependent. Trading the first for the second is a strategy change, not a side
  effect of a billing refactor.
- It is reversible in one row. `orgs.max_owned` for community is a single
  `plan_entitlements` value, so raising it later is a migration, not a redesign.

Flagging it as a product decision worth revisiting once there is fee data,
rather than silently keeping the old answer under new economics.

## Operations

### 1. Attach

Owner-gated on **both** orgs. Admin is an operational role, not a financial one.

Preconditions, all refusals:

- target org's group has a live subscription — deferred, see Out of scope
- group is `past_due` — settle the invoice first
- group has `cancel_at_period_end` — resume the subscription first

An attach must never mutate subscription state as a side effect; "resume, then
add" is two clear steps.

On success: `organizations.subscription_id = <group>`, quantity increments,
prorated charge, org is entitled the same second. Added mid-trial it rides the
group's trial to the same end date and charges nothing now.

**A failed increment invoice does not roll the attach back.** It enters the
group's normal dunning ladder — `past_due` → 14-day grace → every org degrades
together at day 15. One failure mode, not two.

### 2. Detach

**Blocking prerequisite, found in review.** Stripe webhooks currently resolve the
group via `stripeSub.metadata.org_id`, stamped at checkout. That is safe only
while org removal is a soft delete, because the row and its `subscription_id`
survive. It becomes actively wrong the moment detach ships: the stamp then names
an org billing through a DIFFERENT group, and `syncSubscription` would overwrite
the wrong subscription row — silently corrupting a paying customer's plan state.

So detach cannot land without also stamping `subscription_id` into Stripe
metadata and adding a fallback resolve by `stripe_subscription_id` /
`stripe_customer_id`. Same change, not a follow-up.

Either side may initiate. The payer can push an org out; the org's owner can pull
itself out. Nobody needs permission from the person funding them in order to
leave, and no payer is trapped funding an org that refuses to pay.

**Detach requires no payment.**

```
detach(orgB):
  S2 = insert subscriptions {
    owner_user_id: <orgB's owner>,
    plan_key:      S1.plan_key,
    comped_until:  S1.current_period_end,
    trial_used_at: S1.trial_used_at,
    status:        'active'
  }
  orgB.subscription_id = S2.id
  -- S1 quantity trues up at renewal (deferred decrement)
```

Three properties worth naming:

- The org's owner becomes a group owner **automatically** — that is just
  `owner_user_id` on the new row, not a granted role. Under today's per-org
  billing everyone already is one.
- `comped_until` carries the org through the period the old payer already paid
  for, then `entitlements.ts:85` degrades it to community at read time with no
  scheduler. **No new column, no new resolver branch.**
- Inheriting `trial_used_at` is what stops detach farming a fresh 14 days.

If the detached org then subscribes it is $19 + $19 against $28 shared. That gap
is what the $9 tier was discounting.

### 3. Transfer a group

Distinct from `transfer-owner`, which moves org ownership and never touches
billing. A federation whose treasurer leaves needs this; without it a group
changing hands means detaching every org and re-grouping under someone else,
which loses the group and re-charges tier 1.

Moves `subscriptions.owner_user_id` and updates the Stripe customer's contact
details. The card is **not** moved — the new owner re-enters it. Gate on the
current group owner; the recipient must accept.

## Landmine fixes

Four places where existing behaviour, written when one subscription meant one
org, becomes wrong the moment a group holds two.

### L1 — staff suspend would kill a whole group's billing

`app/api/admin/orgs/[id]/suspend/route.ts:29` writes
`subscriptions.status = 'suspended'`. Once that row is shared, suspending one org
stops billing and degrades entitlements for every other org in the group,
including orgs belonging to people who did nothing wrong.

**Fix:** suspension writes `organizations.status` only and never touches the
subscription. `entitlements.ts:84` already carries the note that "suspension is
not billing" — this makes it literally true. A suspended org must also keep
counting toward quantity: suspension is moderation, and the customer keeps paying
for the slot.

### L2 — ownership transfer splits payer from owner silently

`app/api/orgs/[id]/transfer-owner/route.ts` demotes and promotes roles and
touches no billing. Meanwhile `requireBillingOwner`
(`server/usecases/billing-manage.ts:70`) gates on the *active org's* owner role —
so after a transfer the new org owner would get the group's card, invoices and
cancel button.

**Fix:** re-gate every billing route on `subscriptions.owner_user_id`. Transfer
leaves group membership alone and shows the new owner "billed by …", read-only,
with a detach action.

Note the resulting split, which is correct and must be deliberate:

- **Connect** stays gated on the *org's* owner — it is the club's bank account.
  Already true (`server/usecases/stripe-connect.ts`, owner + session only).
- **Billing** gates on the *group's* owner.

### L3 — one tax ID cannot cover two legal entities

`addTaxId` (`billing-manage.ts:656`), billing address and promo codes all hang off
the Stripe customer, so a group has exactly one of each. Two clubs that are two
registered charities have two VAT numbers and cannot share an invoice legally.

**Fix:** none in code — this is the real, non-cosmetic reason detach exists.
Surface it in the detach copy rather than framing detach as merely "separate
invoices."

### L4 — entitlement cache is keyed and invalidated per org

Covered above under Cache fan-out. Highest-risk edit in the change.

## Decisions reference

Cases resolved during design, kept for the implementer. Full catalogue in the
design artifact.

| # | Case | Decision |
|---|---|---|
| G2 | Second org on free | 402 at creation. Free is one org, permanently |
| G5 | Who may attach | Owner of both orgs |
| G7 | Org suspended by staff | Quantity does **not** drop |
| G9 | Two attaches race | `for update` on the subscription row; quantity derived by count |
| P8 | Attach while `past_due` | Refuse |
| P9 | Attach while cancelling | Refuse |
| P10 | Staff comp on one org | `org_entitlement_overrides`, not `comped_until` |
| T1 | Trial | One per group, ever |
| T3 | Detach mid-trial | Inherits stamp and end date |
| M3 | Payer not a member | Allowed — federation and agency case |
| M6 | Org wants to pay for itself | Must detach; no partial payment |
| M7 | Orgs split the bill | Not built |
| M9 | Evicting an org that won't pay | Always succeeds; lands on community at period end |
| M10 | A club wants its own bill | Impossible — clubs have no subscription or Connect account |
| S1 | Failed increment invoice | Stays attached, normal dunning |
| S4 | Currency | One per group, fixed at first checkout; Adaptive Pricing stays off (#191) |
| S5 | Promo code | Applies to orgs added later; prefer duration-limited codes |
| X3 | Reselling | Capped by `orgs.max_owned` |

## Out of scope

- **Attaching an org that already has its own live subscription.** Blocked by
  precondition — cross-customer credit cannot move in Stripe, and refunding an
  annual mid-term could be $130+. Becomes real when re-attach after detach is
  asked for.
- **Freezing entry-fee % per competition.** Attaching mid-registration changes
  the rate for later entrants, and `registrations.ts:939` snapshots the rate per
  charge, so two entrants in one competition can pay different cuts. Still
  pre-existing — a plain community → Pro upgrade already does it — but **V309
  makes it four times worse**: the swing was 5% → 2%, and is now 8% → 2%, or
  8% → 1% into a Pro Plus group. On a $50 entry that is $4.00 against $0.50 for
  two people entering the same event a day apart.

  I would now promote this from "worth a follow-up" to **the first thing to fix
  after this lands**: snapshot `fee_percent` on the competition at first paid
  entry and read it from there. It is a small column and a small change, and
  "everyone in this event paid the same cut" is the only version of this that
  support can defend.
- **Splitting an org into two.** The path for a club that needs its own payouts.
  Data migration, not billing.
- **A new account still earns a new trial.** Unchanged by grouping.
- **Multi-org nav cache bug** — switching org lands Settings on the previous org.
  Grouping makes it more visible, not worse.

## Testing

Per the repo's standing rule, every change ships a test that fails without it.

- `stripe_quantity = max(count, quantity_paid)` — table-driven over add, remove,
  re-add within period, and renewal true-up.
- Removing either org of a pair returns the bill to tier 1 — the regression that
  the count-based model exists to prevent.
- Detach: new row carries plan, `comped_until`, `trial_used_at`; org resolves the
  old plan before that date and `community` after.
- Detach requires no payment and eviction always completes.
- Attach refused on `past_due` and on `cancel_at_period_end`.
- Attach refused for an admin of either side.
- Cache fan-out: a plan change on a 3-org group invalidates all three.
- Staff suspend of one org leaves the other orgs' entitlements intact.
- Billing routes gate on `owner_user_id`, not active-org role — including after a
  `transfer-owner`.
- Community cannot create a second org.
- **SQL/TS parity** — `entitlements-sql-parity.test.ts` must still pass after the
  join moves, proving both resolvers were changed together.
- **Public site** — a grouped org's public pages resolve the group's plan.
  `public_players_v` and `server/public-site/data.ts` go through the SQL
  resolver, so this is a distinct path from the console.
- `scripts/smoke.ts` gains a group path on both the pro and free flows. Note the
  concurrent branch adds ~250 lines to the same script; rebase before extending.

Local e2e per the standing recipe: prod build, `E2E_PROD_TARGET` on `:3100`,
`whsec_e2e_payments` set or payments-hardening fails 11 for nothing.

### Visual verification

Playwright, desktop and mobile viewports, against a prod build:

- Billing page as the group owner — quantity, per-org breakdown, one invoice.
- Billing page as a non-payer org owner — read-only "billed by …" with a detach
  action, never a 403.
- Attach and detach dialogs, including the refusal states (P8, P9) and the
  eviction path (M9).
- Pricing page — the `orgs.max_owned` row and Pro Plus rendering `10`, not `∞`.
- The 402 upgrade CTA from a community org's second-org attempt.
- Org switcher showing which orgs share billing.

Follow the frontend-design skill for anything new, and screenshot-verify both
viewports before merging.

## Schema reset before production

The user will wipe schema and test data locally and on staging before the
production cut, so nothing here needs a data migration and the delta numbering
only has to stay consistent while both branches coexist in dev. That does **not**
remove the need for a numbered delta — Flyway is incremental until the wipe.

## Surfaces to update

Nothing here is optional; the change is only half-shipped if a surface still
describes per-org billing.

### Marketing and pricing

- **`/pricing`** (`app/[lang]/(marketing)/pricing/page.tsx`) — the
  `orgs.max_owned` row stops being an implied allowance and becomes a price:
  "1 / 5 / 10, additional organisations at half your plan's rate". Pro Plus's
  cell renders `10` automatically from `plan_entitlements`, but the surrounding
  copy must stop implying unlimited.
- **`lib/pricing-matrix.ts`** — `orgs.max_owned` is already in `INT_FEATURES`, so
  the number renders; the row LABEL and any footnote change.
- **`config/stripe-plans.json`** — add the graduated tier structure (base +
  half-price extra, per interval), and reword Pro Plus's "unlimited seats and
  scale" so it no longer reads as unlimited orgs. Re-run `npm run stripe:sync`
  against **each** environment (test and prod) after editing.
- **Dictionaries** — `pricing.matrix.orgs.max_owned` in all four locales
  (en/es/fr/nl) plus any new attach/detach strings.

### Console

- **Billing page** (`app/o/[orgSlug]/settings/billing/page.tsx`) — quantity, a
  per-org cost breakdown, one invoice. For a **non-payer** org this becomes
  read-only "billed by …" with a detach action, never a 403.

  Implemented: the page gates on `isPayer` (`subscriptions.owner_user_id`),
  resolved BEFORE the `getBillingOverview` call so the Stripe read itself is
  gated rather than merely the rendering. The non-payer sees the payer's
  **display name only** — never their email, invoices or instruments. Gating on
  org role, as it originally did, exposed the payer's card and invoices to every
  member org's owner.

- **Renewal quotes changed meaning.** `previewIntervalChange` and
  `previewPlanChange` now ask Stripe for a preview invoice
  (`invoices.createPreview`) instead of computing from the flat list price, since
  a graduated price cannot be quoted by multiplication. The number therefore now
  INCLUDES tax and discounts — it is the real next charge, where before it was
  the bare list price. That is more honest, but it is a visible change to what
  the UI shows, and the trialing path gains one Stripe call it previously
  avoided.
- **Attach / detach / transfer** screens, including the refusal states (P8, P9)
  and the eviction path (M9). Attach should lead with the fee-rate drop, not the
  price: "Northside's platform fee falls from 8% to 1%".
- **Org switcher and Settings** — show which orgs share billing.
- **`components/billing-banner.tsx`**, **`billing-manage.tsx`**,
  **`billing-actions.tsx`**, **`plan-badge.tsx`** — all read subscription state
  and must resolve through the group.
- **`lib/feature-copy.ts:8`** — stops saying "clubs your plan can own", which
  collides with the in-org `clubs` entity. The 402 needs a real upgrade CTA that
  names the org cap and the price of the next slot.

### Admin panel

- **`/admin/entitlements`** — the matrix gains the reseeded `orgs.max_owned`
  values; verify the Pro Plus column stops rendering unlimited.
- **`/admin/orgs`** and **`components/admin-org-actions.tsx`** — show an org's
  billing group and its payer, and **suspend must not touch the subscription**
  (landmine L1).
- **`components/admin-plan-panel.tsx`** and `usecases/admin-plan.ts` — staff plan
  grants, comps and trials now act on a GROUP, so the panel must say how many
  orgs a change affects before it is applied. Per-org comping stays on
  `org_entitlement_overrides`.
- **`/admin/billing-events`** — events are group-scoped; the org column becomes a
  group with an org list.
- **`/admin/revenue`** and `usecases/platform-revenue.ts` — subscription revenue
  is now per group with a quantity, not per org. Any per-org revenue arithmetic
  double-counts or under-counts once a group holds two.
- **`/admin/coupons`** — a promo applies to a whole group including orgs added
  later (case S5).

### Help

Mandatory closing pass, per the standing rule. At minimum:

- A new page on billing groups: what a group is, who pays, how to add and remove
  an org, what detaching costs, and that Connect never moves.
- **`registration/card-payments.md`** — the fee ladder and that the rate follows
  the group's plan.
- **`getting-started/invite-your-team.md`** — members are per-org and unaffected
  by grouping; the distinction between joining an org and paying for one.
- Any page asserting one subscription per organisation.

### Machine surfaces

- **OpenAPI** — regenerate (three times if the generator drifts, per the standing
  gotcha).
- **e2e** — grep every changed billing string across BOTH phases before merging
  and scope assertions to a container; UI text changes have broken these before.
- **`scripts/smoke.ts`** — a group path on both the pro and free flows. The
  concurrent branch adds ~250 lines to the same file; rebase before extending.
