# Pro Plus Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Pro Plus plan (`pro_plus`, $39/mo · $390/yr): migration V286, two new quota gates (officials/fixture, save points), api.write re-armed, checkout + live-sub plan change, 4-plan pricing page with a full localized feature matrix, and an `/admin/entitlements` reference page.

**Architecture:** Everything resolves from `plan_entitlements` (missing row = deny). One migration adds a COMPLETE `pro_plus` column, moves `scheduling.ai`/`officials.auto`/`api.write` off Pro, adds 4 new keys, deletes the dark `business` plan and the never-enforced `officials.assignment`. Code changes are three small gates + plan-threading through checkout/billing UI + two rendering surfaces (pricing, admin).

**Tech Stack:** Next.js (READ `node_modules/next/dist/docs/` before writing page code), postgres.js tagged templates, zod, vitest (`environment: "node"` — NO jsdom/@testing-library), Stripe embedded checkout.

**Spec:** `docs/superpowers/specs/2026-07-18-pro-plus-tier-design.md` (approved). Decisions D1–D10 there are binding.

## Global Constraints

- Migration file is exactly `db/migration/deltas/V286__pro_plus_plan.sql`; idempotent; nothing destructive beyond the approved `business` + `officials.assignment` deletions.
- Prices: monthly 3900 usd / 3700 eur / 3300 gbp / 299900 inr / 5900 aud; annual = exactly ×10. Lookup keys `seazn_pro_plus_monthly`, `seazn_pro_plus_annual`. Display name everywhere: **"Pro Plus"**.
- New entitlement keys, exact strings: `officials.per_fixture.max`, `schedule.checkpoints.max`, `domains.custom`, `support.priority`. Values: community 1 / 1 / false / false; pro ∞(null) / 5 / false / false; pro_plus ∞ / ∞ / true / true. NO `event_pass` rows for them.
- `dashboard.branding` values must NOT change on any plan (PLG badge trigger, spec D7).
- Do NOT advertise `domains.custom` on pricing page or cards (ships in Spec 2). `support.priority` IS advertised.
- Every new/changed dictionary key lands in ALL FOUR locales (en/fr/es/nl) — a parity test enforces this.
- Every code change ships a test that fails without it.
- apps/web vitest is node-env: component test = call the function, assert `.props`; stateful = `renderToStaticMarkup`; mocks via `const {x}=vi.hoisted(()=>({x:vi.fn()}))` + `vi.mock`. DB-backed suites use `describe.skipIf(!process.env.DATABASE_URL)`.
- Run from the worktree root `/Users/ashokhein/github/seazn.club/.claude/worktrees/pro-plus-tier`. Commands: `npm run test --workspace apps/web -- <file>` and `npm run typecheck --workspace apps/web`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Migration V286 + matrix-completeness test

**Files:**
- Create: `db/migration/deltas/V286__pro_plus_plan.sql`
- Create: `apps/web/src/server/__tests__/pro-plus-matrix.test.ts`

**Interfaces:**
- Produces: DB plans `pro_plus` (public) with the full entitlement column; `business` and `officials.assignment` gone. Later tasks assume these rows exist locally (run `npm run db:apply` once).

- [ ] **Step 1: Write the migration** — exactly:

```sql
-- ============================================================
-- V286 — Pro Plus plan (spec 2026-07-18-pro-plus-tier §1, D1–D6).
-- New self-serve tier above Pro. Retires the dark v2 'business' plan.
-- Adds quota keys for officials-per-fixture and schedule save points.
-- scheduling.ai + officials.auto + api.write move up to Pro Plus
-- (approved hard move, no grandfather — pre-launch). Idempotent.
-- ============================================================

insert into plans (key, name, is_public) values ('pro_plus', 'Pro Plus', true)
on conflict (key) do nothing;

-- Full pro_plus column: a missing row DENIES (lib/entitlements.ts resolver),
-- so EVERY feature key gets a row. Boolean grants first:
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select 'pro_plus', f, true, null from unnest(array[
  'api.access','api.write','branding','clubs.hierarchy','cricket.dls',
  'dashboard.branding','dashboard.player_profiles','discovery.branding',
  'discovery.featured','discovery.listed','domains.custom',
  'eligibility.enforced','embeds.enabled','exports','exports.branded',
  'formats.advanced','formats.double_elim','import.bulk','logos.bulk',
  'officials.auto','officials.roles_multi','public_pages','realtime',
  'registration.enabled','registration.paid','schedule.versioning',
  'scheduling.ai','scheduling.board','scheduling.constraints',
  'scheduling.multi_division','scoring.ball_by_ball','scoring.device_links',
  'scoring.match_timeline','scoring.rally_by_rally','sponsors.monetize',
  'sponsors.tiers','standings.carry_over','standings.custom_points',
  'stats.club_championship','stats.player','support.priority',
  'tiebreakers.custom'
]) as f
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Unlimited scale (int_value null = unlimited) + the 1% platform fee:
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('pro_plus', 'competitions.max_active',       null, null),
  ('pro_plus', 'dashboard.public.max',          null, null),
  ('pro_plus', 'divisions.per_competition.max', null, null),
  ('pro_plus', 'entrants.per_division.max',     null, null),
  ('pro_plus', 'members.max',                   null, null),
  ('pro_plus', 'officials.per_fixture.max',     null, null),
  ('pro_plus', 'orgs.max_owned',                null, null),
  ('pro_plus', 'registration.fee_percent',      null, 1),
  ('pro_plus', 'schedule.checkpoints.max',      null, null),
  ('pro_plus', 'scorers.max',                   null, null),
  ('pro_plus', 'stages.per_division.max',       null, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Approved hard moves: these leave Pro (D4 + D3 api.write).
update plan_entitlements set bool_value = false, int_value = null
where plan_key = 'pro'
  and feature_key in ('scheduling.ai', 'officials.auto', 'api.write');

-- New quota/flag keys for the existing plans. No event_pass rows — a key
-- missing from the pass matrix falls through to community by design (v3/07 §3).
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'officials.per_fixture.max', null,  1),
  ('pro',       'officials.per_fixture.max', null,  null),
  ('community', 'schedule.checkpoints.max',  null,  1),
  ('pro',       'schedule.checkpoints.max',  null,  5),
  ('community', 'domains.custom',            false, null),
  ('pro',       'domains.custom',            false, null),
  ('community', 'support.priority',          false, null),
  ('pro',       'support.priority',          false, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- The never-enforced officials.assignment key dies (D5) — replaced by the
-- officials.per_fixture.max quota + the existing roles_multi/auto gates.
delete from plan_entitlements where feature_key = 'officials.assignment';

-- Retire the dark v2 'business' plan (D1). Guarded: never delete a plan a
-- subscription still references (there are none — it was never sellable).
delete from plan_entitlements where plan_key = 'business'
  and not exists (select 1 from subscriptions s where s.plan_key = 'business');
delete from plans where key = 'business'
  and not exists (select 1 from subscriptions s where s.plan_key = 'business');
```

- [ ] **Step 2: Apply locally**

Run: `npm run db:apply`
Expected: `Successfully applied 1 migration` (V286). If the local DB is ahead/behind, STOP and report — do not baseline or repair.

- [ ] **Step 3: Write the failing-first completeness test** — `apps/web/src/server/__tests__/pro-plus-matrix.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sql } from "@/lib/db";

// V286 (spec §1): the pro_plus column must be COMPLETE — a key present for
// any plan but missing for pro_plus would silently DENY on Pro Plus.
describe.skipIf(!process.env.DATABASE_URL)("V286 pro_plus matrix", () => {
  it("has a pro_plus row for every feature key any plan defines", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string }[]>`
      select distinct feature_key, plan_key from plan_entitlements`;
    const all = new Set(rows.map((r) => r.feature_key));
    const plus = new Set(rows.filter((r) => r.plan_key === "pro_plus").map((r) => r.feature_key));
    // event_pass is deliberately sparse; pro_plus must not be.
    const missing = [...all].filter((k) => !plus.has(k));
    expect(missing).toEqual([]);
  });

  it("moved scheduling.ai / officials.auto / api.write off Pro", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key in ('scheduling.ai','officials.auto','api.write')
        and plan_key in ('pro','pro_plus')`;
    for (const k of ["scheduling.ai", "officials.auto", "api.write"]) {
      expect(rows.find((r) => r.plan_key === "pro" && r.feature_key === k)?.bool_value).toBe(false);
      expect(rows.find((r) => r.plan_key === "pro_plus" && r.feature_key === k)?.bool_value).toBe(true);
    }
  });

  it("seeds the new quota keys with the approved ladder", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string; int_value: number | null; bool_value: boolean | null }[]>`
      select feature_key, plan_key, int_value, bool_value from plan_entitlements
      where feature_key in ('officials.per_fixture.max','schedule.checkpoints.max','domains.custom','support.priority','registration.fee_percent')`;
    const get = (k: string, p: string) => rows.find((r) => r.feature_key === k && r.plan_key === p);
    expect(get("officials.per_fixture.max", "community")?.int_value).toBe(1);
    expect(get("officials.per_fixture.max", "pro")?.int_value).toBeNull();
    expect(get("schedule.checkpoints.max", "community")?.int_value).toBe(1);
    expect(get("schedule.checkpoints.max", "pro")?.int_value).toBe(5);
    expect(get("schedule.checkpoints.max", "pro_plus")?.int_value).toBeNull();
    expect(get("domains.custom", "pro")?.bool_value).toBe(false);
    expect(get("domains.custom", "pro_plus")?.bool_value).toBe(true);
    expect(get("support.priority", "pro_plus")?.bool_value).toBe(true);
    expect(get("registration.fee_percent", "pro_plus")?.int_value).toBe(1);
    expect(rows.some((r) => r.feature_key === "officials.per_fixture.max" && r.plan_key === "event_pass")).toBe(false);
  });

  it("retired business and officials.assignment", async () => {
    const [biz] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements where plan_key = 'business'`;
    const [plan] = await sql<{ n: number }[]>`select count(*)::int as n from plans where key = 'business'`;
    const [oa] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements where feature_key = 'officials.assignment'`;
    expect(biz!.n).toBe(0);
    expect(plan!.n).toBe(0);
    expect(oa!.n).toBe(0);
  });

  it("did not touch dashboard.branding (PLG badge trigger, D7)", async () => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements where feature_key = 'dashboard.branding'`;
    expect(rows.find((r) => r.plan_key === "community")?.bool_value).toBe(false);
    expect(rows.find((r) => r.plan_key === "pro")?.bool_value).toBe(true);
    expect(rows.find((r) => r.plan_key === "pro_plus")?.bool_value).toBe(true);
  });
});
```

- [ ] **Step 4: Run with DATABASE_URL**

Run: `DATABASE_URL=<local url from main checkout .env.local> npm run test --workspace apps/web -- pro-plus-matrix`
Expected: 5/5 pass. Also run once WITHOUT DATABASE_URL → suite skips.

- [ ] **Step 5: Commit** — `feat(billing): V286 pro_plus plan matrix + completeness test`

---

### Task 2: feature-copy, PlanBadge, tips copy

**Files:**
- Modify: `apps/web/src/lib/feature-copy.ts`
- Modify: `apps/web/src/components/plan-badge.tsx`
- Modify: `apps/web/src/config/tips.ts` (lines ~95-96)
- Test: `apps/web/src/lib/__tests__/feature-copy.test.ts` (create or extend existing)

**Interfaces:**
- Produces: `PaidPlan = "pro" | "pro_plus"`; `featurePlan(key)` returns `"pro_plus"` for the six Plus keys; `featureReason` entries for the four new keys. Consumed by UpgradeGate/PlanBadge (no changes needed there beyond badge labels) and by later tasks' copy assertions.

- [ ] **Step 1: Failing test first** — assert the new mapping:

```ts
import { describe, it, expect } from "vitest";
import { featurePlan, featureReason } from "@/lib/feature-copy";

describe("feature-copy V286", () => {
  it("maps Plus features to pro_plus", () => {
    for (const k of ["api.write", "scorers.max", "scheduling.ai", "officials.auto", "domains.custom", "support.priority"]) {
      expect(featurePlan(k)).toBe("pro_plus");
    }
    expect(featurePlan("scheduling.board")).toBe("pro");
    expect(featurePlan("officials.roles_multi")).toBe("pro");
  });
  it("has reasons for the new keys and none for the dead one", () => {
    expect(featureReason("officials.per_fixture.max")).toMatch(/one official per fixture/i);
    expect(featureReason("schedule.checkpoints.max")).toMatch(/save.point/i);
    expect(featureReason("domains.custom")).toMatch(/domain/i);
    expect(featureReason("support.priority")).toMatch(/priority/i);
    // officials.assignment was deleted (D5) — falls back to the generic line.
    expect(featureReason("officials.assignment")).toBe("This feature needs a plan upgrade.");
  });
});
```

Run: expect FAIL (featurePlan returns "business"; reasons missing).

- [ ] **Step 2: Edit `feature-copy.ts`**
  - Replace the `BUSINESS_FEATURES` block and `PaidPlan`:

```ts
// Cheapest plan that unlocks each feature (mirrors plan_entitlements,
// V112 + V240 + V286). Everything not listed unlocks on Pro — only the
// above-Pro (Pro Plus) exceptions need rows.
const PLUS_FEATURES = new Set([
  "api.write",
  "scorers.max",
  "scheduling.ai",
  "officials.auto",
  "domains.custom",
  "support.priority",
]);

export type PaidPlan = "pro" | "pro_plus";

/** Cheapest plan that unlocks a feature key. Never throws. */
export function featurePlan(featureKey: string): PaidPlan {
  return PLUS_FEATURES.has(featureKey) ? "pro_plus" : "pro";
}
```

  - In `FEATURE_REASONS`: DELETE the `"officials.assignment"` entry; reword three; add four:

```ts
  "api.write": "Write access via the API is a Pro Plus feature — read keys work on Pro.",
  "scheduling.ai": "AI-assisted planning (describe constraints in plain language) is a Pro Plus feature.",
  "officials.auto": "Auto-assigning officials (solver, phased sourcing) is a Pro Plus feature — manual assignment still works.",
  "officials.per_fixture.max": "Community includes one official per fixture — more need Pro.",
  "schedule.checkpoints.max": "You've reached your plan's save points — Pro includes five, Pro Plus unlimited. Undo/redo always works.",
  "domains.custom": "Serving your public pages on your own domain is a Pro Plus feature.",
  "support.priority": "Priority support is included with Pro Plus.",
```

  - Also reword `"schedule.versioning"` to `"Multi-site scope locks are a Pro feature — undo/redo always works."` (save points moved to their own key).

- [ ] **Step 3: PlanBadge** — replace the `business` entries (and the stale scrub comment) with:

```ts
const STYLE: Record<PaidPlan, string> = {
  pro: "bg-purple-100 text-purple-700",
  pro_plus: "bg-indigo-100 text-indigo-700",
};

const LABEL: Record<PaidPlan, string> = {
  pro: "Pro ✦",
  pro_plus: "Pro Plus ◆",
};
```

- [ ] **Step 4: tips.ts** — update the save-points tip body (id near line 95) to: `"A save point bookmarks the timetable exactly as it is now — every kick-off time and court. Restore rewinds the schedule to that bookmark by undoing each change since, one by one. Match results are never touched: if rewinding would erase a played result, the restore stops there. One save point is free, Pro includes five, Pro Plus is unlimited."`

- [ ] **Step 5: Run test + typecheck; grep for stragglers**

Run: `grep -rn "BUSINESS_FEATURES\|\"business\"" apps/web/src --include="*.ts*" | grep -v __tests__` — fix every compile-relevant reference (expect: `plan-badge.tsx` handled; check `admin-plan` usecase and anywhere `PaidPlan`/plan lists are typed). `npm run typecheck --workspace apps/web` clean.

- [ ] **Step 6: Commit** — `feat(billing): Pro Plus copy, featurePlan mapping, badge`

---

### Task 3: officials.per_fixture.max gate

**Files:**
- Modify: `apps/web/src/server/usecases/officials.ts` (patchFixtureOfficials, ~line 455)
- Test: extend the existing officials DB-backed test file (find via `grep -rln "patchFixtureOfficials" apps/web/src/server/__tests__`)

- [ ] **Step 1: Failing test** — in the existing officials test suite (DB-backed, skipIf pattern): community org + fixture; `patchFixtureOfficials` with a `set` naming TWO distinct officials (single role each is fine — use the same role_key to stay off the roles_multi gate... note: same role for two officials is one role → roles_multi does not fire) → expect `PaymentRequiredError` with `featureKey === "officials.per_fixture.max"`. Then flip the org to `pro` (SQL: upsert subscriptions plan_key) → same call succeeds. One official on community still succeeds.

- [ ] **Step 2: Implement** — in `patchFixtureOfficials`, directly after the `roleCount` / `officials.roles_multi` check:

```ts
  // V286 (D5): Community includes ONE official per fixture; the quota is the
  // requested set (replace semantics), so over-limit sets 402 up front.
  // Existing over-limit assignments are never deleted — freeze principle.
  const officialCount = new Set(input.set.map((s) => s.official_id)).size;
  const officialQuota = await withinLimit(auth.orgId, "officials.per_fixture.max", officialCount);
  if (!officialQuota.ok) throw new PaymentRequiredError("officials.per_fixture.max");
```

Import `withinLimit` from `@/lib/entitlements` and `PaymentRequiredError` if not already imported. Update the function's doc comment: manual single-role stays free **for one official per fixture**; more officials or roles need Pro.

- [ ] **Step 3:** Run the officials suite with DATABASE_URL; all green. **Step 4: Commit** — `feat(officials): community capped at one official per fixture (officials.per_fixture.max)`

---

### Task 4: schedule.checkpoints.max quota

**Files:**
- Modify: `apps/web/src/server/usecases/history.ts` (`createCheckpoint`)
- Modify: `apps/web/src/server/api-v1/openapi.ts` line ~202 (summary text)
- Test: extend the existing checkpoints/history DB-backed tests (`grep -rln "createCheckpoint" apps/web/src/server/__tests__`)

- [ ] **Step 1: Failing test** — community org: 1st checkpoint ok, 2nd throws `PaymentRequiredError` with key `schedule.checkpoints.max` (today it throws `schedule.versioning` — assert the NEW key so the test fails first). Pro org: checkpoints 2–5 ok, 6th throws. pro_plus org (SQL flip): 6+ ok.

- [ ] **Step 2: Implement** — in `createCheckpoint`, replace:

```ts
    // Jul3/03 §7: one restore point free; more history depth is Pro.
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from division_checkpoints where division_id = ${divisionId}`;
    if (n >= 1 && !(await hasFeature(auth.orgId, "schedule.versioning"))) {
      throw new PaymentRequiredError("schedule.versioning");
    }
```

with:

```ts
    // Jul3/03 §7 → V286: save points are a per-plan quota (community 1,
    // pro 5, pro_plus unlimited). schedule.versioning still gates scope locks.
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from division_checkpoints where division_id = ${divisionId}`;
    const quota = await withinLimit(auth.orgId, "schedule.checkpoints.max", n + 1);
    if (!quota.ok) throw new PaymentRequiredError("schedule.checkpoints.max");
``` Import `withinLimit`; keep `hasFeature` only if still used elsewhere in the file (it is — line ~487 scope locks).

- [ ] **Step 3: openapi summary** — change `"Create a save point at the current watermark (>1 is Pro \`schedule.versioning\`)"` → `"Create a save point at the current watermark (quota \`schedule.checkpoints.max\`: 1 free / 5 Pro / unlimited Pro Plus)"`. If an openapi snapshot test exists, update it.

- [ ] **Step 4:** Suite green with DATABASE_URL. **Step 5: Commit** — `feat(schedule): save points quota-fied via schedule.checkpoints.max (1/5/unlimited)`

---

### Task 5: api.write re-armed

**Files:**
- Modify: `apps/web/src/server/usecases/api-keys.ts` (`createApiKey`)
- Test: extend existing api-keys tests
- Check: `scripts/smoke.ts` — any suite that creates score/manage-scope API keys under a `pro` org must flip that org to `pro_plus` first (SQL) or expect 402. Search `grep -n "scopes" scripts/smoke.ts`.

- [ ] **Step 1: Failing test** — pro org: `createApiKey` with `scopes: ["manage"]` → `PaymentRequiredError("api.write")`; with `["read"]` → ok. pro_plus org: `["manage"]` ok.

- [ ] **Step 2: Implement** — after the `scopes` normalization line:

```ts
  // V286 re-arms the above-Pro rung: score/manage scopes need api.write
  // (Pro Plus). Read-only keys stay at api.access (Pro).
  if (scopes.some((s) => s !== "read")) await requireFeature(auth.orgId, "api.write");
```

Rewrite the stale "died with the v3 Business scrub" comment accordingly.

- [ ] **Step 3:** Fix any smoke fallout found in the check above (prefer flipping the smoke org to pro_plus for that suite section, restoring after). **Step 4: Commit** — `feat(api): write scopes require api.write (Pro Plus)`

---

### Task 6: prices + checkout thread-through

**Files:**
- Modify: `apps/web/src/config/stripe-plans.json`
- Modify: `apps/web/src/lib/currency.ts`
- Modify: `apps/web/src/lib/types.ts` (`checkoutSchema`)
- Modify: `apps/web/src/lib/billing-checkout-client.ts`
- Modify: `apps/web/src/components/billing-actions.tsx` (`UpgradeButton`)
- Tests: extend `currency` + `billing-checkout-client` + billing-actions tests (find existing files first)

- [ ] **Step 1: stripe-plans.json** — append to `plans` array:

```json
{
  "key": "pro_plus",
  "product": {
    "name": "Seazn Club Pro Plus",
    "description": "Everything in Pro, plus unlimited seats and scale, a 1% platform fee on entry fees, AI-assisted scheduling, auto officials assignment, write API access and priority support."
  },
  "prices": {
    "monthly": {
      "lookup_key": "seazn_pro_plus_monthly",
      "unit_amount": 3900,
      "interval": "month",
      "currency_options": { "eur": 3700, "gbp": 3300, "inr": 299900, "aud": 5900 }
    },
    "annual": {
      "lookup_key": "seazn_pro_plus_annual",
      "unit_amount": 39000,
      "interval": "year",
      "currency_options": { "eur": 37000, "gbp": 33000, "inr": 2999000, "aud": 59000 }
    }
  }
}
```

- [ ] **Step 2: currency.ts** — beside `proPrice`:

```ts
/** Pro Plus price in minor units for a currency, from stripe-plans.json. */
export function proPlusPrice(interval: "monthly" | "annual", currency: Currency): number {
  const plus = stripePlans.plans.find((p) => p.key === "pro_plus");
  if (!plus) throw new Error("stripe-plans.json is missing the pro_plus plan");
  return amountFor(plus.prices[interval], currency);
}
```

- [ ] **Step 3: checkoutSchema** — `plan_key: z.enum(["pro", "pro_plus"])`. The `/api/billing/checkout` route already resolves any plan's price from the `plans` table — no route change.

- [ ] **Step 4: client + button** — `fetchCheckoutClientSecret(plan: "pro" | "pro_plus", interval, fetchFn?)` posts `{ plan_key: plan, interval }`; update its JSDoc. `UpgradeButton` gains a `plan?: "pro" | "pro_plus"` prop (default `"pro"`), passes it through, and tracks `{ plan_key: plan, interval }`. Update ALL existing call sites (billing page passes nothing → default keeps behavior).

- [ ] **Step 5: Tests** — failing-first where practical: `proPlusPrice("monthly","gbp") === 3300`; annual = 10× monthly for every currency incl. usd; checkout client posts `plan_key:"pro_plus"` when told to (mock fetch, assert body); schema accepts `pro_plus`, rejects `business`.

- [ ] **Step 6:** typecheck + suites green. **Step 7: Commit** — `feat(billing): Pro Plus prices + checkout plan thread-through`

---

### Task 7: live-subscription plan change (Pro ↔ Pro Plus)

**Files:**
- Modify: `apps/web/src/server/usecases/billing-manage.ts`
- Create: `apps/web/src/app/api/billing/plan/preview/route.ts`
- Create: `apps/web/src/app/api/billing/plan/route.ts`
- Modify: `apps/web/src/components/billing-manage.tsx`
- Tests: extend billing-manage tests (pure param builders) — find `grep -rln "buildIntervalPreviewParams" apps/web/src`

**Interfaces:**
- Consumes: `proPlusPrice` (Task 6).
- Produces: `previewPlanChange(orgId, planKey, interval)` / `applyPlanChange(orgId, planKey, interval, prorationDate)` mirroring the interval-change pair.

- [ ] **Step 1: Read `billing-manage.ts` fully.** Generalize `resolveIntervalChange(orgId, target)` into `resolvePriceChange(orgId, planKey, interval)`: identical logic, but the target price id comes from `plans` where `key = planKey` (column by interval) instead of the subscription's current plan; refuse `planKey === currentPlan && interval === currentInterval` with `HttpError(400, "Already on this plan")`. Keep `resolveIntervalChange` as a thin wrapper (`resolvePriceChange(orgId, currentPlanKey, target)`) so the existing interval endpoints are untouched.
- [ ] **Step 2:** `previewPlanChange` / `applyPlanChange` = copies of the interval pair calling `resolvePriceChange`; `renewalAmountMinor` uses `planKey === "pro" ? proPrice(...) : proPlusPrice(...)`. `applyPlanChange` must `invalidateOrgEntitlements(orgId)` after `syncSubscription` (check: applyIntervalChange already syncs — mirror exactly, add invalidation if the interval path lacks it because plan_key now CHANGES).
- [ ] **Step 3: Routes** — mirror `api/billing/interval/*` exactly, zod body `{ plan_key: z.enum(["pro","pro_plus"]), interval: z.enum(["monthly","annual"]), proration_date: ... }` (preview: no proration_date, query params `plan_key` + `interval`).
- [ ] **Step 4: UI** — in `billing-manage.tsx`, beside the interval-switch block, add a "Change plan" block: when current plan is `pro` show "Upgrade to Pro Plus", when `pro_plus` show "Switch to Pro"; button → preview (shows due-today/credit/renewal from the same preview shape) → confirm applies with pinned `proration_date`. Reuse the interval block's components/styles verbatim — it is the reference pattern. Dictionary keys: `billing.planChange.toPlus`, `billing.planChange.toPro`, `billing.planChange.confirm` (en/fr/es/nl).
- [ ] **Step 5: Tests** — pure: `resolvePriceChange` refusal case + price-id selection given a fake plans row (mock `sql` via the file's existing test seam if present; otherwise test the exported pure param builders with a pro_plus price id). Failing-first for the refusal case.
- [ ] **Step 6:** typecheck + tests green. **Step 7: Commit** — `feat(billing): in-app plan change Pro ↔ Pro Plus with proration preview`

---

### Task 8: billing page — Plus chooser + priority-support row

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/settings/billing/page.tsx`
- Modify: dictionaries `en/fr/es/nl` `ui.json` (billing.* keys)

- [ ] **Step 1:** Derived flags: `const isPaid = planKey === "pro" || planKey === "pro_plus"; const isPlus = planKey === "pro_plus";` — replace `isPro`-as-paid usages accordingly (the upgrade section shows when `!isPaid`; keep `isPro` where it genuinely means "exactly pro").
- [ ] **Step 2:** In the upgrade section (`!isPaid && isOwner`): change the 2-col compare grid to 3 columns (`xs:grid-cols-3`? NO — reuse the existing responsive idiom: keep `xs:grid-cols-2` and add Pro Plus as a third card that wraps; match existing card markup). Pro Plus card: indigo accent (`border-indigo-500 bg-indigo-50`), price `formatMinor(proPlusPrice("monthly", currency), currency)`, bullets from new dict keys `billing.plus.f1`–`f5` (en: "Unlimited members, scorers & clubs" / "1% platform fee on entry fees" / "AI-assisted scheduling" / "Auto officials assignment" / "Write API access & priority support"). CTA pair: `UpgradeButton plan="pro_plus" interval="annual"` (label from `billing.cta.goPlus` — en "Go Pro Plus") + monthly ghost.
- [ ] **Step 3:** When `isPro && isOwner`: render a compact "Upgrade to Pro Plus" card pointing at the Task 7 plan-change flow (the manage component now owns it) — one line + the plan-change block anchor. When `isPlus`: render a "Priority support" row: `support.priority` copy + `plus@seazn.club` mailto (dict key `billing.plusSupport`, en: "Priority support — email plus@seazn.club and jump the queue.").
- [ ] **Step 4:** All new dict keys ×4 locales; run the dictionary parity test (`npm run test --workspace apps/web -- i18n` or the existing parity test file).
- [ ] **Step 5:** typecheck + parity green. **Step 6: Commit** — `feat(billing): Pro Plus on the org billing page`

---

### Task 9: pricing page — 4 offers + full grouped localized matrix

**Files:**
- Create: `apps/web/src/lib/entitlement-domains.ts`
- Rewrite: `apps/web/src/lib/pricing-matrix.ts`
- Modify: `apps/web/src/app/[lang]/(marketing)/pricing/page.tsx`
- Modify: `apps/web/src/lib/pricing-cards.ts`
- Modify: `apps/web/src/components/pro-price-card.tsx` (reference only — add a Plus variant prop ONLY if trivial; otherwise a sibling card in the page)
- Modify: dictionaries `en/fr/es/nl` `marketing.json`
- Tests: rewrite `pricing-matrix` tests; extend any pricing page test

**Interfaces:**
- Produces: `ENTITLEMENT_DOMAINS: { slug: string; features: string[] }[]` (consumed by Task 10); `buildPricingSections(data): PricingSection[]` where `PricingSection = { labelKey: string; rows: PricingRow[] }`, `PricingRow = { labelKey: string; free: string; pass: string; pro: string; plus: string }`.

- [ ] **Step 1: `entitlement-domains.ts`** — shared domain grouping (pricing + admin render the same order):

```ts
// Domain grouping for entitlement keys — shared by /pricing and
// /admin/entitlements so the two surfaces tell the same story (V286).
// Keys NOT listed here are deliberately unadvertised (vestigial D9 keys +
// domains.custom until Spec 2 ships) — /admin still shows them under "other".
export const ENTITLEMENT_DOMAINS: { slug: string; features: string[] }[] = [
  { slug: "scale", features: [
    "competitions.max_active", "orgs.max_owned", "divisions.per_competition.max",
    "entrants.per_division.max", "members.max", "scorers.max",
    "stages.per_division.max", "dashboard.public.max", "import.bulk",
  ]},
  { slug: "money", features: [
    "registration.enabled", "registration.paid", "sponsors.tiers", "sponsors.monetize",
  ]},
  { slug: "formats", features: [
    "formats.advanced", "formats.double_elim", "standings.custom_points",
    "standings.carry_over", "tiebreakers.custom",
  ]},
  { slug: "scheduling", features: [
    "scheduling.board", "scheduling.constraints", "scheduling.multi_division",
    "scheduling.ai", "schedule.checkpoints.max", "schedule.versioning",
  ]},
  { slug: "scoring", features: [
    "scoring.ball_by_ball", "scoring.rally_by_rally", "scoring.match_timeline",
    "scoring.device_links", "cricket.dls", "stats.player",
  ]},
  { slug: "officials", features: [
    "officials.per_fixture.max", "officials.roles_multi", "officials.auto",
  ]},
  { slug: "brand", features: [
    "branding", "dashboard.branding", "realtime", "embeds.enabled",
    "discovery.listed", "discovery.featured", "discovery.branding",
    "exports", "exports.branded",
  ]},
  { slug: "platform", features: [
    "clubs.hierarchy", "logos.bulk", "api.access", "api.write", "support.priority",
  ]},
];
```

- [ ] **Step 2: rewrite `pricing-matrix.ts`.** Keep `MatrixCell`/`MatrixData`/`passCell` fall-through semantics EXACTLY. New shape: for each domain in `ENTITLEMENT_DOMAINS`, emit a `PricingSection` with `labelKey: "pricing.matrix.section." + slug` and one row per feature with `labelKey: "pricing.matrix." + feature` (dots in the feature key kept verbatim — dict keys may contain dots). Cell formatting:
  - int features → number, or `"∞"` when `int_value === null` (locale-free — replaces "Unlimited"), `"—"` when no cell.
  - `import.bulk` → community shows `"20"` (its int cap), plans with `int null` show `"∞"`.
  - bool features → `"✓"` / `"—"`.
  - `competitions.max_active` keeps the prose row (free count / "pricing.matrix.passedEvent" prose for pass / `"∞"`).
  - Fee row stays folded (`registration.paid` + `registration.fee_percent`) with a `plus` cell; label key `pricing.matrix.fees`; format `"✓ N%"` as today.
  - `plus` column formats from `data[feature]?.pro_plus`.
  Export `buildPricingSections(data)`; DELETE `buildPricingRows` and update all imports.
- [ ] **Step 3a: PlusReveal client island** — create `apps/web/src/components/marketing/plus-reveal.tsx` (user decision 2026-07-18: Pro Plus is progressively disclosed on /pricing):

```tsx
"use client";

import { useState, type ReactNode } from "react";
import { track } from "@/lib/analytics";
import { EVENTS } from "@/lib/analytics-events";

/**
 * Progressive disclosure for the Pro Plus offer (spec §4): the hero grid
 * stays 3-up; this teaser sits below it and swaps itself for the
 * server-rendered Pro Plus card (passed as children) on click. State starts
 * hidden on server AND client — no hydration mismatch.
 */
export function PlusReveal({
  teaser,
  cta,
  children,
}: {
  teaser: string;
  cta: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (open) return <div data-plus-revealed>{children}</div>;
  return (
    <div className="card mx-auto flex max-w-2xl flex-col items-center gap-3 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
      <p className="text-sm text-slate-600">{teaser}</p>
      <button
        type="button"
        data-plus-reveal-cta
        className="btn btn-ghost shrink-0 border-indigo-300 text-indigo-700 hover:bg-indigo-50"
        onClick={() => {
          track(EVENTS.PRICING_PLUS_REVEALED, {});
          setOpen(true);
        }}
      >
        {cta}
      </button>
    </div>
  );
}
```

Add the canonical event to `apps/web/src/lib/analytics-events.ts` beside its siblings: `PRICING_PLUS_REVEALED: "pricing_plus_revealed",` (comment: `/** Pricing page: visitor opened the hidden Pro Plus offer. */`).

- [ ] **Step 3b: pricing page.** `loadMatrix` where-clause adds `'pro_plus'`. Cards grid STAYS `md:grid-cols-3`. Below the grid: `<PlusReveal teaser={t(d,"pricing.plus.teaser")} cta={t(d,"pricing.plus.reveal")}>` wrapping the Pro Plus card (indigo accent, `formatMinor(proPlusPrice(...))`, "Everything in Pro, plus…" framing via dict `pricing.plus.*`: name/note/per/cta + bullets `pricing.plus.f1`–`f5` matching Task 8's list; card CTA → `/login?tab=signup`; render the revealed card centered `max-w-md mx-auto`). en teaser: "Need more scale? Unlimited seats, a 1% platform fee, AI-assisted scheduling and auto officials." en reveal button: "Show Pro Plus". Table: ALWAYS 5 columns regardless of reveal (add `pricing.table.proPlus` header); render sections — for each, a full-width `<tr>` subheader (`<td colSpan={5}>` — styled like a group label) then its rows; keep `data-pricing-matrix`. FAQ: add `"proPlus"` to `FAQ_KEYS` + dict Q/A (en: Q "What's in Pro Plus?" A: "Everything in Pro, plus unlimited seats and scale, a 1% platform fee, AI-assisted scheduling, auto officials assignment, write API access and priority support. Pro stays $20/mo; Pro Plus is $39/mo or $390/yr.").
- [ ] **Step 4: pricing-cards.ts** — add `PLUS_CARD_FEATURES` (5 en bullets, same content as Task 8) exported for the pricing page; `ticketTiers` (home page) STAYS 3 tiers — add a code comment that home shows 3 stubs and /pricing carries the full ladder.
- [ ] **Step 5: dictionaries** — en first, then fr/es/nl translations for: `pricing.table.proPlus`, `pricing.plus.name/note/cta/per`, `pricing.plus.teaser`, `pricing.plus.reveal`, `pricing.plus.f1..f5`, `pricing.faq.proPlus.q/a`, `pricing.matrix.section.{scale,money,formats,scheduling,scoring,officials,brand,platform}`, `pricing.matrix.<each feature key listed in Step 1>` (~42), `pricing.matrix.fees`, `pricing.matrix.passedEvent`. English row labels reuse today's wording where a row existed (e.g. `divisions.per_competition.max` → "Divisions per competition"); new ones follow feature-copy's vocabulary (e.g. `schedule.checkpoints.max` → "Schedule save points", `officials.per_fixture.max` → "Officials per fixture", `api.write` → "Write API access", `support.priority` → "Priority support").
- [ ] **Step 6: tests** — failing-first: `PlusReveal` SSR test (`renderToStaticMarkup`, mock `@/lib/analytics` via vi.hoisted): initial HTML contains the teaser + CTA and does NOT contain the children/`data-plus-revealed` — proving Pro Plus starts hidden; `buildPricingSections` returns 8 sections in domain order; every row has non-empty `free/pass/pro/plus`; `schedule.checkpoints.max` row = `1 / — / 5 / ∞` (pass falls through to community "1"); fee row plus cell = `"✓ 1%"`; `officials.per_fixture.max` = `1 / — / ∞ / ∞`; no section contains `domains.custom` or any D9 vestigial key. Update/replace the old `buildPricingRows` tests. Run the full i18n parity test.
- [ ] **Step 7:** typecheck + suites green. **Step 8: Commit** — `feat(pricing): 4-plan cards + full localized entitlement matrix`

---

### Task 10: /admin/entitlements reference page

**Files:**
- Create: `apps/web/src/app/admin/entitlements/page.tsx`
- Modify: `apps/web/src/app/admin/layout.tsx` (nav link after "Coupons": `<Link href="/admin/entitlements" className="hover:text-white">Entitlements</Link>`)
- Create: `apps/web/src/lib/entitlement-admin.ts` (pure grouping helper + test)

- [ ] **Step 1: pure helper + failing test** — `entitlement-admin.ts`:

```ts
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";

export interface AdminEntRow {
  feature_key: string;
  plan_key: string;
  bool_value: boolean | null;
  int_value: number | null;
}

export interface AdminEntFeature {
  feature_key: string;
  type: "bool" | "int";
  cells: Record<string, string>; // plan_key -> rendered value
}

export interface AdminEntSection { slug: string; features: AdminEntFeature[] }

const PLANS = ["community", "event_pass", "pro", "pro_plus"] as const;

function render(cell: AdminEntRow | undefined): string {
  if (!cell) return "—";
  if (cell.bool_value !== null) {
    // Dual-value keys (import.bulk: true + cap 20) show both.
    if (cell.bool_value && cell.int_value !== null) return `true (${cell.int_value})`;
    return cell.bool_value ? "true" : "false";
  }
  return cell.int_value === null ? "∞" : String(cell.int_value);
}

/** Pivot plan_entitlements rows into domain-grouped admin sections. Keys not
 *  in ENTITLEMENT_DOMAINS land in a trailing "other" section (vestigial +
 *  spec-2 keys stay visible to staff even while unadvertised). */
export function groupForAdmin(rows: AdminEntRow[]): AdminEntSection[] {
  const byKey = new Map<string, Map<string, AdminEntRow>>();
  for (const r of rows) {
    if (!byKey.has(r.feature_key)) byKey.set(r.feature_key, new Map());
    byKey.get(r.feature_key)!.set(r.plan_key, r);
  }
  const toFeature = (k: string): AdminEntFeature => {
    const plans = byKey.get(k) ?? new Map<string, AdminEntRow>();
    const sample = [...plans.values()][0];
    return {
      feature_key: k,
      type: sample && sample.bool_value !== null ? "bool" : "int",
      cells: Object.fromEntries(PLANS.map((p) => [p, render(plans.get(p))])),
    };
  };
  const listed = new Set(ENTITLEMENT_DOMAINS.flatMap((d) => d.features));
  const sections: AdminEntSection[] = ENTITLEMENT_DOMAINS.map((d) => ({
    slug: d.slug,
    features: d.features.filter((f) => byKey.has(f)).map(toFeature),
  }));
  const other = [...byKey.keys()].filter((k) => !listed.has(k)).sort().map(toFeature);
  if (other.length > 0) sections.push({ slug: "other", features: other });
  return sections;
}
```

Test (fails before the file exists): feed rows for 2 keys in "scale" + 1 unknown key → 9 sections max, unknown lands in "other"; bool renders "true"/"false"; int null renders "∞"; a plan with no row renders "—".

- [ ] **Step 2: page** — server component, follows `/admin` conventions (slate-800 tables, English-only):

```tsx
import { sql } from "@/lib/db";
import { featureReason } from "@/lib/feature-copy";
import { groupForAdmin, type AdminEntRow } from "@/lib/entitlement-admin";

export default async function AdminEntitlementsPage() {
  const rows = await sql<AdminEntRow[]>`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements order by feature_key, plan_key`;
  const overrides = await sql<{ feature_key: string; n: number }[]>`
    select feature_key, count(*)::int as n from org_entitlement_overrides
    where expires_at is null or expires_at > now()
    group by feature_key`;
  const ovByKey = new Map(overrides.map((o) => [o.feature_key, o.n]));
  const sections = groupForAdmin(rows);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Entitlements</h1>
        <p className="text-xs text-slate-400">
          Live from <code>plan_entitlements</code> — the resolver, pricing page and this
          table all read the same rows. <code>∞</code> = unlimited (int null); a missing
          cell (<code>—</code>) resolves as DENY. Per-org exceptions live on each org page
          (overrides).
        </p>
      </div>
      {sections.map((s) => (
        <section key={s.slug}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">{s.slug}</h2>
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Feature key</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-center">Community</th>
                  <th className="px-3 py-2 text-center">Event Pass</th>
                  <th className="px-3 py-2 text-center">Pro</th>
                  <th className="px-3 py-2 text-center">Pro Plus</th>
                  <th className="px-3 py-2 text-left">What it gates</th>
                  <th className="px-3 py-2 text-right">Overrides</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {s.features.map((f) => (
                  <tr key={f.feature_key} className="hover:bg-slate-800/50">
                    <td className="px-3 py-2 font-mono text-xs text-purple-300">{f.feature_key}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{f.type}</td>
                    <td className="px-3 py-2 text-center text-slate-300">{f.cells.community}</td>
                    <td className="px-3 py-2 text-center text-slate-300">{f.cells.event_pass}</td>
                    <td className="px-3 py-2 text-center text-slate-300">{f.cells.pro}</td>
                    <td className="px-3 py-2 text-center text-slate-300">{f.cells.pro_plus}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{featureReason(f.feature_key)}</td>
                    <td className="px-3 py-2 text-right text-xs text-slate-500">{ovByKey.get(f.feature_key) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3:** nav link; typecheck; helper test green. **Step 4: Commit** — `feat(admin): /admin/entitlements live reference (keys, plans, copy, overrides)`

---

### Task 11: closing pass — smoke suite + help + ledger

**Files:**
- Modify: `scripts/smoke.ts`
- Modify/Create: `apps/web/content/help/**` (billing/plans + officials + save-points articles)
- Modify: `apps/web/src/lib/help.ts` if any NEW slug

- [ ] **Step 1: `proPlusSuite`** in `scripts/smoke.ts`, following the existing `*Suite` + SQL plan-flip conventions (see `pricingV3Suite` and the pro-flip trick): (a) community org: PATCH fixture officials with 2 officials → expect 402 `officials.per_fixture.max`; 2nd checkpoint POST → 402 `schedule.checkpoints.max`; (b) SQL-flip org to `pro_plus` → both succeed, manage-scope API key create succeeds; (c) `/pricing` HTML contains `pricing` matrix marker + "Pro Plus"; (d) restore the org's original plan. Register the suite in `main()` near `pricingV3Suite()` and BEFORE any suite that depends on the org's plan (read the ordering comments around lines 282–340 first — shared-DB poison is a known trap).
- [ ] **Step 2: help articles** — update the pricing/billing help article (find via `grep -rln "Event Pass" apps/web/content/help`) for the 4-plan ladder; extend the officials article (1 official/fixture on Community) and the schedule/save-points article (1/5/unlimited). New slugs (if any new file) registered in `HELP_ARTICLE_SLUGS` — the registry test fails otherwise.

- [ ] **Step 2b: e2e spec (user mandate 2026-07-18)** — add a Playwright spec in the root `e2e/` directory (follow the existing specs' conventions there — read one first; run from the REPO ROOT, known cwd gotcha): `pricing-pro-plus.spec.ts` — unauthenticated: goto `/en/pricing`; assert the Pro Plus card is NOT visible and the teaser + "Show Pro Plus" button ARE; click the button; assert the revealed card (`[data-plus-revealed]`) shows "Pro Plus" and the $39 price; assert the comparison table (`[data-pricing-matrix]`) contains a "Pro Plus" column header WITHOUT clicking anything (table always 4-col). Keep it self-contained (marketing page, no login).
- [ ] **Step 3:** Full verify: `npm run typecheck --workspace apps/web && npm run test --workspace apps/web`. Then with DATABASE_URL, run the DB suites touched (pro-plus-matrix, officials, history, api-keys).
- [ ] **Step 4: Commit** — `feat(pro-plus): smoke suite + help closing pass`

---

## Post-plan (controller, not a task)

- Final whole-branch review (opus) via review-package MERGE_BASE..HEAD.
- FULL VERIFY GATE before PR (user mandate): typecheck + unit + **headless Playwright e2e against a prod build** (`next build` + `next start`, never dev — dev dies under load/OOM; run playwright from the repo root).
- `npm run stripe:sync` is an OPS step per environment (test/prod) — record in PR body, do not run in tests.
- PR notes: deploy needs V286 + stripe:sync; Pro loses scheduling.ai/officials.auto/api.write-manage (approved hard move D4).
