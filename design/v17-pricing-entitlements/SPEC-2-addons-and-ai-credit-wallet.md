# v17/SPEC-2 — Add-ons & AI Credit Wallet

The ARPU engine. Add-ons stack on top of any tier; the AI credit wallet is the metered axis that doubles as the free-COGS margin floor. See [`README.md`](./README.md) and the matrix in [`SPEC-1`](./SPEC-1-plan-entitlement-matrix.md). Operator allocation + growth loops build on this wallet — [`SPEC-5`](./SPEC-5-operator-and-credit-economy.md).

**UI surfaces:** SPEC-6 §A3 (credits tab), §A4 (buy modal), §A5 (add-ons tab), §A6 (out-of-credits), §A7 (Pass ladder).

---

## 1. Add-ons come in 3 billing shapes

Each shape needs a different mechanism — two are new, one reuses the Event Pass machinery.

| Shape | Examples | Billing | Raises | Lifecycle |
|---|---|---|---|---|
| **Recurring quantity** | extra seats, extra orgs | Stripe subscription **line-item qty** | an int cap, additive | prorates + cancels with the sub |
| **Consumable credits** | AI runs (schedule / officials / news) | one-time payment → **balance** | a spendable wallet | depletes on use; monthly grant resets |
| **Per-comp scale** | bigger entrants/divisions for ONE event | one-time (**Event Pass ladder**) | caps for that competition | reuses #248 Pass auto-lock |

## 2. Principle — keep `plan_entitlements` clean

`plan_entitlements` stays the **per-plan baseline only**. Per-org / per-group state (add-ons, credits) never bloats it. Add-ons live in their own tables and *stack* at resolve time.

## 3. Mechanism 1 — additive caps (`org_addons`)

Recurring add-ons raise an int cap additively. Today the resolver's override *replaces*; add-ons must *add*. Group-aware (see §11):

```
effective_cap(org, comp) = plan_base(group plan)
                   + sum(delta_each * qty  where status = active
                         AND (target_org_id = org OR target_org_id IS NULL)
                         AND (target_competition_id = comp OR target_competition_id IS NULL))
                     -- NULLs widen scope: group-wide / any-org / any-competition
```

New table (group-reconciled — see §11.3):

```
org_addons(
  id,
  wallet_id        text,     -- billing entity CHARGED = subscriptions.id (group);
                             --  coalesce(group_sub_id, org_id) for a standalone org
  target_org_id    text,     -- NULL = group-wide (shared capacity);
                             --  set = one org (e.g. an extra seat). See §11.3
  target_competition_id text, -- NULL = any comp; set = one competition
                             --  (subscriber size pack, §4b)
  feature_key      text,     -- e.g. members.max, orgs.max_owned
  delta_each       int,      -- +1 per unit
  qty              int,      -- Stripe line quantity
  stripe_item_id   text,     -- null when admin-granted (SPEC-3)
  status           enum,     -- active | granted | canceled
  created_at
)
```

- `withinLimit` reads the summed effective cap (via the one resolver — see SPEC-1 §10).
- Add-on lapses/cancels → cap drops → over-cap data **freezes, never deletes** (existing downgrade pattern).
- Admin-granted add-ons (`stripe_item_id = null`, `status = granted`) use the same table — see SPEC-3.

**Extra-org** already works via Stripe graduated quantity ($9 Pro / $19 Pro Plus per org/mo); fold it in as `feature_key = orgs.max_owned`, `target_org_id = NULL` (group-wide capacity).

## 4. Mechanism 2 — per-competition scale (TWO mechanisms, by buyer)

"Per-comp scale" is **two different needs** using two mechanisms — conflating them was the gap the Phase-1 plan caught. The pass arm is **community-only** (`entitlements.ts` fires it only for non-paid plans), so a subscriber cannot ride it.

### 4a. Event Pass ladder (Community) — two pass plan_keys

The pass arm grants whatever `plan_entitlements` rows exist for `competition_passes.pass_key`, and **`pass_key` is already a FK to `plans`**. So the M/L ladder is just **two pass plan_keys — zero resolver change**:

| pass plan_key | Price | Caps |
|---|---|---|
| `event_pass` (M, base) | $29 | ≤128 entrants · ≤10 divisions |
| `event_pass_l` (L) | ~$59 | ∞ entrants · ≤20 divisions |

### 4b. Size pack (subscriber) — per-competition add-on

A Pro/Pro Plus org exceeding its cap on ONE competition is **not** an Event Pass. It is a **per-competition add-on**: an `org_addons` row with **`target_competition_id`** set (§3) — additive on the plan cap, that comp only. Reuses the additive add-on model (no new resolver arm) and follows the SPEC-4 lifecycle lock via the competition.

**Rejected — a `size` column on `competition_passes`:** it adds a resolver special-case (size beats the plan value) and pulls scale out of the matrix. 4a + 4b reuse two mechanisms that already exist.

**Resolved (2026-07-24):** free `entrants.per_division.max` = **64** (tunable — README §7); Event Pass **S dropped**; ladder = `event_pass` M ≤128 / `event_pass_l` L ∞. If free is re-tuned, re-check M sits above it.

## 5. Mechanism 3 — the AI credit wallet

### 5.1 Store — append-only ledger (truth), not a counter

```
ai_credit_ledger(
  id,
  wallet_id        text,     -- BILLING ENTITY = coalesce(group_subscription_id, org_id).
                             --  The group when grouped; else the org's own id
                             --  (a group-of-one). Shared across a billing group (§11).
  delta            int,      -- signed: +grant / -spend / +refund / -expiry
  source           enum,     -- monthly_grant | trial_grant | pack_purchase
                             --  | run_spend | refund | expiry | admin_adjust
                             --  | earn_grant (SPEC-5 fast-follow)
  ref              text,     -- stripe_payment_intent (buys) | ai_run_id (spends)
  spent_by_org_id  text,     -- run_spend only: which org burned it (reporting)
  balance_after    int,      -- snapshot; CHECK (balance_after >= 0)
  idempotency_key  text UNIQUE,
  created_at, created_by
)
balance(wallet) = sum(delta)
```

**Wallet key = billing entity, not org** — see §11. Any org in a billing group spends from the one shared pool; `spent_by_org_id` records who, for per-org reporting. Rows are truth; `balance_after` is a cached snapshot + a `>= 0` guard that makes oversell impossible atomically. **Append-only** — corrections are compensating rows, never UPDATE/DELETE (it's money).

**Credit unit:** **1 credit = 1 AI run.** Run *size* is already capped per tier (entrants/divisions), so COGS is bounded. A size-weight multiplier is a documented future option if a run class blows margin (open question #3).

### 5.2 Consume — reserve → run → settle

```
1. balance < cost?  → 402 "out of credits - top up / upgrade"   (no run)
2. write HOLD row (-cost); balance_after guard blocks oversell   <- atomic, transactional
3. call model
4a. success → settle: HOLD becomes run_spend, ref = ai_run_id
4b. fail    → release: compensating +cost row (net zero; user not charged for our error)
```

- **Concurrency:** a per-wallet `pg_advisory_xact_lock` inside `reserve()` serializes read→compute→insert. **The `balance_after >= 0` CHECK alone does NOT prevent oversell** — two txns can both read the same stale balance and each compute a non-negative `balance_after` (lost-update; proven in Phase-2 Task 3). The advisory lock + CHECK together block it.
- **Idempotent:** spend keyed by `run_id` → retries / webhook replays never double-debit.
- **Spend order:** burn the resetting **grant credits first**, then **paid packs** (never waste paid credits on the free/trial allowance).

Enforced at **action time** in `usecases/schedule-ai.ts`, `officials-ai.ts`, `news`-auto — separate from the boolean resolver. AI runs are available on **every tier** — the gate is wallet balance, not plan (SPEC-1 §5).

### 5.3 Track — the ledger rows ARE the usage record

```
ai_credit_ledger.ref → ai_runs(model, tokens, cost_usd, competition_id)   -- lib/ai-pricing.ts
```

| Surface | Shows |
|---|---|
| Org billing page | balance · grant used/remaining · packs left · run history (date, comp, model, credits) |
| `/admin` | per-org **COGS sold vs credits consumed** = live margin monitor; aggregate burn (SPEC-3) |
| Reconcile job | assert `balance_after` == running sum — catches bug/tamper |

### 5.4 Grant, trial, plan-change + expiry rules

| Rule | Decision | Why |
|---|---|---|
| **D1** monthly grant | **reset (use-or-lose)** each cycle | grant = taste + margin floor, not a bank |
| **Cadence** | grant is **monthly regardless of billing cadence** | annual Pro ($159/yr) still gets 60/mo × 12, NOT a 720 lump (spike/waste) |
| **Anchor** | **billing-cycle** (paid) / **creation-day calendar** (Community) | resets align with the Stripe period + proration |
| **D2** purchased packs | **expire 24 months** from purchase ⚠ finance/legal sign-off | bounds deferred revenue + captures breakage; long enough to feel permanent |
| **Trial grant** | `ai.credits.trial` one-time (default **20**), **once per org** (`trial_used_at` guard) | taste without COGS; convert→monthly grant, expire→Community 10/mo. Guard stops trial-farming for free credits |
| **Downgrade** | keep wallet balance; grant resets to new (lower) tier next cycle; packs persist | credits are money — freeze-not-delete extends to the wallet; AI still runs on any tier |
| **Upgrade** | monthly grant rises to new tier (next cycle; optional prorated immediate top-up) | |
| Refund of a pack | claw back **unspent** only | can't un-consume used value |
| Grant idempotency | keyed `(wallet_id, period)` unique | cron re-run can't double-grant |

## 6. Credit pricing

Target **~50% margin** (accepted). Blended COGS/run ≈ **$0.12** (OpenRouter gemini-first ladder), worst ≈ $0.47.

**Base: $0.25 / credit → $10 = 40 credits.** Bonus credits scale bigger prepay (ARPU + cash upfront):

| Pay | Credits | Effective / credit | Margin* |
|---|---:|---:|---|
| **$10** | **40** | $0.25 | 52% |
| $25 | 105 | $0.238 | 50% |
| $50 | 220 | $0.227 | 47% |
| $100 | 460 | $0.217 | 45% |

*deepest packs dip below 50% but stay well above blended COGS (routing-controlled). Margin floor never breached.

**Currency:** the billing entity's **locked** currency governs (USD $0.25; INR ~₹18/credit PPP set-point). A group/subscription already has a Stripe currency; credit packs + add-ons price in **that** currency — Stripe forbids mixing currencies on one customer (the `currency_options` 400 trap). A standalone org sets currency on its first purchase. **Never** Stripe adaptive pricing (that was the prior $ vs £ bug).

## 7. Add-on catalog (summary)

| Add-on | Shape | Price | Effect |
|---|---|---|---|
| **AI credit pack** | consumable | $10→40 … $100→460 | top up wallet |
| **Size pack / Event Pass M/L** | per-comp | $29 / ~$59 | bump entrants/divisions for ONE comp |
| **Extra seat** | recurring qty | ~$4/seat/mo | +1 `members.max` (targeted to one org) |
| **Extra org** | recurring qty | $9 (Pro) / $19 (Pro Plus) | +1 `orgs.max_owned` (group-wide; exists) |

## 8. Stripe integration (per `stripe-best-practices` skill)

**API:** latest version (2026-06-24.dahlia); **restricted key (`rk_`)** not `sk_`; **omit `payment_method_types`** (dynamic payment methods); tag `integration_identifier` on sessions.

| Purchase | Type | Stripe API |
|---|---|---|
| Credit packs · size packs · Event Pass L | one-time | **Checkout Session** (one-time) |
| Extra seat · extra org | recurring | **Billing** subscription line item + Checkout |
| Auto-topup card on file | save PM | **SetupIntent** → off-session PaymentIntent (SPEC-5 §3) |

- **Prepaid, not metered:** the credit wallet is a **prepaid ledger**, so we do **not** use Stripe usage-based billing / Metronome — `ai_credit_ledger` is the meter; Stripe only sells the packs.
- **Tax:** credit packs + add-ons are digital goods → **Stripe Tax needs an active registration** before `automatic_tax` (else it silently collects nothing — the classic trap). Confirm registration covers the new SKUs.
- **Currency:** one currency per customer (§6); never adaptive pricing.
- Prices added to `apps/web/src/config/stripe-plans.json`, synced via `stripe:sync`. Verify against test-mode Stripe with `BILLING_LIVE=1` (`sk_test`).

## 9. Acceptance criteria (design intent)

- [ ] `effective_cap = plan_base + sum(active add-on deltas)`, group-aware; lapse → freeze, not delete.
- [ ] Ledger append-only; `balance_after >= 0` blocks oversell under concurrency.
- [ ] Failed AI run nets zero credits (release path).
- [ ] Grant resets and is spent before packs; packs persist; annual = monthly cadence.
- [ ] Trial grant is once-per-org; expire drops to Community grant.
- [ ] Downgrade keeps balance + AI runs on Community; upgrade raises grant.
- [ ] Pack refund claws back only unspent credits.
- [ ] Org + admin surfaces show balance, usage history, and COGS-vs-sold.

## 10. Open questions

Carried in [`README.md §7`](./README.md): credit unit (1-run vs size-weighted), pack expiry (never vs 24-mo), AI-officials gating, grant reset anchor, exact size-pack + extra-seat prices, trial-credit default amount.

## 11. Billing-group interaction (multi-org)

Billing is already **group-level**: a grouped org inherits the group's `plan_key`; `subscriptions` is the group, `quantity_paid` = org-seats (`entitlements.ts:142`, `usecases/billing-groups.ts`). v17 aligns to that entity.

### 11.1 Wallet = billing entity

`ai_credit_ledger.wallet_id` = `coalesce(group_subscription_id, org_id)` — the group's subscription when grouped, else the org's own id (a **group-of-one**; free orgs need no subscription row). Consequence: **all orgs in a billing group share ONE credit pool** — buy once, any org spends; `spent_by_org_id` records who.

### 11.2 Scaled monthly grant

```
monthly_grant(group) = ai.credits.monthly(plan) * quantity_paid
```

e.g. a Pro Plus group of 3 paid org-seats → 200 * 3 = **600 credits/mo** shared. Fair to big operators, still bounded by seats paid. Resets (D1). A standalone org = *1. Community (never grouped) = flat 10.

### 11.3 Add-on scope follows the resource

| Add-on | Applies | Table shape |
|---|---|---|
| **AI credits** | **group-wide** (shared wallet) | ledger row, `wallet_id` |
| **Extra org** | group-wide (`quantity_paid++`) | on the group sub (exists) |
| **Extra seat** (`members.max`) | **targeted** to one org | `org_addons.target_org_id` set |
| **Size pack** (subscriber) | competition-scoped | `org_addons.target_competition_id` (§4b) — one org's comp) |

Charge always on the group's one payer (`wallet_id`); apply per the rule above (`target_org_id`).

### 11.4 Admin + reporting

- Admin credit grants (SPEC-3) target the **wallet** (`admin_adjust` row, `wallet_id`), so a grant benefits the whole group.
- Per-org burn is reportable via `spent_by_org_id` even though the pool is shared.

### 11.5 Pro Plus validation

Billing groups **are** the "consolidated multi-org billing" Live differentiator in SPEC-1 §6 — the shared wallet + one-payer add-ons make the operator story concrete, not vapor. Operator allocation over this pool = [`SPEC-5`](./SPEC-5-operator-and-credit-economy.md).

### 11.6 Wallet transitions (credits follow the org)

Credits are money, so they move with the org across the group boundary:

| Transition | Rule |
|---|---|
| Free org **joins** a group | **merge** its own-wallet balance into the group pool (credits follow it in) |
| Org **leaves** a group (detach) | departing org starts fresh (own wallet + Community grant); **group keeps its paid pool** — a leaver can't drain the payer's credits. Ties to the #255 detach modes (ride-out / release) |
| Payer transfers the group | wallet stays with the group `subscription_id` (unchanged) — transfer changes payer, not the pool |

Implement as compensating ledger rows (move = `-balance` on old wallet, `+balance` on new), never a silent re-key.
