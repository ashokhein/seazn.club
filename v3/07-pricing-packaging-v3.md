# v3/07 — Pricing & Packaging v3: Plan Matrix, Event Pass, Multi-Currency, Marketing, Funnel

Owns intake #7 (Free/Pro reorg), #15 (per-event metered pricing), #25 (multi-currency +
annual), #10 (marketing home/pricing update), #24 (Start-competition funnel), and the
pricing-copy side of #5 (no Business anywhere). Extends engine/10 (entitlements v2).

## 1. Current state & market frame

Community: 2 active comps, 3 members, 16 entrants/div, 1 dashboard, no advanced formats.
Pro: $20/mo, $200/yr, 14-day no-card trial. Hidden `business` plan. USD only.

Market (Jul 2026): **Tournify** — free ≤8 teams, then *single-use upgrades* €40 (≤60
teams) / €120 (unlimited) or a yearly unlimited sub for 10+ events/yr. This is the
model to match: most organisers run 1–3 events/year and will never subscribe, but happily
pay per event. A subscription-only lineup leaves that revenue at zero.

## 2. Plan matrix v3 (intake #7)

Free must *demo* everything (public dashboard included — it's the viral surface) but cap
scale. Pro sells scale + brand + money features. Named limits per intake dimensions:

| Dimension | Free | Event Pass (per comp) | Pro |
|---|---|---|---|
| Organisations | 1 | 1 | 3 |
| Active competitions | 1 | the purchased one | Unlimited |
| Divisions / competition | 2 | 10 | Unlimited |
| Entrants / division | 16 | 32 | 256 |
| Members (admin/scorer seats) | 3 | 5 | 15 |
| Public dashboard | ✅ (with "Powered by Seazn" badge) | ✅ badge | ✅ badge removable |
| Advanced formats (`formats.advanced`) | — | ✅ | ✅ |
| Online registration + custom questions | ✅ | ✅ | ✅ |
| Entry fees (Stripe Connect) | — | ✅ (5% platform fee) | ✅ (2% platform fee) |
| Custom branding, exports (PDF/XLSX), slideshow realtime | — | ✅ | ✅ |
| Officials, stats/MOTM, constraints v2, API keys | — | — | ✅ |

Mechanics: pure `plan_entitlements` data change + new keys for per-comp dimensions —
the freeze machinery (`entitlement-freeze.ts`) already handles downgrade excess.
Existing free orgs over new caps: grandfather via `entitlement_overrides` (override →
plan → deny chain already supports it).

## 3. Event Pass — per-event metered pricing (intake #15)

One-time purchase that upgrades **a single competition** for its lifetime:

- **SKU:** Event Pass $39 (competition-scoped; caps per §2 column). One SKU to start —
  resist a size ladder until data demands it; Tournify's two tiers mostly price-segment
  on team count, our divisions/entrants caps do the same job.
- **Model:** `competition_passes` table (comp_id PK, org_id, stripe_payment_intent,
  pass_key, purchased_at). Entitlement resolution order becomes: org override → **comp
  pass** → plan → deny; `checkFeature()` gains optional `competition_id` context (small,
  contained change in `lib/entitlements.ts`; cache key `ent:<org>:<comp>:<feature>`).
- **Checkout:** Stripe one-time payment, embedded (existing `ui_mode: "embedded_page"`
  plumbing + `reconcileCheckout()` pattern — reconcile on return, webhook optional).
- **Upsell surfaces:** every 402 `PaymentRequiredError` gate inside a competition offers
  both paths: "Upgrade this event — $39 one-time" / "Go Pro — $20/mo". `<UpgradeGate>`
  gains the two-button variant.
- **Pro interplay:** Pro org buying a pass = blocked (nothing to add). Pass-holding org
  going Pro: no refund, pass becomes moot (fine). Downgrade from Pro: passed comps stay
  upgraded — passes are lifetime per comp.
- **Quota semantics (v3/11 gap 1):** a passed comp is exempt from the org-level
  active-competition quota (else free orgs — the pass market — could never use one);
  refund/chargeback revokes (`revoked_at`, freeze machinery); passes never carry to
  duplicated/next-edition comps.

## 4. Multi-currency + annual (intake #25)

- **Currencies:** USD / EUR / GBP / INR / AUD at launch. Stripe `currency_options` on
  each price (one price object, N currencies) — extend `stripe-plans.json` schema +
  `stripe:sync`. Checkout picks by org billing country (fallback: Accept-Language guess,
  user-switchable on the pricing page). Non-USD price points are *set*, not converted:
  €19, £16, ₹1,499, A$29 monthly (psychological pricing; INR deliberately lower — PPP
  market). Event Pass likewise (€39/£33/₹2,999/A$59).
- **Annual framing:** $200/yr already = 2 months free; *say it*: annual toggle default-on
  showing "$16.67/mo billed yearly — save 17%". Add first-year offer coupon capability
  (admin coupons exist) rather than a separate price.
- `subscriptions` gains `currency`; portal/receipts follow Stripe automatically.
- **Tax (v3/11 gap 2):** Stripe Tax (`automatic_tax`) on all checkouts; tax-inclusive
  display EU/UK/AU/IN, exclusive US; **INR = Event Pass only at launch** (RBI e-mandate
  makes INR recurring painful); entry-fee (Connect) tax stays the organiser's — say so
  in /help/billing.

## 5. Marketing pages (intake #10)

- **Home:** hero rewrite around the fastest visible proof — a live-looking fixture card
  animation ("create → generate → live in minutes") above the fold; the §6 funnel form
  as hero CTA; social-proof strip (discover-consented showcase, engine/15, already
  designed); sport tiles → use-case pages; format gallery teaser (v3/06 §4); pricing
  teaser with all **three** offers (Free / Event Pass / Pro).
- **Pricing page:** three columns (Free · Event Pass · Pro), annual toggle, currency
  switcher, comparison table = §2 matrix rendered from `plan_entitlements` data (never
  hand-copied — it drifts), FAQ (trial, what happens on downgrade/freeze, pass scope,
  fees %). No Business column; "Need more? Talk to us" mailto line covers enterprise.

## 6. Start-a-competition funnel (intake #24)

Convert before signup — the visitor invests first, authenticates second:

```
Home hero: [ sport ▾ ] [ team/player count ] [ start date ] → "Set up my competition"
   ↓ (no auth)
/start wizard (3 steps, ~60s): name it → format recommendation (v3/06 §4 strip,
   preview via format-preview API) → email capture
   ↓ POST /api/funnel/start → funnel_drafts row {payload, token, expires 7d} + magic link
email: "Your competition is ready to finish setting up" → magic-link URL carries draft token
   ↓ existing magic-link verify → postAuthLanding sees draft → creates org (if none),
     competition + division from draft → lands INSIDE the new competition, entrants tab
```

- Draft creation is idempotent (token single-use); abandoned drafts get one reminder
  email at +24h (Resend), then expire.
- Measure: draft-created → link-clicked → comp-created → dashboard-shared conversion;
  events into the existing audit/analytics path.
- This reuses onboarding pieces; the wizard *is* marketing (show the actual product:
  live format preview, not screenshots).

## 7. Acceptance sketch

Entitlement unit matrix (override/pass/plan/deny × free/pass/pro); pass checkout e2e via
SQL-flip trick analogue (memory: test-infra) + reconcile-on-return; currency snapshot of
checkout params (pure `buildEmbeddedCheckoutParams` extension — keep it unit-tested);
pricing table renders from data; funnel e2e: wizard → magic link (dev `login_url`) →
lands in created comp. Smoke: free + pass + pro paths (house rule).

Related: engine/10 entitlements, [[v3/03]] §6 Business scrub, [[v3/06]] format gallery,
[[v3/08]] admin plan flips, [[v3/10]] growth features that feed this funnel.
