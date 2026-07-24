# v17/SPEC-5 — Operator Allocation & Credit Economy

Builds on the [`SPEC-2`](./SPEC-2-addons-and-ai-credit-wallet.md) wallet. **§1 Operator allocation ships in v17** (out-of-box move 8, Phase 6). **§2 Earn credits + §3 Auto-topup are fast-follow** (moves 9, 10) — specced here, built after the core.

**UI surfaces:** SPEC-6 §B1 (operator console), §B2 (allocation editor), §D1 (auto-topup), §D2 (earn credits).

---

## 1. Operator credit allocation (Pro Plus — v17)

### Opportunity

A Pro Plus **operator** (federation, academy network, county) has ONE shared credit pool (SPEC-2 §11). Without control, one member org can burn the whole pool. Allocation turns the shared wallet into a **mini-reseller console**: the operator hands each member org a monthly credit allowance — the Pro Plus moat, high ARPU, sticky.

### Model

```
org_credit_allocation(
  wallet_id           text,   -- the group (SPEC-2 §11)
  org_id              text,   -- member org
  monthly_cap         int,    -- NULL = unlimited share from pool (default)
  spent_this_period   int,    -- resets with the grant cycle
  updated_by, updated_at
)
```

- **Default = no row = free-for-all** from the pool (backward-compatible with SPEC-2 §11).
- **Spend check** (extends SPEC-2 §5.2 step 1):

```
allow run if
    balance(wallet) >= cost                                  -- pool has credit
AND (alloc.monthly_cap IS NULL
     OR alloc.spent_this_period + cost <= alloc.monthly_cap) -- org within its slice
```

- On settle, increment `spent_this_period` for that org.
- `spent_this_period` resets with the grant cycle; caps are editable anytime (takes effect next check).

### Operator console (UI — part of the "multi-org command center")

List member orgs · each org's monthly cap (editable) · each org's burn this period (from `spent_by_org_id`) · pool balance + top-up · buy packs. See UI inventory (SPEC-6).

## 2. Earn credits (fast-follow — move 9)

Credits as a PLG growth loop. COGS $0.12/credit but perceived $0.25 → cheap CAC.

| Source | Grant | Guard |
|---|---|---|
| Referral (referred org reaches first paid comp) | tunable (e.g. 20) | once per **referred** org; block self-referral (distinct payer/email) |
| Onboarding completion | tunable (e.g. 10) | once per org |
| First paid competition | tunable (e.g. 10) | once per org |

`source = earn_grant`, idempotent per `(wallet_id, earn_reason, ref)`; **lifetime earn cap** per wallet to bound COGS. Amounts are tunable dials.

## 3. Auto-topup (fast-follow — move 10)

Kills the "AI feels broken" 402 wall; smooths revenue.

- **Opt-in.** When `balance < threshold` (e.g. 10), auto-buy a chosen pack ($10/$25/$50/$100) on the saved default card (Stripe **off-session** payment).
- **Guards:** monthly auto-spend cap · email receipt each charge · one-click off · never on a lapsed/past-due sub.
- **Stripe (per stripe skill):** save the card with a **SetupIntent** (`usage=off_session`) at opt-in; charge with an **off-session PaymentIntent** at the threshold. Handle `authentication_required` / card decline → don't retry-loop; notify the buyer and fall back to the 402 "buy credits" state.
- Settings live on the org billing Credits tab (SPEC-6).

## 4. Phasing

| Section | Phase | Depends on |
|---|---|---|
| §1 Operator allocation | **Phase 6** (v17) | wallet (Phase 2) + billing groups (built) |
| §2 Earn credits | fast-follow | wallet (Phase 2) |
| §3 Auto-topup | fast-follow | wallet + packs (Phase 3) |

## 5. Acceptance criteria (design intent)

- [ ] Allocation caps enforced **alongside** pool balance; `NULL` cap = unlimited share; no row = free-for-all.
- [ ] `spent_this_period` increments on settle, resets with the cycle; cap edits take effect immediately.
- [ ] Earn grants idempotent per source+ref; lifetime cap holds; self-referral blocked.
- [ ] Auto-topup is opt-in, off-session, monthly-capped, receipted, disabled on past-due.
