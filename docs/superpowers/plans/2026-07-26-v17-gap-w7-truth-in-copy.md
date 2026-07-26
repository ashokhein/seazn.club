# Wave 7: truth-in-copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every customer-facing description of the Event Pass, Pro Plus and add-ons match what the resolver actually enforces today, and give #299's add-on catalog its first help page — backed by guard tests that fail if a retired feature or a stale number ever gets quoted again.
**Branch:** `fix/v17gap-w7-truth-in-copy` (git worktree — NEVER checkout in main repo dir)
**Issues:** #298 #299
**Depends on:** W1 money-leaks, W2 resolver-truth, W3 grant-correct, W4 credit-economics, W5 L-rung, W6 extra-org (all merged to main before this wave starts)

## Global Constraints

- This repo's Next.js has breaking changes vs training data — read the relevant guide in `node_modules/next/dist/docs/` before writing any Next-specific code.
- Tests: vitest, run from `apps/web`. Every behaviour change ships a regression test that FAILS without the change.
- Billing code: `BILLING_LIVE=1` live suites (`*.live.test.ts`) vs test-mode Stripe (sk_test in main repo `.env.local`; 30s timeout — 5s default times out). Follow stripe:stripe-best-practices.
- Migrations: Flyway via `npm run db:apply`; local ephemeral test PG on :54329; always `search_path=seazn_club`. Migration numbers are assigned per-wave in this plan — do not renumber.
- i18n: every new/changed user-facing string in ALL FOUR locales (en/es/fr/nl); dicts are FLAT dotted-key JSON; run gen-keys + i18n:check. Client components import `@/lib/i18n-runtime`, never `@/lib/i18n`.
- UI: app is LIGHT-ONLY (dark only under /admin). Use the frontend-design skill. Every surface clean at 375px, no horizontal page scroll; wide tables in `overflow-x:auto`. Screenshot-verify before sign-off.
- UI text: grep changed strings across e2e specs (both phases) BEFORE merging; scope assertions to a container. NEVER enable `.github/workflows/e2e.yml` — e2e runs locally: prod build + `E2E_PROD_TARGET` on :3100.
- `scripts/smoke.ts` extended for behaviour changes (pro + free paths).
- Help pages: closing pass in the SAME wave, registered in the help-slug registry.
- Branch per wave in a git worktree; verify `tsc` + unit before push; `/code-review` on the branch before merge; smoke CI only runs on PRs — always merge via PR.

## Wave-specific notes (read before starting)

1. **No migration this wave.** Everything here is prose, one Stripe-sync code path, and a design doc. `smoke.ts` is **not** extended — nothing behavioural changes (copy-only), matching the Standing rule's own scoping ("W2 lock path, W5/W6 purchase paths" — W7 isn't listed).
2. **Corrections to the audit brief, verified against current files (2026-07-26, pre-W1..W6 HEAD):**
   - `stripe-plans.json:110`'s entrant count already reads **128**, not 64 — V319 already shipped that fix. The "64→128" issue is real but lives in `event-pass.md:57` ("the pass's 64"), not in `stripe-plans.json`.
   - Help articles are **not** per-locale. `apps/web/content/help/**` is a single English Markdown tree (`HELP_ROOT = content/help`, no locale segment; `/help` is not nested under `/[lang]`). `help-content.test.ts` and `lib/help.ts` have zero locale awareness, and none of the 6 existing `content/help/billing/*.md` files have es/fr/nl variants. So Tasks 3 and 7's Markdown edits need **no** 4-locale treatment. The 4-locale rule *does* apply to Task 4 below, because that string lives in `dictionaries/*/ui.json`, not Markdown.
   - SPEC-1 §5's wrong ✅ is row **`dashboard.branding` (theme colour) + badge removal**, not the `branding` (logo) row above it — logo is correctly ✅ everywhere (V310); theme colour is correctly ✗ for the pass (V270: `('event_pass', 'dashboard.branding', false, null)`).
3. **New finding, in scope:** the *same* "AI schedule runs" / "for its lifetime" defects also live in `apps/web/src/dictionaries/*/ui.json` (`upgrade.intro`, `upgrade.active.body` — the actual in-app Event Pass purchase page, `/o/[org]/c/[comp]/upgrade`), and in `content/help/billing/plans.md`'s Q&A. Both are the same bug class the issue is about, so they're fixed here (Tasks 3 and 4).
4. **New finding, explicitly out of scope (do not fix in this wave):** `content/help/scheduling/ai-scheduling.md` still documents the fully retired per-division AI-run-cap table plus a "5 AI runs per hour per division" burst-brake claim and "Officials AI runs are not metered" (false — `ai.officials.auto` is credit-metered on every tier per SPEC-1 §5). This is a different help *section* (scheduling, not billing), not named in #298/#299's audit facts, and verifying what's real vs. dead in `schedule-ai.ts`'s current rate-limiting needs its own investigation. File a follow-up issue; do not touch this file here.
5. **Also explicitly out of scope:** `pricing-cards.ts`'s `PLUS_CARD_FEATURES` array (the `/pricing` page's Pro Plus card) lists "AI-assisted scheduling" as a differentiator bullet, same false-exclusivity claim as `stripe-plans.json:59`. **Do not touch it** — `e2e/pro-plus-tier.spec.ts:397` asserts `plusCard).toContainText("AI-assisted scheduling")` verbatim, and fixing the bullet's copy is a separate, larger UI decision (what replaces it) than this wave's remit. Only the Stripe Checkout description (`stripe-plans.json:59`) is fixed here, per the issue's own citation.
6. **Also out of scope:** `content/help/billing/downgrade.md:28` ("back on Community the rate returns to 8%") has the same under-qualified fee-lock gap as `event-pass.md:39` for a **non-passed** competition that already took a paid entry pre-downgrade — V316 locks that competition's rate too, and this sentence doesn't say so (it's saved only by the *next* line calling out passed competitions specifically). Not named in #298's audit facts; flag for a follow-up rather than fix here, to keep this wave to its cited scope.
7. **Cross-wave seam (added at assembly review): the L rung exists by the time this wave runs.** W5 (merged before W7) ships `event_pass_l` with its own `stripe-plans.json` passes entry, description, and V341 `plan_entitlements` rows (∞ entrants, ≤20 divisions), plus its own help/pricing copy. This plan's guard tests (Task 1's description-pin, Task 6's sweep) were drafted against the single `event_pass` key — **implement them iterating over every entry in `stripePlans.passes`** (both rungs, and any future rung) rather than hardcoding `"event_pass"`: pin each rung's quoted entrant/division numbers against that rung's own `plan_entitlements` rows via `capFor(cap, rung.key)`. The retired-feature-key guard needs no change (it's already a full-text sweep). When editing `event-pass.md`, verify W5's two-rung section reads consistently with your Task 3 edits rather than assuming the file matches the pre-W5 text quoted in this plan.

---

### Task 1: `stripe-plans.json` truth — Event Pass & Pro Plus descriptions + guard-test foundation

**Files:**
- Create: `apps/web/src/__tests__/plan-copy-truth.test.ts`
- Modify: `apps/web/src/config/stripe-plans.json:59` (pro_plus `product.description`), `apps/web/src/config/stripe-plans.json:110` (event_pass `product.description`)

**Interfaces:**
- Consumes: `PASS_CREDIT_GRANT` (`apps/web/src/lib/pricing-cards.ts:45`, `= 25`); `plan_entitlements` table via `sql` from `@/lib/db` (same shape as `capFor` in `apps/web/src/lib/__tests__/pricing-cards.test.ts:75-81`); `db/migration/deltas/V319__v17_phase1_reorg.sql:12` (`event_pass`/`entrants.per_division.max` = 128); `db/migration/deltas/V322__retire_ai_run_cap.sql:17` (retired `scheduling.ai.runs_per_division.max`); `db/migration/deltas/V316__competition_fee_lock.sql` (fee-lock semantics, referenced in the comment, fixed properly in Task 3).
- Produces: `plan-copy-truth.test.ts`'s `RETIRED_AI_RUN_CAP_PATTERNS` and `FALSE_PASS_PERMANENCE_PATTERNS` constants and its `stripeRenderedText` string — Tasks 3, 4 and 7 extend this same file with more surfaces scanned against the same two pattern lists.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/plan-copy-truth.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** Same shape as pricing-cards.test.ts's capFor (apps/web/src/lib/__tests__/pricing-cards.test.ts:75-81) —
 *  duplicated locally rather than imported across test files. */
const capFor = async (feature: string, plan: string): Promise<number | null> => {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
    where plan_key = ${plan} and feature_key = ${feature}`;
  expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
  return row!.int_value;
};

// v17 Phase 2 (V322, db/migration/deltas/V322__retire_ai_run_cap.sql) deleted
// `scheduling.ai.runs_per_division.max` from every plan — AI runs are metered
// by the credit wallet on every tier now, not a graded per-division count.
// These are how that dead cap has historically been marketed; their
// reappearance means a customer-facing surface is quoting a number the
// resolver no longer enforces. (Same phrase pricing-cards.test.ts already
// bans from PASS_FEATURES — apps/web/src/lib/__tests__/pricing-cards.test.ts:45-48.)
export const RETIRED_AI_RUN_CAP_PATTERNS = [/\d+\s+AI schedule runs/i, /runs per division/i];

// V328/V334 (org_has_feature) lock the Event Pass to the competition's own
// lifecycle: it stops applying once the competition is archived/completed, or
// more than 7 days past its end date. It does not last "for the event's
// lifetime" unconditionally.
export const FALSE_PASS_PERMANENCE_PATTERNS = [/for (the )?event.s lifetime/i];

// Every field Stripe actually renders to a buyer — not the "$comment*" keys,
// which are developer notes and never reach Stripe or a customer.
const stripeRenderedText = [
  ...stripePlans.plans.map((p) => p.product.description),
  ...(stripePlans.passes ?? []).map((p) => p.product.description),
  ...(stripePlans.packs ?? []).map((p) => p.product.description),
  ...(stripePlans.seats ?? []).map((p) => p.product.description),
  ...(stripePlans.size_packs ?? []).map((p) => p.product.description),
].join(" | ");

describe("stripe-plans.json names no retired feature and no false pass permanence", () => {
  it("quotes no retired per-division AI-run cap", () => {
    for (const pattern of RETIRED_AI_RUN_CAP_PATTERNS) {
      expect(stripeRenderedText).not.toMatch(pattern);
    }
  });

  it("does not claim the Event Pass lasts the competition's whole lifetime", () => {
    for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
      expect(stripeRenderedText).not.toMatch(pattern);
    }
  });
});

describe.skipIf(!HAS_DB)("stripe-plans.json quotes the numbers the matrix enforces", () => {
  it("the Event Pass description quotes the live entrant cap and the credit grant", async () => {
    const entrants = await capFor("entrants.per_division.max", "event_pass");
    const description = stripePlans.passes!.find((p) => p.key === "event_pass")!.product.description;
    expect(description).toContain(`${entrants} entrants`);
    expect(description).toContain(`+${PASS_CREDIT_GRANT} AI credits`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `npx vitest run src/__tests__/plan-copy-truth.test.ts`
Expected: FAIL — `stripeRenderedText` still contains `"10 AI schedule runs per division"` (matches both `RETIRED_AI_RUN_CAP_PATTERNS` entries) and `"for the event's lifetime"` (matches `FALSE_PASS_PERMANENCE_PATTERNS`); with `DATABASE_URL` set, the DB-gated test also fails because the description has no `+25 AI credits` substring.

- [ ] **Step 3: Write minimal implementation**

`apps/web/src/config/stripe-plans.json` — pro_plus product (line 59), before:
```json
        "description": "Everything in Pro, plus unlimited members, teams and clubs inside every organisation, a 1% platform fee on entry fees, AI-assisted scheduling, auto officials assignment, write API access and priority support. Covers up to 10 organisations on one bill — each extra organisation is half the base rate."
```
after:
```json
        "description": "Everything in Pro, plus unlimited members, teams and clubs inside every organisation, a 1% platform fee on entry fees, automatic officials assignment, write API access, priority support and the largest monthly AI credit grant. Covers up to 10 organisations on one bill — each extra organisation is half the base rate."
```
(`scheduling.ai` is `true` on every plan since V291/V302 — community, event_pass, pro and pro_plus all carry it, confirmed by grepping every `'scheduling.ai'` insert across `db/migration/deltas/*.sql` — so it is not a Pro-Plus differentiator. "the largest monthly AI credit grant" replaces it truthfully: Pro Plus's real, live AI-axis differentiator is the 200/mo wallet size, not exclusive access.)

`apps/web/src/config/stripe-plans.json` — event_pass product (line 110), before:
```json
        "description": "One-time upgrade for a single competition: 10 divisions, 128 entrants per division, advanced formats, a 5% entry-fee rate instead of 8%, branded exports, public player profiles, sponsor tiers and paid packages, realtime and 10 AI schedule runs per division — for the event's lifetime."
```
after:
```json
        "description": "One-time upgrade for a single competition, while it's active: 10 divisions, 128 entrants per division, advanced formats, a 5% entry-fee rate instead of 8%, branded exports, public player profiles, sponsor tiers and paid packages, realtime scoreboard, and a one-time +25 AI credits added to your wallet."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/plan-copy-truth.test.ts` — expect PASS (both describe blocks; DB-gated block passes if `DATABASE_URL` is set, skips cleanly otherwise).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/config/stripe-plans.json apps/web/src/__tests__/plan-copy-truth.test.ts
git commit -m "$(cat <<'EOF'
fix(billing): stop selling a dead AI-run cap and a pass that never ends

stripe-plans.json's Event Pass description still quoted the graded
per-division AI-run cap V322 retired (credits meter it now) and claimed
the pass lasts "for the event's lifetime" (V328/V334 lock it to the
competition's own lifecycle) while never mentioning the +25 credit
grant it actually includes. Pro Plus's description sold AI scheduling
as an exclusive, but it's been true on every plan since V291/V302.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `stripe-sync.ts` propagates a copy-only edit to Stripe

**Files:**
- Modify: `scripts/stripe-sync.ts:307-317` (`ensurePrice`)
- Modify: `apps/web/src/__tests__/stripe-sync.test.ts` (extend `describe("ensurePrice — flat → tiered", ...)` block's `fakeStripe` helper)
- Create: `apps/web/src/__tests__/stripe-sync.live.test.ts`

**Interfaces:**
- Consumes: `ensurePrice(stripe, spec, product, planKey, currency, productId)` (`scripts/stripe-sync.ts:292-299`, already imported by the existing unit test at `apps/web/src/__tests__/stripe-sync.test.ts:5-13`); `eventPass`, `livePrice`, `liveCurrencyOption` fixtures already defined in that file (lines 18-21, 30-42, 56-65).
- Produces: `ensurePrice` now also calls `stripe.products.update(...)` when the live product's `name`/`description` differ from the seed, independent of whether the price itself drifted. Task 1's JSON edit needs this to actually reach Stripe — without it, `products.update` is never called anywhere in the script (verified: `scripts/stripe-sync.ts` has exactly one Products API call today, `products.create` at line 333, gated behind "no existing price found at all").

**Why this is necessary:** `ensurePrice` finds the Event Pass price by `lookup_key`, and if neither the amount nor the tier structure drifted it returns immediately (`return { priceId: p.id, productId: prod }`, line 317) — it never looks at `product.name`/`product.description` at all. A copy-only edit like Task 1's would run `npm run stripe:sync` and silently do nothing to the live Stripe product. The `list` call already expands `data.product` (line 305), so the live product object (not just its id) is already in hand — no extra API call needed to compare it.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/__tests__/stripe-sync.test.ts`, after the existing `describe("ensurePrice — flat → tiered", ...)` block:

```ts
describe("ensurePrice — product copy sync", () => {
  function fakeProduct(over: Partial<Stripe.Product>): Stripe.Product {
    return {
      id: "prod_1",
      object: "product",
      name: "old name",
      description: "old description",
      ...over,
    } as Stripe.Product;
  }

  function fakeStripeWithProduct(product: Stripe.Product) {
    const price = livePrice({
      unit_amount: eventPass.unit_amount,
      billing_scheme: "per_unit",
      currency_options: Object.fromEntries(
        Object.entries(eventPass.currency_options ?? {}).map(([c, a]) => [
          c,
          liveCurrencyOption({ unit_amount: a }),
        ]),
      ),
      product,
    });
    const list = vi.fn<(p: Stripe.PriceListParams) => Promise<Stripe.ApiList<Stripe.Price>>>(
      async () => ({ data: [price] }) as Stripe.ApiList<Stripe.Price>,
    );
    const priceUpdate = vi.fn<(id: string, p: Stripe.PriceUpdateParams) => Promise<Stripe.Price>>(
      async () => price,
    );
    const create = vi.fn<(p: Stripe.PriceCreateParams) => Promise<Stripe.Price>>(
      async () => ({ id: "price_new" }) as Stripe.Price,
    );
    const productsUpdate = vi.fn<
      (id: string, p: Stripe.ProductUpdateParams) => Promise<Stripe.Product>
    >(async () => product);
    return {
      stripe: {
        prices: { list, create, update: priceUpdate },
        products: { create: vi.fn(), update: productsUpdate },
      } as unknown as Stripe,
      priceUpdate,
      productsUpdate,
    };
  }

  it("updates the live product when the seed's copy changed but the price did not", async () => {
    const { stripe, productsUpdate, priceUpdate } = fakeStripeWithProduct(
      fakeProduct({ name: "Seazn Club Event Pass", description: "old description" }),
    );
    const out = await ensurePrice(
      stripe,
      eventPass,
      { name: "Seazn Club Event Pass", description: "new description" },
      "event_pass",
      "usd",
      null,
    );
    expect(out.priceId).toBe("price_old"); // the price itself is untouched
    expect(productsUpdate).toHaveBeenCalledWith("prod_1", {
      name: "Seazn Club Event Pass",
      description: "new description",
    });
    expect(priceUpdate).not.toHaveBeenCalled();
  });

  it("does not call products.update when name and description already match", async () => {
    const { stripe, productsUpdate } = fakeStripeWithProduct(
      fakeProduct({ name: "Seazn Club Event Pass", description: "Same description" }),
    );
    await ensurePrice(
      stripe,
      eventPass,
      { name: "Seazn Club Event Pass", description: "Same description" },
      "event_pass",
      "usd",
      null,
    );
    expect(productsUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/stripe-sync.test.ts`
Expected: FAIL — the first new test's `expect(productsUpdate).toHaveBeenCalledWith(...)` fails because `productsUpdate` was never called (current `ensurePrice` never touches `stripe.products.update`).

- [ ] **Step 3: Write minimal implementation**

`scripts/stripe-sync.ts`, inside `ensurePrice`, before:
```ts
  if (found.data[0]) {
    const p = found.data[0];
    const prod = typeof p.product === "string" ? p.product : p.product.id;
    // The base currency is immutable too, and a price minted under the wrong one
    // charges every group in the wrong money — cheap to check here, where the
    // seed's currency is in scope (priceHasDrifted only sees the spec).
    const currencyDrift = p.currency !== currency;
```
after:
```ts
  if (found.data[0]) {
    const p = found.data[0];
    const prod = typeof p.product === "string" ? p.product : p.product.id;
    // Product name/description are MUTABLE Stripe fields, unlike the price
    // amounts below — sync them on every run regardless of whether the price
    // itself drifted, so a copy-only stripe-plans.json edit still reaches
    // Stripe. `data.product` is expanded in the `list` call above, so a live
    // product usually arrives as a full object here, not a bare id; when it
    // doesn't (a deleted product, or an unexpanded response) there is nothing
    // to compare against, so this is a silent no-op rather than a second call.
    if (
      typeof p.product !== "string" &&
      p.product !== null &&
      !("deleted" in p.product && p.product.deleted)
    ) {
      const live = p.product;
      if (live.name !== product.name || (live.description ?? "") !== (product.description ?? "")) {
        await stripe.products.update(prod, { name: product.name, description: product.description });
        console.log(`  ↳ ${spec.lookup_key}: product copy updated (${prod})`);
      }
    }
    // The base currency is immutable too, and a price minted under the wrong one
    // charges every group in the wrong money — cheap to check here, where the
    // seed's currency is in scope (priceHasDrifted only sees the spec).
    const currencyDrift = p.currency !== currency;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/stripe-sync.test.ts` — expect all tests PASS, including the pre-existing `ensurePrice — flat → tiered` block (its fixtures use a bare string `product: "prod_1"`, so `typeof p.product !== "string"` is `false` there and the new branch is skipped — no regression).

- [ ] **Step 5: Write the live verification test**

Create `apps/web/src/__tests__/stripe-sync.live.test.ts`:

```ts
// LIVE verification that stripe-sync.ts propagates a copy-only edit
// (name/description) to an EXISTING Stripe product — #298's "run stripe:sync
// and verify the rendered Checkout copy" step, made concrete and repeatable.
// Before the products.update fix in ensurePrice, a copy edit to
// stripe-plans.json with an unchanged price silently never reached Stripe.
// Self-contained: mints its own scratch product+price under a throwaway
// lookup_key, never the real seed's — it never touches the real Event Pass
// product. Skipped unless BILLING_LIVE=1. Run (from apps/web):
//   BILLING_LIVE=1 STRIPE_SECRET_KEY=sk_test_... \
//     npx vitest run src/__tests__/stripe-sync.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { ensurePrice } from "../../../scripts/stripe-sync.ts";

const LIVE =
  process.env.BILLING_LIVE === "1" && (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test");

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
});

describe.skipIf(!LIVE)("stripe-sync product copy (live Stripe, test mode)", () => {
  it(
    "a description-only seed edit reaches the live product on the next sync",
    async () => {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const lookupKey = `seazn_copy_probe_${Date.now()}`;
      const spec = { lookup_key: lookupKey, unit_amount: 500, currency_options: { eur: 500 } };

      // First sync: mints the product+price with the OLD description.
      const first = await ensurePrice(
        stripe,
        spec,
        { name: "Copy probe", description: "old description" },
        "copy_probe",
        "usd",
        null,
      );
      cleanup.push(() => stripe.prices.update(first.priceId, { active: false }));
      cleanup.push(() => stripe.products.update(first.productId, { active: false }));

      const before = await stripe.products.retrieve(first.productId);
      expect(before.description).toBe("old description");

      // Second sync: same price (no drift), NEW description only.
      const second = await ensurePrice(
        stripe,
        spec,
        { name: "Copy probe", description: "new description" },
        "copy_probe",
        "usd",
        null,
      );
      expect(second.priceId).toBe(first.priceId); // proves the price itself never changed

      const after = await stripe.products.retrieve(second.productId);
      expect(after.description).toBe("new description");
    },
    30_000,
  );
});
```

- [ ] **Step 6: Run the live test, then run the real sync**

```bash
cd apps/web
BILLING_LIVE=1 STRIPE_SECRET_KEY=sk_test_... npx vitest run src/__tests__/stripe-sync.live.test.ts
# then, once the live test passes, sync Task 1's edits to the test-mode account:
cd ..
STRIPE_SECRET_KEY=sk_test_... npm run stripe:sync
```
Expected: the live test passes (proves the propagation mechanism works); the real sync run logs `↳ seazn_event_pass: product copy updated (prod_...)` and `↳ seazn_pro_plus_monthly: product copy updated (prod_...)` (or the annual price's lookup key, whichever `ensurePrice` call reaches the product first — a product is shared between the monthly/annual price calls per plan, so only the first to run touches it) confirming the new description reads back correctly. Spot-check with `stripe products retrieve <id>` or the Stripe Dashboard (test mode) — the description shown should match Task 1's new text.

- [ ] **Step 7: Commit**

```bash
git add scripts/stripe-sync.ts apps/web/src/__tests__/stripe-sync.test.ts apps/web/src/__tests__/stripe-sync.live.test.ts
git commit -m "$(cat <<'EOF'
fix(billing): stripe-sync now propagates product copy edits

ensurePrice only ever called products.create, and only when no price
existed at all — a copy-only stripe-plans.json edit against an
already-live product silently never reached Stripe. Sync name/
description on every run instead, independent of price drift.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Help-page truth — `event-pass.md` + `plans.md`

**Files:**
- Modify: `apps/web/content/help/billing/event-pass.md:20,39,48,57,71`
- Modify: `apps/web/content/help/billing/plans.md:13,65`
- Modify: `apps/web/src/__tests__/plan-copy-truth.test.ts` (extend Task 1's file)

**Interfaces:**
- Consumes: `RETIRED_AI_RUN_CAP_PATTERNS`, `FALSE_PASS_PERMANENCE_PATTERNS`, `capFor` from Task 1 (same file); `PASS_COMPARE_ROWS` (`apps/web/src/lib/pass-comparison.ts:42-63` — confirms the live upgrade-page comparison table has **no** AI-runs row since V322, so `event-pass.md:71`'s claim that the table shows "AI schedule runs" is describing a row that doesn't exist); `V316__competition_fee_lock.sql` + `effectiveFeePercentFor` (`apps/web/src/server/usecases/registrations.ts:85-93`) for the corrected fee-lock wording.
- Produces: extends `stripeRenderedText`-style scanning to `content/help/billing/*.md` as `helpBillingText`, reused unmodified by Task 7.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/__tests__/plan-copy-truth.test.ts`, add the imports and a new text source, then extend both existing `describe` blocks and add two new DB-gated tests:

```ts
// add to the top imports:
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// add near stripeRenderedText:
const HELP_BILLING_DIR = join(process.cwd(), "content", "help", "billing");
const helpBillingText = readdirSync(HELP_BILLING_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => readFileSync(join(HELP_BILLING_DIR, f), "utf8"))
  .join(" | ");
```

Change the two existing `it`s in the first `describe` to also scan `helpBillingText`:

```ts
  it("quotes no retired per-division AI-run cap", () => {
    for (const pattern of RETIRED_AI_RUN_CAP_PATTERNS) {
      expect(stripeRenderedText).not.toMatch(pattern);
      expect(helpBillingText, "content/help/billing/*.md").not.toMatch(pattern);
    }
  });

  it("does not claim the Event Pass lasts the competition's whole lifetime", () => {
    for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
      expect(stripeRenderedText).not.toMatch(pattern);
      expect(helpBillingText, "content/help/billing/*.md").not.toMatch(pattern);
    }
  });
```

Add two new tests to the DB-gated `describe.skipIf(!HAS_DB)` block:

```ts
  it("the Event Pass help article quotes the live entrant cap and the credit grant", async () => {
    const entrants = await capFor("entrants.per_division.max", "event_pass");
    const text = readFileSync(join(HELP_BILLING_DIR, "event-pass.md"), "utf8");
    expect(text).toContain(`${entrants} entrants`);
    expect(text).toContain(`+${PASS_CREDIT_GRANT} AI credits`);
    expect(text).not.toContain("pass's 64"); // the wrong number this task fixes
  });

  it("Plans at a glance quotes the live Event Pass entrant cap and credit grant", async () => {
    const entrants = await capFor("entrants.per_division.max", "event_pass");
    const text = readFileSync(join(HELP_BILLING_DIR, "plans.md"), "utf8");
    expect(text).toContain(`${entrants} entrants`);
    expect(text).toContain(`${PASS_CREDIT_GRANT} AI credits`);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/plan-copy-truth.test.ts`
Expected: FAIL — `helpBillingText` contains `"10 AI schedule runs per division"`, `"20 AI schedule runs"`, `"runs per division"` (event-pass.md) and `"5 / 10 / 20 / 50"` alongside "AI Schedule runs on every plan" (plans.md — note: this exact wording is fine, see Step 3's replacement, which avoids the banned phrase); `"for that event's lifetime"` (plans.md:13); and the DB-gated `event-pass.md` test fails on `expect(text).not.toContain("pass's 64")`.

- [ ] **Step 3: Write minimal implementation**

`apps/web/content/help/billing/event-pass.md` — 5 edits:

Line 20, before:
```markdown
- **10 AI schedule runs** per division, up from Community's 5 ([AI Schedule](/help/scheduling/ai-scheduling)).
```
after:
```markdown
- **A one-time +25 AI credits**, added straight to your wallet on top of your plan's monthly grant ([AI credits](/help/billing/credits)).
```

Line 39 (the "when a pass stops applying" paragraph), before:
```markdown
When that happens the event stays fully **readable** — nothing you built is deleted — but the paid-for-running lifts switch off: the entrant and division headroom drops back to your plan's limits, branded exports return to plain tables, the realtime board and sponsor tools stop, and the platform fee returns to your plan's rate. It's the same fallback as a downgrade, scoped to that one finished event.
```
after:
```markdown
When that happens the event stays fully **readable** — nothing you built is deleted — but the paid-for-running lifts switch off: the entrant and division headroom drops back to your plan's limits, branded exports return to plain tables, and the realtime board and sponsor tools stop. The platform fee works differently: once this competition has taken its first paid entry, that rate is **locked in for the rest of the competition** and does not rise when the pass stops applying — only a competition that never took a paid entry moves to your plan's live rate. It's the same fallback as a downgrade, scoped to that one finished event.
```

Line 48, before:
```markdown
- Refunding a pass — or losing a chargeback on one — **revokes it**: the competition drops back to your plan's normal limits and the owner gets an email. Nothing you've built is deleted; the extra divisions, the entrant headroom, branded exports and the sponsor tools simply switch off and the platform fee returns to your plan's rate, exactly like a downgrade.
```
after:
```markdown
- Refunding a pass — or losing a chargeback on one — **revokes it**: the competition drops back to your plan's normal limits and the owner gets an email. Nothing you've built is deleted; the extra divisions, the entrant headroom, branded exports and the sponsor tools simply switch off, exactly like a downgrade. The entry-fee rate is untouched if the competition already took a paid entry — [it's locked in for good](#when-a-pass-stops-applying) — and only moves to your plan's rate if it never did.
```

Line 57, before:
```markdown
**Can I buy a pass on top of Pro?** No — and you wouldn't want to. Every paid plan grants strictly more than the pass does: Pro allows **256 entrants** per division against the pass's 64, and **20 AI schedule runs** against 10. So while you're on a paid plan, upgrade prompts inside your competitions don't offer the pass at all — they show your plan's next step on its own — and the purchase itself is blocked with a note.
```
after:
```markdown
**Can I buy a pass on top of Pro?** No — and you wouldn't want to. Every paid plan grants strictly more than the pass does: Pro allows **256 entrants** per division against the pass's 128, and every AI feature already runs on your plan's own credit wallet — a pass would only add a one-time top-up you don't need. So while you're on a paid plan, upgrade prompts inside your competitions don't offer the pass at all — they show your plan's next step on its own — and the purchase itself is blocked with a note.
```

Line 71, before:
```markdown
**What does the competition's upgrade page show me?** Whatever is true for that competition. Before you buy: the price, and a table of what changes — divisions, entrants per division, AI schedule runs, the platform fee and the organiser extras — read straight from the live plan limits, so the numbers on it are the numbers we actually enforce. If you're not the owner, the same page without a checkout, so you know what to ask for. After you buy: the date you bought it and a link to the **receipt**, plus the Pro step and what a pass credits toward it. If you're on a paid plan it shows your plan against Free and offers no pass at all — buying one would give you less than you hold.
```
after:
```markdown
**What does the competition's upgrade page show me?** Whatever is true for that competition. Before you buy: the price, and a table of what changes — divisions, entrants per division, the platform fee and the organiser extras — read straight from the live plan limits, so the numbers on it are the numbers we actually enforce. If you're not the owner, the same page without a checkout, so you know what to ask for. After you buy: the date you bought it and a link to the **receipt**, plus the Pro step and what a pass credits toward it. If you're on a paid plan it shows your plan against Free and offers no pass at all — buying one would give you less than you hold.
```

`apps/web/content/help/billing/plans.md` — 2 edits:

Line 13, before:
```markdown
## Event Pass — $29 one-time

One-time upgrade for a single competition, for that event's lifetime, without a subscription: **128 entrants** per division, up to **10 divisions**, branded exports, public player cards, sponsor tiers and paid packages, the realtime scoreboard and slideshow, advanced formats including double elimination, a one-time top-up of **25 AI credits**, and a **5% platform fee** on entry fees instead of 8%. Your brand **colour** is not part of it — that stays Pro. A passed competition doesn't count against your active-competition limit. Right for the annual tournament that doesn't justify a year of Pro. It doesn't carry to next year's edition. [What the pass buys, in full](/help/billing/event-pass).
```
after:
```markdown
## Event Pass — $29 one-time

One-time upgrade for a single competition, while it runs, without a subscription: **128 entrants** per division, up to **10 divisions**, branded exports, public player cards, sponsor tiers and paid packages, the realtime scoreboard and slideshow, advanced formats including double elimination, a one-time top-up of **25 AI credits**, and a **5% platform fee** on entry fees instead of 8%. Your brand **colour** is not part of it — that stays Pro. A passed competition doesn't count against your active-competition limit. Right for the annual tournament that doesn't justify a year of Pro. It doesn't carry to next year's edition. [What the pass buys, in full](/help/billing/event-pass).
```

Line 65, before:
```markdown
**Is AI Schedule a paid feature?** No — AI Schedule runs on every plan, including Community. Only the number of runs per division differs (5 / 10 / 20 / 50), and automatic *officials* assignment is separate and Pro Plus. See [AI Schedule](/help/scheduling/ai-scheduling).
```
after:
```markdown
**Is AI Schedule a paid feature?** No — AI Schedule and AI officials both run on every plan, including Community, metered by your **AI credit wallet** instead of a per-plan run cap: 10 credits a month on Community, 60 on Pro, 200 on Pro Plus, plus any pack or Event Pass top-up. Automatic *officials* assignment (the auto-run mode, not AI access itself) stays Pro Plus. See [AI Schedule](/help/scheduling/ai-scheduling) and [AI credits](/help/billing/credits).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/plan-copy-truth.test.ts` — expect PASS.

- [ ] **Step 5: e2e safety check (see Task 6) then commit**

```bash
git add apps/web/content/help/billing/event-pass.md apps/web/content/help/billing/plans.md apps/web/src/__tests__/plan-copy-truth.test.ts
git commit -m "$(cat <<'EOF'
docs(help): fix Event Pass and AI-schedule copy in billing help

event-pass.md and plans.md both still quoted the retired per-division
AI-run cap, understated the pass's entrant cap in one spot (64 instead
of 128), promised the fee "returns to plan rate" (false once a
competition has locked its rate, V316), and claimed the pass lasts
"for that event's lifetime" (V328/V334 lock it to the competition's
own status/end date instead).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: In-app purchase page truth — `upgrade.intro` + `upgrade.active.body` (4 locales)

**Files:**
- Modify: `apps/web/src/dictionaries/en/ui.json:778,782`
- Modify: `apps/web/src/dictionaries/es/ui.json:778,782`
- Modify: `apps/web/src/dictionaries/fr/ui.json:778,782`
- Modify: `apps/web/src/dictionaries/nl/ui.json:778,782`
- Modify: `apps/web/src/__tests__/plan-copy-truth.test.ts` (extend Task 1/3's file)

**Interfaces:**
- Consumes: `FALSE_PASS_PERMANENCE_PATTERNS` from Task 1 (same file); usage sites `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx:294` (`t(dict, held ? "upgrade.active.body" : "upgrade.intro")`) and `:307` (`upgrade.active.title`, unchanged).
- Produces: nothing new consumed downstream — this is a leaf fix. Deliberately does **not** touch the page's state logic (`held` boolean) or add a lock-aware third state — that's W8 (#301)'s remit (`competition-pass-entry.tsx`'s eligible/live/ended states), a different component. This task only removes the false permanence claim from the two states that already exist.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/__tests__/plan-copy-truth.test.ts`, add:

```ts
it("the in-app upgrade page's own copy does not claim the pass lasts forever", () => {
  const en = JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8")) as Record<string, string>;
  for (const key of ["upgrade.intro", "upgrade.active.body"]) {
    for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
      expect(en[key], key).not.toMatch(pattern);
    }
    expect(en[key], key).not.toMatch(/\bforever\b/i);
  }
});
```

(`readFileSync`/`join` are already imported from Task 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/plan-copy-truth.test.ts`
Expected: FAIL — `en["upgrade.intro"]` is `"One payment upgrades this competition for its lifetime — no subscription, and it survives forever even if you never go Pro."`, matching both the permanence pattern and `/\bforever\b/i`; `en["upgrade.active.body"]` matches the permanence pattern too.

- [ ] **Step 3: Write minimal implementation**

`apps/web/src/dictionaries/en/ui.json`, before:
```json
  "upgrade.active.body": "This competition is upgraded for its lifetime — divisions, entrants, formats, fees, branding and exports are all unlocked here.",
```
```json
  "upgrade.intro": "One payment upgrades this competition for its lifetime — no subscription, and it survives forever even if you never go Pro.",
```
after:
```json
  "upgrade.active.body": "This competition is upgraded while it's running — divisions, entrants, formats, fees, branding and exports are all unlocked here.",
```
```json
  "upgrade.intro": "One payment upgrades this competition while it's running — no subscription, and it stays in place even if you never go Pro.",
```

`apps/web/src/dictionaries/es/ui.json`, before:
```json
  "upgrade.active.body": "Esta competición está mejorada de por vida — divisiones, participantes, formatos, cuotas, personalización y exportaciones están todos desbloqueados aquí.",
```
```json
  "upgrade.intro": "Un solo pago mejora esta competición de por vida — sin suscripción, y se conserva para siempre aunque nunca pases a Pro.",
```
after:
```json
  "upgrade.active.body": "Esta competición está mejorada mientras está en curso — divisiones, participantes, formatos, cuotas, personalización y exportaciones están todos desbloqueados aquí.",
```
```json
  "upgrade.intro": "Un solo pago mejora esta competición mientras está en curso — sin suscripción, y se mantiene aunque nunca pases a Pro.",
```

`apps/web/src/dictionaries/fr/ui.json`, before:
```json
  "upgrade.active.body": "Cette compétition est améliorée à vie — divisions, participants, formats, frais, image de marque et exports sont tous débloqués ici.",
```
```json
  "upgrade.intro": "Un seul paiement améliore cette compétition à vie — pas d'abonnement, et elle reste valable pour toujours même si vous ne passez jamais à Pro.",
```
after:
```json
  "upgrade.active.body": "Cette compétition est améliorée tant qu'elle est en cours — divisions, participants, formats, frais, image de marque et exports sont tous débloqués ici.",
```
```json
  "upgrade.intro": "Un seul paiement améliore cette compétition tant qu'elle est en cours — pas d'abonnement, et cela reste en place même si vous ne passez jamais à Pro.",
```

`apps/web/src/dictionaries/nl/ui.json`, before:
```json
  "upgrade.active.body": "Deze competitie is voor de volledige levensduur geüpgraded — divisies, deelnemers, formats, kosten, branding en exports zijn hier allemaal ontgrendeld.",
```
```json
  "upgrade.intro": "Eén betaling upgradet deze competitie voor de volledige levensduur — geen abonnement, en het blijft voor altijd behouden, zelfs als je nooit Pro neemt.",
```
after:
```json
  "upgrade.active.body": "Deze competitie is geüpgraded zolang ze loopt — divisies, deelnemers, formats, kosten, branding en exports zijn hier allemaal ontgrendeld.",
```
```json
  "upgrade.intro": "Eén betaling upgradet deze competitie zolang ze loopt — geen abonnement, en dat blijft zo, ook als je nooit Pro neemt.",
```

(Translations are translate-of-en for review by a fluent speaker before merge — the load-bearing content is that all three drop "de por vida"/"à vie"/"voor de volledige levensduur" and "para siempre"/"pour toujours"/"voor altijd", the same permanence claim the English fix removes.)

- [ ] **Step 4: Run test to verify it passes, then check parity**

```bash
cd apps/web && npx vitest run src/__tests__/plan-copy-truth.test.ts
cd .. && npm run i18n:check
```
Expected: vitest PASS; `i18n:check` PASS (key *parity* across locales is unaffected — no keys added or removed, only 8 existing values across 4 files changed).

- [ ] **Step 5: e2e safety check (see Task 6) then commit**

```bash
git add apps/web/src/dictionaries/*/ui.json apps/web/src/__tests__/plan-copy-truth.test.ts
git commit -m "$(cat <<'EOF'
fix(i18n): stop the Event Pass purchase page promising forever

upgrade.intro and upgrade.active.body (the actual in-app Event Pass
purchase page, /o/[org]/c/[comp]/upgrade) claimed the pass lasts "for
its lifetime" and "survives forever" — the same false permanence
claim as the Stripe/help copy fixed elsewhere this wave, but on the
page a buyer actually sees before paying. All four locales.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `pricing-cards.ts` "forever" bullet + SPEC-1 §5 spec correction

**Files:**
- Modify: `apps/web/src/lib/pricing-cards.ts:26`
- Modify: `apps/web/src/lib/__tests__/pricing-cards.test.ts`
- Modify: `design/v17-pricing-entitlements/SPEC-1-plan-entitlement-matrix.md:70,74`

**Interfaces:**
- Consumes: `PASS_FEATURES` export (`apps/web/src/lib/pricing-cards.ts:25-38`), already imported by `pricing-cards.test.ts:5`; `db/migration/deltas/V270__pricing_v3_matrix.sql:35` (`('event_pass', 'dashboard.branding', false, null)` — confirms the spec row this task corrects).
- Produces: nothing downstream; both edits are leaves.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/lib/__tests__/pricing-cards.test.ts`, inside the existing `describe("pricing cards", ...)` block (after the "the Event Pass card quotes the +25 one-time credit grant" test):

```ts
  // V328/V334 (org_has_feature) lock the Event Pass to the competition's own
  // lifecycle — it stops applying once the competition ends. The card's own
  // headline bullet must not promise otherwise.
  it("the Event Pass card does not claim the upgrade lasts forever", () => {
    expect(PASS_FEATURES.join(" | ")).not.toMatch(/\bforever\b/i);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/pricing-cards.test.ts`
Expected: FAIL — `PASS_FEATURES[0]` is currently `"Upgrades ONE competition, forever"`.

- [ ] **Step 3: Write minimal implementation**

`apps/web/src/lib/pricing-cards.ts`, before:
```ts
export const PASS_FEATURES = [
  "Upgrades ONE competition, forever",
  "10 divisions, 128 entrants each",
```
after:
```ts
export const PASS_FEATURES = [
  "Upgrades ONE competition while it runs",
  "10 divisions, 128 entrants each",
```

(Verified zero e2e collisions: `grep -rn "Upgrades ONE competition" apps/web/e2e` returns no hits.)

`design/v17-pricing-entitlements/SPEC-1-plan-entitlement-matrix.md`, before:
```markdown
| Feature key | Comm | Pass | Pro | Pro Plus |
|---|:-:|:-:|:-:|:-:|
| `branding` (logo) | ✅ | ✅ | ✅ | ✅ |
| `officials.*` (assign / multi-role / marks) | ✅ | ✅ | ✅ | ✅ |
| `dashboard.branding` (theme colour) + badge removal | — | ✅⁴ | ✅ | ✅ |
```
after:
```markdown
| Feature key | Comm | Pass⁴ | Pro | Pro Plus |
|---|:-:|:-:|:-:|:-:|
| `branding` (logo) | ✅ | ✅ | ✅ | ✅ |
| `officials.*` (assign / multi-role / marks) | ✅ | ✅ | ✅ | ✅ |
| `dashboard.branding` (theme colour) + badge removal | — | — | ✅ | ✅ |
```
and, further down, before:
```markdown
⁴ Pass unlocks polish for **that one competition** only (resolver's pass arm is competition-scoped).
```
after:
```markdown
⁴ Pass unlocks polish for **that one competition** only (resolver's pass arm is competition-scoped) — except `dashboard.branding` (the org's theme colour) and badge removal, which stay Pro-only: the pass carries your logo, not your palette (V270: `('event_pass', 'dashboard.branding', false, null)`; `pricing-cards.ts`'s `PASS_FEATURES` comment says the same).
```

(No test for the SPEC-1 edit — it's prose in a design doc, not code; correctness is the citation to `V270__pricing_v3_matrix.sql:35` above, already independently verified.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/pricing-cards.test.ts` — expect PASS (all tests, including the pre-existing ones — no regression).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/pricing-cards.ts apps/web/src/lib/__tests__/pricing-cards.test.ts design/v17-pricing-entitlements/SPEC-1-plan-entitlement-matrix.md
git commit -m "$(cat <<'EOF'
fix(pricing): pass card and SPEC-1 stop claiming permanence/branding

/pricing's Event Pass card said "forever"; SPEC-1 §5 marked
dashboard.branding (theme colour) granted to the pass when V270 denies
it (only the logo is free everywhere). Code was already right in both
cases — this brings the card copy and the design doc in line with it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: e2e text-safety audit (verification, no code)

**Files:** none modified — this task documents the grep audit required before merging Tasks 1-5 and 7's UI-text changes, per the Standing rule ("UI text changes break e2e" — grep the TEXT across e2e, both phases, before merging).

**Interfaces:** Consumes every changed literal string from Tasks 1-5 and 7. Both e2e "phases" (`playwright.config.ts:47` `parallel` project and `:53` `serial` project, per `package.json:15`'s `test:e2e` script) share one spec directory (`apps/web/e2e/*.spec.ts`, partitioned by `testMatch`, not by folder), so one flat grep covers both.

- [ ] **Step 1: Re-run the audit grep after all content edits land (already run once during planning — repeat as a final gate)**

```bash
cd apps/web/e2e
grep -rn "AI schedule runs\|AI-assisted scheduling\|runs per division\|forever\|event's lifetime\|entrants each\|pass's 64\|128 entrants\|10 AI schedule\|20 AI schedule\|Everything in Pro\|automatic officials assignment\|Upgrades ONE competition\|for its lifetime\|survives forever\|upgrades this competition\|One payment upgrades\|share one credit\|lifetime.*credit\|Add-ons\|/help/billing" .
```

**Findings from running this during planning (2026-07-26, pre-Task-1..7 state) — confirmed real, not hypothetical:**

| Match | File:line | Risk to this wave's edits | Verdict |
|---|---|---|---|
| `"AI-assisted scheduling"` | `pro-plus-tier.spec.ts:397` | Asserts the `/pricing` Pro Plus card (`plusCard`) contains this text. That text lives in `pricing-cards.ts`'s `PLUS_CARD_FEATURES`, **not** touched by this wave (Global note 5) — `stripe-plans.json:59`'s Checkout description is a different, untested-by-e2e surface. | **Safe** — confirmed `PLUS_CARD_FEATURES` is out of scope and untouched. |
| `"Auto officials assignment"` | `pro-plus-tier.spec.ts:398` | Same card, same array — untouched. | **Safe.** |
| entrant matrix `"64"`, `"128"`, `"256"` | `pricing-v3.spec.ts:33-35` | Asserts the `/pricing` comparison table (`lib/pricing-matrix.ts`, DB-driven, not hand-written prose). Numbers are unchanged by this wave (128 was already correct). | **Safe** — this table was never wrong; confirms no drift risk either way. |
| `/help/billing/groups` navigation | `billing-groups-journey.spec.ts:440` | Screenshot-only test (`expect(page.getByRole("heading").first()).toBeVisible()`); no text-content assertion. Task 7 adds a sentence to this page's body. | **Safe** — no body-text assertion exists to break. |
| "forever" (2 hits) | `helpers.ts:414`, `billing-states.spec.ts:226` | Both are **code comments** about a dead Stripe customer id ("keeps its dead Stripe id forever"), unrelated to Event Pass copy. | **Safe — false positive**, not a text assertion at all. |
| "AI-assisted scheduling" / dead run-cap comment | `payments-hardening.spec.ts:1022` | Comment only ("The per-division AI-run count cap this test covered is gone"), not an assertion. | **Safe.** |
| Everything else in the pattern list | — | Zero hits in `apps/web/e2e/*.spec.ts`. | **Safe.** |

- [ ] **Step 2: Re-run after Task 7's `add-ons.md` lands, checking specifically for `/help/billing/add-ons` or `"Add-ons"` collisions**

```bash
cd apps/web/e2e && grep -rn "Add-ons\|add-ons\|extra.seat\|size.pack\|extra.org" .
```
Expected (confirmed during planning): no hits — no e2e spec currently references seats, size packs, or an add-ons surface, since none of that has UI yet (verified: zero `.tsx` files under `apps/web/src/app` import `resolveSeatPriceId`, `setExtraSeats`, `resolveSizePackPriceId` or `createSizePackCheckout` — these are backend-only today). Nothing to update.

- [ ] **Step 3: No commit** — this task produces no diff; its findings gate Tasks 1-5 and 7's merge. If a future re-run (after rebasing on a newer W6 that changes `pricing-cards.ts`'s `PLUS_CARD_FEATURES` or adds add-on UI) surfaces a new hit, stop and re-scope the relevant task's copy change before merging, per the Standing rule.

---

### Task 7: #299 — `help/billing/add-ons.md` + registry + groups.md lifetime-cap sentence

**Files:**
- Create: `apps/web/content/help/billing/add-ons.md`
- Modify: `apps/web/src/lib/help.ts:65-71` (`HELP_ARTICLE_SLUGS`)
- Modify: `apps/web/content/help/billing/groups.md:149`
- Modify: `apps/web/src/__tests__/plan-copy-truth.test.ts` (extend Task 1/3/4's file)

**Interfaces:**
- Consumes: `stripePlans.seats[0]` / `stripePlans.size_packs[0]` (`apps/web/src/config/stripe-plans.json:175-190,193-208` — `feature_key`/`delta_each` for extra-seat and size-pack); `setExtraSeats` (`apps/web/src/server/usecases/extra-seats.ts:34-90`, `requireBillingOwner`-gated, "who pays" = group payer); `createSizePackCheckout` (`apps/web/src/server/usecases/size-pack-checkout.ts:27-85`, owner-of-competition's-org-gated, charges the group card only if that owner is also the payer); `addonBonus`'s `'canceled' is frozen-not-deleted` comment (`apps/web/src/lib/entitlements.ts:413`) for the lapse language; `preferredCurrency` (`apps/web/src/lib/currency-server.ts:16-33`, reads the locked `subscriptions.currency` first) for the currency-lock claim; existing bidirectional registry tests in `apps/web/src/server/__tests__/help-content.test.ts:16-27` (unmodified — reused as-is for TDD red/green).
- Produces: nothing downstream — closing page for this wave.
- **Depends on W6 (#293), which this repo does not have yet.** Per the design spec's W6 section, it ships `extra_org` (recurring, $9 Pro / $19 Pro Plus per currency, same rate as the existing group tier-2 price already in `stripe-plans.json`'s `plans[].prices.*.tiers`), writes `org_addons(feature_key='orgs.max_owned')` via the same webhook pattern as seats, and adds "an Add-ons tab entry + purchase offer in the `assertWithinGroupCap` 402 body." This task assumes that tab exists under Settings → Billing by the time W7 runs. **If W6 names the surface differently, adjust this page's "where to buy" wording to match at execution time** — the scope/billing-shape/lapse facts below don't depend on the exact UI location and don't need to change.
- **Note on "prices link to /pricing":** verified only partially true. `/pricing` (via `marketing.json`'s group-pricing row) already shows the $9/$19 extra-organisation-in-a-group rate that #293 pegs the extra-org add-on to (Decision #293: "same-as-tier-2 pricing"), so that add-on legitimately links there. The $4/mo extra-seat and $10 one-time size-pack prices are **not** shown on `/pricing` anywhere (confirmed: no `.tsx` under `apps/web/src/app/[lang]/(marketing)/pricing` renders `stripePlans.seats`/`.size_packs`), and neither has any purchase UI yet at all (see above) — so this page follows this repo's other established never-hardcode pattern instead (`credits.md`'s pack ladder never states a $ figure; `groups.md`: "You never guess the figure... shown live from Stripe, before you confirm") rather than link to a page that doesn't have the number.

- [ ] **Step 1: Write the failing tests (registry + content pin)**

`apps/web/src/lib/help.ts`, before:
```ts
  "billing/credits",
  "billing/operator",
  "api/keys",
] as const;
```
after:
```ts
  "billing/credits",
  "billing/operator",
  "billing/add-ons",
  "api/keys",
] as const;
```

In `apps/web/src/__tests__/plan-copy-truth.test.ts`, add (non-DB-gated — reads the JSON seed and a file, no DB query):

```ts
it("add-ons.md quotes the live seat and size-pack deltas from the Stripe seed", () => {
  const text = readFileSync(join(HELP_BILLING_DIR, "add-ons.md"), "utf8");
  const seat = stripePlans.seats!.find((s) => s.key === "extra_seat")!;
  const sizePack = stripePlans.size_packs!.find((s) => s.key === "size_pack_32")!;
  expect(text).toContain(`\`${seat.feature_key}\` +${seat.delta_each}`);
  expect(text).toContain(`\`${sizePack.feature_key}\` +${sizePack.delta_each}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web
npx vitest run src/server/__tests__/help-content.test.ts src/__tests__/plan-copy-truth.test.ts
```
Expected: FAIL in two places — `help-content.test.ts`'s `"every registry slug has a Markdown file"` (`lib/help.ts` now lists `billing/add-ons` but `content/help/billing/add-ons.md` doesn't exist yet); and `plan-copy-truth.test.ts`'s new test (`ENOENT: no such file or directory, open 'content/help/billing/add-ons.md'`).

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/content/help/billing/add-ons.md`:

```markdown
---
title: Add-ons — buying more of one thing
description: Four ways to buy extra capacity without changing plan — AI credits (group-wide), extra seats (per organisation), competition size packs (per competition) and extra organisations (per group) — each billed, scoped and paid for differently.
order: 7
---

An add-on buys **more of one specific thing** without moving you to a different plan. There are four, and they don't work the same way:

| Add-on | Lifts | Scope | Billing | If it lapses |
| --- | --- | --- | --- | --- |
| AI credit pack | AI credit balance | Whole billing group (shared wallet) | One-time | Nothing to lapse — never expires |
| Extra seat | `members.max` +1 | One organisation | Recurring, monthly | Freezes any member over the new limit |
| Size pack | `entrants.per_division.max` +32 | One competition | One-time | Nothing to lapse — permanent |
| Extra organisation | `orgs.max_owned` +1 | Whole billing group | Recurring, group's billing period | Freezes the group at its plan's own slot count |

## AI credit packs — group-wide, never expire

A **credit pack** tops up the shared AI wallet every organisation in your billing group spends from. It's a one-time purchase, the credits land immediately, and — like an Event Pass's one-time credit grant — they **never expire**, unlike your monthly plan grant, which resets every month. See [AI credits](/help/billing/credits) for the ladder, how spending order works (monthly grant first, packs after) and the Pro Plus operator wallet.

## Extra seats — one organisation, recurring

An **extra seat** raises one organisation's team-member limit by one, for as long as you keep paying for it — a monthly charge that rides your billing group's existing subscription as one more line item, not a second bill. Only the group's **payer** can add or remove seats, even though the seat itself only lifts the one organisation you buy it for.

## Size packs — one competition, one-time

A **size pack** raises one competition's entrants-per-division limit by a fixed amount, permanently, for that competition only — bought once, like an Event Pass, but for headroom rather than the whole feature set. Any **owner** of the competition's organisation can buy one; it charges the billing group's card when that owner is also the group's payer, or the buyer's own card otherwise — the same rule an [Event Pass](/help/billing/event-pass) purchase follows.

## Extra organisations — the whole group, recurring

If your billing group has already filled every organisation slot your plan allows (5 on Pro, 10 on Pro Plus), an **extra organisation** add-on buys one more slot rather than forcing an upgrade — at the same rate as the plan's own extra-organisation tier. Both Pro and Pro Plus groups can buy it; see [current per-organisation rates](/pricing) for the exact figure, since it's the same number the plan's own pricing already shows for each organisation past the first. Only the group's payer can buy or drop this add-on, and it lifts the cap for the whole group, not one organisation.

## Who pays, and in what currency

Every add-on bills in your billing group's **locked currency** — the one fixed by whichever purchase (a plan, a pass, or an earlier add-on) came first. None of them ask you to pick a currency again.

"Who can buy" differs by add-on: a **credit pack**, **extra seats** and an **extra organisation** are all gated to the group's **payer** — the same person who owns the plan and the card. A **size pack** is gated to an **owner of the competition's organisation**, and only charges the group's card automatically when that owner happens to be the payer too; otherwise it's billed to them directly, exactly like buying an [Event Pass](/help/billing/event-pass).

## Lapsing — freeze, not delete

Cancel an extra seat or an extra organisation and nothing is deleted: the capacity it added simply stops counting from that point on. If you're already using more than the plan-plus-remaining-add-ons allows, the overage **freezes** — becomes read-only — exactly like [what downgrading freezes](/help/billing/downgrade); it does not remove anyone or anything you've built. Buy the add-on back, or make room another way, and the freeze lifts immediately. A size pack and a credit pack are one-time purchases, so there's nothing to lapse — what they added stays added for good.

## See also

[Billing groups](/help/billing/groups) for how a group's card, payer and organisation slots work. [AI credits](/help/billing/credits) for the shared wallet and the operator console. [Plans at a glance](/help/billing/plans) for what's already included before you need an add-on. [Current pricing](/pricing) for every live rate.
```

`apps/web/content/help/billing/groups.md`, the "We bought an Event Pass..." Q&A, before:
```markdown
**We bought an Event Pass for one of our organisations — does it credit the group?** Only if that same organisation is the one whose checkout starts the group's subscription. The credit checks that one organisation's own pass, not a shared pool across the group — a pass held by a different organisation, even one that joined the group earlier, earns nothing. If you want the pass to count, buy it for the organisation that will actually run the upgrade. See [Event Pass](/help/billing/event-pass).
```
after:
```markdown
**We bought an Event Pass for one of our organisations — does it credit the group?** Only if that same organisation is the one whose checkout starts the group's subscription, and only **once, ever**: a billing group earns this credit a single time in its lifetime, no matter how many organisations it holds or how many passes any of them buy afterwards. The credit checks that one organisation's own pass, not a shared pool across the group — a pass held by a different organisation, even one that joined the group earlier, earns nothing. If you want the pass to count, buy it for the organisation that will actually run the upgrade, before the group's one credit is already spent. See [Event Pass](/help/billing/event-pass).
```

(This makes true the promise `event-pass.md:63`'s existing sentence already makes — "And once a group's one credit is used, a second pass anywhere in the group... earns nothing further" — and its link text, "More on how billing groups share one credit", which today lands on an answer that doesn't actually spell out the *lifetime, once-ever* part. Ties to the real constraint: `pass-credit.ts`'s `GROUP_CAP_CONSTRAINT = "pass_credit_redemptions_group_cap"`, the V335 partial unique index enforcing exactly this.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web
npx vitest run src/server/__tests__/help-content.test.ts src/__tests__/plan-copy-truth.test.ts
```
Expected: PASS — registry/disk agree both directions, the new billing section has its 7th article, and the seat/size-pack delta numbers are pinned.

- [ ] **Step 5: e2e safety check (Task 6, Step 2) then commit**

```bash
git add apps/web/content/help/billing/add-ons.md apps/web/content/help/billing/groups.md apps/web/src/lib/help.ts apps/web/src/__tests__/plan-copy-truth.test.ts
git commit -m "$(cat <<'EOF'
docs(help): add the add-ons help page, close the group-credit promise

New help/billing/add-ons.md covers all four add-ons (credit packs,
extra seats, size packs, extra organisations) — scope, billing shape,
who pays, and freeze-not-delete lapse behaviour, registered in the
help-slug registry. groups.md's pass-credit Q&A now states the
lifetime-once cap explicitly, honouring event-pass.md's existing link
to it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing checklist (before opening the PR)

- [ ] `cd apps/web && npx tsc --noEmit` clean.
- [ ] `cd apps/web && npx vitest run` clean (full suite, not just the files touched this wave).
- [ ] `npm run i18n:check` clean (repo root).
- [ ] Task 6's grep re-run one final time against the merged diff (not just per-task) — a later task's copy could theoretically reintroduce a string an earlier task's e2e check already cleared against a *different* wording.
- [ ] `/code-review` on the branch.
- [ ] No migration to reconcile — confirm `git diff` touches no file under `db/migration/deltas/`.
- [ ] Merge via PR (smoke CI is PR-only, per the Standing rule — do not merge-local + push-main).
