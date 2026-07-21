# Event Pass end-to-end + entitlement gap closure — design

**Date:** 2026-07-21
**Status:** awaiting review
**Branch:** to be cut from `main`

## Problem

The Event Pass (`event_pass`, $29 one-time, one competition for its lifetime) was
shipped in v3/07 §3 and has not been exercised end to end since. Three audits of
the entitlement system (TS call sites, SQL resolver, matrix coverage) found that
the pass is undiscoverable, sells features it does not deliver, leaves no receipt,
and dead-ends the buyer at its own quota ceiling. The audits also found
entitlement leaks unrelated to the pass: expired staff overrides and lapsed comps
keep granting Pro on every public surface.

The payment rails themselves are healthy and were verified live against test-mode
Stripe on 2026-07-21: price `price_1TukMvAy22H0xqqxw3aoT3Dr`, active, 2900 usd,
`one_time`, with `currency_options` for aud/eur/gbp/inr/usd — an exact match for
`SUPPORTED_CURRENCIES` (`apps/web/src/lib/currency.ts:6`). No dead-price or
missing-currency trap. The defects are all in the product layer.

## How pass scoping actually works

`resolve(orgId, featureKey, competitionId?)` in `apps/web/src/lib/entitlements.ts:109`:

```ts
if (planKey === "community" && competitionId) {
  // join competition_passes -> plan_entitlements on pass_key
}
```

Two conditions. The org must resolve to `community`, and the caller must thread
`competitionId`. A key missing from the `event_pass` matrix falls through to the
community row (it does not deny). **A call site that omits `competitionId` makes
the pass invisible.** That single omission is the root cause of most defects
below, and it recurs at 27 call-site groups.

## Decisions taken (2026-07-21)

| # | Decision |
|---|---|
| D1 | At a pass quota ceiling the gate offers **Pro only**, with goodwill copy crediting the pass already bought. Never re-sell a pass the org holds. |
| D2 | Event Pass buyers get **both** a real Stripe invoice (`invoice_creation.enabled` + `invoice_data.description` naming the competition) **and** an in-app purchases section on the billing page. |
| D3 | Four discovery entry points: competition header/settings, billing page block, `/pricing` CTA, competition-list badge. |
| D4 | `branding` becomes genuinely **competition-scoped** and is delivered, not dropped. This means the **org's existing** logo and brand colour render on the passed competition's public pages, slideshow and branded exports — scoped to that competition. It does **not** introduce a per-competition logo entity; no new upload surface, no schema change. |
| D5 | `realtime` is **delivered** by threading `competitionId` at the slideshow sites. |
| D6 | `exports.branded` is **granted to the pass** (plain `exports` has been free for everyone since V285, so the old bullet was hollow). |
| D7 | `sponsors.tiers` and `sponsors.monetize` are added to the gate's pass CTA list and to all marketing copy. |
| D8 | Resolver unification: fix `org_has_feature` via a new migration **and delete** the two app-side duplicate resolvers. |
| D9 | The override-expiry and lapsed-comp leaks land **first** in the branch — the Event Pass work builds on a correct resolver. |
| D10 | Spec + fix + E2E ship on one branch; the upgrade-page visual redesign needs screenshot sign-off before merge. |
| D11 | The Event Pass checkout opens in the **same `Modal` and theme as the Pro checkout** on the billing page — one checkout presentation across the product. |
| D12 | A pass bought within **30 days** credits its full price against the org's first Pro invoice, delivered as a **Stripe customer balance credit** (not a coupon — `discounts` and `allow_promotion_codes` are mutually exclusive in Checkout, and both builders set the latter). The pass keeps working if they later downgrade. |
| D13 | A pass holder **keeps** the 14-day Pro trial but **must supply a card** to start it. `trial_used_at` is not stamped by a pass purchase. |
| D14 | `subscriptions.currency` is pinned at the org's **first purchase of any kind, including a pass**, and never changed thereafter. |
| D15 | Every regression suite is extended, not just the ones nearest the change: unit (vitest), E2E (Playwright, desktop + mobile), `scripts/smoke.ts` (pro **and** free paths), and the help pages. A workstream is not done until its suite entries exist. |
| D16 | One branch, resolver first (workstream 1 before all others). Visual direction is chosen by the implementer for this session only; the standing sign-off rule resumes next session. |
| D17 | The Event Pass **grants `dashboard.player_profiles`** for the competition it covers. Consent still governs independently — `V237` requires per-person `public_name` consent regardless of plan, so this cannot publish anyone who has not opted in. Add the `('event_pass','dashboard.player_profiles', true)` row and include it in the pass copy (Task 18). |

## What the pass actually sells (corrected)

The `event_pass` column has 22 rows. Only these lift the community baseline:

| Feature | Community | Pass | Enforcement |
|---|---|---|---|
| `divisions.per_competition.max` | 2 | 10 | works |
| `entrants.per_division.max` | 16 | 32 | **partial — one broken site** |
| `formats.advanced` | false | true | works |
| `formats.double_elim` | false | true | works |
| `registration.paid` | false | true | partial (UI site broken) |
| `registration.fee_percent` | (default) | 5% | partial (admin site broken) |
| `sponsors.tiers` | false | true | works, unadvertised |
| `sponsors.monetize` | false | true | works, unadvertised |
| `scheduling.ai.runs_per_division.max` | 5 | 10 | works, unadvertised |
| `branding` | false | true | **DEAD** |
| `realtime` | false | true | **DEAD** |

Every other `event_pass` row equals the community value (no-op) or is an explicit
deny. `members.max` was deleted from the pass by `V291:36-37`.

**Correction on record:** an earlier reading of this work claimed the pass fails to
unlock AI scheduling. That was wrong. `V302:6` grants `scheduling.ai = true` to
**community**, so AI is free for every tier; only the run quota differs, and that
path already threads `competitionId` correctly. The pass's AI behaviour is
correct today.

## Workstream 1 — resolver correctness (lands first, D8/D9)

Five resolvers exist. Two are correct-ish, three drift.

| Resolver | Action |
|---|---|
| `lib/entitlements.ts` | reference implementation — unchanged except tests |
| `org_has_feature` (V228) | fix via new migration |
| `api/orgs/[id]/entitlements/route.ts:32-41` | **delete** — call the real resolver |
| `lib/auth.ts:198-214` (`assertMayOwnAnotherOrg`) | **delete** the raw SQL — call the real resolver |
| `V270:55-78` grandfather backfills | one-shot, already applied; leave |

`org_has_feature` misses four mechanisms, all added by migrations **later** than
V228 — it was correct when written and was left behind:

| Drift | Added by | Consequence |
|---|---|---|
| No pass awareness | V270/V271 | wrong FALSE — buyer's logo stripped from the competition they paid for |
| No `expires_at` check | V266 | **wrong TRUE — expired staff grants work forever** |
| No `comped_until` | V266 | **wrong TRUE — lapsed comp keeps Pro** on public pages, discovery, featured slot |
| No `past_due` grace | V291 | wrong TRUE — dunning past 14 days still renders Pro; `status` is ignored entirely, so `canceled`/`suspended` keep their stale `plan_key` |

A fifth, latent: a `bool_value IS NULL` override makes TS **deny**
(`entitlements.ts:60` returns the row unconditionally) while V228's `coalesce`
falls through and **grants**. No live key hits it; pin it with a test.

### Migration mechanics

`db/README.md:5` — applied migrations are immutable; `db/README.md:10-12` — the
`V###` prefix alone orders execution across all folders. So **V228 is not edited**;
the fix ships as **V306+** (current max is V305).

Adding `p_competition_id` is not a `create or replace` — a new argument list is a
new function, and dropping the 2-arg form fails on five dependent views. Two
viable shapes; the migration must pick one and do it atomically:

- **(a)** create the 3-arg function, `create or replace view` all four dependent
  views in the same file, then drop the 2-arg form.
- **(b)** add the 3-arg as an overload and migrate call sites view by view.

Caveat: `create or replace view` may only **append** columns
(`V289:3-4`, `jul3/V242:84`). Changing an expression inside an existing column is
fine; changing column order or type needs `drop view … cascade` + recreate +
re-`grant select … to app_user`.

Also mark the function `security definer` with an explicit `search_path` (pattern
at `v2-engine/functions/V226__hash_chain_functions.sql:15`). `competition_passes`
has RLS; today every consumer reads through the owner role, but a future
`withTenant` caller would silently get filtered results.

### `public_players_v` — the one structural blocker

`V237__view_public_players.sql:12` gates over `from persons p`; the only
competition reference is inside a correlated `exists()` below the call site. The
view has no competition column, because a person plays in many competitions.
Pushing the gate into the `exists()` would change its meaning to "*some*
competition this person appears in is entitled" — one Event Pass would expose that
person across every unpaid competition in the org.

**Resolution:** move the gate out of the view into the caller, which already knows
the competition (`server/public-site/data.ts:411`, consumer at `:417`). Do not add
a competition column to the view.

## Workstream 2 — close the pass-scoping gaps

### Live bugs (fix and regression-test each)

| Site | Key | Symptom |
|---|---|---|
| `server/usecases/registrations.ts:828` | `entrants.per_division.max` | **Public registration caps at 16, not the 32 paid for**, and rejects entrants mid-signup. `ctx.competition_id` is used 12 lines above at `:816`. |
| `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/registrations/page.tsx:34` | `registration.paid` | Paid-registration control renders locked for a pass holder; `competition` in scope at `:27`. |
| `app/slideshow/competitions/[id]/page.tsx:40` | `realtime` | D5. `id` **is** the competition id (`:21-24`). |
| `app/slideshow/divisions/[id]/page.tsx:26` | `realtime` | D5. `division.competition_id` at `:23`. |
| `server/slideshow-data.ts:84-85` | `dashboard.branding`, `branding` | D4/D5. `orgBoardChrome` needs a `competitionId` parameter; both callers have one. |
| `app/admin/orgs/[id]/page.tsx:87` | `registration.fee_percent` | Staff console shows the platform default instead of the pass's 5%. |
| `server/usecases/exports.ts:131` | `exports.branded` | Required by D6. `competitionId` is a **parameter of the same function**, used at `:132`. |
| `server/public-site/data.ts:178-182`, `:373`, `:481` | `branding`, `realtime` | D4/D5. `loadOrg(orgSlug, competitionId?)`; cache keys already differ per scope (`:216` vs `:262`). |

### Latent sites

27 further groups pass no competition id where one is reachable — `stages.ts` ×5,
`scoring.ts` ×2, `schedule.ts` ×3, `officials*.ts` ×8, `discipline.ts` ×6,
`history.ts` ×2, `api-v1/auth.ts:138`, `embed-data.ts:64`, and others. They are
inert only because their keys carry no `event_pass` row. Thread the id wherever it
is in scope; each becomes a one-line change that prevents the next dead grant.

### Guard against regression

Add a test that fails when a feature key present in the `event_pass` matrix is
resolved anywhere without a `competitionId`. This is the check whose absence let
`branding` and `realtime` ship dead: `entitlements-v2.test.ts` is currently the
only test that exercises the pass overlay, and only for two keys.

## Workstream 3 — the offer, the gate, and the copy

### Gate states (D1)

`UpgradeGate` (`components/upgrade-gate.tsx`) is a client component that infers the
pass CTA from `usePathname()` alone (`:36-40`) and cannot see whether the pass is
owned. Add `app/o/[orgSlug]/c/[compSlug]/layout.tsx` (none exists today) resolving
the pass once and providing it through a `CompetitionPassProvider` context. Read
the Next 16 layout docs in `node_modules/next/dist/docs/` before writing it.

| Org state | Gate renders |
|---|---|
| Community, no pass, liftable feature | Event Pass + Pro (unchanged) |
| Community, **pass held**, ceiling hit | **Pro only** + "Event Pass covers 10 divisions — you've used all 10" |
| Community, pass held, non-pass feature | Pro only, "not included in the Event Pass" |
| Any paid plan | Pro/Plus path only |

### `PASS_FEATURES` correction

`upgrade-gate.tsx:12-21` claims to mirror the `event_pass` column. It lists 8 keys;
the column actually lifts 11.

- **Remove:** `exports` — community is `true` since `V285:11-13`, so this gate can
  never render for a community org.
- **Keep:** `branding` and `realtime`, which become truthful entries once D4/D5
  land. They must not be listed before those fixes ship in the same branch.
- **Add:** `exports.branded` (D6), `sponsors.tiers`, `sponsors.monetize`,
  `scheduling.ai.runs_per_division.max` (D7).

### Matrix change required by D6

`exports.branded` is currently community `false`, pro `true`, **no `event_pass`
row** (`V247`). Granting it to the pass is a new `plan_entitlements` row and ships
in the same migration as the resolver fix. It is inert until
`server/usecases/exports.ts:131` threads its `competitionId` — both changes are
required, or the grant joins `branding` and `realtime` as dead.

### Copy surfaces — all four must agree

`lib/pricing-cards.ts:14-21`, `app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx:16-22`,
the Stripe product description in `config/stripe-plans.json`, and the four locale
dictionaries. Today the first three sell "Custom branding & PDF/XLSX exports" and
"Realtime scoreboard & slideshow" — two of six bullets that the resolver does not
deliver.

Also missing `FEATURE_REASONS` entries (`lib/feature-copy.ts`), so their gates fall
back to generic copy: `sponsors.tiers`, `sponsors.monetize`, `branding`.

Also unadvertised on `/pricing`: `scheduling.ai.runs_per_division.max` is absent
from `ENTITLEMENT_DOMAINS`, so buyers see "AI scheduling ✓" on all four columns and
never learn the quota is 5/10/20/50. Add it.

i18n parity is currently exact (62 `pricing.matrix.*` keys × 4 locales); every key
added here must land in all four.

## Workstream 4 — money leaves a trace (D2)

1. `buildPassCheckoutParams` (`lib/billing.ts:137`) gains
   `invoice_creation: { enabled: true, invoice_data: { description: "Event Pass — <competition name>" } }`.
   The route already fetches the competition at `pass-checkout/route.ts:26`.
2. `reconcilePassCheckout` (`lib/billing.ts:546`) calls
   `linkStripeCustomer(orgId, session.customer)` — the parity fix with
   `reconcileCheckout:594`. Same on the webhook path. Without it a pass-only org
   never gets a `stripe_customer_id`, so its billing page can show nothing at all.
3. Billing page: **Event Pass purchases** section — competition name, date, amount,
   link to the competition, link to the invoice PDF.
4. Probe `customer_update: { address: "auto" }`. Both builders set
   `automatic_tax.enabled` and pass an existing `customer`; Stripe may 400. Bites
   an org that had Pro, downgraded (keeping its customer id), then buys a pass —
   and, once step 2 lands, **every** pass holder upgrading to Pro. The customer
   link makes this path common rather than rare, so it must be settled here.
5. Stamp `subscriptions.currency` on pass reconcile (D14), reusing
   `syncSubscription`'s never-overwrite shape:
   `currency = coalesce(excluded.currency, subscriptions.currency)`
   (`lib/billing.ts:451`). Today only `syncSubscription` writes it (`:414,:423`),
   so a pass-only org keeps `NULL` and `preferredCurrency`
   (`lib/currency-server.ts:20-24`) falls through to the cookie and then
   Accept-Language — meaning a buyer who paid £25 for a pass can be quoted USD for
   Pro later.

## Workstream 4b — Event Pass to Pro (D12/D13/D14)

What happens today, traced end to end:

| Step | Today | After |
|---|---|---|
| Checkout allowed? | yes — `assertCheckoutAllowed` only blocks a *live* sub (`billing.ts:115`) | unchanged |
| Trial | 14 days, **no card** — `checkoutTrialDays` returns 14 because a pass never stamps `trial_used_at`, and `trialDays > 0` implies `payment_method_collection: "if_required"` (`billing.ts:69`) | 14 days, **card required** (D13) |
| Stripe customer | **a second one is minted** — `stripe_customer_id` is NULL, so the builder falls to `customer_email` | reused; one customer per org |
| The $29 | sunk; nothing reads `competition_passes` in any pricing path | credited to the customer balance if bought ≤30 days ago (D12) |
| The pass row | dormant — the resolver skips it while `planKey !== 'community'` (`entitlements.ts:109`) | unchanged; revives on downgrade |
| Currency | may differ from the pass purchase | pinned at first purchase (D14) |

The reverse direction already behaves: a Pro org attempting a pass gets 400
"Your plan already covers everything an Event Pass adds" (`pass-checkout/route.ts:34`).

**D13 implementation note.** `buildEmbeddedCheckoutParams` currently ties
card collection to the trial:

```ts
...(args.trialDays > 0 ? { payment_method_collection: "if_required" as const } : {}),
```

Add an explicit `requireCard` argument rather than overloading `trialDays`. When
true the parameter is omitted, so Checkout defaults to `always`, and
`trial_settings.end_behavior.missing_payment_method: "cancel"` becomes
belt-and-braces instead of the primary control.

**D12 precondition.** The credit must attach to the customer that will be billed
for Pro, so it is only correct **after** the customer-link fix in workstream 4.
Verified enabling fact: every org gets a `subscriptions` row at creation
(`lib/auth.ts:242-245`, `community`/`active`), so `linkStripeCustomer`'s
`if (!before) return` guard (`billing.ts:331`) will not silently no-op for a
pass-only org.

## Workstream 5 — discovery (D3)

- Competition header/settings: "Upgrade this event" for community owners;
  "Event Pass active" chip once held.
- Billing page: Event Pass block with a competition picker (community orgs only).
- `/pricing`: pass column CTA routes a signed-in community owner to a picker.
- Competition list: badge on passed competitions.

Today `routes.competitionUpgrade` has exactly one inbound link in the whole app —
`upgrade-gate.tsx:39` — reachable only after a gate has already bitten.

## Workstream 6 — checkout presentation and upgrade page (D10/D11)

### Checkout parity (D11)

The two checkouts diverged. Pro (`components/billing-actions.tsx:49`) mounts
`<EmbeddedCheckout>` inside `<Modal title="Complete your upgrade" size="lg">` from
`@/components/modal`, letting the Modal cap the sheet at 85vh. The pass
(`components/pass-upgrade.tsx:36-51`) renders it **inline**, escapes its container
with a `-mx-9 w-auto sm:mx-0` full-bleed hack, and offers a bare text "Cancel"
link.

Bring the pass onto the same `Modal`, same title treatment, same size, same close
affordance, and drop the full-bleed hack — the Modal already solves phone widths.
Both already share `CHECKOUT_BRANDING` (`lib/billing.ts:18`), so the Stripe iframe
itself matches; only our chrome differs. After the change, a screenshot of the two
checkouts side by side should be indistinguishable apart from the line item.

### Upgrade page redesign (D10)

`upgrade/page.tsx` is two flat cards plus a dead-end green box. Rework to a
pass-vs-Pro comparison naming real limits, with states for: not owned (owner),
not owned (non-owner), owned, owned + at ceiling, already Pro. Load the
frontend-design skill. Build variants, screenshot desktop and mobile, get sign-off
**before** merge.

## Use cases

| # | Actor | Flow | Expected |
|---|---|---|---|
| U1 | Community owner | Buys a pass from a bitten gate | Checkout, pass active, gate gone, invoice exists |
| U2 | Community owner | Buys from competition header before any wall | Same, no 402 first |
| U3 | Community owner | Buys from the billing-page block via picker | Same |
| U4 | Non-owner admin | Opens the upgrade page | Owner-only message, no checkout |
| U5 | Pass holder | Adds divisions 3–10 | Allowed |
| U6 | Pass holder | Adds division 11 | **Pro-only gate**, pass credited, no re-sale |
| U7 | Pass holder | Public registration, entrants 17–32 | Allowed (fixes `registrations.ts:828`) |
| U8 | Pass holder | Opens slideshow | Realtime + comp branding live (D4/D5) |
| U9 | Pass holder | Branded export | Allowed (D6) |
| U10 | Pass holder | Sponsor tiers / monetize | Allowed; gate offered them (D7) |
| U11 | Pass holder | AI schedule | 10 runs/division, quota surfaced |
| U12 | Pass holder | Billing page | Purchases section + invoice PDF |
| U13 | Pro org | Opens the upgrade page | "Your plan already covers this", no purchase |
| U14 | Pass holder | Upgrades to Pro within 30 days | Same Stripe customer; $29 on the customer balance; 14-day trial with a card required; pass dormant, not consumed |
| U14b | Pass holder | Upgrades to Pro after 30 days | Same, but no credit; copy says so before they commit |
| U15 | Pro org | Downgrades to community | **Pass survives** on its competition |
| U16 | Staff | Refunds the pass in the Stripe dashboard | Pass revoked, quotas re-freeze |

## Edge cases

| # | Case | Expected |
|---|---|---|
| E1 | Two owners buy the same competition concurrently | One pass; loser auto-refunded (`billing.ts:512`). **Never E2E-tested.** |
| E2 | Same owner double-clicks | One session via idempotency key (`pass-checkout/route.ts:70`) |
| E3 | Webhook never arrives | Reconcile-on-return records the pass |
| E4 | Webhook and reconcile race | Idempotent; not counted as a duplicate (`recordPassPurchase:479`) |
| E5 | Partial refund | Pass **retained** — deliberate; support flow |
| E6 | Full refund | Pass revoked (`revokePassForRefundedCharge:529`) |
| E7 | Refund with 11 divisions live | Freeze machinery degrades lazily; no data loss |
| E8 | Competition deleted with a pass | `on delete cascade` (V271); money not refunded — confirm intended |
| E9 | Pass bought, then org comped to Pro, comp expires | Falls back to pass, not community |
| E10 | Org suspended holding a pass | Suspension is not billing; pass unaffected |
| E11 | Buyer in EUR/GBP/INR/AUD | Charged in the quoted currency; `adaptive_pricing` off (#191) |
| E12 | Org with a stale `stripe_customer_id` from a cancelled sub | Reused, not duplicated; watch the `automatic_tax` 400 |
| E21 | Pass bought in GBP, Pro later quoted | GBP — `subscriptions.currency` pinned at the pass purchase (D14) |
| E22 | Credit applied, buyer then cancels inside the trial | Balance credit stays on the customer; it is not clawed back |
| E23 | Two passes bought, then upgrade to Pro | Credit is capped at one pass price — the most recent within 30 days, not the sum |
| E24 | Pass refunded, then upgrade to Pro | No credit — the refund already returned the money |
| E25 | Pass holder upgrades to Pro Plus, not Pro | Same credit rule; D12 is not Pro-specific |
| E13 | Pass on a competition in another org | 404 (`pass-checkout/route.ts:28`) |
| E14 | `stripe_price_id_onetime` unset | 503 with support copy |
| E15 | Expired staff override | **No longer grants** (workstream 1) |
| E16 | Lapsed comp on public pages | **Degrades to community** (workstream 1) |
| E17 | `past_due` past 14 days | Degrades on public surfaces too |
| E18 | Pass + `members.max` | Falls through to community's 3 — pass buys no seats. State it in copy. |
| E19 | Pass + `competitions.max_active` | Passed comps already excluded from the count (`competitions.ts:86`) |
| E20 | Entitlement cache after purchase | Invalidated immediately (`recordPassPurchase:490`) |

## Verification

- **Unit:** gate states; builder params (invoice_creation, description, currency,
  adaptive_pricing); resolver parity TS vs SQL across all five drifts; the
  "pass key resolved without competitionId" guard.
- **Integration:** `reconcilePassCheckout` links the customer; duplicate-pass
  refund; refund revokes.
- **E2E (Playwright, Stripe test mode):** U1, U6, U7, U12, U15 at desktop **and**
  mobile viewports, real 4242 purchase through embedded checkout, screenshots at
  every state. The pass checkout modal is captured next to the Pro checkout modal
  at both viewports to prove D11 parity.
- **Visual:** the frontend-design skill drives every UI change in workstreams 3, 5
  and 6 — not just the upgrade page. Each surface is screenshot-verified at desktop
  and mobile before it is considered done.
- **Smoke:** extend `scripts/smoke.ts` pass paths for the newly delivered grants.
- **Help pages:** `apps/web/content/help/billing/event-pass.md` and `plans.md`
  updated to match the corrected offer.

Command: `cd apps/web && npx tsc --noEmit && npx vitest run`

## Risks

- `refunds.create` **write** permission on the restricted test key is unverified —
  a probe was blocked. The E2E exercises it for real in test mode; if the key
  lacks the grant, E1 cannot be tested and the key needs widening.
- The V306 view-recreation path is the highest-risk change here. `create or replace
  view` cannot reorder columns, and four public-facing views depend on the function.
- Deploy ordering: `main` already has V304 and #191 pending. V306 must land after
  V304 in the same deploy or later.

## Out of scope

- Retiring the five dead grants (`public_pages`, `eligibility.enforced`,
  `stats.club_championship`, `domains.custom`, `support.priority`) — inventory
  recorded, no user impact.
- `scorers.max` being 1 on both community and pro (`V112:29-30`) — a pricing
  question for the owner, not a bug.
- The `business` plan, fully deleted by `V290:79-82`.
