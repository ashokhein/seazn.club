# v17/SPEC-2 — Add-ons & AI Credit Wallet

The ARPU engine. Add-ons stack on top of any tier; the AI credit wallet is the metered axis that doubles as the free-COGS margin floor. See [`README.md`](./README.md) and the matrix in [`SPEC-1`](./SPEC-1-plan-entitlement-matrix.md).

---

## 1. Add-ons come in 3 billing shapes

Each shape needs a different mechanism — two are new, one reuses the Event Pass machinery.

| Shape | Examples | Billing | Raises | Lifecycle |
|---|---|---|---|---|
| **Recurring quantity** | extra seats, extra orgs | Stripe subscription **line-item qty** | an int cap, additive | prorates + cancels with the sub |
| **Consumable credits** | AI runs (schedule / officials / news) | one-time payment → **balance** | a spendable wallet | depletes on use; monthly grant resets |
| **Per-comp scale** | bigger entrants/divisions for ONE event | one-time (**Event Pass ladder**) | caps for that competition | reuses #248 Pass auto-lock |

## 2. Principle — keep `plan_entitlements` clean

`plan_entitlements` stays the **per-plan baseline only**. Per-org state (add-ons, credits) never bloats it. Add-ons live in their own tables and *stack* at resolve time.

## 3. Mechanism 1 — additive caps (`org_addons`)

Recurring add-ons raise an int cap additively. Today the resolver's override *replaces*; add-ons must *add*.

```
effective_cap(org, feature) = plan_base + Σ(active org_addons.delta_each × qty)
```

New table:

```
org_addons(
  id, org_id,
  feature_key      text,     -- e.g. members.max, orgs.max_owned
  delta_each       int,      -- +1 per unit
  qty              int,      -- Stripe line quantity
  stripe_item_id   text,     -- null when admin-granted (SPEC-3)
  status           enum,     -- active | granted | canceled
  created_at
)
```

- `withinLimit` reads the summed effective cap.
- Add-on lapses/cancels → cap drops → over-cap data **freezes, never deletes** (existing downgrade pattern).
- Admin-granted add-ons (`stripe_item_id = null`, `status = granted`) use the same table — see SPEC-3.

**Extra-org** already works via Stripe graduated quantity ($9 Pro / $19 Pro Plus per org/mo); fold it into this model as `feature_key = orgs.max_owned`.

## 4. Mechanism 2 — per-comp scale = Event Pass ladder

Per-competition scale reuses `competition_passes` (one-time, competition-scoped, auto-locks when the comp ends per #248). Two entry points, one mechanism:

| Entry point | Buyer | SKU |
|---|---|---|
| **Event Pass M/L** | Community (lift one comp) | M ≤128 / ≤10 div · L ∞ / ≤20 (S dropped: free = 64) |
| **Size pack** | Pro subscriber exceeding a cap on one comp | one-time bump on that `competition_id` |

Suggested prices (USD set-points; INR PPP-cheap like plans):

| Pass / pack | Price | Cap |
|---|---|---|
| Event Pass **M** (base, today's $29) | $29 | ≤128 entrants · ≤10 divisions |
| Event Pass **L** | ~$59 | ∞ entrants · ≤20 divisions |

All lift the same polish features for that competition (SPEC-1 §5) and grant a one-time +25 AI credits.

**Resolved (2026-07-24):** free `entrants.per_division.max` = **64** (tunable — README §7). So Event Pass **S is dropped** (≤32 would be worse than free); ladder re-tiered to **M ≤128 · L ∞** above. If free is later re-tuned, re-check that M sits comfortably above it.

## 5. Mechanism 3 — the AI credit wallet

### 5.1 Store — append-only ledger (truth), not a counter

```
ai_credit_ledger(
  id, org_id,
  delta            int,      -- signed: +grant / −spend / +refund / −expiry
  source           enum,     -- monthly_grant | pack_purchase | run_spend
                             --  | refund | expiry | admin_adjust
  ref              text,     -- stripe_payment_intent (buys) | ai_run_id (spends)
  balance_after    int,      -- snapshot; CHECK (balance_after >= 0)
  idempotency_key  text UNIQUE,
  created_at, created_by
)
balance(org) = Σ delta
```

Rows are truth; `balance_after` is a cached snapshot + a `>= 0` guard that makes oversell impossible atomically. **Append-only** — corrections are compensating rows, never UPDATE/DELETE (it's money).

**Credit unit:** **1 credit = 1 AI run.** Run *size* is already capped per tier (entrants/divisions), so COGS is bounded. A size-weight multiplier is a documented future option if a run class blows margin (open question #3).

### 5.2 Consume — reserve → run → settle

```
1. balance < cost?  → 402 "out of credits — top up / upgrade"   (no run)
2. write HOLD row (−cost); balance_after guard blocks oversell   ← atomic, transactional
3. call model
4a. success → settle: HOLD becomes run_spend, ref = ai_run_id
4b. fail    → release: compensating +cost row (net zero; user not charged for our error)
```

- **Concurrency:** the `balance_after >= 0` CHECK + transactional insert prevents two parallel runs both grabbing the last credit. No app lock needed.
- **Idempotent:** spend keyed by `run_id` → retries / webhook replays never double-debit.
- **Spend order:** burn the resetting **monthly grant first**, then **paid packs** (never waste paid credits on the free allowance).

Enforced at **action time** in `usecases/schedule-ai.ts`, `officials-ai.ts`, `news`-auto — separate from the boolean resolver.

### 5.3 Track — the ledger rows ARE the usage record

Join to the existing run log for depth:

```
ai_credit_ledger.ref → ai_runs(model, tokens, cost_usd, competition_id)   -- lib/ai-pricing.ts
```

| Surface | Shows |
|---|---|
| Org billing page | balance · monthly grant used/remaining · packs left · run history (date, comp, model, credits) |
| `/admin` | per-org **COGS sold vs credits consumed** = live margin monitor; aggregate burn (SPEC-3) |
| Reconcile job | assert `balance_after` == running Σ — catches bug/tamper |

### 5.4 Grant + expiry rules

| Rule | Decision | Why |
|---|---|---|
| **D1** monthly grant | **reset (use-or-lose)** | grant = taste + margin floor, not a bank |
| **D2** purchased packs | **never expire** (or 24-mo cap — open) | paid money; expiring paid credits = bad will / breakage risk |
| Refund of a pack | claw back **unspent** only | can't un-consume used value |
| Grant idempotency | keyed `(org, period)` unique | cron re-run can't double-grant |

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

Currency set-points per `stripe-plans.json` pattern (USD $0.25; e.g. INR ~₹18/credit PPP — not literal FX).

## 7. Add-on catalog (summary)

| Add-on | Shape | Price | Effect |
|---|---|---|---|
| **AI credit pack** | consumable | $10→40 … $100→460 | top up wallet |
| **Size pack / Event Pass M/L** | per-comp | $29 / ~$59 | bump entrants/divisions for ONE comp |
| **Extra seat** | recurring qty | ~$4/seat/mo | +1 `members.max` |
| **Extra org** | recurring qty | $9 (Pro) / $19 (Pro Plus) | +1 `orgs.max_owned` (exists) |

## 8. Stripe products needed (when built)

- Credit packs: 4 one-time prices × currencies.
- Size packs / Event Pass S & L: one-time prices × currencies (M exists).
- Extra-seat: recurring per-unit price (extra-org exists).
- All added to `apps/web/src/config/stripe-plans.json`, synced via `stripe:sync`.

## 9. Acceptance criteria (design intent)

- [ ] `effective_cap = plan_base + Σ active add-on deltas`; lapse → freeze, not delete.
- [ ] Ledger append-only; `balance_after >= 0` blocks oversell under concurrency.
- [ ] Failed AI run nets zero credits (release path).
- [ ] Monthly grant resets and is spent before packs; packs persist.
- [ ] Pack refund claws back only unspent credits.
- [ ] Org + admin surfaces show balance, usage history, and COGS-vs-sold.

## 10. Open questions

Carried in [`README.md §7`](./README.md): credit unit (1-run vs size-weighted), pack expiry (never vs 24-mo), AI-officials gating, grant reset anchor, exact size-pack + extra-seat prices.
