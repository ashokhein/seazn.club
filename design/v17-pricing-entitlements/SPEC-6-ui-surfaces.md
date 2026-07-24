# v17/SPEC-6 — UI Surfaces (new & changed screens)

Inventory + design intent + wireframe for **every new or changed screen / page / tab / modal** in v17. Feeds the high-fidelity mockups (built with the frontend-design skill). Every user-facing string here is **i18n × 4 locales** (en/es/fr/nl) and needs **help-page** coverage — mandatory closing passes.

**Design system:** reuse the existing console theme (`.app-*` / `--mk-*`, floodlit palette), `.input`/`.label`/`.card` primitives, Barlow Condensed display. No new design language — these are new screens in the current system.

Legend: 🆕 new · ✏️ changed · 🔒 Pro Plus · 🛠️ admin · ⏳ fast-follow.

---

## A. Buyer-facing

### A1. Pricing page `/pricing` ✏️

4 tier cards + add-ons strip. Pro Plus card carries **Live** features + a **Coming soon** list.

```
┌──────────┬──────────┬───────────┬────────────────────┐
│Community │Event Pass│   Pro      │   Pro Plus          │
│  Free    │  $29 1×  │ $19/mo     │  $39/mo   [Popular] │
│          │          │            │                     │
│ 10 comps │ one event│ ∞ comps    │ everything in Pro   │
│ 64/side  │ shine    │ depth+tools│ + multi-org billing │
│ 8% fee   │ 5% fee   │ 2% fee     │ 1% fee · write API  │
│ 10 cr/mo │ +25 cr   │ 60 cr/mo   │ 200 cr/mo · operator│
│          │          │            │  ──Coming soon──    │
│[Start]   │[Buy Pass]│[Upgrade]   │ SSO·domain·SLA·…    │
└──────────┴──────────┴───────────┴────────────────────┘
  Add-ons:  ⚡AI credits from $10   ＋Extra seat   ＋Extra org   ⤢ Size pack
```

- Source: renders from `plan_entitlements` + `pricing-cards.ts` / `pricing-matrix.ts`.
- "Coming soon" items badged, **not** clickable, never gate money (SPEC-1 §6 ethics).

### A2. Plan comparison / entitlement matrix ✏️

The full feature table (expand under the cards). Rows = feature keys with a story; **no dead/seed-only keys** (SPEC-1 §9). Columns = 4 tiers with ✓ / number / "coming soon".

### A3. Org Billing → **Credits** tab 🆕

The wallet home.

```
Credits                                    [ Buy credits ]
┌────────────────────────────────────────────────────────┐
│  Balance   ┃████████░░░░  184 credits                   │
│  This month grant: 42 / 60 used · resets in 12 days     │
│  Packs: 120 (never expire)                              │
│  Auto-topup:  ◯ off   [ set up ]                        │
├────────────────────────────────────────────────────────┤
│ Run history                                             │
│  Jul 24  Div A schedule   gemini   -1   comp: Spring…   │
│  Jul 23  Officials assign grok     -1   comp: Spring…   │
│  …                                          [ export ]  │
└────────────────────────────────────────────────────────┘
```

- Balance = `sum(ledger.delta)`; grant meter = grant used vs `ai.credits.monthly`.
- Grouped org: shows **shared pool** + "shared across N orgs" note (SPEC-2 §11).

### A4. Buy Credits modal 🆕

Pack ladder; Stripe checkout in the group's locked currency (SPEC-2 §6).

```
Buy credits                                            ✕
  ◯ $10  → 40      ◯ $25 → 105  (+10%)
  ◉ $50  → 220     ◯ $100→ 460  (+30%)   ← best value
  Credits never expire · shared across your orgs
                                     [ Pay $50 ]
```

### A5. Org Billing → **Add-ons** tab 🆕

Manage recurring + one-time add-ons.

```
Add-ons
  Extra admin seats   [ – ] 2 [ + ]   $4/seat/mo   → org: [Riverside ▾]
  Extra organisations [ – ] 1 [ + ]   $19/mo
  Size packs (per competition)                 [ Buy for a competition ]
  ── active ──  +256 entrants · Spring Cup 2026 · $19 one-time
```

- Seat = `target_org_id` picker (SPEC-2 §11.3). Charge on group payer.

### A6. Out-of-credits state 🆕

Inline where an AI run is triggered (schedule board, officials).

```
⚡ Out of credits
 You've used this month's 60 and your packs are empty.
 [ Buy credits ]   [ Upgrade to Pro Plus ]   [ Turn on auto-topup ]
```

- Returned as the 402 body (SPEC-2 §5.2); never a dead end.

### A7. Event Pass buy — M/L ladder ✏️

```
Upgrade this competition — Event Pass
  ◉ M  $29   ≤128 entrants · ≤10 divisions   +25 credits
  ◯ L  $59   ∞ entrants · ≤20 divisions      +25 credits
  Covers THIS competition until it ends. New edition = new Pass.
                                     [ Buy Event Pass M ]
```

### A8. Event Pass Ended / next-edition 🆕 (SPEC-4)

```
⌛ Event Pass ended  — Spring Cup 2026 completed.
 Data stays visible. Paid features are off.
 [ Create 2027 edition ]   [ Go Pro for all competitions ]
```

- Billing pass list shows **Active** / **Ended** badges.

## B. Operator-facing 🔒 (Pro Plus, SPEC-5)

### B1. Operator console / multi-org command center 🆕

```
Operator · 3 organisations                 Pool: 512 credits [Top up]
┌───────────────┬───────────┬──────────────┬──────────────┐
│ Organisation  │ Plan seat │ Monthly cap  │ Used this mo │
│ Riverside     │  ✓        │  200         │ ███░ 142     │
│ Northside     │  ✓        │  100         │ █░░░  38     │
│ Academy U15   │  ✓        │  unlimited   │ ██░░  90     │
└───────────────┴───────────┴──────────────┴──────────────┘
  [ + Add organisation ($19/mo) ]      shared wallet · one bill
```

### B2. Per-org allocation editor 🆕

```
Allocate — Northside                                   ✕
  Monthly credit cap:  ◯ unlimited   ◉ [ 100 ]
  Used this period: 38 · resets in 12 days
                                          [ Save ]
```

## C. Admin-facing 🛠️ (SPEC-3)

### C1. `/admin/orgs/[id]` tabbed view 🆕

```
Org: Riverside FC   [Community▸Pro]  ⚑ wallet: group #s_123
[ Plan | Entitlements | Credits | Add-ons | Adjustments log ]
```

- Extends `/admin/entitlements`; reuses admin shell + `/admin/billing-events` + `/admin/revenue`.

### C2. Admin Credits tab + Grant modal 🆕

```
Credits (wallet #s_123 · shared by 3 orgs)   balance 512
  [ Grant / deduct ]
 ┌─ Grant credits ───────────────────────────┐
 │ Amount [ +50 ]   Reason [ support_goodwill ▾]│
 │ Note  [ botched run refund…             ]   │
 │ ⚠ 50 ≤ your support limit                   │
 │                         [ Cancel ] [ Grant ]│
 └────────────────────────────────────────────┘
```

- Writes `admin_adjust` ledger row (SPEC-3 §1); RBAC threshold + confirm.

### C3. Admin Entitlements tab ✏️

Existing override grid, but **only live, storied keys** (dead keys hidden per SPEC-1 §9); shows base (plan) + add-on deltas + override, resolved effective value.

### C4. Adjustments log 🆕

```
Adjustments — Riverside FC
  Jul 24  admin@   +50 credits   support_goodwill   ↩ reversible
  Jul 20  sales@   plan→Pro Plus  sales_comp        —
  Jul 18  admin@   entrants→500   grandfather       ↩
```

- Unified timeline across credits / overrides / add-ons / passes / plan (SPEC-3 §3).

## D. Fast-follow ⏳

### D1. Auto-topup settings ⏳ (SPEC-5 §3)

```
Auto-topup   ◉ on
  When balance < [ 10 ], buy [ $25 → 105 ▾ ] on •••• 4242
  Monthly cap [ $50 ]      receipts on
```

### D2. Earn-credits surfaces ⏳ (SPEC-5 §2)

Referral link + "earn credits" nudges on the Credits tab + onboarding checklist.

---

## Screen → spec → phase map

| # | Screen | Spec | Phase |
|---|---|---|---|
| A1/A2 | Pricing + matrix | SPEC-1 | 1 |
| A3/A4/A6 | Credits tab · buy · 402 | SPEC-2 | 2 |
| A5/A7 | Add-ons · Pass ladder | SPEC-2 | 3 |
| A8 | Pass ended / next-edition | SPEC-4 | 5 |
| C1–C4 | Admin tabs | SPEC-3 | 4 |
| B1/B2 | Operator console | SPEC-5 | 6 |
| D1/D2 | Auto-topup · earn | SPEC-5 | fast-follow |

## Closing passes (mandatory)

- **i18n** — every string above in en/es/fr/nl (`gen-keys` + `i18n:check`).
- **Help** — new pages: `help/billing/credits.md`, `help/billing/add-ons.md`, `help/billing/operator.md`; update `plans.md` + `event-pass.md`.
- **Frontend-design — per-screen workflow (not an upfront gallery):** when a phase builds an actual screen, design its clean UI **at build time** with the frontend-design skill → build → **Playwright screenshot-verify** light + dark → iterate until clean. The published mockup gallery (Artifact) is the **north-star reference**, not the deliverable; the real, polished screen is designed as it's developed.
