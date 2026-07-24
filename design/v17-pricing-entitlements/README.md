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

## 3. The 4 tiers (kept — no new SKU tier)

| Tier | Axis / job | Price |
|---|---|---|
| **Community** | Attract every organizer. Run a real season, badged. | Free |
| **Event Pass** | Make ONE tournament shine without subscribing. | $29 one-time (M/L size ladder) |
| **Pro** | **Depth** — run one club/league brilliantly. | $19/mo · $159/yr |
| **Pro Plus** | **Breadth / operator** — run a network of orgs + enterprise roadmap. | $39/mo · $327/yr |

**Decision (2026-07-24):** keep the existing 4 tiers. A separate sales-led *Enterprise* SKU is **not** created now — enterprise-grade features live inside Pro Plus, the not-yet-built ones shown as **"coming soon"** (see SPEC-1 §Pro-vs-Pro-Plus). This gives Pro Plus a visible roadmap = the differentiator Pro lacks, without building an Enterprise tier prematurely.

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
| Admin | overrides + billing-events | + **credit grants + unified adjustment/audit layer** |

## 5. Spec index

| File | Covers |
|---|---|
| [`SPEC-1-plan-entitlement-matrix.md`](./SPEC-1-plan-entitlement-matrix.md) | Full 4-tier × entitlement matrix; fee ladder; feature ownership; Pro↔Pro Plus axis + coming-soon; officials ungate; scorers retire; dead-key disposition; resolver + enforcement; migration sketch |
| [`SPEC-2-addons-and-ai-credit-wallet.md`](./SPEC-2-addons-and-ai-credit-wallet.md) | 3 add-on shapes; `org_addons` additive caps; per-comp size ladder; AI credit ledger (store/consume/track); credit pricing; margin math; Stripe products |
| [`SPEC-3-admin-adjustments.md`](./SPEC-3-admin-adjustments.md) | Admin adjustment layer (credits/overrides/add-ons/passes/plan); safety rules; unified audit trail; `/admin` surface |
| [`SPEC-4-event-pass-validity.md`](./SPEC-4-event-pass-validity.md) | Event Pass auto-lock lifecycle (absorbs #248–#252): lock on end/`ends_on`, no carry to next edition, next-edition UX, help copy, 12-mo safety cap |

## 6. Relationship to open issues (`pricing-entitlements`)

| Issue | Disposition in v17 |
|---|---|
| #242 inventory | baseline (BEFORE column in SPEC-1) |
| #243 free AI COGS | **solved offensively** — AI wallet (SPEC-2), free grant = margin floor |
| #245 teams.active.max | **superseded (confirmed 2026-07-24)** — Pro↔Pro Plus axis reframe (SPEC-1 §6) replaces the knob; **close #245 as superseded**, do not ship `teams.active.max` |
| #244 scorers.max | **retire** the key (SPEC-1 §8) |
| #246 dead keys | **disposition each** — revive `stats.club_championship` as Pro Plus analytics; kill the rest (SPEC-1 §9) |
| #253 ungate officials | **included** (SPEC-1 §7) |
| #248–#252 Event Pass validity | **absorbed** — [`SPEC-4`](./SPEC-4-event-pass-validity.md) ports the full lifecycle spec + child issue map |

**Every open `pricing-entitlements` issue now has a home in v17.**

## 7. Open questions (need product call before build)

> **Tunable dials** — deliberate numbers meant to be re-tuned without a redesign: free entrants (64) · credit price ($0.25/credit) · fee ladder (8/5/2/1%) · monthly AI grants (10/60/200). Build them as config knobs, not hard constants, so they flex with data.

1. ~~Free entrants — 64 vs 32~~ → **RESOLVED: 64** (2026-07-24), flagged tunable (above). Primary COGS/abuse-vs-attraction lever; revisit if free abuse appears. Knock-on: Event Pass **S dropped** → ladder is **M ≤128 / L ∞** (SPEC-2 §4).
2. Pro `orgs.max_owned` — keep **5** base, or lower base + sell extra-org add-on harder?
3. Credit unit — **1 credit = 1 run** (simple) vs size-weighted (COGS-precise)?
4. Pack expiry — **never** vs 24-month cap (D2)?
5. AI officials auto — fully credit-metered on any tier, or keep a light Pro+ gate?
6. Build any "coming soon" Pro Plus feature now, or ship the re-org first and tease?
7. Grant reset anchor — calendar month vs billing-cycle anchor?

## 8. Non-goals

- No development in this pass — design only.
- Not deleting historical data on any downgrade/lapse (freeze pattern stays).
- Not building the sales-led Enterprise tier.
- Not changing the resolver's core order (`override → pass → plan → deny`) — only adding an additive layer.
