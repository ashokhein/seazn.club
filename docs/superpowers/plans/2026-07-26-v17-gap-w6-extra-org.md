# Wave 6: Extra-org add-on Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a recurring extra-organisation add-on ($9/mo Pro, $19/mo Pro Plus) so a billing group at its plan's `orgs.max_owned` cap can buy past it instead of hitting a dead-end refusal — both Pro and Pro Plus can buy, since exceeding the cap is a purchase, not an upgrade wall.

**Branch:** `feat/v17gap-w6-extra-org` (git worktree — NEVER checkout in main repo dir)

**Issues:** #293

**Depends on:** W1 money-leaks (merged), W5 L-rung (merged, `stripe-plans.json` conflicts resolved)

**Migration:** **NONE.** V342 was reserved provisionally but is not needed — verified against extra-seat's own migration history (V323 `org_addons` + V324 guards, both already shipped) and confirmed the `org_addons` table already anticipates `feature_key = 'orgs.max_owned'` verbatim in its own column comment (`db/migration/deltas/V323__org_addons.sql:28`: *"The cap this lifts, e.g. 'members.max', 'orgs.max_owned'."*), the unique index on `stripe_item_id` is feature-key-agnostic, and the `target_org_id is null` (group-wide) shape this add-on needs is already supported by the resolver (`lib/entitlements.ts:addonBonus`). No new table, column, or seed row is required. Say so again if a later task discovers otherwise — but Task 1–9 below do not.

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

## What this wave assumes from earlier waves (Consumes, wave-level)

- **From W1 (money-leaks):** `attachOrgToGroup` (`apps/web/src/server/usecases/billing-groups.ts`) now merges the leaving/joining wallet's `ai_credit_ledger` balance inside its own transaction (two compensating rows, `source` enum extended via V336/V337). W6 does **not** touch that ledger code and does **not** add any code inside the `sql.begin` block beyond a one-argument change to the existing `assertWithinGroupCap(...)` call (Task 5) — a call that already exists at today's line 697, immediately after the `heldRow` count query. **Re-read `billing-groups.ts` before editing Task 5** — W1 landing first may have shifted line numbers; find the call by its argument shape (`assertWithinGroupCap(Number(heldRow?.n ?? 0), capLimit)`), not by line number.
- **From W5 (L-rung):** `apps/web/src/config/stripe-plans.json` gained an `event_pass_l` pass entry and `pass_key` threading. W6 adds a **new top-level key** (`org_addons`) to the same JSON file — additive, no structural overlap with W5's `passes` array. If W5's diff touched the file's trailing structure, re-verify the insertion point (after `size_packs`) before editing Task 1.
- Both are read-verified against the **pre-W1/W5** state of the repo during planning (2026-07-26) since those waves have not executed yet in this checkout; the line numbers cited throughout this plan are from that state and must be re-verified by whichever wave executes first.

---

### Task 1: Stripe catalog — the two org-addon prices + the reader module

**Files:**
- Modify: `apps/web/src/config/stripe-plans.json`
- Create: `apps/web/src/lib/org-addons.ts`
- Modify: `scripts/stripe-sync.ts` (add `OrgAddonSpec` + a sync loop mirroring the existing `seats` loop at lines 427–437)
- Test: `apps/web/src/lib/__tests__/org-addon-catalog-parity.test.ts`

**Interfaces:**
- Consumes: `extraOrgPrice(plan, interval, currency)` — `apps/web/src/lib/currency.ts:60-71` (existing, reads the graduated tier-2 amount). `SUPPORTED_CURRENCIES` — `apps/web/src/lib/currency.ts:6`. `getStripe()` — `apps/web/src/lib/stripe.ts`. `HttpError` — `apps/web/src/lib/errors.ts`.
- Produces: `ORG_ADDONS: OrgAddonCatalogEntry[]`, `ORG_ADDON_FEATURE_KEY`, `ORG_ADDON_DELTA_EACH`, `isOrgAddonItem(item)`, `orgAddonForPlan(planKey)`, `resolveOrgAddonPriceId(planKey)` — all from `@/lib/org-addons`, consumed by Task 2 (webhook), Task 3 (usecase), Task 5 (offer gating), Task 6 (UI pricing/availability).

**Decision baked into the price seed (per the approved design):** the add-on is priced **identically** to the plan's own graduated tier-2 rate (`pro` monthly tier `up_to: "inf"` = 900 / `pro_plus` monthly tier `up_to: "inf"` = 1900, and their `currency_options`, verified by reading `apps/web/src/config/stripe-plans.json` lines 20-31 and 69-79 directly) — same amounts, copied byte-for-byte into two NEW recurring prices (never a shared Stripe price object, since the add-on rides the subscription as its own line item, exactly like `extra_seat`). Always billed **monthly**, regardless of whether the group's own plan is billed monthly or annual — this mirrors `extra_seat`'s existing behaviour (`stripe-plans.json`'s `seats[0].price.interval` is `"month"` with no annual variant) and is proven safe in production already.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/org-addon-catalog-parity.test.ts
//
// The extra-org ADD-ON price (v17 gap #293) must never drift from the
// graduated tier-2 rate `extraOrgPrice()` already advertises — the decision
// is "same as tier-2", not "close to it". No DB, no Stripe: pure JSON +
// pure-function checks, mirroring extra-org-price-parity.test.ts's style.
import { describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { extraOrgPrice, SUPPORTED_CURRENCIES } from "@/lib/currency";
import { ORG_ADDONS, ORG_ADDON_FEATURE_KEY, ORG_ADDON_DELTA_EACH, orgAddonForPlan } from "@/lib/org-addons";

describe("extra-organisation add-on catalog (v17 gap #293)", () => {
  it("has exactly one recurring price per paid plan", () => {
    expect(ORG_ADDONS.map((e) => e.planKey).sort()).toEqual(["pro", "pro_plus"]);
  });

  it("lifts orgs.max_owned by 1 per unit, for every plan tier", () => {
    for (const entry of ORG_ADDONS) {
      expect(entry.featureKey).toBe("orgs.max_owned");
      expect(entry.deltaEach).toBe(1);
    }
    expect(ORG_ADDON_FEATURE_KEY).toBe("orgs.max_owned");
    expect(ORG_ADDON_DELTA_EACH).toBe(1);
  });

  it("orgAddonForPlan resolves pro/pro_plus and refuses community", () => {
    expect(orgAddonForPlan("pro")?.lookupKey).toBe(ORG_ADDONS.find((e) => e.planKey === "pro")!.lookupKey);
    expect(orgAddonForPlan("pro_plus")?.lookupKey).toBe(
      ORG_ADDONS.find((e) => e.planKey === "pro_plus")!.lookupKey,
    );
    expect(orgAddonForPlan("community")).toBeUndefined();
  });

  it("prices each tier at EXACTLY what extraOrgPrice() advertises — same as tier-2, #293", () => {
    const proSpec = stripePlans.org_addons!.find((o) => o.plan_key === "pro")!;
    const proPlusSpec = stripePlans.org_addons!.find((o) => o.plan_key === "pro_plus")!;
    for (const currency of SUPPORTED_CURRENCIES) {
      const proAmount =
        currency === "usd" ? proSpec.price.unit_amount : proSpec.price.currency_options![currency];
      const proPlusAmount =
        currency === "usd"
          ? proPlusSpec.price.unit_amount
          : proPlusSpec.price.currency_options![currency];
      expect(proAmount).toBe(extraOrgPrice("pro", "monthly", currency));
      expect(proPlusAmount).toBe(extraOrgPrice("pro_plus", "monthly", currency));
    }
  });

  it("is a RECURRING monthly price — rides the subscription like extra-seat, never one-time", () => {
    for (const entry of stripePlans.org_addons ?? []) {
      expect(entry.price.interval).toBe("month");
    }
  });

  it("charges less for Pro than Pro Plus, mirroring the plan ladder itself", () => {
    const pro = stripePlans.org_addons!.find((o) => o.plan_key === "pro")!;
    const proPlus = stripePlans.org_addons!.find((o) => o.plan_key === "pro_plus")!;
    expect(pro.price.unit_amount).toBeLessThan(proPlus.price.unit_amount);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `npx vitest run src/lib/__tests__/org-addon-catalog-parity.test.ts`
Expected: FAIL — `Cannot find module '@/lib/org-addons'` (module doesn't exist yet) and `stripePlans.org_addons` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/web/src/config/stripe-plans.json`, after the `"size_packs"` array (currently ends at line 208) and before the closing `}`:

```json
  ,
  "$comment_org_addons": "Extra-organisation RECURRING add-on (v17 gap remediation #293, design/v17-pricing-entitlements SPEC-2 §3/§7): exceeding the group's plan cap (orgs.max_owned) is a PURCHASE, not an upgrade wall — both Pro and Pro Plus can buy. Priced identically to the plan's own graduated tier-2 rate (extraOrgPrice() in lib/currency.ts reads the SAME `plans[].prices.monthly.tiers[up_to=inf]` numbers this seed copies) — org-addon-catalog-parity.test.ts pins the two together so a tier change and a forgotten add-on price can never drift apart. Like extra_seat this rides the group's EXISTING subscription as an extra RECURRING item (never a second subscription, never annual — always $/month regardless of the group's own billing interval, mirroring extra_seat's shape exactly). ONE ENTRY PER PLAN because the rate differs by plan; `plan_key`/`feature_key`/`delta_each` are OUR fields (never sent to Stripe) — the customer.subscription.updated webhook (billing-events.syncOrgAddonsForSubscription) is the SINGLE writer of the resulting org_addons(feature_key='orgs.max_owned', target_org_id=null) row, group-wide (not scoped to one org, unlike a seat).",
  "org_addons": [
    {
      "key": "extra_org_pro",
      "plan_key": "pro",
      "feature_key": "orgs.max_owned",
      "delta_each": 1,
      "product": {
        "name": "Seazn Club Extra Organisation — Pro",
        "description": "One additional organisation on your Pro bill, beyond your plan's included limit, billed monthly for as long as it is active."
      },
      "price": {
        "lookup_key": "seazn_extra_org_pro_monthly",
        "unit_amount": 900,
        "interval": "month",
        "currency_options": { "eur": 900, "gbp": 700, "inr": 69900, "aud": 1400 }
      }
    },
    {
      "key": "extra_org_pro_plus",
      "plan_key": "pro_plus",
      "feature_key": "orgs.max_owned",
      "delta_each": 1,
      "product": {
        "name": "Seazn Club Extra Organisation — Pro Plus",
        "description": "One additional organisation on your Pro Plus bill, beyond your plan's included limit, billed monthly for as long as it is active."
      },
      "price": {
        "lookup_key": "seazn_extra_org_pro_plus_monthly",
        "unit_amount": 1900,
        "interval": "month",
        "currency_options": { "eur": 1800, "gbp": 1600, "inr": 149900, "aud": 2900 }
      }
    }
  ]
```

(Verify the exact byte match against the live `pro`/`pro_plus` monthly tier-2 `currency_options` at edit time — read the file, do not trust this citation blindly; Step 4's test is what actually proves it.)

Create `apps/web/src/lib/org-addons.ts`:

```ts
import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { HttpError } from "@/lib/errors";
import stripePlans from "@/config/stripe-plans.json";

// Extra-organisation recurring add-on (v17 gap #293, design/v17-pricing-
// entitlements SPEC-2 §3/§7). Structurally like lib/seat-addons.ts — a
// RECURRING line item that rides the billing group's EXISTING subscription as
// an extra subscription item (one invoice, one cycle, Stripe-native proration,
// never a second subscription) — but ONE CATALOG ENTRY PER PLAN, because the
// rate differs by tier ($9 Pro / $19 Pro Plus), where extra_seat has only one
// flat rate. Every tier still lifts the SAME feature by the SAME amount —
// only the PRICE differs — so featureKey/deltaEach are pinned ONCE below
// (ORG_ADDON_FEATURE_KEY/ORG_ADDON_DELTA_EACH), exactly like SEAT_ADDON pins
// them for its one entry; only the lookup_key varies per plan.

export interface OrgAddonCatalogEntry {
  planKey: string;
  featureKey: string;
  deltaEach: number;
  lookupKey: string;
}

const orgAddonSeed = stripePlans.org_addons ?? [];

/** Derived from config/stripe-plans.json's `org_addons` array — the same file
 *  stripe-sync.ts seeds Stripe from, so the catalog and the live prices can
 *  never drift out of key-naming step. */
export const ORG_ADDONS: OrgAddonCatalogEntry[] = orgAddonSeed.map((e) => ({
  planKey: e.plan_key,
  featureKey: e.feature_key,
  deltaEach: e.delta_each,
  lookupKey: e.price.lookup_key,
}));

/** Every tier lifts the SAME cap by the SAME amount — only price differs by
 *  plan. Pinned once here, not trusted per-item, exactly like SEAT_ADDON, so
 *  the webhook (Task 2) can pin feature/delta without knowing which tier an
 *  item was bought at. Fails closed at import time if the seed ever
 *  disagrees with itself — a silently wrong feature_key would be a stuck
 *  lift no reconcile could find. */
export const ORG_ADDON_FEATURE_KEY: string = orgAddonSeed[0]?.feature_key ?? "orgs.max_owned";
export const ORG_ADDON_DELTA_EACH: number = orgAddonSeed[0]?.delta_each ?? 1;
if (ORG_ADDONS.some((e) => e.featureKey !== ORG_ADDON_FEATURE_KEY || e.deltaEach !== ORG_ADDON_DELTA_EACH)) {
  throw new Error(
    "config/stripe-plans.json org_addons: every tier must lift the SAME feature_key by the SAME " +
      "delta_each — only the price may differ by plan.",
  );
}

const LOOKUP_KEYS = new Set(ORG_ADDONS.map((e) => e.lookupKey));

/**
 * Is this subscription item one of the recurring extra-org SKUs (any tier)?
 * Matched on the price `lookup_key` (the durable identity, stable across price
 * replacements via transfer_lookup_key), falling back to the item metadata
 * marker the usecase stamps for the case a payload arrives without the price
 * expanded. Used by the webhook (billing-events.ts) to pick org-addon items
 * out of a subscription that may also carry the plan item and seat items.
 */
export function isOrgAddonItem(item: Stripe.SubscriptionItem): boolean {
  if (item.price?.lookup_key && LOOKUP_KEYS.has(item.price.lookup_key)) return true;
  return item.metadata?.feature_key === ORG_ADDON_FEATURE_KEY;
}

/** The catalog entry for a plan, or undefined when that plan has no add-on
 *  (community: exceeding a free org is an upgrade, not a purchase). */
export function orgAddonForPlan(planKey: string): OrgAddonCatalogEntry | undefined {
  return ORG_ADDONS.find((e) => e.planKey === planKey);
}

/**
 * The live Stripe price id for a plan's org-addon SKU, resolved by
 * `lookup_key` at request time (mirrors resolveSeatPriceId) — there is no
 * `plans` row to cache it on. 503s (matching every other checkout route) when
 * `stripe:sync` has not yet been run against this Stripe account; 400s when
 * the plan simply has no add-on (community).
 */
export async function resolveOrgAddonPriceId(planKey: string): Promise<string> {
  const entry = orgAddonForPlan(planKey);
  if (!entry) {
    throw new HttpError(400, `Extra organisations are not available on the ${planKey} plan.`);
  }
  const found = await getStripe().prices.list({ lookup_keys: [entry.lookupKey], limit: 1 });
  const price = found.data[0];
  if (!price) {
    throw new HttpError(503, "Billing is not yet configured. Please contact support.");
  }
  return price.id;
}
```

Wire `stripe-sync.ts` (extend the `Seed`/loop pattern that already handles `seats`):

Add the interface near `SeatSpec` (`scripts/stripe-sync.ts:70-76`):

```ts
/** The extra-org RECURRING add-on (v17 gap #293). Structurally identical to a
 *  SeatSpec — one product, one recurring price, `feature_key`/`delta_each`
 *  OUR fields never sent to Stripe — but ONE ENTRY PER PLAN (`plan_key`)
 *  because the rate differs by tier. No `plans` row: lib/org-addons.ts
 *  resolves the live price by lookup_key at request time. */
export interface OrgAddonSpec {
  key: string;
  plan_key: string;
  feature_key: string;
  delta_each: number;
  product: { name: string; description?: string };
  price: PriceSpec;
}
```

Add `org_addons?: OrgAddonSpec[];` to the `Seed` interface (`scripts/stripe-sync.ts:90-97`).

Add the sync loop to `main()`, right after the `size_packs` loop (`scripts/stripe-sync.ts:443-455`):

```ts
    // Extra-org RECURRING add-on (v17 gap #293): same idempotent ensurePrice
    // as a seat, but ONE PRICE PER PLAN — lib/org-addons.resolveOrgAddonPriceId
    // resolves the plan-specific live price by lookup_key at request time.
    for (const orgAddon of seed.org_addons ?? []) {
      const price = await ensurePrice(
        stripe,
        orgAddon.price,
        orgAddon.product,
        orgAddon.key,
        seed.currency,
        null,
      );
      console.log(
        `✓ ${orgAddon.key}: recurring=${price.priceId} ` +
          `(${orgAddon.plan_key}, ${orgAddon.feature_key} +${orgAddon.delta_each})`,
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/org-addon-catalog-parity.test.ts`
Expected: PASS, all 6 assertions green.

- [ ] **Step 5: Commit**

```
git add apps/web/src/config/stripe-plans.json apps/web/src/lib/org-addons.ts scripts/stripe-sync.ts apps/web/src/lib/__tests__/org-addon-catalog-parity.test.ts
git commit -m "$(cat <<'EOF'
feat(billing): extra-org add-on price catalog (#293)

Two recurring Stripe prices (Pro $9/mo, Pro Plus $19/mo per extra
org), priced identically to each plan's existing tier-2 rate and
pinned together by a parity test so the two can never drift.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Webhook writer — reflect org-addon items into `org_addons`

**Files:**
- Modify: `apps/web/src/server/usecases/billing-events.ts` (new `syncOrgAddonsForSubscription`, wired into `handleSubscriptionChanged`)
- Test: `apps/web/src/server/usecases/__tests__/extra-org-addon.test.ts` (new file, real Postgres, mirrors `extra-seat-addon.test.ts`)

**Interfaces:**
- Consumes: `ORG_ADDONS`, `isOrgAddonItem`, `ORG_ADDON_FEATURE_KEY`, `ORG_ADDON_DELTA_EACH` — `@/lib/org-addons` (Task 1). `walletIdFor(orgId)` — `@/lib/credits.ts:62` (already imported into billing-events.ts). `getLimit`/`groupOrgLimit` — for the test only.
- Produces: `syncOrgAddonsForSubscription(stripeSub, subscriptionId): Promise<void>`, exported from `billing-events.ts`, consumed by Task 8 (live suite) and Task 9 (smoke, conceptually — smoke writes the row directly rather than calling this, since smoke has no live Stripe, matching `setPlan`'s own precedent).

**Design, verified against the extra-seat precedent (`syncSeatAddonsForSubscription`, `billing-events.ts:595-657`):** same idempotent-upsert-keyed-on-`stripe_item_id` shape, same freeze-not-delete reconcile-on-removal shape (error-handling note: *"W6 webhook writer must be idempotent per subscription-item quantity — extra-seat machinery already is — keep that property"*). Kept as a **sibling function**, not a literal shared one: the org-addon write is **group-wide** (`target_org_id = null` always — `orgs.max_owned` is a property of the whole group, never one org) where the seat write is **per-org** (`target_org_id` threaded through item metadata) — different enough in shape that forcing one shared function would either lose the seat's `target_org_id` guard-rail or grow a branch parameter into the seat path for no reason. This mirrors the codebase's own existing precedent: `grantSizePackAddon` (`billing-events.ts:250+`) is ALSO a sibling function next to the seat sync, not a shared one, for the same reason (one-time vs recurring, comp-scoped vs org-scoped).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/usecases/__tests__/extra-org-addon.test.ts
//
// v17 gap #293: the extra-organisation recurring add-on ($9/mo Pro, $19/mo
// Pro Plus → +1 orgs.max_owned per unit, GROUP-WIDE). The webhook
// (syncOrgAddonsForSubscription) is the SINGLE writer of the org_addons row;
// these tests drive it against real Postgres and assert on the resolver
// (getLimit/groupOrgLimit), mirroring extra-seat-addon.test.ts.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit } from "@/lib/entitlements";
import { groupOrgLimit } from "@/lib/billing-group";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { ORG_ADDONS } from "@/lib/org-addons";
import { syncOrgAddonsForSubscription } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`org-addon-${uniq()}@test.local`}, 'Org Addon Owner', true) returning id`;
  return id;
}

async function makeGroupOrg(planKey: "pro" | "pro_plus"): Promise<{ orgId: string; walletId: string }> {
  const org = await createOrgForUser(await makeUser(), `Org Addon ${planKey} ${uniq()}`);
  await setOrgPlan(org.id, planKey);
  const walletId = await walletIdFor(org.id);
  return { orgId: org.id, walletId };
}

/** An org-addon subscription item as the webhook sees it: the recurring SKU
 *  (matched by lookup_key), no target_org_id — group-wide by definition. */
function orgAddonItem(id: string, lookupKey: string, quantity: number): Stripe.SubscriptionItem {
  return {
    id,
    quantity,
    price: { id: `price_${id}`, lookup_key: lookupKey },
    metadata: {},
  } as unknown as Stripe.SubscriptionItem;
}

function subWith(items: Stripe.SubscriptionItem[]): Stripe.Subscription {
  return { id: `sub_${uniq()}`, items: { data: items } } as unknown as Stripe.Subscription;
}

let proBase: number;
let proPlusBase: number;
const proEntry = ORG_ADDONS.find((e) => e.planKey === "pro")!;
const proPlusEntry = ORG_ADDONS.find((e) => e.planKey === "pro_plus")!;

beforeAll(async () => {
  if (!HAS_DB) return;
  const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
    select plan_key, int_value from plan_entitlements
     where feature_key = 'orgs.max_owned' and plan_key in ('pro', 'pro_plus')`;
  proBase = rows.find((r) => r.plan_key === "pro")?.int_value ?? 0;
  proPlusBase = rows.find((r) => r.plan_key === "pro_plus")?.int_value ?? 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 5 });
});

describe.skipIf(!HAS_DB)("extra-org add-on — webhook sync -> resolver", () => {
  it("a pro org-addon item (qty=1) lifts orgs.max_owned by 1, group-wide", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);
    expect(await groupOrgLimit(walletId)).toBe(proBase);

    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(`si_${uniq()}`, proEntry.lookupKey, 1)]),
      walletId,
    );

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);
    expect(await groupOrgLimit(walletId)).toBe(proBase + 1);
  });

  it("a pro_plus org-addon item prices/lifts independently of pro's", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro_plus");
    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(`si_${uniq()}`, proPlusEntry.lookupKey, 2)]),
      walletId,
    );
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proPlusBase + 2);
  });

  it("removal freezes the row (freeze-not-delete) and the cap drops back", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const itemId = `si_${uniq()}`;
    await syncOrgAddonsForSubscription(subWith([orgAddonItem(itemId, proEntry.lookupKey, 1)]), walletId);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);

    await syncOrgAddonsForSubscription(subWith([]), walletId);
    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase);

    const [row] = await sql<{ status: string }[]>`
      select status from org_addons where stripe_item_id = ${itemId}`;
    expect(row?.status).toBe("canceled");
  });

  it("re-processing the SAME event is idempotent — one row, qty unchanged", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const sub = subWith([orgAddonItem(`si_${uniq()}`, proEntry.lookupKey, 3)]);

    await syncOrgAddonsForSubscription(sub, walletId);
    await syncOrgAddonsForSubscription(sub, walletId);

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 3);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(1);
  });

  it("is GROUP-WIDE: a second org sharing the wallet also sees the raised cap", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    const org2 = await createOrgForUser(await makeUser(), `Org Addon Sibling ${uniq()}`);
    await sql`update organizations set subscription_id = ${walletId} where id = ${org2.id}`;

    await syncOrgAddonsForSubscription(
      subWith([orgAddonItem(`si_${uniq()}`, proEntry.lookupKey, 1)]),
      walletId,
    );

    expect(await getLimit(orgId, "orgs.max_owned")).toBe(proBase + 1);
    expect(await getLimit(org2.id, "orgs.max_owned")).toBe(proBase + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/server/usecases/__tests__/extra-org-addon.test.ts`
Expected: FAIL — `syncOrgAddonsForSubscription` is not exported from `../billing-events` (TypeScript/import error).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/server/usecases/billing-events.ts`, add to the import block (near line 27, alongside the existing `SEAT_ADDON`/`isSeatAddonItem` import):

```ts
import { ORG_ADDON_FEATURE_KEY, ORG_ADDON_DELTA_EACH, isOrgAddonItem } from "@/lib/org-addons";
```

Wire the call into `handleSubscriptionChanged` (today at `billing-events.ts:524-578`), immediately after the existing `await syncSeatAddonsForSubscription(stripeSub, resolved.subscriptionId);` line:

```ts
  await syncSeatAddonsForSubscription(stripeSub, resolved.subscriptionId);
  // Extra-org add-on (v17 gap #293): same rider-item shape as a seat, but
  // GROUP-WIDE (no target_org_id) — see syncOrgAddonsForSubscription's own
  // doc comment for why this is a sibling function, not a shared one.
  await syncOrgAddonsForSubscription(stripeSub, resolved.subscriptionId);
```

Add the function itself, after `syncSeatAddonsForSubscription` (today ends at `billing-events.ts:657`):

```ts
/**
 * Reflect a subscription's extra-org add-on items into org_addons (v17 gap
 * #293, design/v17-pricing-entitlements SPEC-2 §3/§7). The ROUTE
 * (setExtraOrgs, Task 3) mutates Stripe; THIS is the SINGLE writer of the
 * resulting rows, so Stripe and the DB can never diverge — same contract as
 * syncSeatAddonsForSubscription.
 *
 * Unlike a seat, an org-addon item lifts a GROUP-WIDE cap: `target_org_id` is
 * always NULL (orgs.max_owned is a property of the whole group, not one
 * member org), so there is no per-item metadata to resolve a target from —
 * every item this function sees, it applies to the whole wallet.
 * `feature_key`/`delta_each` are PINNED from the catalog (ORG_ADDON_FEATURE_KEY/
 * ORG_ADDON_DELTA_EACH), never trusted from item metadata, for the same
 * "no stuck lift on a rogue key" reason the seat sync pins them.
 *
 * UPSERT keyed on `stripe_item_id` (the V324 partial-unique key IS the
 * idempotency — a redelivered event neither duplicates a row nor
 * double-counts the cap). Any active org-addon row for this GROUP whose item
 * Stripe no longer reports is FLIPPED to status='canceled' (freeze-not-delete,
 * V323/V324) — never deleted, never written with qty=0.
 */
export async function syncOrgAddonsForSubscription(
  stripeSub: Stripe.Subscription,
  subscriptionId: string,
): Promise<void> {
  const items = (stripeSub.items?.data ?? []).filter(isOrgAddonItem);
  const seenItemIds: string[] = [];
  for (const item of items) {
    const qty = item.quantity ?? 0;
    if (qty <= 0) {
      // A quantity-0 item is a removal in disguise: never write qty=0 (the
      // V324 CHECK forbids it), flip any existing row to canceled instead.
      await sql`
        update org_addons set status = 'canceled'
         where stripe_item_id = ${item.id} and status <> 'canceled'`;
      continue;
    }
    // subscriptionId doubles as the wallet id directly here: every member
    // org's own wallet (coalesce(subscription_id, org_id)) already resolves
    // to it by construction — no walletIdFor(orgId) lookup needed, unlike the
    // per-org seat write, because there is no single target org to resolve
    // one through.
    await sql`
      insert into org_addons
        (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
         stripe_item_id, status)
      values (${subscriptionId}, null, null, ${ORG_ADDON_FEATURE_KEY}, ${ORG_ADDON_DELTA_EACH},
              ${qty}, ${item.id}, 'active')
      on conflict (stripe_item_id) where stripe_item_id is not null
      do update set qty = excluded.qty, status = 'active',
        wallet_id = excluded.wallet_id, feature_key = excluded.feature_key,
        delta_each = excluded.delta_each`;
    seenItemIds.push(item.id);
  }

  // Reconcile removals: an active Stripe-origin org-addon row (non-null
  // stripe_item_id) for THIS group whose item Stripe no longer reports is
  // gone. Scoped to ORG_ADDON_FEATURE_KEY so a seat or size-pack row on the
  // same wallet is never swept here.
  if (seenItemIds.length === 0) {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
         and stripe_item_id is not null and status = 'active'`;
  } else {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
         and stripe_item_id is not null and status = 'active'
         and stripe_item_id not in ${sql(seenItemIds)}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/server/usecases/__tests__/extra-org-addon.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/billing-events.ts apps/web/src/server/usecases/__tests__/extra-org-addon.test.ts
git commit -m "$(cat <<'EOF'
feat(billing): webhook writes the extra-org add-on (#293)

syncOrgAddonsForSubscription is the single writer of org_addons for
the group-wide orgs.max_owned add-on — idempotent per subscription-
item quantity, freeze-not-delete on removal, same contract as the
extra-seat sync it sits beside.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Purchase usecase + API route

**Files:**
- Create: `apps/web/src/server/usecases/extra-orgs.ts`
- Create: `apps/web/src/app/api/billing/extra-orgs/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/extra-org-addon.test.ts` (extend the file from Task 2)

**Interfaces:**
- Consumes: `requireBillingOwner()` — `apps/web/src/server/usecases/billing-manage.ts:124-147` (returns `{orgId, subscriptionId}`, throws `HttpError(400/403)`). `hasLiveSubscription` — `@/lib/subscription-status.ts:46-53`. `orgAddonForPlan`, `resolveOrgAddonPriceId` — `@/lib/org-addons` (Task 1). `getStripe()` — `@/lib/stripe.ts`.
- Produces: `setExtraOrgs(count): Promise<{ subscriptionId: string; extraOrgs: number }>`, `POST /api/billing/extra-orgs`. Consumed by Task 6 (UI) and Task 8 (live suite, conceptually — the live suite exercises the same Stripe calls directly).

**Design, verified against `setExtraSeats` (`apps/web/src/server/usecases/extra-seats.ts`, read in full):** identical shape — mutate Stripe ONLY, never write `org_addons` here (the webhook is the single writer), same `proration_behavior` rule (raise prorates now, lower/remove takes effect at renewal), same group-payer gate. Differs in exactly two ways: (1) no `target_org_id` — the item is group-wide, so metadata carries only `feature_key`; (2) the price is **plan-tier-specific** — resolved via `orgAddonForPlan(groupRow.plan_key)` instead of a single constant.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/server/usecases/__tests__/extra-org-addon.test.ts` (created in Task 2). Add these imports at the top, alongside the existing ones:

```ts
import { HttpError } from "@/lib/errors";
import { setExtraOrgs } from "../extra-orgs";
```

Add the Stripe/auth mocks (place these `vi.mock` calls near the top of the file, ABOVE the `import { sql } from "@/lib/db";` line — vitest hoists `vi.mock`, but the `vi.hoisted` spies must be declared before any import that transitively pulls in `@/lib/stripe` or `billing-manage`, matching `extra-seat-addon.test.ts`'s exact structure):

```ts
const { retrieveSpy, itemCreateSpy, itemUpdateSpy, itemDelSpy, pricesListSpy, requireBillingOwnerMock } =
  vi.hoisted(() => ({
    retrieveSpy: vi.fn(),
    itemCreateSpy: vi.fn(),
    itemUpdateSpy: vi.fn(),
    itemDelSpy: vi.fn(),
    pricesListSpy: vi.fn(async () => ({ data: [{ id: "price_org_addon" }] })),
    requireBillingOwnerMock: vi.fn(),
  }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: retrieveSpy },
    subscriptionItems: { create: itemCreateSpy, update: itemUpdateSpy, del: itemDelSpy },
    prices: { list: pricesListSpy },
  }),
}));
vi.mock("@/server/usecases/billing-manage", () => ({
  requireBillingOwner: requireBillingOwnerMock,
}));
```

Add new tests inside the existing `describe.skipIf(!HAS_DB)("extra-org add-on — webhook sync -> resolver", ...)` block (they need real DB rows for `subscriptions`/`organizations`, same as the webhook tests):

```ts
  it("refuses on a community group (no live subscription) before any Stripe call", async () => {
    const org = await createOrgForUser(await makeUser(), `Org Addon Community ${uniq()}`);
    const walletId = await walletIdFor(org.id);
    requireBillingOwnerMock.mockResolvedValueOnce({ orgId: org.id, subscriptionId: walletId });
    retrieveSpy.mockClear();

    await expect(setExtraOrgs(1)).rejects.toMatchObject({ status: 400 });
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it("creates a subscription item on the PLAN-SPECIFIC price, group-wide metadata only", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    await sql`update subscriptions set stripe_subscription_id = ${`sub_stripe_${uniq()}`} where id = ${walletId}`;
    requireBillingOwnerMock.mockResolvedValueOnce({ orgId, subscriptionId: walletId });
    retrieveSpy.mockResolvedValueOnce({ id: "sub_stripe", items: { data: [] } });
    itemCreateSpy.mockClear();
    pricesListSpy.mockClear();

    const result = await setExtraOrgs(2);

    expect(result.extraOrgs).toBe(2);
    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proEntry.lookupKey] }),
    );
    expect(itemCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        price: "price_org_addon",
        quantity: 2,
        metadata: { feature_key: "orgs.max_owned" },
      }),
    );
  });

  it("resolves the PRO PLUS price for a pro_plus group, not pro's", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro_plus");
    await sql`update subscriptions set stripe_subscription_id = ${`sub_stripe_${uniq()}`} where id = ${walletId}`;
    requireBillingOwnerMock.mockResolvedValueOnce({ orgId, subscriptionId: walletId });
    retrieveSpy.mockResolvedValueOnce({ id: "sub_stripe", items: { data: [] } });
    pricesListSpy.mockClear();

    await setExtraOrgs(1);

    expect(pricesListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: [proPlusEntry.lookupKey] }),
    );
  });

  it("removal is a Stripe DELETE, proration_behavior none", async () => {
    const { orgId, walletId } = await makeGroupOrg("pro");
    await sql`update subscriptions set stripe_subscription_id = ${`sub_stripe_${uniq()}`} where id = ${walletId}`;
    requireBillingOwnerMock.mockResolvedValueOnce({ orgId, subscriptionId: walletId });
    const existingItem = { id: "si_existing", quantity: 3, price: { lookup_key: proEntry.lookupKey } };
    retrieveSpy.mockResolvedValueOnce({ id: "sub_stripe", items: { data: [existingItem] } });
    itemDelSpy.mockClear();

    const result = await setExtraOrgs(0);

    expect(result.extraOrgs).toBe(0);
    expect(itemDelSpy).toHaveBeenCalledWith("si_existing", { proration_behavior: "none" });
  });
```

Add the standalone (no-DB) IDOR test, mirroring extra-seat's, in its own `describe`:

```ts
describe("extra-org route auth (IDOR)", () => {
  it("a non-payer is refused 403 before any Stripe call", async () => {
    requireBillingOwnerMock.mockRejectedValueOnce(
      new HttpError(403, "Only the person who pays for this billing group can manage its subscription."),
    );
    retrieveSpy.mockClear();
    itemCreateSpy.mockClear();

    await expect(setExtraOrgs(1)).rejects.toMatchObject({ status: 403 });
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(itemCreateSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/server/usecases/__tests__/extra-org-addon.test.ts`
Expected: FAIL — `Cannot find module '../extra-orgs'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/server/usecases/extra-orgs.ts`:

```ts
import "server-only";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { orgAddonForPlan, resolveOrgAddonPriceId, isOrgAddonItem } from "@/lib/org-addons";

/** Sanity bound — the group's own plan cap (10 on Pro Plus today) is far
 *  smaller than this; a request for hundreds is a bug or abuse, not a real
 *  purchase. The real cap is the customer's card. */
const MAX_EXTRA_ORGS = 50;

/**
 * Add / adjust / remove the extra-organisation recurring add-on for the
 * caller's billing GROUP (v17 gap #293, design/v17-pricing-entitlements
 * SPEC-2 §3/§7). Priced per plan tier ($9/mo Pro, $19/mo Pro Plus); +1
 * orgs.max_owned per unit, GROUP-WIDE (not scoped to one org — unlike a
 * seat, which lifts one org's members.max).
 *
 * Rides the group's EXISTING Stripe subscription as an extra subscription
 * ITEM (one invoice, one billing cycle, Stripe-native proration) — never a
 * second subscription. This mutates STRIPE ONLY: the org_addons row is
 * written by the customer.subscription.updated webhook
 * (syncOrgAddonsForSubscription, billing-events.ts), the single writer, so
 * Stripe and the DB can never diverge. Do NOT write org_addons here.
 *
 * Group-payer gated (`requireBillingOwner`, the same gate extra-seat and the
 * credit-pack checkout use) — a non-payer is refused 403 BEFORE any Stripe
 * call fires.
 *
 * @param count total extra organisations this group should hold beyond its
 *   plan's base cap (0 removes the add-on).
 */
export async function setExtraOrgs(
  count: number,
): Promise<{ subscriptionId: string; extraOrgs: number }> {
  if (!Number.isInteger(count) || count < 0 || count > MAX_EXTRA_ORGS) {
    throw new HttpError(400, `extra organisations must be an integer between 0 and ${MAX_EXTRA_ORGS}.`);
  }
  const { subscriptionId } = await requireBillingOwner();

  const [group] = await sql<
    { stripe_subscription_id: string | null; status: string | null; plan_key: string | null }[]
  >`select stripe_subscription_id, status, plan_key from subscriptions where id = ${subscriptionId}`;
  const groupRow = group ?? undefined;
  if (!hasLiveSubscription(groupRow)) {
    // Community (no Stripe subscription) has nothing to attach an item to.
    throw new HttpError(400, "Extra organisations require an active paid subscription.");
  }
  const stripeSubId = groupRow.stripe_subscription_id;

  const addon = orgAddonForPlan(groupRow.plan_key ?? "");
  if (!addon) {
    throw new HttpError(400, `Extra organisations are not available on the ${groupRow.plan_key} plan.`);
  }

  const live = await getStripe().subscriptions.retrieve(stripeSubId);
  // Group-wide: there is only ever ONE org-addon item on a subscription
  // (unlike seats, which carry one item per target org), so any match wins.
  const existing = live.items.data.find((it) => isOrgAddonItem(it));

  if (count === 0) {
    // Removal is a DELETE in Stripe — a subscription item cannot hold
    // quantity 0. The webhook then flips the org_addons row to canceled
    // (freeze-not-delete). Removing does not refund mid-cycle.
    if (existing) {
      await getStripe().subscriptionItems.del(existing.id, { proration_behavior: "none" });
    }
    return { subscriptionId, extraOrgs: 0 };
  }

  if (existing) {
    // Raising prorates now; lowering takes effect with no mid-cycle refund —
    // mirrors setExtraSeats' and syncGroupQuantity's proration rule.
    const raising = count > (existing.quantity ?? 0);
    await getStripe().subscriptionItems.update(existing.id, {
      quantity: count,
      proration_behavior: raising ? "create_prorations" : "none",
    });
  } else {
    const priceId = await resolveOrgAddonPriceId(groupRow.plan_key ?? "");
    await getStripe().subscriptionItems.create({
      subscription: stripeSubId,
      price: priceId,
      quantity: count,
      proration_behavior: "create_prorations",
      // Group-wide: no target_org_id (unlike a seat item). The webhook reads
      // feature_key off THIS metadata only as the unexpanded-price fallback
      // match (isOrgAddonItem primarily matches on lookup_key).
      metadata: { feature_key: addon.featureKey },
    });
  }
  return { subscriptionId, extraOrgs: count };
}
```

Create `apps/web/src/app/api/billing/extra-orgs/route.ts`:

```ts
import { z } from "zod";
import { handler } from "@/lib/http";
import { setExtraOrgs } from "@/server/usecases/extra-orgs";

const schema = z.object({ count: z.number().int().min(0).max(50) }).strict();

/**
 * POST /api/billing/extra-orgs — add / adjust / remove the recurring
 * extra-organisation add-on ($9/mo Pro, $19/mo Pro Plus, +1 orgs.max_owned
 * each, GROUP-WIDE) for the caller's billing group (v17 gap #293).
 *
 * Group-payer gated inside setExtraOrgs (requireBillingOwner) — a non-payer
 * gets 403 before any Stripe call. The org_addons row is written by the
 * customer.subscription.updated webhook, never here.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const { count } = schema.parse(await req.json());
    return setExtraOrgs(count);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/server/usecases/__tests__/extra-org-addon.test.ts`
Expected: PASS, all tests in the file green (webhook-sync tests from Task 2 plus the new usecase/route tests).

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/extra-orgs.ts apps/web/src/app/api/billing/extra-orgs/route.ts apps/web/src/server/usecases/__tests__/extra-org-addon.test.ts
git commit -m "$(cat <<'EOF'
feat(billing): purchase route for the extra-org add-on (#293)

setExtraOrgs mutates the group's Stripe subscription only (the
webhook remains the single org_addons writer); price resolves per
plan tier via lib/org-addons. Group-payer gated, mirrors extra-seat.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Resolver — route `groupOrgLimit`'s degenerate (all-suspended) branch through the addon bonus

**Files:**
- Modify: `apps/web/src/lib/entitlements.ts` (export `addonBonusForWallet`, refactor `addonBonus` to use it)
- Modify: `apps/web/src/lib/billing-group.ts` (`groupOrgLimit`'s degenerate branch, today at lines 166-177)
- Test: `apps/web/src/lib/__tests__/billing-groups.test.ts` (extend the existing `describe.skipIf(!HAS_DB)("suspension is org-scoped, billing is group-scoped", ...)` block)

**Interfaces:**
- Consumes: nothing new from earlier tasks in this wave — this is a standalone resolver fix.
- Produces: `addonBonusForWallet(walletId, featureKey, orgId?, competitionId?): Promise<number>`, exported from `@/lib/entitlements.ts`, consumed by `lib/billing-group.ts`'s `groupOrgLimit`.

**What was verified before writing this task (do not re-derive):** `groupOrgLimit`'s NORMAL branch (`lib/billing-group.ts:164`, `return getLimit(pick.id, "orgs.max_owned")`) **already** routes through the resolver — `getLimit` calls the private `addonBonus`, which sums `org_addons` on top of the plan base. So the common case (at least one non-suspended org in the group) needs **no code change at all**: once Task 2's webhook writes a row, `groupOrgLimit` already reflects it, and so does `attachOrgToGroup`'s `capLimit` (resolved via `groupOrgLimit` at `billing-groups.ts:612`, before its transaction) and `assertMayOwnAnotherOrg`'s per-owned-org `getLimit` calls (`lib/auth.ts:234`). The ONLY gap is the **degenerate branch** — every live org in the group suspended — which reads `plan_entitlements` directly (`lib/billing-group.ts:171-177`) and never asks the add-on table at all. This is exactly the case the existing test at `billing-groups.test.ts:300-306` ("Even with EVERY org suspended, the cap is the plan's, not community's") already proves is stuck at the plan base — this task keeps that assertion (still no-addon → still the plan base) and adds a new one for the addon-present case.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/lib/__tests__/billing-groups.test.ts`, add a new `it` inside the existing `describe.skipIf(!HAS_DB)("suspension is org-scoped, billing is group-scoped", ...)` block (right after the "does not let a suspended org shrink the GROUP cap it resolves through" test, today ending at line 307):

```ts
  it("the degenerate (every-org-suspended) branch also honours a purchased add-on (v17 gap #293)", async () => {
    const { subId, orgIds } = await seedGroup("pro", 2);
    for (const id of orgIds) {
      await sql`update organizations set status = 'suspended' where id = ${id}`;
      await invalidateOrgEntitlements(id);
    }
    expect(await groupOrgLimit(subId)).toBe(5); // pro base, no add-on yet — same as the test above

    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${subId}, null, 'orgs.max_owned', 1, 2, 'active')`;

    // Even with every org suspended, a purchased add-on still lifts the cap —
    // moderation state must not hide money the group already paid for.
    expect(await groupOrgLimit(subId)).toBe(7);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/lib/__tests__/billing-groups.test.ts`
Expected: FAIL — the new assertion gets `5`, not `7` (the degenerate branch ignores `org_addons`).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/lib/entitlements.ts`, replace the private `addonBonus` function (today at lines 426-441) with:

```ts
/**
 * addonBonus's WALLET-keyed core (v17 gap #293): sums org_addons directly by
 * wallet rather than resolving one through `walletIdFor(orgId)` first.
 * Exported for `groupOrgLimit`'s degenerate branch (lib/billing-group.ts),
 * which already KNOWS the wallet — it IS the subscription id being asked
 * about — and has no live org left to resolve one through when every member
 * is suspended, which is the one case `addonBonus` itself cannot reach (it
 * always starts from an org).
 *
 * `orgId`/`competitionId` omitted narrows the sum to GROUP-WIDE rows only
 * (target_org_id/target_competition_id both null) — the correct scope for a
 * cap like orgs.max_owned that is never meaningfully org- or comp-scoped.
 */
export async function addonBonusForWallet(
  walletId: string,
  featureKey: string,
  orgId?: string,
  competitionId?: string,
): Promise<number> {
  const [r] = await sql<{ bonus: number }[]>`
    select coalesce(sum(delta_each * qty), 0)::int as bonus
      from org_addons
     where wallet_id = ${walletId}
       and feature_key = ${featureKey}
       and status in ('active', 'granted')
       and (target_org_id is null or target_org_id = ${orgId ?? null})
       and (target_competition_id is null or target_competition_id = ${competitionId ?? null})`;
  return r?.bonus ?? 0;
}

async function addonBonus(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<number> {
  const walletId = await walletIdFor(orgId);
  return addonBonusForWallet(walletId, featureKey, orgId, competitionId);
}
```

In `apps/web/src/lib/billing-group.ts`, update the import (today at line 14):

```ts
import { getLimit, addonBonusForWallet } from "@/lib/entitlements";
```

And replace the degenerate branch's return (today `lib/billing-group.ts:174-177`):

```ts
  const [pe] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${grp.plan_key} and feature_key = 'orgs.max_owned'`;
  // A null base is unlimited (or the plan has no row at all) — no add-on can
  // raise "no cap", so skip the query entirely rather than waste a round trip.
  if (pe?.int_value == null) return pe?.int_value ?? null;
  const bonus = await addonBonusForWallet(subscriptionId, "orgs.max_owned");
  return pe.int_value + bonus;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/lib/__tests__/billing-groups.test.ts`
Expected: PASS, including the pre-existing "Even with EVERY org suspended, the cap is the plan's, not community's" assertion (unchanged, still 5 with no add-on) and the new one (7 with a +2 add-on).

- [ ] **Step 5: Commit**

```
git add apps/web/src/lib/entitlements.ts apps/web/src/lib/billing-group.ts apps/web/src/lib/__tests__/billing-groups.test.ts
git commit -m "$(cat <<'EOF'
fix(billing): degenerate groupOrgLimit honours purchased add-ons (#293)

The normal path already summed org_addons via getLimit; only the
all-orgs-suspended branch read plan_entitlements directly and never
asked the add-on table. addonBonusForWallet lets it ask without an
org to resolve a wallet through.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 402 purchase-offer plumbing

**Files:**
- Modify: `apps/web/src/lib/errors.ts` (`PaymentRequiredError` gains an optional `extra` param)
- Modify: `apps/web/src/lib/billing-group.ts` (`assertWithinGroupCap` gains an optional `addonAvailable` param)
- Modify: `apps/web/src/server/usecases/billing-groups.ts` (`attachOrgToGroup` call site — **re-verify the line number**, see the wave-level Consumes note)
- Modify: `apps/web/src/lib/auth.ts` (`assertMayOwnAnotherOrg` — widen the same way, for the PERSON cap)
- Modify: `apps/web/src/lib/http.ts` (surface `err.extra` in the 402 JSON envelope)
- Modify: `apps/web/src/lib/feature-copy.ts` (`orgs.max_owned` reason text — mention the purchase path)
- Test: `apps/web/src/lib/__tests__/billing-groups.test.ts` (pure unit tests, top-level, no DB needed), `apps/web/src/server/usecases/__tests__/billing-group-move.test.ts` (integration, extends the existing "refuses once the group is at its plan's org cap" test)

**Interfaces:**
- Consumes: `orgAddonForPlan` — `@/lib/org-addons` (Task 1). `GroupRow.plan_key` — `billing-groups.ts:40` (already selected by `groupRow()`). `orgPlanKey` — `@/lib/entitlements.ts:182` (already exported).
- Produces: `PaymentRequiredError.extra: Record<string, unknown> | undefined` (readable by any 402 consumer); `assertWithinGroupCap(count, limit, addonAvailable?)`; both call sites now throw `{offer: "extra_org"}` when the refused plan can buy one. Consumed by Task 9 (smoke, asserts the wire shape directly).

**Why both call sites (group cap AND person cap):** `POST /api/orgs` always runs `createOrgForUser` first regardless of an `attachToGroupId` choice (`apps/web/src/app/api/orgs/route.ts:20` calls `createOrgForUser` unconditionally), and `createOrgForUser` evaluates the PERSON cap (`assertMayOwnAnotherOrg`) before any attach logic ever runs (`lib/auth.ts:278`). A payer who already personally owns their plan's cap in orgs will ALWAYS hit the person-cap 402 on a plain "create org #N", never the group-cap one — so the "org #N create" moment the smoke test (Task 9) proves needs the offer on `assertMayOwnAnotherOrg`, not only on `assertWithinGroupCap`. The GROUP-cap offer (Task 7's UI) is a genuinely separate moment: attaching an EXISTING org (possibly one someone else already owns) into a group that is full.

**Scope decision:** `PaymentRequiredError`'s `extra` is a generic pass-through (mirrors `HttpError.extra`, already used elsewhere for `SEQ_CONFLICT`/`SCHEDULE_CONFLICT`/`STAGE_NOT_READY` — see `server/api-v1/http.ts:120-145`); only these two call sites populate it for `orgs.max_owned`. `feature-copy.ts`'s `FEATURE_REASONS` map is **not** run through the i18n dict today (verified: `client-api-reason.test.ts` mocks its OWN `reason` string; nothing in the codebase localises this specific map) — that is a pre-existing, out-of-scope gap this wave does not fix; the edited line stays English-only, consistent with every other line in that file.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/lib/__tests__/billing-groups.test.ts`, add a new top-level `describe` (pure, no `skipIf` needed — place it near the top, after the imports, before the `seedGroup` helper or after `afterAll`, at the same nesting level as the other top-level `describe`s):

```ts
describe("assertWithinGroupCap — purchase offer (v17 gap #293)", () => {
  it("carries { offer: 'extra_org' } when the caller says the plan can buy one", () => {
    let caught: unknown;
    try {
      assertWithinGroupCap(5, 5, true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PaymentRequiredError);
    expect((caught as InstanceType<typeof PaymentRequiredError>).extra).toEqual({ offer: "extra_org" });
  });

  it("carries no offer when the plan cannot buy one", () => {
    let caught: unknown;
    try {
      assertWithinGroupCap(1, 1, false);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();
  });

  it("defaults to no offer when the third argument is omitted (back-compat)", () => {
    let caught: unknown;
    try {
      assertWithinGroupCap(5, 5);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();
  });
});
```

Add to `apps/web/src/lib/__tests__/billing-groups.test.ts`'s existing `describe.skipIf(!HAS_DB)("the per-user cap and the per-group cap are different guards", ...)` block (today ending at line 241), two new tests:

```ts
  it("the person-cap refusal offers a purchase when an owned org's plan can buy one (v17 gap #293)", async () => {
    const s = uniq();
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`personcap-${s}@test.local`}, 'Person Cap', true) returning id`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${userId}, 'pro', 'active', 5) returning id`;
    for (let i = 0; i < 5; i++) {
      const [{ id: orgId }] = await sql<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Cap ${s} ${i}`}, ${`cap-${s}-${i}`}, ${userId}, ${subId}) returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    }

    const { assertMayOwnAnotherOrg } = await import("@/lib/auth");
    const err = await assertMayOwnAnotherOrg(userId).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as InstanceType<typeof PaymentRequiredError>).extra).toEqual({ offer: "extra_org" });
  });

  it("carries no offer for a community-only spread (nothing to buy)", async () => {
    const s = uniq();
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`personcap-comm-${s}@test.local`}, 'Person Cap Comm', true) returning id`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'community', 'active') returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`CommCap ${s}`}, ${`comm-cap-${s}`}, ${userId}, ${subId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;

    const { assertMayOwnAnotherOrg } = await import("@/lib/auth");
    const err = await assertMayOwnAnotherOrg(userId).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as InstanceType<typeof PaymentRequiredError>).extra).toBeUndefined();
  });
```

In `apps/web/src/server/usecases/__tests__/billing-group-move.test.ts`, add a new test right after the existing "refuses once the group is at its plan's org cap" test (today at lines 421-429):

```ts
  it("the org-cap refusal carries a purchase offer for pro (v17 gap #293)", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { plan: "pro", stripeSubId: "sub_cap_offer_" + uniq() });
    for (let i = 0; i < 5; i++) await makeOrg(group, payer);
    const joiner = await makeLooseOrg(payer);

    const err = await attachOrgToGroup({
      actorUserId: payer,
      orgId: joiner.orgId,
      subscriptionId: group,
    }).then(() => null, (e) => e);

    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as InstanceType<typeof PaymentRequiredError>).extra).toEqual({ offer: "extra_org" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/lib/__tests__/billing-groups.test.ts src/server/usecases/__tests__/billing-group-move.test.ts`
Expected: FAIL — `assertWithinGroupCap` doesn't accept a third argument yet (TS error / `.extra` is always `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/lib/errors.ts`, widen `PaymentRequiredError`:

```ts
/** Thrown by entitlement gates; maps to HTTP 402. `extra` merges into the
 *  error body the same way HttpError's does — e.g. a purchase OFFER next to
 *  the refusal (v17 gap #293: `{ offer: "extra_org" }` on orgs.max_owned when
 *  the refused plan can buy its way past the cap). */
export class PaymentRequiredError extends HttpError {
  constructor(
    public readonly featureKey: string,
    extra?: Record<string, unknown>,
  ) {
    super(402, `Plan upgrade required: ${featureKey}`, undefined, extra);
  }
}
```

In `apps/web/src/lib/billing-group.ts`, widen `assertWithinGroupCap` (today lines 182-187):

```ts
/** Apply a limit resolved by groupOrgLimit to a count read under the lock.
 *  Pure, so it is safe to call from inside a transaction.
 *
 *  `addonAvailable` (v17 gap #293): can the refused plan buy its way past the
 *  cap? Resolved by the caller BEFORE the transaction — same reason `limit`
 *  itself is — so the refusal can point at a real purchase instead of a
 *  dead-end "upgrade". Defaults to false (no offer) for the one caller that
 *  cannot cheaply know (assertGroupMayHoldAnotherOrg, which has no production
 *  caller left). */
export function assertWithinGroupCap(
  currentOrgCount: number,
  limit: number | null,
  addonAvailable = false,
): void {
  // null is UNLIMITED; 0 means the plan has no row for the key at all, and both
  // that and a real 1 correctly refuse a group that already holds one org.
  if (limit === null) return;
  if (currentOrgCount + 1 > limit) {
    throw new PaymentRequiredError(
      "orgs.max_owned",
      addonAvailable ? { offer: "extra_org" } : undefined,
    );
  }
}
```

In `apps/web/src/server/usecases/billing-groups.ts`, add the import (near the existing `activeOrgCount, assertWithinGroupCap, groupOrgLimit` import from `@/lib/billing-group`, today at line 26):

```ts
import { orgAddonForPlan } from "@/lib/org-addons";
```

Update the `attachOrgToGroup` call site — find it by its argument shape (`assertWithinGroupCap(Number(heldRow?.n ?? 0), capLimit)`), which today sits right after the `heldRow` count query, and compute the offer flag from `target.plan_key` (already selected by `groupRow()` at the top of the function, today `billing-groups.ts:607`):

```ts
    // Counted under the lock, compared against a limit resolved outside it.
    assertWithinGroupCap(Number(heldRow?.n ?? 0), capLimit, !!orgAddonForPlan(target.plan_key));
```

In `apps/web/src/lib/auth.ts`, add to the existing import (today line 9):

```ts
import { getLimit, orgPlanKey } from "@/lib/entitlements";
```

And add:

```ts
import { orgAddonForPlan } from "@/lib/org-addons";
```

Widen `assertMayOwnAnotherOrg` (today lines 211-244), replacing only the final refusal line:

```ts
  const limit = Math.max(...(limits as number[]));
  if (owned.length + 1 > limit) {
    // v17 gap #293: does ANY owned org's plan support the extra-org add-on?
    // Resolved through the SAME plan the limit itself came from (orgPlanKey),
    // so a lapsed/degraded plan never offers a purchase it cannot complete.
    const plans = await Promise.all(owned.map((o) => orgPlanKey(o.org_id)));
    const addonAvailable = plans.some((p) => !!orgAddonForPlan(p));
    throw new PaymentRequiredError(
      "orgs.max_owned",
      addonAvailable ? { offer: "extra_org" } : undefined,
    );
  }
```

In `apps/web/src/lib/http.ts`, update the `PaymentRequiredError` branch (today lines 31-43):

```ts
      if (err instanceof PaymentRequiredError) {
        // Upgrade-moment contract (doc 10 §3): feature_key + human reason let
        // the client render a contextual paywall (<UpgradeGate>). `extra`
        // merges in machine-readable hints — e.g. a purchase offer (v17 gap
        // #293) — the same way HttpError's extra always has.
        return NextResponse.json(
          {
            ok: false,
            error: err.message,
            feature_key: err.featureKey,
            reason: featureReason(err.featureKey),
            ...err.extra,
          },
          { status: 402 },
        );
      }
```

In `apps/web/src/lib/feature-copy.ts`, replace the `"orgs.max_owned"` line (today lines 15-16):

```ts
  "orgs.max_owned":
    "Your current plan covers the most organisations it allows (Community 1, Pro 5, Pro Plus 10). On Pro or Pro Plus, buy an extra organisation from Settings → Add-ons for the same rate as the ones already on your bill; Community upgrades to Pro first.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/lib/__tests__/billing-groups.test.ts src/server/usecases/__tests__/billing-group-move.test.ts`
Expected: PASS, all new and pre-existing tests green (`instanceof PaymentRequiredError` assertions elsewhere are unaffected by the added optional param).

Also run the full lib + usecases suites once to catch any other `PaymentRequiredError("orgs.max_owned")` equality assertion this touched:

Run: `npx vitest run src/lib/__tests__/ src/server/usecases/__tests__/`
Expected: PASS (no regressions — every existing caller passes exactly one argument, which the new optional parameters default safely for).

- [ ] **Step 5: Commit**

```
git add apps/web/src/lib/errors.ts apps/web/src/lib/billing-group.ts apps/web/src/server/usecases/billing-groups.ts apps/web/src/lib/auth.ts apps/web/src/lib/http.ts apps/web/src/lib/feature-copy.ts apps/web/src/lib/__tests__/billing-groups.test.ts apps/web/src/server/usecases/__tests__/billing-group-move.test.ts
git commit -m "$(cat <<'EOF'
feat(billing): orgs.max_owned 402 offers a purchase, not just an upgrade (#293)

Both the group cap (attachOrgToGroup) and the person cap
(assertMayOwnAnotherOrg) now carry { offer: "extra_org" } when the
refused plan can buy past the cap — a payer creating org #N (the
common path, since createOrgForUser always runs first) sees the
offer as readily as one attaching an existing org into a full group.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add-ons tab UI (SPEC-6 §A5)

**Files:**
- Create: `apps/web/src/server/usecases/add-ons-tab.ts`
- Create: `apps/web/src/app/o/[orgSlug]/settings/add-ons/page.tsx`
- Create: `apps/web/src/components/extra-orgs-control.tsx`
- Modify: `apps/web/src/lib/routes.ts` (add `addOns` route helper)
- Modify: `apps/web/src/app/o/[orgSlug]/settings/page.tsx` (nav link, mirrors `CREDITS_NAV`)
- Modify: `apps/web/src/config/tips.ts` (new tip)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (new keys)
- Test: `apps/web/src/server/usecases/__tests__/add-ons-tab.test.ts`

**Interfaces:**
- Consumes: `walletIdFor` (`@/lib/credits.ts:62`), `activeOrgCount`/`groupOrgLimit` (`@/lib/billing-group.ts`, Task 4-corrected), `hasLiveSubscription` (`@/lib/subscription-status.ts`), `orgAddonForPlan` (`@/lib/org-addons`, Task 1), `extraOrgPrice` (`@/lib/currency.ts:60-71`, pre-existing), `requireOrgPage` (`@/server/page-auth.ts:69-90`), `preferredCurrency` (`@/lib/currency-server.ts:16-31`), `POST /api/billing/extra-orgs` (Task 3).
- Produces: `getAddOnsTab(orgId, userId): Promise<AddOnsTabView>`; `routes.addOns(orgSlug)`.

**SPEC-6 §A5 gap found during research:** the Add-ons tab does not exist anywhere in the app today — grepped for `size-pack-checkout`/`setExtraSeats`/`add-ons` across `apps/web/src/components` and `apps/web/src/app` and found zero UI call sites; extra-seat and size-pack have been API-only since they shipped. Building the whole SPEC-6 §A5 mock (seat picker + size-pack list) is **out of scope** for #293 — this task builds only the **Extra organisations** row the issue asks for, on a route/nav structure that can accept the other rows later without a rename. Note this explicitly rather than silently under-delivering the mock.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/usecases/__tests__/add-ons-tab.test.ts
//
// v17 gap #293, SPEC-6 §A5 — the Add-ons tab's view model. Real-Postgres
// integration test: skips without DATABASE_URL. Mirrors credits-tab.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { walletIdFor } from "@/lib/credits";
import { seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { getAddOnsTab } from "../add-ons-tab";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("getAddOnsTab", () => {
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("a Pro payer sees the base cap, zero extra orgs, and the add-on offered", async () => {
    const { auth } = await seedOrg("pro");
    const view = await getAddOnsTab(auth.orgId, auth.userId);
    expect(view.planKey).toBe("pro");
    expect(view.isPayer).toBe(true);
    expect(view.hasLiveSubscription).toBe(false); // smoke/tests never touch real Stripe
    expect(view.addonAvailable).toBe(true);
    expect(view.orgCap).toBe(5);
    expect(view.extraOrgCount).toBe(0);
  });

  it("community cannot buy the add-on", async () => {
    const { auth } = await seedOrg("community");
    const view = await getAddOnsTab(auth.orgId, auth.userId);
    expect(view.addonAvailable).toBe(false);
    expect(view.orgCap).toBe(1);
  });

  it("reflects a purchased extra-org row in both the cap and the count", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 2, 'active')`;

    const view = await getAddOnsTab(auth.orgId, auth.userId);
    expect(view.orgCap).toBe(7);
    expect(view.extraOrgCount).toBe(2);
  });

  it("a non-payer member sees the same numbers but isPayer=false", async () => {
    const { auth } = await seedOrg("pro");
    const view = await getAddOnsTab(auth.orgId, "not-" + auth.userId);
    expect(view.isPayer).toBe(false);
    expect(view.orgCap).toBe(5);
  });

  it("pro_plus prices independently of pro", async () => {
    const { auth } = await seedOrg("community");
    await setOrgPlan(auth.orgId, "pro_plus");
    await invalidateOrgEntitlements(auth.orgId);
    const view = await getAddOnsTab(auth.orgId, auth.userId);
    expect(view.planKey).toBe("pro_plus");
    expect(view.orgCap).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/server/usecases/__tests__/add-ons-tab.test.ts`
Expected: FAIL — `Cannot find module '../add-ons-tab'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/server/usecases/add-ons-tab.ts`:

```ts
import "server-only";
import { sql } from "@/lib/db";
import { walletIdFor } from "@/lib/credits";
import { activeOrgCount, groupOrgLimit } from "@/lib/billing-group";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { orgAddonForPlan } from "@/lib/org-addons";

/**
 * The Add-ons tab's view model (v17 gap #293, SPEC-6 §A5). Today this covers
 * only the extra-organisation add-on — extra-seat and size-pack purchase UI
 * do not exist yet (verified: no component references either), and building
 * them is not this issue's job. The route/nav shape is designed to grow
 * those rows in later without a rename.
 */
export interface AddOnsTabView {
  /** Raw plan_key on the subscription row — the same basis setExtraOrgs
   *  prices from, not the resolver-degraded "effective" plan. */
  planKey: string;
  isPayer: boolean;
  hasLiveSubscription: boolean;
  /** Can THIS plan buy the extra-org add-on at all? False for community. */
  addonAvailable: boolean;
  /** Effective cap = plan base + any active add-on, through the resolver. */
  orgCap: number | null;
  liveOrgCount: number;
  /** Current purchased extra-org quantity (0 if none). */
  extraOrgCount: number;
}

export async function getAddOnsTab(orgId: string, userId: string): Promise<AddOnsTabView> {
  const walletId = await walletIdFor(orgId);
  const [group] = await sql<
    {
      plan_key: string;
      owner_user_id: string;
      stripe_subscription_id: string | null;
      status: string | null;
    }[]
  >`select plan_key, owner_user_id, stripe_subscription_id, status
      from subscriptions where id = ${walletId}`;
  const planKey = group?.plan_key ?? "community";

  const [orgCap, liveCount, addonRow] = await Promise.all([
    groupOrgLimit(walletId),
    activeOrgCount(walletId),
    sql<{ qty: number }[]>`
      select qty from org_addons
       where wallet_id = ${walletId} and feature_key = 'orgs.max_owned'
         and target_org_id is null and status = 'active'`,
  ]);

  return {
    planKey,
    isPayer: group?.owner_user_id === userId,
    hasLiveSubscription: hasLiveSubscription(
      group
        ? { stripe_subscription_id: group.stripe_subscription_id, status: group.status }
        : undefined,
    ),
    addonAvailable: !!orgAddonForPlan(planKey),
    orgCap,
    liveOrgCount: liveCount,
    extraOrgCount: addonRow[0]?.qty ?? 0,
  };
}
```

Create `apps/web/src/components/extra-orgs-control.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useMsg } from "@/components/i18n/dict-provider";
import { formatMinor, type Currency } from "@/lib/currency";

/** The Extra organisations stepper (SPEC-6 §A5) — rides the group's existing
 *  subscription (POST /api/billing/extra-orgs, Task 3), no separate Stripe
 *  checkout: the payer already has a payment method on file, same as
 *  extra-seat's (never-built) equivalent would have. */
export function ExtraOrgsControl({
  initialCount,
  priceMinor,
  currency,
}: {
  initialCount: number;
  priceMinor: number;
  currency: Currency;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = count !== initialCount;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/billing/extra-orgs", { method: "POST", json: { count } });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("addOns.extraOrg.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3">
      <span className="flex-1 text-sm font-medium text-slate-800">
        {msg("addOns.extraOrg.label")}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCount((c) => Math.max(0, c - 1))}
          disabled={busy || count <= 0}
          aria-label={msg("addOns.extraOrg.decrease")}
          className="btn btn-ghost h-8 w-8 p-0 text-lg leading-none"
        >
          –
        </button>
        <span className="w-6 text-center text-sm font-semibold" data-extra-org-count>
          {count}
        </span>
        <button
          type="button"
          onClick={() => setCount((c) => c + 1)}
          disabled={busy}
          aria-label={msg("addOns.extraOrg.increase")}
          className="btn btn-ghost h-8 w-8 p-0 text-lg leading-none"
        >
          +
        </button>
      </div>
      <span className="text-xs text-slate-500">
        {msg("addOns.extraOrg.priceEach", { price: formatMinor(priceMinor, currency) })}
      </span>
      {dirty && (
        <button type="button" onClick={save} disabled={busy} className="btn btn-primary text-xs">
          {busy ? msg("addOns.extraOrg.saving") : msg("addOns.extraOrg.save")}
        </button>
      )}
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
```

Create `apps/web/src/app/o/[orgSlug]/settings/add-ons/page.tsx`:

```tsx
export const dynamic = "force-dynamic";
// Add-ons tab (v17 gap #293, SPEC-6 §A5) — today, extra organisations only;
// see add-ons-tab.ts's doc comment for why extra-seat/size-pack rows are not
// here yet. Member-visible (like Credits, Billing), payer-only controls.
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { BackLink } from "@/components/back-link";
import { getAddOnsTab } from "@/server/usecases/add-ons-tab";
import { extraOrgPrice } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { ExtraOrgsControl } from "@/components/extra-orgs-control";
import { Tip } from "@/components/ui/tip";

export default async function AddOnsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org, user } = await requireOrgPage(orgSlug, { tail: "/settings/add-ons" });
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const view = await getAddOnsTab(org.id, user.id);
  const currency = await preferredCurrency(org.id);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <BackLink href={routes.orgSettings(orgSlug)} label={t(dict, "action.settings")} emphasis="button" />
      <div className="mb-6 flex items-center gap-2">
        <h1 className="page-title">{t(dict, "settings.nav.addOns")}</h1>
        <Tip id="billing.addons.extra-org" small />
      </div>

      <p className="mb-4 text-sm text-slate-600">
        {t(dict, "addOns.cap.summary", {
          count: view.liveOrgCount,
          cap: view.orgCap ?? "∞",
        })}
      </p>

      {!view.addonAvailable ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.communityNotice")}
        </p>
      ) : !view.hasLiveSubscription ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.noLiveSubscription")}
        </p>
      ) : view.isPayer ? (
        <ExtraOrgsControl
          initialCount={view.extraOrgCount}
          priceMinor={extraOrgPrice(view.planKey as "pro" | "pro_plus", "monthly", currency)}
          currency={currency}
        />
      ) : (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.guestNotice")}
        </p>
      )}
    </main>
  );
}
```

In `apps/web/src/lib/routes.ts`, add (near `credits`, today line 16):

```ts
  /** Purchasable add-ons — extra organisations today (SPEC-6 §A5). */
  addOns: (org: Slug) => `/o/${org}/settings/add-ons`,
```

In `apps/web/src/app/o/[orgSlug]/settings/page.tsx`, add the nav const (near `CREDITS_NAV`, today line 111):

```ts
const ADDONS_NAV = { labelKey: "settings.nav.addOns", icon: Sparkles } as const;
```

And add the link (near the `CREDITS_NAV` `<Link>`, today lines 282-288, right after it, before the closing `</nav>`):

```tsx
              <Link
                href={routes.addOns(orgSlug)}
                className="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-purple-50 hover:text-purple-700"
              >
                <ADDONS_NAV.icon className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.75} />
                {t(dict, ADDONS_NAV.labelKey)}
              </Link>
```

In `apps/web/src/config/tips.ts`, add a new entry (near `"billing.extra-org"`, today lines 64-68 — a DIFFERENT key, since that one already means the within-cap graduated-tier rate):

```ts
  "billing.addons.extra-org": {
    title: "Buy past your plan's organisation limit",
    body: "An extra organisation beyond your plan's limit is a recurring add-on, priced the same as the organisations already on your bill.",
    helpSlug: "billing/add-ons",
  },
```

(`billing/add-ons` is not yet in `HELP_ARTICLE_SLUGS` — W7 registers it. `helpUrl()` resolves an unregistered slug to `null` and the Tip's "Learn more" link simply does not render, verified in `apps/web/src/lib/help.ts:82-87` — never a dead link, safe to reference now.)

Add the new dict keys to **all four** `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, near the existing `settings.nav.*`/`tips.billing.*`/`orgNew.bill.*` blocks (keep each locale's relative key ordering the same as `en`'s, matching the existing convention):

`settings.nav.addOns` (near `settings.nav.credits`, en line 473):
- en: `"Add-ons"`
- es: `"Complementos"`
- fr: `"Extensions"`
- nl: `"Add-ons"`

`tips.billing.addons.extra-org.title` / `.body` (near `tips.billing.extra-org.*`, en lines 919-920):
- en title: `"Buy past your plan's organisation limit"`, body: `"An extra organisation beyond your plan's limit is a recurring add-on, priced the same as the organisations already on your bill."`
- es title: `"Compra más allá del límite de organizaciones de tu plan"`, body: `"Una organización adicional más allá del límite de tu plan es un complemento recurrente, con el mismo precio que las organizaciones que ya están en tu factura."`
- fr title: `"Achetez au-delà de la limite d'organisations de votre forfait"`, body: `"Une organisation supplémentaire au-delà de la limite de votre forfait est une extension récurrente, au même tarif que les organisations déjà sur votre facture."`
- nl title: `"Koop voorbij de organisatielimiet van je abonnement"`, body: `"Een extra organisatie boven de limiet van je abonnement is een terugkerende add-on, tegen hetzelfde tarief als de organisaties die al op je factuur staan."`

`addOns.cap.summary` (new block, e.g. near `orgNew.bill.*`):
- en: `"Using {count} of {cap} organisations on this bill."`
- es: `"Usando {count} de {cap} organizaciones en esta factura."`
- fr: `"{count} organisations utilisées sur {cap} pour cette facture."`
- nl: `"{count} van {cap} organisaties in gebruik op deze factuur."`

`addOns.communityNotice`:
- en: `"Add-ons are available on Pro and Pro Plus. Upgrade to buy past the Community limit."`
- es: `"Los complementos están disponibles en Pro y Pro Plus. Mejora tu plan para superar el límite de Community."`
- fr: `"Les extensions sont disponibles avec Pro et Pro Plus. Passez à un forfait supérieur pour dépasser la limite Community."`
- nl: `"Add-ons zijn beschikbaar bij Pro en Pro Plus. Upgrade om voorbij de Community-limiet te gaan."`

`addOns.noLiveSubscription`:
- en: `"Extra organisations need an active paid subscription. Complete checkout on the Billing tab first."`
- es: `"Las organizaciones adicionales requieren una suscripción de pago activa. Completa el pago primero en la pestaña Facturación."`
- fr: `"Les organisations supplémentaires nécessitent un abonnement payant actif. Terminez d'abord le paiement dans l'onglet Facturation."`
- nl: `"Extra organisaties vereisen een actief betaald abonnement. Rond eerst het afrekenen af op het tabblad Facturering."`

`addOns.guestNotice`:
- en: `"Only the person who pays for this billing group can buy add-ons."`
- es: `"Solo la persona que paga este grupo de facturación puede comprar complementos."`
- fr: `"Seule la personne qui paie ce groupe de facturation peut acheter des extensions."`
- nl: `"Alleen degene die voor deze factureringsgroep betaalt, kan add-ons kopen."`

`addOns.extraOrg.label`:
- en: `"Extra organisations"` · es: `"Organizaciones adicionales"` · fr: `"Organisations supplémentaires"` · nl: `"Extra organisaties"`

`addOns.extraOrg.decrease`:
- en: `"Decrease extra organisations"` · es: `"Reducir organizaciones adicionales"` · fr: `"Réduire les organisations supplémentaires"` · nl: `"Extra organisaties verminderen"`

`addOns.extraOrg.increase`:
- en: `"Increase extra organisations"` · es: `"Aumentar organizaciones adicionales"` · fr: `"Augmenter les organisations supplémentaires"` · nl: `"Extra organisaties verhogen"`

`addOns.extraOrg.priceEach`:
- en: `"{price}/mo each"` · es: `"{price}/mes cada una"` · fr: `"{price}/mois chacune"` · nl: `"{price}/mnd per stuk"`

`addOns.extraOrg.save`:
- en: `"Save"` · es: `"Guardar"` · fr: `"Enregistrer"` · nl: `"Opslaan"`

`addOns.extraOrg.saving`:
- en: `"Saving…"` · es: `"Guardando…"` · fr: `"Enregistrement…"` · nl: `"Bezig met opslaan…"`

`addOns.extraOrg.failed`:
- en: `"Could not update extra organisations. Try again."` · es: `"No se pudieron actualizar las organizaciones adicionales. Inténtalo de nuevo."` · fr: `"Impossible de mettre à jour les organisations supplémentaires. Réessayez."` · nl: `"Extra organisaties konden niet worden bijgewerkt. Probeer het opnieuw."`

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=<local test PG on :54329> npx vitest run src/server/usecases/__tests__/add-ons-tab.test.ts`
Expected: PASS, all 5 tests green.

Then, from repo root: `npm run i18n:gen-keys && npm run i18n:check` — expect clean (no missing keys across the 4 locales, `MessageKey` type widened automatically since it derives from `en/ui.json`).

Then screenshot-verify (per Global Constraints — frontend-design skill, light theme, 375px + desktop) the new `/o/<slug>/settings/add-ons` page in three states: payer on Pro (stepper visible), non-payer member (guest notice), community org (community notice). Confirm no horizontal scroll at 375px.

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/add-ons-tab.ts apps/web/src/app/o/\[orgSlug\]/settings/add-ons/page.tsx apps/web/src/components/extra-orgs-control.tsx apps/web/src/lib/routes.ts apps/web/src/app/o/\[orgSlug\]/settings/page.tsx apps/web/src/config/tips.ts apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json apps/web/src/lib/i18n-keys.ts apps/web/src/server/usecases/__tests__/add-ons-tab.test.ts
git commit -m "$(cat <<'EOF'
feat(billing): Add-ons Settings tab — extra organisations (#293)

New /settings/add-ons tab (SPEC-6 §A5), extra-org row only (seat and
size-pack rows have no UI to move yet). Payer buys/adjusts inline;
non-payer members and community orgs see explanatory copy. 4 locales.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: "Full" bill picker gets a purchase link

**Files:**
- Modify: `apps/web/src/components/create-org-form.tsx`
- Test: `apps/web/src/components/__tests__/create-org-form.test.tsx`

**Interfaces:**
- Consumes: `routes.addOns(orgSlug)` — `@/lib/routes.ts` (Task 6).
- Produces: `eligibility()` gains an `addOnsHref?: string` field, consumed by the render.

**Design:** `GET /api/billing/groups`'s `max_orgs` already resolves through `groupOrgLimit` (`apps/web/src/app/api/billing/groups/route.ts:97`), which Task 4 corrected — so once a payer buys the add-on, the "Full" badge clears **automatically** on next load, with zero change needed here. What's missing is the CTA at the moment of refusal: today a full group just shows a disabled "Full" pill with no way out. This task adds a link straight to the Add-ons tab.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/__tests__/create-org-form.test.tsx`, add new tests inside the existing `describe("create-org-form billing decisions", ...)` block (after the "(a) offers an eligible group..." test, today ending at line 59):

```ts
  it("(v17 gap #293) a full pro/pro_plus group's reason carries an Add-ons link when the org has a slug", () => {
    const fullWithSlug = {
      ...fullGroup,
      orgs: [{ id: "o2", name: "Northside", slug: "northside" }],
    };
    const full = eligibility(fullWithSlug, msg);
    expect(full.addOnsHref).toBe("/o/northside/settings/add-ons");
  });

  it("omits the Add-ons link when the group has no org to hang a slug off", () => {
    expect(eligibility(fullGroup, msg).addOnsHref).toBeUndefined();
  });

  it("an ELIGIBLE group never carries an addOnsHref (nothing to buy)", () => {
    expect(eligibility(proGroup, msg)).toEqual({ eligible: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/create-org-form.test.tsx`
Expected: FAIL — `full.addOnsHref` is `undefined` (property doesn't exist on the returned object yet).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/components/create-org-form.tsx`, widen the `CreateOrgGroup` interface (today lines 12-20):

```ts
export interface CreateOrgGroup {
  id: string;
  plan_key: string;
  status: string;
  cancel_at_period_end: boolean;
  has_live_subscription: boolean;
  max_orgs: number | null;
  orgs: { id: string; name?: string | null; slug?: string | null }[];
}
```

Add the import (near the top, alongside `useRouter`):

```ts
import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
```

Replace `eligibility()` (today lines 33-46):

```ts
export function eligibility(
  g: CreateOrgGroup,
  msg: Msg,
): { eligible: boolean; reason?: string; addOnsHref?: string } {
  if (g.status === "past_due")
    return { eligible: false, reason: msg("orgNew.bill.reasonPastDue") };
  if (g.cancel_at_period_end)
    return { eligible: false, reason: msg("orgNew.bill.reasonCancelling") };
  if (g.status !== "active" && g.status !== "trialing")
    return { eligible: false, reason: msg("orgNew.bill.reasonInactive") };
  if (g.max_orgs !== null && g.orgs.length >= g.max_orgs) {
    // Community's max_orgs is always 1 with one org, so it never reaches
    // here — "Full" only fires for pro/pro_plus (v17 gap #293), both of
    // which the extra-org add-on sells, so the CTA always has somewhere to
    // send the payer.
    const slug = g.orgs[0]?.slug;
    return {
      eligible: false,
      reason: msg("orgNew.bill.reasonFull"),
      addOnsHref: slug ? routes.addOns(slug) : undefined,
    };
  }
  return { eligible: true };
}
```

In the render loop over `groups` (today lines 282-323), destructure `addOnsHref` and render the link next to the reason pill (today lines 315-319):

```tsx
                {(groups ?? []).map((g) => {
                  const { eligible, reason, addOnsHref } = eligibility(g, msg);
```

```tsx
                        {!eligible && (
                          <span className="flex flex-none items-center gap-1.5">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                              {reason}
                            </span>
                            {addOnsHref && (
                              <Link
                                href={addOnsHref}
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs font-semibold text-purple-700 underline"
                              >
                                {msg("orgNew.bill.reasonFullCta")}
                              </Link>
                            )}
                          </span>
                        )}
```

Add `orgNew.bill.reasonFullCta` to all four `dictionaries/*/ui.json` (near `orgNew.bill.reasonFull`, en line 1133):
- en: `"Buy another slot →"` · es: `"Comprar otra plaza →"` · fr: `"Acheter une place supplémentaire →"` · nl: `"Nog een plek kopen →"`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/create-org-form.test.tsx`
Expected: PASS, all tests in the file green (including the pre-existing `.toEqual({eligible: true})` — an extra optional field left unset does not change deep-equality).

Then: `npm run i18n:gen-keys && npm run i18n:check` from repo root — clean.

Grep the changed/added UI text across e2e specs before merging (UI-text-breaks-e2e rule): `rg "reasonFull|Full\b" apps/web/e2e` and confirm no e2e assertion depends on the "Full" pill rendering with NO sibling link.

- [ ] **Step 5: Commit**

```
git add apps/web/src/components/create-org-form.tsx apps/web/src/components/__tests__/create-org-form.test.tsx apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json apps/web/src/lib/i18n-keys.ts
git commit -m "$(cat <<'EOF'
feat(billing): "Full" bill picker links straight to Add-ons (#293)

A full pro/pro_plus group used to dead-end at a disabled "Full"
pill; it now also offers a direct link to buy an extra-org slot.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: BILLING_LIVE suite

**Files:**
- Create: `apps/web/src/server/usecases/__tests__/extra-org-addon.live.test.ts`

**Interfaces:**
- Consumes: `ORG_ADDONS` (Task 1), `syncOrgAddonsForSubscription` (Task 2), real `DATABASE_URL` + `STRIPE_SECRET_KEY` (sk_test).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/usecases/__tests__/extra-org-addon.live.test.ts
//
// LIVE verification for the extra-organisation recurring add-on (v17 gap
// #293) — NOT a unit test. Every other test mocks Stripe; this asks a real
// (test-mode) Stripe account to actually add the item to a subscription and
// bill it, then runs the REAL webhook writer (syncOrgAddonsForSubscription)
// against a scratch DB row, proving the whole pipeline: purchase -> Stripe
// item -> webhook -> org_addons -> resolver.
//
// Self-contained: mints its own product/prices under the catalog's OWN
// lookup_keys, so resolveOrgAddonPriceId-shaped resolution is exercised
// against a real account independent of whether `stripe:sync` has run.
// Everything is cleaned up; no real money moves. Skipped unless
// BILLING_LIVE=1 AND a test-mode key AND DATABASE_URL. Run:
//   BILLING_LIVE=1 STRIPE_SECRET_KEY=sk_test_... DATABASE_URL=postgres://... \
//     npx vitest run --root apps/web src/server/usecases/__tests__/extra-org-addon.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit } from "@/lib/entitlements";
import { ORG_ADDONS } from "@/lib/org-addons";
import { syncOrgAddonsForSubscription } from "../billing-events";

const LIVE =
  process.env.BILLING_LIVE === "1" &&
  (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test") &&
  !!process.env.DATABASE_URL;

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
});

describe.skipIf(!LIVE)("extra-org add-on (live Stripe, test mode)", () => {
  it("rides the group's subscription as an extra item and the webhook lifts orgs.max_owned", async () => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const proEntry = ORG_ADDONS.find((e) => e.planKey === "pro")!;

    const product = await stripe.products.create({ name: `org-addon-probe-${Date.now()}` });
    cleanup.push(() => stripe.products.update(product.id, { active: false }));
    const proPrice = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: 900,
      recurring: { interval: "month" },
      lookup_key: `${proEntry.lookupKey}-livetest-${Date.now()}`,
    });
    cleanup.push(() => stripe.prices.update(proPrice.id, { active: false }));

    const baseProduct = await stripe.products.create({ name: `org-base-probe-${Date.now()}` });
    cleanup.push(() => stripe.products.update(baseProduct.id, { active: false }));
    const basePrice = await stripe.prices.create({
      product: baseProduct.id,
      currency: "usd",
      unit_amount: 1900,
      recurring: { interval: "month" },
    });
    cleanup.push(() => stripe.prices.update(basePrice.id, { active: false }));

    const customer = await stripe.customers.create({
      email: `org-addon-probe-${Date.now()}@example.com`,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    cleanup.push(() => stripe.customers.del(customer.id));

    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: basePrice.id, quantity: 1 }],
    });
    cleanup.push(() => stripe.subscriptions.cancel(sub.id));

    // Add the org-addon item — quantity 2 extra organisations.
    const item = await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: proPrice.id,
      quantity: 2,
      metadata: { feature_key: proEntry.featureKey },
    });
    cleanup.push(() => stripe.subscriptionItems.del(item.id).catch(() => undefined));

    const live = await stripe.subscriptions.retrieve(sub.id);
    expect(live.items.data.some((i) => i.id === item.id && i.quantity === 2)).toBe(true);

    // Now the REAL webhook writer, against a scratch DB org.
    const [owner] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`org-addon-probe-${randomUUID()}@test.local`}, 'Probe Owner', true) returning id`;
    const org = await createOrgForUser(owner!.id, "Org Addon Live Probe");
    const walletId = await walletIdFor(org.id);
    await sql`update subscriptions set plan_key = 'pro', status = 'active' where id = ${walletId}`;

    const [{ int_value: base }] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements where plan_key = 'pro' and feature_key = 'orgs.max_owned'`;

    await syncOrgAddonsForSubscription(live, walletId);

    expect(await getLimit(org.id, "orgs.max_owned")).toBe((base ?? 0) + 2);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (without `BILLING_LIVE`/keys set): `npx vitest run src/server/usecases/__tests__/extra-org-addon.live.test.ts`
Expected: the suite is **skipped** (`LIVE` is false) — this is the correct "no false green" baseline, not a red. Confirm it FAILS for the right reason when only partially configured: run with `BILLING_LIVE=1` and a fake `STRIPE_SECRET_KEY=sk_test_x` (no real network) and confirm the first Stripe call throws (proving the test genuinely exercises the network, not a stub).

- [ ] **Step 3: Write minimal implementation**

None — this task's file IS the test; Tasks 1-3 already implement everything it exercises. If Step 2's real-network run surfaces a defect (e.g. metadata shape mismatch), fix it in the relevant Task 1-3 file, not here.

- [ ] **Step 4: Run test to verify it passes**

Run: `BILLING_LIVE=1 STRIPE_SECRET_KEY=<sk_test from main repo .env.local> DATABASE_URL=<local test PG> npx vitest run --root apps/web src/server/usecases/__tests__/extra-org-addon.live.test.ts`
Expected: PASS (30s timeout, several sequential Stripe round trips — do not lower it).

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/__tests__/extra-org-addon.live.test.ts
git commit -m "$(cat <<'EOF'
test(billing): live Stripe verification for the extra-org add-on (#293)

BILLING_LIVE=1 suite against test-mode Stripe: real subscription
item + quantity, then the real webhook writer against a scratch DB
row — proves the pipeline end to end, not just each half mocked.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: smoke.ts — 402 → purchase → org #11 creation succeeds

**Files:**
- Modify: `scripts/smoke.ts`

**Interfaces:**
- Consumes: `setPlan(orgId, plan, session)` (`scripts/smoke.ts:7219-7256`, existing — busts entitlement cache internally), `smokeDb()` (`scripts/smoke.ts:4069-4079`), `raw`/`call`/`check`/`signIn`/`newSession` (existing smoke primitives), the wire-level `{feature_key, offer}` 402 shape (Task 5).

**Design:** matches the person-cap path Task 5 enriched (`assertMayOwnAnotherOrg`), since a bare `POST /api/orgs {name}` always hits that check first regardless of any attach choice (verified: `createOrgForUser` runs before any attach logic — `apps/web/src/app/api/orgs/route.ts:20`). Nine of the ten Pro Plus orgs are seeded directly in the DB, mirroring `setPlan`'s own established technique — the HTTP attach round trip is already proven end-to-end by the pre-existing billing-group block earlier in `main()`; this suite's job is the cap **boundary**, not attach mechanics, so nine extra HTTP round trips would only slow the run down for no new signal. The "purchase" step likewise writes `org_addons` directly (smoke has no live Stripe — same reasoning `setPlan`'s own doc comment gives), which is exactly the row the real webhook (Task 2) would write. No cache bust needed after that insert: `addonBonus`/`addonBonusForWallet` read `org_addons` UNCACHED on every call (verified in `lib/entitlements.ts`'s doc comments), unlike a raw `plan_key` write.

- [ ] **Step 1: Write the failing test**

Add a new function to `scripts/smoke.ts`, right before `async function main() {` is too early — place it as a new top-level function near the other `*Suite()` functions (e.g. immediately after `async function referralSuite(): Promise<void> { ... }`, today ending at line 2084):

```ts
/**
 * v17 gap #293: the extra-organisation recurring add-on. A Pro Plus payer at
 * their plan's org cap (10) hits a 402 with a purchase offer on a plain
 * "create org #11"; buying the add-on (simulated the same way the real
 * webhook writes it — smoke has no live Stripe, see setPlan's own doc
 * comment) raises the cap and the same create succeeds. Own fresh group;
 * keyless-safe, no Stripe calls.
 *
 * Nine of the ten orgs are seeded directly in the DB — the attach HTTP round
 * trip is already proven end-to-end by the billing-group block earlier in
 * main(); this suite's job is the cap BOUNDARY, not attach mechanics.
 */
async function extraOrgAddonSuite(): Promise<void> {
  const ownerEmail = `orgaddon_${tag}@example.com`;
  const owner = newSession();
  const auth = await signIn(owner, ownerEmail);
  await setPlan(auth.org_id, "pro_plus", owner); // busts entitlement cache itself

  const db = smokeDb();
  try {
    const [{ id: ownerUserId }] = await db<{ id: string }[]>`
      select id from users where email = ${ownerEmail}`;
    const [{ id: walletId }] = await db<{ id: string }[]>`
      select coalesce(subscription_id, id)::text as id from organizations where id = ${auth.org_id}`;

    // Fill the group to its Pro Plus cap of 10 — nine more orgs sharing the
    // same subscription_id, owned by the SAME payer (both assertMayOwnAnotherOrg's
    // person cap and attachOrgToGroup's group cap must read "at 10").
    for (let i = 0; i < 9; i++) {
      const [{ id: orgId }] = await db<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Org Addon Fill ${tag} ${i}`}, ${`org-addon-fill-${tag}-${i}`},
                ${ownerUserId}, ${walletId})
        returning id`;
      await db`insert into org_members (org_id, user_id, role)
                values (${orgId}, ${ownerUserId}, 'owner')`;
    }

    // #11 is refused — the group (and this payer) is at the Pro Plus cap of 10.
    const blocked = await raw(owner, "/api/orgs", "POST", { name: `Org 11 ${tag}` });
    check("extra-org: org #11 is refused at the Pro Plus cap of 10", blocked.status === 402);
    const body = blocked.json as unknown as { feature_key?: string; offer?: string };
    check(
      "extra-org: the 402 carries the purchase offer (v17 gap #293)",
      body.feature_key === "orgs.max_owned" && body.offer === "extra_org",
    );

    // Buy the add-on the same way the real webhook would write it — smoke has
    // no live Stripe (setPlan's own doc comment); the write IS the contract
    // the webhook (billing-events.syncOrgAddonsForSubscription) fulfils.
    await db`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 1, 'active')`;

    // #11 now succeeds — no cache bust needed: addonBonus reads org_addons
    // UNCACHED on every call (lib/entitlements.ts).
    const created = (await call(owner, "/api/orgs", "POST", {
      name: `Org 11 ${tag}`,
    })) as { id: string };
    check("extra-org: org #11 succeeds once the add-on is bought", !!created.id);
  } finally {
    await db.end();
  }
}
```

Wire the call into `main()`, right after the existing `await referralSuite();` (today `scripts/smoke.ts:737`, the last line before `main()`'s closing brace):

```ts
  await referralSuite();

  // --- v17 gap #293: extra-org recurring add-on — 402 with a purchase
  // offer at the Pro Plus cap, then the same create succeeds after buying.
  // Own fresh group; keyless-safe, no Stripe calls.
  await extraOrgAddonSuite();
}
```

Add `orgaddon_${tag}@example.com` to the `cleanup(tag)` email allowlist (today `scripts/smoke.ts:7264-7284`), alongside the other per-suite emails:

```ts
    `orgaddon_${tag}@example.com`,
```

- [ ] **Step 2: Run test to verify it fails**

Run smoke against a running dev server pointed at a disposable DB (per `project_local_e2e_recipe`/local dev conventions — `npm run dev` on the smoke `BASE`, `DATABASE_URL` set) BEFORE Task 5 lands (or with Task 5's `.extra` change reverted locally): `DATABASE_URL=<disposable> node --experimental-strip-types scripts/smoke.ts`
Expected: FAIL on `"extra-org: the 402 carries the purchase offer (v17 gap #293)"` — `body.offer` is `undefined` without Task 5.

(If run only after Task 5-9 are all already committed sequentially, this step is satisfied retroactively by having watched Task 5's own tests go red→green; re-run smoke once at the end of Task 9 regardless to prove the full chain.)

- [ ] **Step 3: Write minimal implementation**

None — this task's code IS the test; Tasks 1-6 already implement everything it exercises.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=<disposable> node --experimental-strip-types scripts/smoke.ts`
Expected: every `extra-org:` line prints `PASS`; overall `pass`/`fail` tallies show 0 new failures. Also re-run the FULL smoke suite once (not just this new block) to confirm nothing upstream (the billing-group section, the multi-org quota section) regressed from Task 4/5's resolver and error-shape changes.

- [ ] **Step 5: Commit**

```
git add scripts/smoke.ts
git commit -m "$(cat <<'EOF'
test(smoke): extra-org add-on — 402, offer, purchase, org #11 (#293)

Fills a Pro Plus group to its 10-org cap (9 seeded directly, mirror-
ing setPlan's own technique), proves the person-cap 402 carries the
purchase offer, writes the add-on row the way the real webhook
would, and proves org #11 then succeeds.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing checklist (before `/code-review` / PR)

- [ ] `npm run typecheck` clean from `apps/web`.
- [ ] `npm run i18n:gen-keys && npm run i18n:check` clean from repo root.
- [ ] Full unit suite green: `npx vitest run` from `apps/web` (with `DATABASE_URL` pointed at the local ephemeral test PG on :54329).
- [ ] `BILLING_LIVE=1` suite (Task 8) green against sk_test.
- [ ] Full `scripts/smoke.ts` green against a fresh disposable DB + prod build.
- [ ] e2e text grep for every changed/added string (`reasonFull`, `orgs.max_owned` reason copy, `settings.nav.addOns`) against `apps/web/e2e` — confirm no assertion scoped too broadly breaks.
- [ ] Screenshots: `/o/<slug>/settings/add-ons` (payer/non-payer/community, 375px + desktop, light theme); `orgs/new` "Full" pill with the new link (375px + desktop).
- [ ] Help: `billing.addons.extra-org` tip's `helpSlug` (`billing/add-ons`) is correctly UNREGISTERED in this wave (W7 registers it and writes the page — verify `apps/web/src/lib/help.ts`'s `HELP_ARTICLE_SLUGS` was NOT touched by this wave).
- [ ] `/code-review` on the branch.
- [ ] Merge via PR (smoke CI only runs on PRs, never on a direct push to main).
