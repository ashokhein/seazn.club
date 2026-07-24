# v17/SPEC-1 — Plan × Entitlement Matrix (re-org)

Owns the re-organized quota + feature matrix across the 4 tiers. See [`README.md`](./README.md) for the north star and decisions. Add-on axes and the AI wallet are in [`SPEC-2`](./SPEC-2-addons-and-ai-credit-wallet.md); admin adjustments in [`SPEC-3`](./SPEC-3-admin-adjustments.md).

**UI surfaces:** SPEC-6 §A1 (pricing page), §A2 (plan comparison / entitlement matrix), §C3 (admin entitlements grid).

---

## 1. How entitlements work (unchanged core)

| Layer | What |
|---|---|
| Matrix | `plan_entitlements(plan_key, feature_key, bool_value, int_value)` |
| Plans | `community` · `event_pass` · `pro` · `pro_plus` |
| Resolve order | org override → Event Pass (community only, per competition) → plan row → **deny** |
| Semantics | `bool false`/missing = off · `int null` = **unlimited** · missing int row = **0/deny** |
| Prices | `apps/web/src/config/stripe-plans.json` → Stripe via `stripe:sync` |
| Enforce | `requireFeature` / `withinLimit` in usecases; over-quota = **freeze, never delete** |
| Resolver | `apps/web/src/lib/entitlements.ts` |

**v17 adds one thing to the resolver:** an **additive** layer for add-ons — `effective_int = plan_base + Σ(active add-on deltas)`. Detail in SPEC-2 §3. Order and freeze semantics are otherwise unchanged.

## 2. Re-org philosophy

- **Free runs big** — loosen scale so a real club (season + cup) fits on free; monetize *polish + power + fee*, not headcount.
- **Depth vs breadth** — Pro deepens one org; Pro Plus operates many. Unlimited caps on Pro Plus are a *side-effect* of the operator job, not the pitch.
- **Officials are free infrastructure** — the umpire/scoring path is ungated on every tier (#253).
- **AI is a wallet, not a cap** — remove `scheduling.ai.runs_per_division.max`; replace with a monthly credit grant + buyable packs (SPEC-2).

## 3. Scale quotas — BEFORE → AFTER

`∞` = `int null` (unlimited). ↑ = looser than today.

| Key | Comm (before→after) | Pass | Pro | Pro Plus | Add-on |
|---|---|---:|---:|---:|---|
| `orgs.max_owned` | 1 → 1 | 1 | 5 | 10 | extra-org |
| `competitions.max_active` | 5 → **10** ↑ | 1¹ | ∞ | ∞ | — |
| `divisions.per_competition.max` | 2 → **4** ↑ | 10 | ∞ | ∞ | size-pack |
| `entrants.per_division.max` | 32 → **64** ↑ⁿ | 128/∞² | 256 | ∞ | size-pack |
| `members.max` | 3 → **5** ↑ | 5 | 15 | ∞ | extra-seat |
| `clubs.max` | 2 → **5** ↑ | 5 | 25 | ∞ | — |
| `teams.max` | 2 → **8** ↑ | 8 | 50 | ∞ | — |
| `teams.squad_max` | 20 → 20 | 25 | ∞ | ∞ | — |
| `stages.per_division.max` | 2 → 2 | 3 | 6 | ∞ | — |
| `dashboard.public.max` | 1 → 1 | 1 | ∞ | ∞ | — |
| `import.bulk` | 20 → **50** ↑ | 100 | ∞ | ∞ | — |
| `schedule.checkpoints.max` (save points) | 1 → **2** ↑ | 2 | 5 | ∞ | — |
| `officials.per_fixture.max` | 1 → **∞** | ∞ | ∞ | ∞ | ungated (#253) |
| ~~`scorers.max`~~ | 1 → **retired** | — | — | — | superseded (#244) |

¹ Event Pass covers **one** competition; a passed comp is excluded from `competitions.max_active` counting.
² Event Pass size ladder — see SPEC-2 §4. **Resolved (2026-07-24): free = 64, so the old S rung (≤32) is dropped.** Two rungs: base **M** ≤128 entrants · ≤10 div ($29) · **L** ∞ entrants · ≤20 div (~$59). Both add all polish features (§5).
ⁿ Free `entrants.per_division.max` = **64** is a **tunable dial** — the primary COGS/abuse-vs-attraction lever (README §7). Changing it re-tiers the Pass ladder.

## 4. Money engine — fee ladder + AI grant

| | Comm | Pass | Pro | Pro Plus |
|---|---:|---:|---:|---:|
| `registration.fee_percent` | 8 | 5 | 2 | 1 |
| `ai.credits.monthly` **(new)** | 10 | +25 one-time³ | 60 | 200 |
| `ai.credits.trial` **(new)** | — | — | 20⁴ | 20⁴ |

³ Event Pass grants a **one-time** +25 credit boost on purchase (not a monthly reset — Pass is one-time). Packs top up any tier (SPEC-2).
⁴ Trial of a paid tier grants a **custom one-time** credit (default 20), **once per org** (`trial_used_at` guard). Convert → monthly grant; expire → Community 10. Tunable (SPEC-2 §5.4). Prevents trial-farming for credits.

**Margin floor by design:** free's 10 credits/mo ≈ $1–5/mo max COGS per free org (blended ~$0.12/run, worst ~$0.47). #243 solved without walling AI.

## 5. Feature ownership (bool flags)

| Feature key | Comm | Pass | Pro | Pro Plus |
|---|:-:|:-:|:-:|:-:|
| `branding` (logo) | ✅ | ✅ | ✅ | ✅ |
| `officials.*` (assign / multi-role / marks) | ✅ | ✅ | ✅ | ✅ |
| `dashboard.branding` (theme colour) + badge removal | — | ✅⁴ | ✅ | ✅ |
| `formats.advanced` (double-elim, swiss+) | — | ✅ | ✅ | ✅ |
| `scoreboard.realtime` | — | ✅ | ✅ | ✅ |
| `exports.branded` | — | ✅ | ✅ | ✅ |
| `players.profiles` | — | ✅ | ✅ | ✅ |
| `sponsors.*` (tiers + monetize) | — | ✅ | ✅ | ✅ |
| `scoring.depth` (ball-by-ball / rally / DLS / device / stats) | — | — | ✅ | ✅ |
| `scheduling.board` + constraints | — | — | ✅ | ✅ |
| `discipline.enforced` | — | — | ✅ | ✅ |
| `news.auto` | — | — | ✅ | ✅ |
| `embeds.enabled` | — | — | ✅ | ✅ |
| `api.read` | — | — | ✅ | ✅ |
| `api.write` | — | — | — | ✅ |
| `support.priority` | — | — | — | ✅ |
| `ai.officials.auto` | credit-metered on **any** tier (SPEC-2) | | | |

⁴ Pass unlocks polish for **that one competition** only (resolver's pass arm is competition-scoped).

## 6. Pro vs Pro Plus — the axis + coming-soon

The differentiator is **job**, not size. Pro Plus's price is justified by its **Live** column alone; the **Coming soon** column is roadmap upside shown on the pricing card.

| **Live now** (justifies price) | **Coming soon** (roadmap) |
|---|---|
| Everything in Pro | Multi-org command center (cross-org roll-up dashboard) |
| Consolidated multi-org billing + **shared credit wallet** — *built* (billing groups, `usecases/billing-groups.ts`; wallet SPEC-2 §11) | Shared templates + branding across orgs |
| Write API + webhooks (`api.write`) | Cross-competition analytics (revive `stats.club_championship`) |
| Unlimited scale (seats / clubs / teams / entrants) | Custom domain / white-label (`domains.custom`) |
| 1% entry-fee cut | SSO / SAML |
| 200 AI credits/mo | SLA + dedicated support |
| Priority support | Data export / warehouse |
| Up to 10 orgs | Bulk / scheduled automation |

**Ethics guardrail:** never gate money on undelivered features. "Coming soon" items are badged roadmap only; the Live column stands alone. When a coming-soon feature ships, it moves to Live; if the roadmap grows, a future sales-led Enterprise tier can split off — out of scope here.

## 7. Officials — ungate (#253)

Set on **all four** plans: `officials.roles_multi = true`, `officials.marks = true`, `officials.per_fixture.max = null`. Remove `requireFeature`/`withinLimit`/UI gates for those keys in `usecases/officials.ts` + directory. **`ai.officials.auto`** (the AI Architect path) is **not** free — it is credit-metered (SPEC-2); split it off the old `officials.auto` gate so ungating manual officials doesn't give away metered AI.

## 8. Scorers — retire (#244)

Officials replaced the scorer-seat path. `scorers.max` / `role=scorer` / `scorer_assignments` stay as **dormant legacy** in the backend (still enforce if someone joins via the generic invites API) but are **removed from the pricing matrix, marketing, and help**. Do not advertise or upsell scorer seats.

## 9. Dead-key disposition (#246)

| Key | Disposition |
|---|---|
| `stats.club_championship` | **Revive** as Pro Plus cross-competition analytics (coming-soon → Live) |
| `domains.custom` | Keep Pro Plus-seeded, badged **coming soon** until the DNS product ships |
| `support.priority` | Keep (Pro Plus) — back it with a real queue, not copy-only |
| `public_pages` | **Kill** if truly unenforced, or document as seed-only |
| `eligibility.enforced` | **Kill** or document as seed-only |

Goal: `/admin/entitlements` shows no mystery rows; every live key has a story (clarity ceiling).

## 10. Enforcement sites (reference)

- Resolver: `apps/web/src/lib/entitlements.ts`
- Caps (`withinLimit`): `usecases/competitions.ts`, `entrants.ts`, `stages.ts`, `clubs.ts`, `imports.ts`, `billing-groups.ts`, `invites.ts`
- Features (`requireFeature`): scoring, scheduling, officials, news, embeds, api usecases
- Render: `lib/pricing-cards.ts`, `pricing-matrix.ts`, `entitlement-domains.ts`, `feature-copy.ts`
- Help: `apps/web/content/help/billing/plans.md`

**One-resolver guardrail:** ALL feature decisions — server usecases **and** public/read paths (`public-site/data.ts`, `embed-data.ts`, `slideshow-data.ts`) — must route through the single resolver (now additive + wallet-aware + pass-lock-aware). No path may read `plan_key` directly for a feature decision, or add-ons / wallet / pass-lock will silently not apply there.

## 11. Migration sketch (when built — not now)

1. New `plan_entitlements` delta (`V3xx`): updated ints/bools per §3–§5; new `ai.credits.monthly`; officials ungate; scorers rows removed from matrix; dead-key disposition.
2. New Stripe products (SPEC-2): AI credit packs, size packs, extra-seat. Update `stripe-plans.json` + `stripe:sync`.
3. New tables (SPEC-2): `ai_credit_ledger`, `org_addons`.
4. Render + help updates; add **"coming soon"** list to the Pro Plus pricing card.
5. Update tests/smoke that assert old caps/gates (officials 402s, entrants 32, scorers=1, AI run caps).

## 12. Acceptance criteria (design intent)

- [ ] Every tier's column matches §3–§5 exactly; no orphan keys.
- [ ] Officials work on Community (2nd official, multi-role, marks, auto via credits) — no 402.
- [ ] `scorers.max` absent from all pricing/marketing surfaces.
- [ ] Pro Plus pricing card shows Live + Coming-soon, Live justifies price alone.
- [ ] AI run enforcement reads the wallet (SPEC-2), not `runs_per_division.max`.
- [ ] `/admin/entitlements` shows only live, storied keys.
- [ ] Public-site / embed / slideshow entitlement reads go through the one resolver (test: add-on + pass-lock honored on a public page).

## 13. Open questions

Carried in [`README.md §7`](./README.md) — free entrants 64 vs 32; Pro orgs base; credit unit; pack expiry; AI-officials gating; build-vs-tease coming-soon; grant reset anchor.
