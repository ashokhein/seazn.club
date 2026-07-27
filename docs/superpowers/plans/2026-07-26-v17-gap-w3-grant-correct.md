# Wave 3: grant-correct Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grant AI credits on the org's RESOLVED plan (not a raw status filter) so churned orgs stop getting zero forever, scale a trialing group's grant to its live org count instead of the frozen paid-seat count, and make the operator-allocation and Credits-tab spend derives agree with the grant cadence's UTC period boundary.
**Branch:** `fix/v17gap-w3-grant-correct` (git worktree — NEVER checkout in main repo dir)
**Issues:** #290 #291 #292
**Depends on:** W1 (money-leaks) and W2 (resolver-truth) merged first per the sequential wave order. Functionally this wave is self-contained: `orgPlanKey` (the TS resolver this wave now calls from the grant sweep) already has its own `canceled`/`incomplete`/`past_due`/trial-end-backstop/suspended-org degrade arms today — none of this wave's fixes wait on W2's SQL-side (`org_has_feature`) parity migration, which is a different resolver (used by public/embed views, not the credit sweep).

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

## Scope notes (read before starting)

- **No migration.** Per the wave map this is code-only. Confirmed: nothing in this wave touches a table or a stored function — `grantMonthlyForAllWallets`, `spentThisPeriodByOrg`, and `getCreditsTab` are all plain application code.
- **i18n: N/A.** No new or changed user-facing string — the cron sweep, the allocation derive, and the Credits-tab meter's SQL are invisible mechanics; the *numbers* they produce were already documented behavior (Community grants 10/mo, the Credits tab shows a monthly meter), this wave only makes the numbers correct.
- **Help pages: N/A.** Nothing here changes a documented promise a help page makes — a churned org correctly landing on the ALREADY-documented Community grant is not a new behavior to document.
- **smoke.ts: N/A for the cron/derive paths.** `scripts/smoke.ts` (repo root) drives the app over HTTP (`signIn`/`call`/`raw`) and already asserts the entitlement matrix's `ai.credits.monthly` values and the bootstrap grant (`matrix/community: a freshly-created org's AI credit wallet is bootstrap-granted...`, `scripts/smoke.ts:1238`) — none of that is touched by this wave. `grantMonthlyForAllWallets` is a cron batch job with no HTTP smoke path of its own (it's driven by `.github/workflows/billing-grant.yml`, gated on `CRON_SECRET`, not something a smoke script triggers); `spentThisPeriodByOrg` is a pure derive with no route of its own either — both are already covered by real-Postgres vitest suites, the correct layer for this class of change (same reasoning `credits-monthly-cron.test.ts`'s own suite already applies).
- **A real import-cycle risk was found and resolved during planning** (Task 1) — read that task's "Cycle" note before touching `credits.ts`'s imports.
- **A second money-read with the same TZ bug was found during the required grep sweep** (`server/usecases/credits-tab.ts:182`) — fixed in Task 5, not just `spentThisPeriodByOrg`.

---

### Task 1: #290 — grant sweep resolves the RESOLVED plan, not a raw status filter

**Files:**
- Modify: `apps/web/src/lib/credits.ts:269-332` (`grantMonthlyForAllWallets` + its doc comment)
- Test: `apps/web/src/lib/__tests__/credits-monthly-cron.test.ts` (modify one existing test, add one)

**Interfaces:**
- Consumes: `orgPlanKey(orgId: string): Promise<string>` (`apps/web/src/lib/entitlements.ts:182`) — already handles `canceled`/`incomplete`/`past_due`-grace/trial-end-backstop/suspended-org/comp-expiry degrades today, no changes needed there. `grantMonthly(walletId, planKey, quantityPaid): Promise<number>` (`credits.ts:225`, unchanged signature).
- Produces: `grantMonthlyForAllWallets(): Promise<{wallets, granted, failed}>` — same return shape, callers (`api/cron/billing-grant/route.ts`) untouched.

**Cycle note (verify-before-you-cite catch):** the audit digest says "pick grant org via `groupOrgLimit`'s selection rule (`lib/billing-group.ts`:155-164)". Importing `groupOrgLimit` (or a shared helper) FROM `billing-group.ts` into `credits.ts` is not safe: `billing-group.ts:14` imports `getLimit` from `@/lib/entitlements.ts`, and `entitlements.ts:4` already imports `walletIdFor` from `@/lib/credits.ts` — so `credits.ts → billing-group.ts → entitlements.ts → credits.ts` would close a second, avoidable cycle. This task already takes on ONE deliberate cycle (`credits.ts → entitlements.ts → credits.ts`, needed because #290 explicitly requires calling `orgPlanKey`) — that one is judged safe (see the code comment below) because neither module calls the other's export at module-evaluation time, only from inside async function bodies, long after both modules have finished loading. A SECOND cycle through `billing-group.ts` is unnecessary, so `groupOrgLimit`'s selection RULE (the `order by (status = 'suspended'), created_at limit 1`) is re-implemented as a SQL `lateral` join directly in the sweep's own query, not imported. This is a small, stable, structural ORDER BY — not the kind of business-logic CASE the audit's "never hand-copy" warning is about (that warning targets `orgPlanKey`'s CASE, which this task does NOT copy — it calls the real function).

**Design note (documented, not silently decided):** if EVERY org in a group is suspended, the representative picked is necessarily suspended, and `orgPlanKey` on it resolves to `'community'` — so a fully-suspended group's credit grant degrades to the Community rate. This differs from `groupOrgLimit`'s own degenerate branch (`billing-group.ts:166-177`), which deliberately bypasses the suspended-org resolver for the ORG CAP so moderation can never shrink what a paying group is allowed to own ("moderation must not move money" — `billing-groups.test.ts:313`). The audit that raised #290 named churn and trial under-grants specifically, not this moderation-linked edge case, and grant-at-the-resolved-rate is the conservative direction for a money primitive (it under-grants, never over-grants) — so this task does NOT special-case it. Flagged here for whoever revisits it; not tested as its own scenario (YAGNI — it isn't one of the three audit-named facts).

- [ ] **Step 1: Write the failing test**

  Modify the existing test (currently asserts the OLD, buggy behavior) and add one more, in `apps/web/src/lib/__tests__/credits-monthly-cron.test.ts`:

  ```ts
  // REPLACES the existing `it("skips a canceled subscription (not live)", ...)`
  // block (currently asserts `balance === 0`) with the corrected expectation,
  // and adds the `incomplete` case next to it.
  it("REGRESSION (#290): grants the resolved Community rate for a canceled (churned) subscription, not zero", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    // comped_at stays null (setOrgPlan's default) — orgPlanKey's `canceled`
    // arm degrades this to community, exactly like any other entitlement
    // read of this org (hasFeature, getLimit, the billing page).
    const subId = await setOrgPlan(orgId, "pro", "canceled");

    await grantMonthlyForAllWallets();

    // Before #290 the raw status filter (`status in ('trialing','active',
    // 'past_due')`) skipped this row entirely — a churned org got 0 credits
    // forever even though every OTHER entitlement read already resolves it
    // to Community and expects the Community grant to back that up.
    expect(await balance(subId)).toBe(10);
  });

  it("REGRESSION (#290): grants the resolved Community rate for an incomplete (never-paid) subscription", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "incomplete");

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(10);
  });
  ```

  Note: Stripe's `unpaid` and `incomplete_expired` statuses are normalized before they ever reach `subscriptions.status` (`lib/billing.ts:404`'s `STATUS_MAP` maps `unpaid → past_due` and `incomplete_expired → canceled`), so those two literal values never appear in the DB — no separate test case needed for them; the `canceled` and `incomplete` cases above already cover what actually gets stored.

- [ ] **Step 2: Run test to verify it fails**

  Run (from `apps/web`):
  ```
  DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_smoke DATABASE_SSL=disable DB_SCHEMA=v17gap_w3 npx vitest run src/lib/__tests__/credits-monthly-cron.test.ts
  ```
  (Fresh schema first time: `npm run db:apply` then `npm run sync:sports` under the same env.)

  Expected: FAIL — both new/modified assertions expect `balance === 10`, but the current status-filtered query never selects a `canceled` or `incomplete` subscription row at all, so `grantMonthlyForAllWallets` grants nothing and `balance` stays `0`.

- [ ] **Step 3: Write minimal implementation**

  Add the import (with the cycle documented at the point of use):

  ```ts
  // #290: resolves the grant sweep's plan via the SAME resolver every other
  // entitlement read uses (orgPlanKey). This creates a deliberate two-file
  // import cycle — entitlements.ts already imports walletIdFor from THIS
  // file — safe because neither module calls the other's export at
  // module-evaluation time, only from inside an async function body, long
  // after both modules have finished loading. Verify with `npm run
  // typecheck` and by actually running credits-monthly-cron.test.ts: a
  // broken cycle here would surface as `orgPlanKey is not a function` at
  // call time, not a compile error.
  import { orgPlanKey } from "@/lib/entitlements";
  ```

  Replace `grantMonthlyForAllWallets`'s doc comment (`credits.ts:269-308`) and body (`credits.ts:309-332`) with:

  ```ts
  /**
   * Cron entry point (Task 6, `api/cron/billing-grant`): grant every wallet
   * with at least one live org its monthly allowance for this period.
   *
   * **Grants on the RESOLVED plan, not the raw subscription row (#290).** A
   * prior version filtered `subscriptions.status in ('trialing', 'active',
   * 'past_due')` before granting anything — so a churned subscription
   * (`canceled`, `incomplete`, ...) was skipped by the query entirely and its
   * org got 0 credits forever, even though `orgPlanKey` (entitlements.ts)
   * already resolves that SAME row to `'community'` for every other
   * entitlement read (hasFeature, getLimit, the billing page). This sweep now
   * scans every subscription with a live org — no status filter — and calls
   * `orgPlanKey` per wallet to learn what it should ACTUALLY be granted, so a
   * churned org gets its Community 10/mo like any other Community wallet
   * instead of silently nothing. No retroactive back-grant for months already
   * missed (v17-gap design decision) — this only fixes the sweep going
   * forward.
   *
   * **Which org answers for the group:** `orgPlanKey` takes a single org id,
   * but a wallet can back several orgs (a billing group). The `rep` lateral
   * below picks the SAME representative `lib/billing-group.ts`'s
   * `groupOrgLimit` does — the oldest LIVE org that is not suspended, falling
   * back to a suspended one only if every org in the group is suspended — so
   * a single suspended member cannot silently change which plan the whole
   * group's credits resolve against. Re-implemented as SQL here rather than
   * imported: `billing-group.ts` imports `lib/entitlements.ts` (for
   * `getLimit`), which imports `lib/credits.ts` (for `walletIdFor`) — so
   * `credits.ts` importing FROM `billing-group.ts` would close a second,
   * avoidable cycle on top of the one this file already takes on for
   * `orgPlanKey`. Keep this ORDER BY in step with `groupOrgLimit`'s by hand
   * if that one ever changes.
   *
   * A representative org that is itself community-suspended (a fully
   * moderation-suspended group) grants flat Community — a deliberate,
   * minimal reading of #290 that does NOT special-case that edge the way
   * `groupOrgLimit` special-cases the ORG CAP; see the plan task that added
   * this function for the reasoning.
   *
   * **Trial grant scales to live orgs, not the frozen paid count (#291):**
   * `syncGroupQuantity` (#279) freezes `quantity_paid` at its pre-trial
   * baseline for the whole trial — a second org that joins mid-trial rides
   * free and raises the ACTIVE org count without moving `quantity_paid` (by
   * design: nothing has been billed yet). Granting on the frozen
   * `quantity_paid` alone would under-grant that org's own seat's worth of
   * credits, so a trialing wallet's quantity is `max(quantity_paid,
   * liveOrgCount)` — never less than what's actually live. #279's own tests
   * (`billing-group-trial-seat.test.ts`) assert `quantity_paid` itself stays
   * frozen — this reads `live_org_count` alongside it rather than touching
   * that column, so both stay true at once.
   *
   * **Anchor (README §7 item 7): calendar month for EVERY wallet, paid or
   * Community — never `current_period_end`.** SPEC-2 §5.4's Cadence rule is
   * explicit that the grant is monthly *regardless of billing cadence* (an
   * annual Pro at $159/yr must still get 60/mo × 12, not a single 720 lump),
   * so `grantMonthly`'s own `monthlyPeriod()` (UTC `YYYY-MM`) is the only
   * anchor this function uses.
   *
   * One wallet's failure (a bad plan_key, a transient DB error) is logged and
   * skipped rather than aborting the whole sweep, matching
   * `reconcileGroupQuantities`'s per-group try/catch — `failed` is returned
   * so the caller (the cron route, then `billing-grant.yml`) can warn on a
   * persistent per-wallet grant failure instead of it going unnoticed.
   */
  export async function grantMonthlyForAllWallets(): Promise<{
    wallets: number;
    granted: number;
    failed: number;
  }> {
    const rows = await sql<
      { id: string; quantity_paid: number; rep_org_id: string }[]
    >`
      select s.id, s.quantity_paid, rep.id as rep_org_id
        from subscriptions s
        cross join lateral (
          select o.id from organizations o
           where o.subscription_id = s.id and o.deleted_at is null
           order by (o.status = 'suspended'), o.created_at
           limit 1
        ) rep`;
    let granted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const planKey = await orgPlanKey(row.rep_org_id);
        const qty = planKey === "community" ? 1 : row.quantity_paid;
        granted += await grantMonthly(row.id, planKey, qty);
      } catch (err) {
        failed++;
        console.error(`[credits] monthly grant failed for wallet ${row.id}`, err);
      }
    }
    return { wallets: rows.length, granted, failed };
  }
  ```

  Note: this step deliberately does NOT yet add the trial branch or `live_org_count` — that's Task 2, so each task's diff stays minimal and independently verifiable. `cross join lateral (...) rep` also replaces the old `exists (...)` guard: a subscription with zero live orgs produces zero rows from the lateral subquery, so `cross join lateral` (an implicit inner join) drops that row from the result set the same way `exists()` used to filter it out.

- [ ] **Step 4: Run test to verify it passes**

  Re-run the Step 2 command. Expected: all tests in the file pass, including the pre-existing ones ("grants a paid wallet the scaled amount...", "grants a community wallet the FLAT 10...", the idempotency and cadence tests) — none of those change shape (single-org groups on `active`/`community` status resolve identically through `orgPlanKey` as they did through the raw `plan_key` before, since no degrade arm fires for them).

- [ ] **Step 5: Commit**

  ```
  git add apps/web/src/lib/credits.ts apps/web/src/lib/__tests__/credits-monthly-cron.test.ts
  git commit -m "$(cat <<'EOF'
  fix(credits): grant sweep uses the resolved plan (#290)

  grantMonthlyForAllWallets filtered subscriptions.status before granting,
  so a churned (canceled/incomplete) org was skipped and got 0 AI credits
  forever instead of the Community rate orgPlanKey already resolves it to
  on every other entitlement read.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: #291 — trial grant scales to live org count, not the frozen paid count

**Files:**
- Modify: `apps/web/src/lib/credits.ts` (the `grantMonthlyForAllWallets` query + loop from Task 1)
- Test: `apps/web/src/lib/__tests__/credits-monthly-cron.test.ts` (add one test) + verification run of `apps/web/src/server/usecases/__tests__/billing-group-trial-seat.test.ts` (#279's suite — must stay green, per the audit's explicit instruction)

**Interfaces:**
- Consumes: Task 1's `grantMonthlyForAllWallets` shape (extends its query and ternary, does not change its signature).
- Produces: same `grantMonthlyForAllWallets` export; no new public function.

- [ ] **Step 1: Write the failing test**

  Add to `apps/web/src/lib/__tests__/credits-monthly-cron.test.ts`:

  ```ts
  it("REGRESSION (#291): a trialing group grants for the LIVE org count when quantity_paid is frozen below it", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "trialing");
    // #279 (syncGroupQuantity) freezes quantity_paid at its pre-trial
    // baseline through the whole trial — simulate a second org that rode the
    // trial for free without quantity_paid ever moving off its default (1).
    const suffix = randomUUID().slice(0, 8);
    await sql`
      insert into organizations (name, slug, subscription_id)
      values (${"Rider " + suffix}, ${"rider-" + suffix}, ${subId})`;

    await grantMonthlyForAllWallets();

    // max(quantity_paid=1, liveOrgCount=2) — not quantity_paid alone, or the
    // rider org would spend against a wallet that only ever got 1 seat's
    // worth of monthly credits.
    expect(await balance(subId)).toBe(60 * 2);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run the Step 2 command from Task 1 (same file). Expected: FAIL — after Task 1's change alone, a `trialing` subscription still falls into the `else` branch (`qty = row.quantity_paid`), so this grants `60 * 1 = 60`, not `60 * 2 = 120`.

- [ ] **Step 3: Write minimal implementation**

  Extend the query (adds `s.status` and a second lateral for the live count) and the ternary:

  ```ts
    const rows = await sql<
      { id: string; status: string; quantity_paid: number; rep_org_id: string; live_org_count: number }[]
    >`
      select s.id, s.status, s.quantity_paid, rep.id as rep_org_id, live.n as live_org_count
        from subscriptions s
        cross join lateral (
          select o.id from organizations o
           where o.subscription_id = s.id and o.deleted_at is null
           order by (o.status = 'suspended'), o.created_at
           limit 1
        ) rep
        cross join lateral (
          select count(*)::int as n from organizations o
           where o.subscription_id = s.id and o.deleted_at is null
        ) live`;
    let granted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const planKey = await orgPlanKey(row.rep_org_id);
        const qty =
          planKey === "community"
            ? 1
            : row.status === "trialing"
              ? Math.max(row.quantity_paid, row.live_org_count)
              : row.quantity_paid;
        granted += await grantMonthly(row.id, planKey, qty);
      } catch (err) {
        failed++;
        console.error(`[credits] monthly grant failed for wallet ${row.id}`, err);
      }
    }
    return { wallets: rows.length, granted, failed };
  ```

- [ ] **Step 4: Run test to verify it passes, and verify #279 stays green**

  Re-run Task 1's command against `credits-monthly-cron.test.ts` — all tests including the new one pass.

  Then run #279's own suite (verification step, not a new test — it exercises `syncGroupQuantity`/`attachOrgToGroup`/`detachOrgFromGroup`/`previewAttachCharge`, none of which this task touches, but it starts a real `e2e/stripe-fixture-server` on a fixed port so it must be run alone):
  ```
  cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_smoke DATABASE_SSL=disable DB_SCHEMA=v17gap_w3 npx vitest run src/server/usecases/__tests__/billing-group-trial-seat.test.ts
  ```
  Expected: all 4 tests pass unchanged — "freezes quantity_paid through a trial attach and detach", "previews a trial attach as free", "lets the trial-end renewal set quantity_paid to the active count", "still inflates quantity_paid on an ACTIVE (non-trial) group". This confirms `quantity_paid` itself is never written by this task's change — only what it's multiplied by for the grant — so #279's freeze guarantee and this task's grant-scaling coexist without either function touching the other's invariant.

- [ ] **Step 5: Commit**

  ```
  git add apps/web/src/lib/credits.ts apps/web/src/lib/__tests__/credits-monthly-cron.test.ts
  git commit -m "$(cat <<'EOF'
  fix(credits): trial grant scales to live orgs (#291)

  #279 froze quantity_paid at its pre-trial baseline for the whole trial
  (nothing is billed yet), but quantity_paid also drove the monthly grant
  multiplier — a seat added mid-trial rode free and under-granted its own
  credits. Grant qty is now max(quantity_paid, liveOrgCount) while trialing.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: Record the #291 decision in SPEC-2 §11.2

**Files:**
- Modify: `design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md:215-221` (§11.2 "Scaled monthly grant")

**Interfaces:** none (documentation only — no code/test steps; this task is explicitly requested by the audit as a standalone plan task, not folded silently into Task 2).

- [ ] **Step 1: Write the doc change**

  §11.2 currently reads (verified against the file):

  ```
  ### 11.2 Scaled monthly grant

  \`\`\`
  monthly_grant(group) = ai.credits.monthly(plan) * quantity_paid
  \`\`\`

  e.g. a Pro Plus group of 3 paid org-seats → 200 * 3 = **600 credits/mo** shared. Fair to big operators, still bounded by seats paid. Resets (D1). A standalone org = *1. Community (never grouped) = flat 10.
  ```

  Append a new paragraph after it:

  ```
  **Trial exception (#291, 2026-07-26):** `quantity_paid` is frozen at its pre-trial baseline for the whole trial (#279, `syncGroupQuantity`) — a seat added mid-trial rides free and raises the live org count without moving `quantity_paid`. Granting on the frozen number alone would under-grant that seat's own credits, so while trialing:

  \`\`\`
  monthly_grant(group) = ai.credits.monthly(plan) * max(quantity_paid, live_org_count)
  \`\`\`

  `quantity_paid` itself is never rewritten by the grant — only what it's multiplied by for THIS grant. It converges back to plain `quantity_paid` once the trial converts (`syncGroupQuantity`'s renewal path sets `quantity_paid` to what was actually invoiced).
  ```

- [ ] **Step 2: Commit**

  ```
  git add design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md
  git commit -m "$(cat <<'EOF'
  docs(spec-2): record the trial grant qty rule (§11.2, #291)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: #292 — shared UTC period-boundary helper, `spentThisPeriodByOrg` fix

**Files:**
- Modify: `apps/web/src/lib/credits.ts:121-132` (`monthlyPeriod`), `apps/web/src/lib/credits.ts:775-821` (`spentThisPeriodByOrg` + its doc)
- Create: `apps/web/src/lib/__tests__/credits-period-boundary.test.ts`

**Interfaces:**
- Produces: `export function utcMonthStart(): Date` (`credits.ts`) — consumed by `monthlyPeriod()` in this task and by `credits-tab.ts` in Task 5.
- Consumes: `Executor` type (`credits.ts:24`, unchanged) for `spentThisPeriodByOrg`'s existing signature.

**Required grep sweep (audit instruction: "grep for other `date_trunc(now())`/`current_date` money reads and list every hit with fix-or-why-not"):**

| Hit | Money read? | Verdict |
|---|---|---|
| `lib/credits.ts:819` (`spentThisPeriodByOrg`) | Yes — operator allocation cap derive (SPEC-5 §1) | **FIX — this task** |
| `server/usecases/credits-tab.ts:182` (Credits-tab "used this month" meter) | Yes — org-facing usage meter on the billing page | **FIX — Task 5** |
| `server/usecases/me.ts:109` (`scheduled_at >= date_trunc('day', now())`) | No — officiating fixture-scheduling filter, day granularity | No fix: not money, and a day-granularity boundary has no cross-month TZ divergence class to begin with |
| `server/usecases/scorers.ts:221` (same shape) | No — scorer-assignment fixture filter | No fix, same reasoning |
| `server/public-site/discovery.ts` (`current_date`, multiple) | No — public competition discovery ordering | No fix: content ordering, not billing |
| `server/usecases/public.ts` (`current_date`) | No — same, public listing ordering | No fix |
| `server/usecases/me-officiating.ts:147` (`oa.date >= current_date`) | No — officiating assignment date filter | No fix |
| `db/migration/deltas/V328__event_pass_lifecycle_lock.sql`, `V332__trialing_trial_end_backstop.sql` (`current_date` in `org_has_feature`'s pass-lock arm) | Was — pass-lock grace boundary | Already fixed forward by `V334__org_has_feature_utc_pass_grace.sql` (`create or replace function`, double `at time zone 'utc'`); these are applied historical deltas — never edited in place |

**Proven timezone subtlety (verify-before-you-cite — the audit digest's literal wording is a trap):** the digest says "Decided: `date_trunc('month', (now() at time zone 'utc'))`". Verified against the local dev Postgres (`psql -h localhost -p 5432 -d seazn`) that this single-conversion form is **still buggy** when compared against a `timestamptz` column:

```sql
set local time zone 'Europe/London';
select timestamptz '2026-06-30 23:30:00+00' >= date_trunc('month', now() at time zone 'utc');
-- returns TRUE — June 30 23:30 UTC wrongly counted as inside "this month" (July)
```

`date_trunc('month', now() at time zone 'utc')` returns a bare `timestamp` (no tz) representing the UTC month start; comparing that directly against a `timestamptz` column forces Postgres to cast it back to `timestamptz` using the **session's** TimeZone GUC — reintroducing the exact bug being fixed. The TZ-safe SQL form needs a SECOND `at time zone 'utc'` to re-tag the naive value as UTC:

```sql
select timestamptz '2026-06-30 23:30:00+00' >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc');
-- returns FALSE — correct
```

Rather than rely on getting that double-conversion right in every SQL call site (and every future one), this task computes the boundary in JS instead (trivially correct — `Date.UTC` has no session-TZ concept at all) and passes it as a `timestamptz` parameter — an absolute-instant comparison against `created_at`, immune to the DB session's TimeZone GUC by construction. This is the "shared period-boundary helper both sites use" the audit asks for: ONE function (`utcMonthStart`) both `monthlyPeriod()`'s idempotency-key string and `spentThisPeriodByOrg`'s SQL comparison derive from, so they cannot independently compute "this month" and drift again.

- [ ] **Step 1: Write the failing test**

  Create `apps/web/src/lib/__tests__/credits-period-boundary.test.ts`:

  ```ts
  // AI credit wallet — UTC-safe period boundary (#292).
  //
  // spentThisPeriodByOrg (SPEC-5 §1's operator allocation derive) used to
  // bound "this period" with `date_trunc('month', now())` — truncated in the
  // DB SESSION's TimeZone GUC (Europe/London in prod), not UTC.
  // grantMonthly's own period anchor (monthlyPeriod(), a plain
  // toISOString().slice(0,7)) is always UTC. Around a month boundary the two
  // could disagree by up to an hour: a spend recorded in the last hour of
  // UTC June could read as "July" under a UTC+1 session TZ and wrongly count
  // toward July's operator allocation cap. Real Postgres required; skipped
  // without DATABASE_URL.
  //
  // Uses session TZ Europe/London specifically (production's session TZ, and
  // the exact shape V334's org_has_feature fix reproduced) rather than a
  // fixed always-offset zone like entitlements-sql-parity.test.ts's
  // Etc/GMT-14 pair — so, like that choice trades away, this test only
  // demonstrates the bug while Europe/London is genuinely ahead of UTC (BST,
  // roughly late March-late October). It is valid today (2026-07-26, BST).
  // If this ever needs to be season-proof, mirror
  // entitlements-sql-parity.test.ts's Etc/GMT-14 / Etc/GMT+12 pair instead.
  import { afterAll, describe, expect, it } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { spentThisPeriodByOrg } from "@/lib/credits";

  const HAS_DB = !!process.env.DATABASE_URL;
  const uniq = () => randomUUID().slice(0, 8);

  async function seedOrg(): Promise<string> {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug)
      values (${`PeriodBoundary ${uniq()}`}, ${`period-boundary-${uniq()}`})
      returning id`;
    return org!.id;
  }

  afterAll(async () => {
    if (!HAS_DB) return;
    const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
    const client = globalForDb._sql;
    globalForDb._sql = undefined;
    await client?.end();
  });

  describe.skipIf(!HAS_DB)("spentThisPeriodByOrg — UTC period boundary (#292)", () => {
    it("REGRESSION: excludes a hold from the PRIOR UTC month even under session TZ Europe/London, at the exact month-boundary edge", async () => {
      const walletId = randomUUID();
      const orgId = await seedOrg();
      // 30 minutes before THIS UTC month started — genuinely last month in
      // UTC. Computed relative to Postgres's own (TZ-safe, double-converted)
      // clock so this holds regardless of which real day this suite runs on.
      const [{ edge }] = await sql<{ edge: string }[]>`
        select (date_trunc('month', now() at time zone 'utc') at time zone 'utc'
                - interval '30 minutes')::text as edge`;
      await sql`
        insert into ai_credit_ledger
          (wallet_id, delta, source, bucket, spent_by_org_id, balance_after,
           idempotency_key, created_at)
        values (${walletId}, -1, 'run_spend', 'grant', ${orgId}, 0,
                ${`edge-${uniq()}`}, ${edge})`;

      const spent = await sql.begin(async (tx) => {
        await tx`set local time zone 'Europe/London'`;
        return spentThisPeriodByOrg(tx, walletId, orgId);
      });

      // Genuinely last month — must not count toward this period's spend no
      // matter what TZ the DB session happens to run under.
      expect(spent).toBe(0);
    });

    it("still counts a hold recorded inside the current UTC month", async () => {
      const walletId = randomUUID();
      const orgId = await seedOrg();
      const [{ edge }] = await sql<{ edge: string }[]>`
        select (date_trunc('month', now() at time zone 'utc') at time zone 'utc'
                + interval '1 second')::text as edge`;
      await sql`
        insert into ai_credit_ledger
          (wallet_id, delta, source, bucket, spent_by_org_id, balance_after,
           idempotency_key, created_at)
        values (${walletId}, -3, 'run_spend', 'grant', ${orgId}, 0,
                ${`this-month-${uniq()}`}, ${edge})`;

      const spent = await sql.begin(async (tx) => {
        await tx`set local time zone 'Europe/London'`;
        return spentThisPeriodByOrg(tx, walletId, orgId);
      });

      expect(spent).toBe(3);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `apps/web`, during BST — see the test file's own note if run in GMT months):
  ```
  DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_smoke DATABASE_SSL=disable DB_SCHEMA=v17gap_w3 npx vitest run src/lib/__tests__/credits-period-boundary.test.ts
  ```
  Expected: the first test FAILS (`expect(spent).toBe(0)` but old code's session-TZ `date_trunc('month', now())` truncates ~1h earlier under BST, so the June-30-23:30-UTC hold reads as inside "this period" and `spent` comes back `1`). The second test passes either way (a hold 1 second past the true UTC boundary is inside the month under both old and new code).

- [ ] **Step 3: Write minimal implementation**

  Add the shared helper and rewire `monthlyPeriod()`:

  ```ts
  /** The current UTC calendar-month boundary (00:00 UTC on the 1st) — the ONE
   *  anchor `monthlyPeriod()`'s idempotency key and `spentThisPeriodByOrg`'s
   *  period window both derive from (#292), so the two can never
   *  independently compute "this month" and disagree.
   *
   *  A real `Date`, handed to SQL as a `timestamptz` PARAMETER — comparing a
   *  `timestamptz` column against a `timestamptz` parameter is an
   *  absolute-instant comparison, immune to the DB session's `TimeZone` GUC
   *  (Europe/London in prod). Deliberately NOT computed in SQL:
   *  `date_trunc('month', now())` truncates in the SESSION timezone, and even
   *  `date_trunc('month', now() at time zone 'utc')` — which reads as
   *  UTC-correct — returns a bare `timestamp` (no tz); comparing THAT
   *  directly against a `timestamptz` column forces Postgres to cast it back
   *  to `timestamptz` using the session TZ, reintroducing the exact
   *  divergence this fixes (proven against a live session: under TZ
   *  Europe/London, `timestamptz '2026-06-30 23:30:00+00' >= date_trunc(
   *  'month', now() at time zone 'utc')` evaluates TRUE — a June 30 23:30 UTC
   *  spend wrongly counted as inside July). Only `date_trunc(...) at time
   *  zone 'utc'` (a SECOND conversion, back to a real timestamptz) is
   *  TZ-safe in SQL; doing the truncation in JS and passing a `Date`
   *  sidesteps the whole subtlety, and is what every call site now does. */
  export function utcMonthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  /** Calendar-month period the monthly grant is scoped to (server clock,
   *  `YYYY-MM`) — the ONLY anchor `grantMonthly` uses, for every wallet, paid
   *  or Community (SPEC-2 §5.4 Cadence: "grant is monthly regardless of
   *  billing cadence"). Derives from `utcMonthStart()` (#292) — the SAME
   *  anchor `spentThisPeriodByOrg` compares against — rather than computing
   *  its own `new Date().toISOString().slice(0, 7)` independently, so the two
   *  can never drift apart again. Deliberately has no notion of a
   *  subscription's Stripe billing cycle at all — an annual-billed plan's
   *  `current_period_end` only advances once a year, so keying off it (a
   *  prior version of this module did, for paid wallets) collapses 12
   *  monthly grants into a single lump on the renewal date, which is the
   *  exact regression this cadence rule exists to forbid. */
  function monthlyPeriod(): string {
    return utcMonthStart().toISOString().slice(0, 7);
  }
  ```

  Update `spentThisPeriodByOrg`'s doc comment's "Period bound" paragraph and its query:

  ```ts
   * **Period bound** = `utcMonthStart()` (#292), the same UTC calendar-month
   * anchor `grantMonthly`'s `monthlyPeriod()` resets on — so the cap resets
   * implicitly with the grant cycle, and the two can never independently
   * compute "this month" and disagree (a prior version compared against bare
   * `date_trunc('month', now())`, truncated in the DB session's TimeZone GUC
   * — Europe/London in prod — which could disagree with the UTC-anchored
   * grant cycle by up to an hour around a month boundary). A hold from a
   * prior month is excluded (its refund, if any, is moot — only holds inside
   * the period are summed). Runs inside the caller's executor (`reserve`'s
   * advisory-locked tx) so the check sees this reserve's own prior writes.
   * Returns a non-negative integer.
  ```

  ```ts
  export async function spentThisPeriodByOrg(
    exec: Executor,
    walletId: string,
    orgId: string,
  ): Promise<number> {
    const periodStart = utcMonthStart();
    const [row] = await exec<{ spent: string | null }[]>`
      select coalesce(sum(
        -h.delta - coalesce((
          select sum(r.delta) from ai_credit_ledger r
           where r.source = 'refund' and r.ref = h.id::text
        ), 0)
      ), 0)::text as spent
        from ai_credit_ledger h
       where h.wallet_id = ${walletId}
         and h.spent_by_org_id = ${orgId}
         and h.source = 'run_spend'
         and h.created_at >= ${periodStart}`;
    return Math.max(0, Number(row?.spent ?? 0));
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Re-run Step 2's command. Expected: both tests pass. Also re-run the suites that exercise `spentThisPeriodByOrg` indirectly through `reserve()` to confirm no regression:
  ```
  DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_smoke DATABASE_SSL=disable DB_SCHEMA=v17gap_w3 npx vitest run src/lib/__tests__/credits-allocation.test.ts src/lib/__tests__/credits-monthly-cron.test.ts src/lib/__tests__/credits-grant.test.ts
  ```
  Expected: all green, including `credits-allocation.test.ts`'s test 8 ("period-scoped: a hold stamped last month does not count toward the cap") — it backdates by a full 2 months, well clear of the boundary this task touches.

- [ ] **Step 5: Commit**

  ```
  git add apps/web/src/lib/credits.ts apps/web/src/lib/__tests__/credits-period-boundary.test.ts
  git commit -m "$(cat <<'EOF'
  fix(credits): UTC-safe period boundary for spend derive (#292)

  spentThisPeriodByOrg bounded "this period" with date_trunc('month', now()),
  truncated in the DB session's TimeZone GUC (Europe/London in prod) — up to
  1h out of step with grantMonthly's UTC-anchored cycle around a month
  boundary. Both now derive from one JS-computed utcMonthStart() helper,
  passed as a timestamptz parameter (immune to session TZ by construction).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: #292 continued — same fix for the Credits-tab "used this month" meter

**Files:**
- Modify: `apps/web/src/server/usecases/credits-tab.ts:1-3,151-182`
- Test: `apps/web/src/server/usecases/__tests__/credits-tab.test.ts`

**Interfaces:**
- Consumes: `utcMonthStart(): Date` (`@/lib/credits`, produced by Task 4).

**Testability note:** unlike `spentThisPeriodByOrg`, `getCreditsTab` takes no `exec`/transaction parameter — its internal queries run directly on the shared pool `sql` client, so a test cannot inject a `set local time zone` around it the way Task 4's test does (and setting a non-`local` `SET TIME ZONE` on the shared pool would leak to other connections/tests, since postgres.js reuses pooled connections — exactly the contamination the codebase's existing `set local time zone` pattern, e.g. `entitlements-sql-parity.test.ts`, deliberately avoids). This task's regression test instead relies on the AMBIENT session `TimeZone` GUC already being non-UTC — verified `Europe/London` on this project's local dev Postgres (`psql ... -c "show timezone;"` → `Europe/London`), matching production (V334's own note) — and checks it explicitly so the test degrades to a harmless no-op rather than a false failure on a differently-configured DB (e.g. a UTC-default CI Postgres). The canonical, TZ-forced proof of the shared mechanism is Task 4's `Europe/London`-forced test; this one confirms the SAME bug class is fixed at this SECOND call site, using the tightest edge (30 minutes before the boundary, not a multi-day margin) so it actually exercises the divergence rather than only sanity-checking the query still runs.

- [ ] **Step 1: Write the failing test**

  Add to `apps/web/src/server/usecases/__tests__/credits-tab.test.ts`:

  ```ts
  it("REGRESSION (#292): the used-this-month meter excludes a hold recorded 30 minutes before the UTC month boundary", async () => {
    const [{ tz }] = await sql<{ tz: string }[]>`select current_setting('TimeZone') as tz`;
    // getCreditsTab has no tx to force a TZ on (see this task's Testability
    // note) — this only reproduces under a non-UTC ambient session TimeZone
    // (Europe/London here and in production). Skip cleanly rather than
    // false-fail on a UTC-default DB.
    if (tz === "UTC" || tz === "Etc/UTC") return;

    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await grantMonthly(walletId, "pro", 1);

    // 23:30 UTC on the last day of the PRIOR month — under the ambient
    // Europe/London (BST, UTC+1) session TZ this instant reads as "00:30"
    // on the 1st, an hour INTO the new month locally, so a session-TZ-
    // anchored boundary wrongly counts it. Computed relative to Postgres's
    // own clock so this holds on any run date, not hardcoded.
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, spent_by_org_id, balance_after,
         idempotency_key, created_at)
      values (${walletId}, -7, 'run_spend', 'grant', ${auth.orgId}, 53,
              ${`edge-${randomUUID()}`},
              date_trunc('month', now() at time zone 'utc') at time zone 'utc' - interval '30 minutes')`;

    const view = await getCreditsTab(auth.orgId);

    expect(view.grantUsed).toBe(0); // must NOT count toward the current UTC month
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `apps/web`, during BST so the ambient-TZ check above doesn't no-op — see Task 4's note on the same seasonal caveat):
  ```
  DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_smoke DATABASE_SSL=disable DB_SCHEMA=v17gap_w3 npx vitest run src/server/usecases/__tests__/credits-tab.test.ts
  ```
  Expected: FAIL — `view.grantUsed` is `7`, not `0`. The old `date_trunc('month', now())` query truncates in the ambient session TZ, which sits ~1h ahead of the true UTC month start under BST, so the seeded row reads as "this month" and gets summed into the meter.

- [ ] **Step 3: Write minimal implementation**

  Update the import and hoist `periodStart`:

  ```ts
  import { balance, packBalance, utcMonthStart, walletIdFor } from "@/lib/credits";
  ```

  ```ts
  export async function getCreditsTab(orgId: string): Promise<CreditsTabView> {
    const walletId = await walletIdFor(orgId);
  ```
  (unchanged down to the `Promise.all` call — insert just above it:)
  ```ts
    const periodStart = utcMonthStart();

    const [bal, packBal, spent, history, shared, referralCode, referred, referralEarned] =
      await Promise.all([
        balance(walletId),
        packBalance(walletId),
        sql<{ used: string | null }[]>`
        select coalesce(sum(-delta), 0)::text as used from ai_credit_ledger
         where wallet_id = ${walletId} and bucket = 'grant' and source = 'run_spend'
           and created_at >= ${periodStart}`,
  ```
  (the rest of the array — `creditHistory`, shared-org count, referral code, etc. — is unchanged).

- [ ] **Step 4: Run test to verify it passes**

  Re-run Step 2's command. Expected: all tests in `credits-tab.test.ts` pass, including the new one and the pre-existing "derives balance, grant meter, packs and history for a Pro wallet" (`grantUsed` still `1` for a same-instant spend) and "caps the grant meter at the Community flat 10 and starts empty".

- [ ] **Step 5: Commit**

  ```
  git add apps/web/src/server/usecases/credits-tab.ts apps/web/src/server/usecases/__tests__/credits-tab.test.ts
  git commit -m "$(cat <<'EOF'
  fix(credits): UTC-safe period boundary for the Credits-tab meter (#292)

  Same date_trunc('month', now()) session-TZ bug as spentThisPeriodByOrg,
  found by the #292 grep sweep. Reuses the shared utcMonthStart() helper.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: Final verification

**Files:** none (no code changes — confirms Tasks 1-5 together).

**Interfaces:** none.

- [ ] **Step 1: Typecheck**

  ```
  cd apps/web && npm run typecheck
  ```
  Expected: clean. This is also the practical check on Task 1's deliberate `credits.ts ↔ entitlements.ts` import cycle — `tsc` resolves circular type imports fine for function declarations, but confirm zero errors before trusting the runtime story in Step 2.

- [ ] **Step 2: Run every suite this wave touched or could affect, together**

  ```
  cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_smoke DATABASE_SSL=disable DB_SCHEMA=v17gap_w3 npx vitest run \
    src/lib/__tests__/credits-monthly-cron.test.ts \
    src/lib/__tests__/credits-grant.test.ts \
    src/lib/__tests__/credits-allocation.test.ts \
    src/lib/__tests__/credits-period-boundary.test.ts \
    src/lib/__tests__/credits-spend.test.ts \
    src/lib/__tests__/credits-balance.test.ts \
    src/lib/__tests__/credits-earn.test.ts \
    src/lib/__tests__/credits-admin-adjust.test.ts \
    src/lib/__tests__/credits-bootstrap-grant.test.ts \
    src/lib/__tests__/billing-sync-trial-credits.test.ts \
    src/lib/__tests__/billing-groups.test.ts \
    src/lib/__tests__/entitlements-sql-parity.test.ts \
    src/server/usecases/__tests__/credits-tab.test.ts \
    src/server/usecases/__tests__/billing-group-trial-seat.test.ts \
    src/server/usecases/__tests__/operator-allocation.test.ts
  ```

  Confirm 0 failures. Per `vitest.globalSetup.ts`'s own warning, read the SKIPPED count too — with `DATABASE_URL` set as above every one of these `describe.skipIf(!HAS_DB)` suites should actually RUN, not skip; a suspiciously high skip count here means the env vars above didn't take and the run is a false green.

  `billing-group-trial-seat.test.ts` starts its own `e2e/stripe-fixture-server` on a fixed port (12118) — if run alongside other files in the same vitest invocation and it conflicts, run it in its own invocation instead (as in Task 2 Step 4); either way it must be exercised and green before calling this wave done. `entitlements-sql-parity.test.ts` is included as a sanity cross-check (same UTC-boundary theme as this wave, unrelated code path — confirms this wave didn't destabilize it).

- [ ] **Step 3: Confirm scope notes hold**

  Re-read this plan's "Scope notes" section and confirm: no migration was added, no user-facing string changed (grep the diff for any dictionary/`.tsx` copy edits — there should be none), no help page needed an edit, `scripts/smoke.ts` was correctly left untouched for the reasons stated there.

No commit for this task — verification only, folded into the PR built from Tasks 1-5's commits.
