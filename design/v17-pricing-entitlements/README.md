# v17 — Pricing & Entitlement Re-organization

**Status:** DESIGN (no development yet — spec only)
**Date:** 2026-07-24
**Owner:** ashokhein
**Supersedes / organizes:** `design/v3/07-pricing-packaging-v3.md`; issues #242–#253 (label `pricing-entitlements`)
**Context:** Greenfield — **no paying customers yet**, so tiers, prices, and Stripe products can change freely with zero migration/grandfather cost.

---

## 1. North star

Re-organize entitlements so the product is **more valuable** — primarily **ARPU + expansion**, with three supporting guardrails. All four goals accepted, ranked for tie-breaks:

| Rank | Goal | Role |
|---|---|---|
| 1 | **ARPU / expansion** | drive — orgs pay more as they grow |
| 2 | **Conversion (free→paid)** | drive — smooth, well-placed upgrade triggers |
| 3 | **Margin floor** | guardrail — never ship a COGS bomb (esp. free AI) |
| 4 | **Clarity ceiling** | guardrail — never add a knob without a story |

**Tie-break rule:** chase revenue + growth, but never below the margin floor, and every new knob must earn its complexity.

## 2. Packaging model

**Model A — "tiers set scale, add-ons handle bursts."** The 4 tiers set a predictable baseline; à-la-carte **add-ons** are the expansion engine; the entry-fee ladder is the value-capture engine.

Three out-of-box moves woven through:

1. **AI is a metered wallet, not a capped feature.** The same credit ledger that *bounds* free COGS (margin floor) *is* the ARPU meter (top-ups). Turns the #243 "free AI is a leak" problem from defensive to offensive.
2. **Free runs BIG, pays for polish + power + fee** — not headcount walls. Attract every organizer; monetize brand removal, feature depth, and the fee %.
3. **Pro Plus = operator + enterprise roadmap**, not "Pro with bigger numbers." Splits Pro↔Pro Plus by *axis* (depth vs breadth), fixing the soft-differentiation flagged in #245.

**Amplifiers** (SPEC-5): operator credit allocation (v17), earn-credits + auto-topup (fast-follow). Everything ships in **phases** — see §9.

## 3. The 4 tiers (kept — no new SKU tier)

| Tier | Axis / job | Price |
|---|---|---|
| **Community** | Attract every organizer. Run a real season, badged. | Free |
| **Event Pass** | Make ONE tournament shine without subscribing. | $29 one-time (M/L size ladder) |
| **Pro** | **Depth** — run one club/league brilliantly. | $19/mo · $159/yr |
| **Pro Plus** | **Breadth / operator** — run a network of orgs + enterprise roadmap. | $39/mo · $327/yr |

**Decision (2026-07-24):** keep the existing 4 tiers. A separate sales-led *Enterprise* SKU is **not** created now — enterprise-grade features live inside Pro Plus, the not-yet-built ones shown as **"coming soon"** (SPEC-1 §6). This gives Pro Plus a visible roadmap = the differentiator Pro lacks, without building an Enterprise tier prematurely.

## 4. What changes vs today (summary)

| Area | Today | After |
|---|---|---|
| Tiers | 4 (Pro Plus = top self-serve) | 4 (Pro Plus = operator + roadmap) |
| Free scale | 5 comps · 32 entrants · 2 div | **10 comps · 64 entrants · 4 div** (runs big) |
| AI | per-division run cap (5/10/20/50) | **credit wallet**: monthly grant (10/–/60/200) + buyable packs |
| Officials | gated (per-fixture/roles/auto/marks) | **free on all tiers** (#253) |
| Scorers | `scorers.max` 1/1/1/∞ | **retired** — officials replaced it (#244) |
| Pro↔Pro Plus | soft (∞ vs caps) | **axis split** — depth vs operator + coming-soon list |
| Expansion revenue | pick a higher plan | **add-ons**: AI credits · size packs · seats · orgs |
| Trials | 14-day, tier features | + **custom trial credit** (`ai.credits.trial` ~20, once/org) |
| Multi-org (billing groups) | per-org assumptions | **group-level** — one shared credit wallet + one-payer add-ons (SPEC-2 §11) |
| Operator (Pro Plus) | shared pool only | **per-org allocation console** (SPEC-5 §1) |
| Admin | overrides + billing-events | + **credit grants + unified adjustment/audit layer** (SPEC-3) |

## 5. Spec index

| File | Covers |
|---|---|
| [`SPEC-1-plan-entitlement-matrix.md`](./SPEC-1-plan-entitlement-matrix.md) | Full 4-tier × entitlement matrix; fee ladder; Pro↔Pro Plus axis + coming-soon; officials ungate; scorers retire; dead-key disposition; **one-resolver guardrail**; migration sketch |
| [`SPEC-2-addons-and-ai-credit-wallet.md`](./SPEC-2-addons-and-ai-credit-wallet.md) | 3 add-on shapes; `org_addons` additive caps; size ladder; AI credit ledger (store/consume/track); trial + plan-change + annual rules; **billing-group wallet** (§11) |
| [`SPEC-3-admin-adjustments.md`](./SPEC-3-admin-adjustments.md) | Admin adjustment layer (credits/overrides/add-ons/passes/plan); safety rules; unified audit trail; `/admin` surface |
| [`SPEC-4-event-pass-validity.md`](./SPEC-4-event-pass-validity.md) | Event Pass auto-lock lifecycle (absorbs #248–#252): lock on end/`ends_on`, no carry to next edition, next-edition UX |
| [`SPEC-5-operator-and-credit-economy.md`](./SPEC-5-operator-and-credit-economy.md) | Operator credit allocation (v17); earn-credits + auto-topup (fast-follow) |
| [`SPEC-6-ui-surfaces.md`](./SPEC-6-ui-surfaces.md) | Every new/changed screen/page/tab/modal: pricing page, credits tab, add-ons, operator console, admin tabs — wireframes + i18n/help closing passes |

## 6. Relationship to open issues (`pricing-entitlements`)

| Issue | Disposition in v17 |
|---|---|
| #242 inventory | baseline (BEFORE column in SPEC-1) |
| #243 free AI COGS | **solved offensively** — AI wallet (SPEC-2), free grant = margin floor |
| #245 teams.active.max | **superseded (confirmed)** — Pro↔Pro Plus axis reframe (SPEC-1 §6); **close #245** |
| #244 scorers.max | **retire** the key (SPEC-1 §8) |
| #246 dead keys | **disposition each** — revive `stats.club_championship`; kill the rest (SPEC-1 §9) |
| #253 ungate officials | **included** (SPEC-1 §7) |
| #248–#252 Event Pass validity | **absorbed** — [`SPEC-4`](./SPEC-4-event-pass-validity.md) |

**Every open `pricing-entitlements` issue now has a home in v17.** New scope beyond the issues (wallet, add-ons, operator allocation, admin layer, UI) is captured in SPEC-2/3/5/6.

## 7. Resolved decisions (2026-07-24)

> **Tunable dials** — deliberate numbers, re-tuned without redesign: free entrants (64) · credit price ($0.25/credit) · fee ladder (8/5/2/1%) · monthly AI grants (10/60/200) · trial credit (~20) · earn amounts. Build as config knobs, not constants.

All resolved via the north star (ARPU > conversion > margin floor > clarity):

1. **Free entrants → 64** (tunable). Event Pass ladder M ≤128 / L ∞ (SPEC-2 §4a).
2. **Pro `orgs.max_owned` → keep 5.** The Pro↔Pro Plus line is **operator tools** (command center, shared wallet, per-org allocation, cross-org roll-up), **not** org count — a Pro user may run a few clubs; the operator *layer* is Pro Plus (SPEC-1 §6).
3. **Credit unit → 1 credit = 1 run** (simple; COGS bounded by tier size caps). Size multiplier deferred until telemetry shows a run class > ~2× median COGS.
4. **Pack expiry → 24 months** from purchase (bounds deferred-revenue liability + captures breakage; long enough to feel permanent). ⚠ **needs finance/legal sign-off** — prepaid-credit / gift-card rules vary by jurisdiction (per stripe skill + finance).
5. **Trials → custom `ai.credits.trial` ~20, once/org** (SPEC-2 §5.4).
6. **AI officials auto → credit-metered on any tier** — same model as AI scheduling (wallet-gated, not plan-gated). Consistent, and it is revenue.
7. **Grant reset anchor → billing-cycle anchor** for paid tiers (aligns with the Stripe period + proration); **creation-day calendar month** for Community.
8. **Operator allocation →** default **free-for-all** from the pool (no row = unlimited share); an org at its cap is a **hard block** (402 "ask your operator"), operator raises it instantly (SPEC-5 §1). Hard, because soft defeats the purpose.
9. **Coming-soon Pro Plus features → tease now, build post-v17** (each its own project). No v17 scope creep.

## 8. Non-goals

- No development in this pass — design only.
- Not deleting historical data on any downgrade/lapse (freeze pattern stays).
- Not building the sales-led Enterprise tier.
- Not building earn-credits / auto-topup in the core — **fast-follow** (SPEC-5 §2–3).
- Not changing the resolver's core order (`override → pass → plan → deny`) — only adding an additive layer.

## 9. Build phasing

v17 is **7 subsystems** — build in slices, each valuable + shippable alone. Order = dependency order.

| Phase | Ships | New subsystem | Value alone | Depends on |
|---|---|---|---|---|
| **1 — Re-org** ⭐ | matrix, fees, officials ungate, scorers retire, Pro↔Pro Plus labels + coming-soon, dead keys, pricing page (SPEC-6 A1/A2) | none (config + render + help) | "more valuable packaging" **immediately**, lowest risk | — |
| **2 — Wallet** | `ai_credit_ledger`, grant, reserve→settle, trial/plan-change, 402, credits tab (A3/A4/A6) | ledger | fixes #243 margin; AI metered | 1 |
| **3 — Add-ons** | `org_addons` additive, size-pack, seat, Stripe products, add-ons tab (A5/A7) | add-on billing | expansion revenue | 1,2 |
| **4 — Admin** | adjustment layer + audit, `/admin/orgs/[id]` tabs (C1–C4) | admin console | ops + support | 2,3 |
| **5 — Pass lock** | SPEC-4 auto-lock, ended/next-edition (A8) | resolver arm | closes the loophole | 1 (parallel-ok) |
| **6 — Operator** | SPEC-5 §1 allocation console (B1/B2) | operator console | Pro Plus moat | 2 + groups (built) |
| **fast-follow** | earn-credits (SPEC-5 §2), auto-topup (SPEC-5 §3), D1/D2 | — | growth + smoothing | 2,3 |

**Phase 1 is the MVP.** Every phase carries its own tests, i18n, and help pages (closing passes per SPEC-6).

**Global closing passes (every phase):** i18n × 4 locales · help pages · frontend-design + screenshot-verify · regression test that fails without the change · smoke-demo extension.
