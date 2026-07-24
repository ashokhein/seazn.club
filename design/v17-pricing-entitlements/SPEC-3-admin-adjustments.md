# v17/SPEC-3 — Admin Adjustment Layer

One audited surface for staff to adjust anything money- or entitlement-related — grant credits, override caps, comp add-ons, grant passes, set plans. See [`README.md`](./README.md); wallet in [`SPEC-2`](./SPEC-2-addons-and-ai-credit-wallet.md).

---

## 1. The adjustment set

All five write an attributed, reversible row to their existing store — nothing silently mutated.

| Adjust | Writes to | Example |
|---|---|---|
| **Grant / deduct AI credits** | `ai_credit_ledger` (`source = admin_adjust`, ±N) | comp a support case, promo, fix a botched run |
| **Override a cap / feature** | `org_entitlement_overrides` (exists) | bump entrants to 500, flip a flag, grandfather |
| **Grant / revoke an add-on** | `org_addons` (`status = granted`, `stripe_item_id = null`) | comp extra seats / a size pack for a sales deal |
| **Grant an Event Pass** | `competition_passes` (staff-granted) | goodwill on one competition |
| **Set plan / extend trial** | subscription override + `restoreTrial` (exists) | beta partner on Pro Plus free; extend trial |

The credit path reuses the ledger's `admin_adjust` source + `created_by` + reason from SPEC-2 §5.1 — no new primitive.

## 2. Safety rules (money-adjacent)

| Rule | Detail |
|---|---|
| **Reason mandatory** | dropdown (`support_goodwill · sales_comp · promo · bug_fix · refund_adjust`) + free text |
| **Attributed** | `created_by` = staff user id on every row — who / what / when |
| **Reversible** | compensating row, never delete (append-only) |
| **RBAC tiers** | support can grant ≤ threshold (e.g. 50 credits / no plan change); admin unlimited |
| **Confirm modal** | grants above threshold require explicit confirm |
| **Idempotency key** | no double-grant on double-click |

## 3. Unified audit trail

Per org, a single **Adjustments log** aggregates all five sources into one timeline:

```
actor · action · target (credits / cap / add-on / pass / plan) · reason · timestamp · reversible?
```

Answers "why does this org have X?" in one place — and pairs with the SPEC-2 §5.3 margin monitor (credits granted vs COGS).

## 4. `/admin` surface

Extend the existing `/admin/entitlements` into a per-org view with tabs, reusing the admin shell + `/admin/billing-events` + `/admin/revenue`:

```
/admin/orgs/[id]
  ├─ Plan            set plan · extend/restore trial
  ├─ Entitlements    cap/feature overrides (org_entitlement_overrides)
  ├─ Credits         balance · grant/deduct · run history (ai_credit_ledger)
  ├─ Add-ons         grant/revoke seats/orgs/size-packs (org_addons)
  └─ Adjustments log unified audit timeline (§3)
```

## 5. Org-side transparency

The org sees a **friendly** line in its own history for staff grants — e.g. "+20 credits — Seazn goodwill" — building support trust. The **internal reason** (`sales_comp`, etc.) stays internal.

## 6. Ties to existing admin

- `/admin/entitlements` — extend, don't replace.
- `/admin/billing-events` — Stripe event diff/replay (exists).
- `/admin/revenue` — aggregate (exists); add credits sold vs COGS.
- `restoreTrial` — reuse for trial adjustments (exists).
- `org_entitlement_overrides` — the override store (exists); add-on grants use `org_addons`.

## 7. Acceptance criteria (design intent)

- [ ] Every adjustment writes an attributed, reason-tagged, reversible row.
- [ ] Credit grant = one `admin_adjust` ledger row; no mutable balance touched.
- [ ] RBAC threshold enforced; over-threshold needs confirm.
- [ ] Adjustments log shows all five sources in one timeline.
- [ ] Org history shows a friendly line for staff credit grants.
- [ ] No adjustment can push a balance below 0 or delete history.
