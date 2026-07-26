# Wave 2: resolver-truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three v17-gap entitlement-resolver defects — a competition write that never busts the entitlement cache (#287), an SQL resolver arm missing that the TS resolver has carried since #206 (#288), and an analytics comparison that can never be true because it compares against strings outside the enum (#289) — each with a regression test that fails without the fix.

**Branch:** `fix/v17gap-w2-resolver-truth` (git worktree — NEVER checkout in main repo dir)
**Issues:** #287 #288 #289
**Depends on:** W1 money-leaks (`fix/v17gap-w1-money-leaks`) — assumed merged before this wave starts, per the sequential wave order. Verified: none of this wave's tasks consume anything W1 produces (W1 touches `usecases/billing-groups.ts` wallet-merge and `usecases/pass-credit.ts` refund-reversal; this wave touches `usecases/competitions.ts`, `lib/entitlements.ts`'s SQL twin, and CI wiring — disjoint files).

**Note on migration numbering:** the design spec's per-wave design section names this migration "V336"; the wave-map table (authoritative, assigned after V336/V337 were reserved for W1) supersedes that with **V338**. This plan uses V338 throughout.

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

**This wave has no i18n/UI/help surface.** All three issues are backend correctness fixes (cache invalidation, an SQL function, and a private analytics comparison) — no new or changed user-facing copy, no new UI, no product-visible behaviour change (the *intended* behaviour — a locked Event Pass, a never-paid sub conveying no plan, an accurate start/complete funnel event — already existed on paper; these tasks make the code actually deliver it, on time and without drift between TS and SQL). Verified by reading every touched file: `usecases/competitions.ts`, `lib/entitlements.ts`'s SQL twin (a migration, not a UI surface), `.github/workflows/ci.yml`, `scripts/smoke.ts`. The Global Constraints' i18n/UI/help rules are therefore inapplicable this wave, and no task below touches those checklists.

---

### Task 1: #287 — `patchCompetition` busts the entitlement cache on write

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts:7` (import), `apps/web/src/server/usecases/competitions.ts:295-306` (invalidation call)
- Create: `apps/web/src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts`

**Interfaces:**
- Consumes: `invalidateOrgEntitlements(orgId: string): Promise<void>` (`apps/web/src/lib/entitlements.ts:30-32`, already exported); `hasFeature(orgId, featureKey, competitionId?): Promise<boolean>` (`entitlements.ts:360-367`); `createCompetition`/`patchCompetition` from `apps/web/src/server/usecases/competitions.ts`; `AuthCtx` from `apps/web/src/server/api-v1/auth.ts:18-27`; `setOrgPlan` from `apps/web/src/lib/__tests__/_billing-group.ts:40`; `incrWindow` from `apps/web/src/lib/cache.ts:96-105` (Redis-readiness warmup, mirrors `apps/web/src/lib/__tests__/rate-limit.redis.test.ts:22-28`).
- Produces: an `invalidateOrgEntitlements` call inside `patchCompetition`, so every later task (2, 3, 4) can rely on a competition PATCH self-invalidating — Task 4 removes a now-redundant manual workaround in `scripts/smoke.ts` on the strength of this.

**Verified facts (read the code, not the audit digest):**
- `apps/web/src/lib/entitlements.ts:21-23` — `ENT_TTL_SECONDS = 300`; cache key `ent:<org>:<feature>` or `ent:<org>:<competition>:<feature>`.
- `apps/web/src/lib/entitlements.ts:304-330` (`resolveFromDb`) — the Event Pass arm reads `competitions.status`/`ends_on` live on every uncached resolve, via `isPassLocked` (`entitlements.ts:149-162`).
- `apps/web/src/server/usecases/competitions.ts` — the function that patches a competition is `patchCompetition` (not `updateCompetition`, which does not exist in this file), at line 212. It calls `invalidateDiscoveryCache()` (line 304, conditional) and `invalidateSlugCache()` (line 309, conditional) but **zero** `invalidateOrgEntitlements` calls anywhere in the file.
- Audited the pass-refund path the brief flagged as a possible second gap — it is **already correct**, no change needed: `recordPassPurchase` (`apps/web/src/lib/billing.ts:801-831`) calls `invalidateOrgEntitlements(args.orgId)` at line 819 on the winning insert; `revokePassForRefundedCharge` (`billing.ts:855-882`) calls it at line 881 after deleting the row. Both are proven (not just asserted) in Task 2.
- `apps/web/src/lib/cache.ts:7-9,52-60,63-80` — the whole cache module is fail-open by construction: `cacheSet`/`cacheDelPattern` swallow every error internally and never throw. `invalidateOrgEntitlements` therefore cannot fail the write it rides on; no extra try/catch is needed at the call site. This satisfies the design spec's "Error handling notes: W2 invalidation is fail-open by design... do not make competition writes fail on Redis errors" with zero new code — it's already how `lib/cache.ts` is built.
- The bug is invisible without a real Redis: `apps/web/src/lib/cache.ts:40-49` — with `REDIS_URL` unset, `client()` returns `null` and `cacheGet` always returns `null` (never a stale hit), so every read goes straight to Postgres. A DB-only test cannot observe this bug at all. That is exactly why `.github/workflows/ci.yml:227-234` scopes `REDIS_URL` to one dedicated step for the rate limiter — Task 3 mirrors that for this suite.

- [ ] **Step 1: Write the failing test**

  Create `apps/web/src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts`:

  ```ts
  // v17 #287: lib/entitlements.ts caches resolved answers under
  // `ent:<org>:<competition>:<feature>` for 300s (ENT_TTL_SECONDS). A
  // competition write that moves status/ends_on — which the Event Pass lock
  // (isPassLocked) reads live off the row on every resolve — must bust that
  // cache in the SAME call, or a warm answer outlives the write for up to 5
  // minutes. The bug is structurally invisible without a real Redis: with
  // REDIS_URL unset, cacheGet always misses and every read hits Postgres
  // fresh (lib/cache.ts), so this suite needs BOTH a real Postgres (usecase
  // seeding) and a real Redis (an actually-warm cache to go stale). Skipped
  // without either. CI runs this in its own step, mirroring
  // rate-limit.redis.test.ts's REDIS_URL scoping (ci.yml).
  import { afterAll, beforeAll, describe, expect, it } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { incrWindow } from "@/lib/cache";
  import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
  import type { AuthCtx } from "@/server/api-v1/auth";
  import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
  import { setOrgPlan } from "./_billing-group";

  const HAS_DB = !!process.env.DATABASE_URL;
  const HAS_REDIS = !!process.env.REDIS_URL;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Community org an Event Pass can lift (`realtime`: community false, pro
   *  true, event_pass true — same probe key entitlements-sql-parity.test.ts
   *  uses, and for the same reason: V310 made `branding` free for community,
   *  so it can no longer show a pass LIFT). */
  export async function seedCommunityOrg(): Promise<AuthCtx> {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`cachebust-${suffix}@test.local`}, 'Cache Bust Owner', true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"Cache Bust " + suffix}, ${"cache-bust-" + suffix}, ${ownerId}) returning id`;
    await setOrgPlan(orgId, "community", "active");
    return { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  }

  describe.skipIf(!HAS_DB || !HAS_REDIS)("entitlement cache invalidation (real Redis)", () => {
    // The client uses enableOfflineQueue:false, so a command fired before the
    // socket is 'ready' rejects (incrWindow returns null). A long-lived server
    // warms the singleton once; here we warm it explicitly before asserting —
    // same pattern as rate-limit.redis.test.ts.
    beforeAll(async () => {
      for (let i = 0; i < 50; i++) {
        if ((await incrWindow(`warmup:${randomUUID()}`, 5)) !== null) return;
        await sleep(100);
      }
      throw new Error("Redis did not become ready");
    });

    afterAll(async () => {
      const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
      const dbClient = globalForDb._sql;
      globalForDb._sql = undefined;
      await dbClient?.end();
      const g = globalThis as unknown as { _redis?: { quit?: () => Promise<unknown> } };
      await g._redis?.quit?.().catch(() => {});
    });

    it("patchCompetition busts the cache the instant a pass-bearing competition locks", async () => {
      const auth = await seedCommunityOrg();
      const comp = await createCompetition(auth, {
        name: `Cache Lock ${randomUUID().slice(0, 6)}`,
        visibility: "private",
        branding: {},
      });
      await sql`insert into competition_passes (competition_id, org_id) values (${comp.id}, ${auth.orgId})`;
      await invalidateOrgEntitlements(auth.orgId);

      // Warm the cache: still 'draft' (isPassLocked's active set), so the
      // pass lifts `realtime`.
      expect(await hasFeature(auth.orgId, "realtime", comp.id)).toBe(true);

      // The write under test — no manual invalidateOrgEntitlements call here,
      // unlike the raw-SQL seeding above. This is what proves the FIX, not
      // just the seed.
      const patched = await patchCompetition(auth, comp.id, { status: "completed" });
      expect(patched.status).toBe("completed");

      // Pre-#287 this reads the 300s-TTL entry warmed above and wrongly stays
      // true for up to 5 minutes even though the competition is now terminal.
      expect(await hasFeature(auth.orgId, "realtime", comp.id)).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `apps/web`, against a migrated local Postgres on :54329 and a local Redis):

  ```bash
  cd apps/web
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
  REDIS_URL="redis://127.0.0.1:6379" \
  npx vitest run src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts
  ```

  Expected: FAIL on the final `expect(...).toBe(false)` — `patchCompetition` never calls `invalidateOrgEntitlements`, so the cache entry warmed a few lines above is still live and `hasFeature` returns the stale `true`.

- [ ] **Step 3: Write minimal implementation**

  In `apps/web/src/server/usecases/competitions.ts`, add `invalidateOrgEntitlements` to the existing entitlements import (line 7):

  ```ts
  import { invalidateOrgEntitlements, requireFeature, withinLimit } from "@/lib/entitlements";
  ```

  Then, inside `patchCompetition`, insert the invalidation call right after the `withTenant` transaction commits and before the existing discovery-cache bust (between the current lines 300 and 301):

  ```ts
    const discoveryTouched =
      before.discoverable !== row.discoverable ||
      (row.discoverable &&
        Boolean(patch.discovery ?? patch.name ?? patch.starts_on ?? patch.ends_on ?? patch.status));
    return { row, discoveryTouched };
  });
  // v17 #287: ANY competition write can move status/ends_on, which the Event
  // Pass lock (isPassLocked) reads live off this row on every resolve — so
  // invalidate broadly (not gated to "did status/ends_on change") rather than
  // reason about which columns matter. Fail-open by construction:
  // invalidateOrgEntitlements -> cacheDelPattern swallows every Redis error
  // internally (lib/cache.ts) and never throws, so this can never fail the
  // write it rides on; the 300s TTL is the last-resort bound if it's ever
  // skipped. Outside the tx, same reasoning as the discovery/slug busts below
  // — invalidation never rolls back a write.
  await invalidateOrgEntitlements(auth.orgId);
  // Toggle-off is immediate (doc 15 §1): drop the Redis window and fire the
  // `discovery` ISR tag. Outside the tx — invalidation never rolls back a write.
  if (discoveryTouched) {
  ```

- [ ] **Step 4: Run test to verify it passes**

  Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/src/server/usecases/competitions.ts apps/web/src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts
  git commit -m "$(cat <<'EOF'
  fix(entitlements): bust cache on competition write (#287)

  patchCompetition never invalidated ent:<org>:*, so a competition write
  that moves status/ends_on (locking an Event Pass) could serve the stale
  answer for up to the 300s TTL. Redis-gated regression test — invisible
  without a real Redis, which is why this shipped unnoticed.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: #287 — audit the pass-grant and pass-refund paths for the same gap

**Files:**
- Modify: `apps/web/src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts` (add two `it()` blocks)

**Interfaces:**
- Consumes: `seedCommunityOrg()` from Task 1 (same file); `recordPassPurchase(args: {orgId, competitionId, paymentIntent?}): Promise<{recorded, duplicateIntent}>` (`apps/web/src/lib/billing.ts:801-831`, unchanged); `revokePassForRefundedCharge(charge: Stripe.Charge): Promise<boolean>` (`billing.ts:855-882`, unchanged).
- Produces: nothing new for later tasks — this is proof, not a code change.

This is **not a bug fix** — both paths were already found correct while reading `lib/billing.ts` in Task 1 (see "Verified facts"). The regression tests here prove that and guard against it drifting later; they are expected to pass on the very first run, with no implementation step.

- [ ] **Step 1: Write the audit tests**

  Append to `apps/web/src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts`, inside the `describe.skipIf(...)` block, after the Task 1 test. Add `recordPassPurchase, revokePassForRefundedCharge` to the imports (`import { recordPassPurchase, revokePassForRefundedCharge } from "@/lib/billing";` and `import type Stripe from "stripe";`):

  ```ts
    it("recordPassPurchase busts the cache the instant the pass is granted", async () => {
      const auth = await seedCommunityOrg();
      const [{ id: compId }] = await sql<{ id: string }[]>`
        insert into competitions (org_id, name, slug)
        values (${auth.orgId}, ${"Grant Cup " + randomUUID().slice(0, 6)},
                ${"grant-cup-" + randomUUID().slice(0, 6)}) returning id`;
      await invalidateOrgEntitlements(auth.orgId);

      // Warm the cache on the pre-purchase (deny) answer.
      expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(false);

      await recordPassPurchase({
        orgId: auth.orgId,
        competitionId: compId,
        paymentIntent: `pi_${randomUUID().slice(0, 8)}`,
      });

      // recordPassPurchase already calls invalidateOrgEntitlements
      // (lib/billing.ts:819) — this proves it, doesn't just assert it.
      expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(true);
    });

    it("revokePassForRefundedCharge busts the cache the instant a refund revokes the pass", async () => {
      const auth = await seedCommunityOrg();
      const [{ id: compId }] = await sql<{ id: string }[]>`
        insert into competitions (org_id, name, slug)
        values (${auth.orgId}, ${"Refund Cup " + randomUUID().slice(0, 6)},
                ${"refund-cup-" + randomUUID().slice(0, 6)}) returning id`;
      const intent = `pi_${randomUUID().slice(0, 8)}`;
      await recordPassPurchase({ orgId: auth.orgId, competitionId: compId, paymentIntent: intent });
      await invalidateOrgEntitlements(auth.orgId);

      // Warm the cache on the granted (true) answer.
      expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(true);

      const charge = { payment_intent: intent, refunded: true } as unknown as Stripe.Charge;
      expect(await revokePassForRefundedCharge(charge)).toBe(true);

      // revokePassForRefundedCharge already calls invalidateOrgEntitlements
      // (lib/billing.ts:881) — this proves it, doesn't just assert it.
      expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(false);
    });
  ```

- [ ] **Step 2: Run test to verify it ALREADY PASSES**

  Same command as Task 1 Step 2. Expected: all three `it()` blocks PASS — no production code changes in this task. A pass here is the audit's actual finding: the grant and refund paths were never the gap; only the plain competition-status PATCH was.

- [ ] **Step 3: (no implementation step — nothing to fix)**

- [ ] **Step 4: (n/a, see Step 2)**

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts
  git commit -m "$(cat <<'EOF'
  test(entitlements): prove pass grant/refund already bust cache (#287)

  Audited recordPassPurchase and revokePassForRefundedCharge per the #287
  ticket's "also check the pass-refund path" — both already call
  invalidateOrgEntitlements. These tests prove it and guard the property
  going forward instead of leaving the audit undocumented.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: #287 — wire the Redis-gated suite into its own CI step

**Files:**
- Modify: `.github/workflows/ci.yml:204-211` (comment), `.github/workflows/ci.yml` (new step after line 234)

**Interfaces:**
- Consumes: `apps/web/src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts` (Tasks 1-2); the smoke job's existing `env:` block (`DATABASE_URL`, `DATABASE_SSL`, etc. — job-level, so it flows into any new step automatically) and the exact `REDIS_URL: redis://localhost:6379` shape the rate-limiter step already uses (`.github/workflows/ci.yml:231-234`).
- Produces: nothing later tasks depend on — this is CI infrastructure, verified by local dry-run rather than a vitest assertion.

**Verified facts:**
- `.github/workflows/ci.yml:124-150` — the `smoke` job's `services:` block runs both a `postgres:16` and a `redis:7` container; `env:` at job level supplies `DATABASE_URL` to every step automatically.
- `.github/workflows/ci.yml:212-213` — the broad `Engine-db + service-layer + lib integration tests` step runs `npm test --workspace apps/web -- run src/server src/lib` with **no** `REDIS_URL` in its step env. Since the new test file is Redis-gated (`describe.skipIf(!HAS_DB || !HAS_REDIS)`), it self-skips there automatically — same mechanism already proven for `rate-limit.redis.test.ts` (comment at lines 210-211).
- `.github/workflows/ci.yml:227-234` — the exact shape to mirror: a `name:`, a `run:` invoking `npm test --workspace apps/web -- run <path>`, and an `env: REDIS_URL: redis://localhost:6379`.

- [ ] **Step 1: Local dry run WITHOUT REDIS_URL (self-skip proof)**

  Run (against a migrated local Postgres; no Redis needed for this check):

  ```bash
  cd apps/web
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
  npx vitest run src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts
  ```

  Expected: 0 failed, 1 skipped (the whole `describe` block skips — `HAS_REDIS` is false). This is the state every non-Redis CI step will see.

- [ ] **Step 2: Local dry run WITH REDIS_URL (real-run proof)**

  ```bash
  cd apps/web
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
  REDIS_URL="redis://127.0.0.1:6379" \
  npx vitest run src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts
  ```

  Expected: 3 passed (Tasks 1-2's tests), 0 skipped, 0 failed.

- [ ] **Step 3: Add the CI step**

  In `.github/workflows/ci.yml`, update the comment at lines 204-211 (append the new file to the existing note):

  ```yaml
      # src/lib is in scope alongside src/server. It used to be excluded, which
      # meant the two suites guarding the Event Pass invariant —
      # entitlements-sql-parity (SQL resolver == TS resolver) and
      # pass-scoping-guard (no enforcement site drops the competition id) —
      # plus every billing-*/entitlements-* DB suite ran in NO job at all: the
      # unit job has no DATABASE_URL, so they skipped there and read as green.
      # rate-limit.redis.test.ts and entitlements-cache-invalidation.redis.test.ts
      # are Redis-gated, so they still self-skip here and execute in the two
      # dedicated steps below, each of which owns REDIS_URL for itself alone.
  ```

  Then insert a new step immediately after the existing "Rate-limiter integration tests" step (after line 234, before the "Live-Stripe integration tests" comment block at line 236):

  ```yaml

        # v17 #287: the counterpart REDIS_URL-scoped step. patchCompetition
        # (and the pass grant/refund paths) must bust ent:<org>:* the instant
        # they write — a cached Event Pass answer must not outlive the write
        # it rode in on. Needs its own step for the same reason as the
        # limiter above: with REDIS_URL unset (the step above's
        # src/server+src/lib run, and any plain local `npm test`), cacheGet
        # always misses and every read hits Postgres fresh (lib/cache.ts) —
        # the bug this suite catches is structurally invisible without a
        # real Redis actually going stale.
        - name: Entitlement cache invalidation tests (real Redis)
          run: npm test --workspace apps/web -- run src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts
          env:
            REDIS_URL: redis://localhost:6379
  ```

- [ ] **Step 4: Verify the YAML is well-formed**

  Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` (or any YAML linter available) — expected: no error. Re-read the diff once more to confirm indentation matches the surrounding `steps:` list (6-space step dashes inside the `smoke` job, same as `Rate-limiter integration tests`).

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/ci.yml
  git commit -m "$(cat <<'EOF'
  ci(smoke): dedicated Redis step for entitlement cache tests (#287)

  Mirrors the rate-limiter step's REDIS_URL scoping — this class of bug
  (a write that forgets to invalidate) is invisible in every other step,
  where REDIS_URL is unset and the cache is inert by design.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: #287 — smoke: lock path on `completed`, drop the now-redundant manual bust

**Files:**
- Modify: `scripts/smoke.ts:1839-1855` (existing `archived`-lock block inside `passGrantsSuite`)

**Interfaces:**
- Consumes: `patchCompetition`'s self-invalidation from Task 1 (this task's whole point is to lean on it and prove it via a real HTTP `PATCH`); existing smoke helpers `grantPass(orgId, competitionId)` (`scripts/smoke.ts:3885-3901`), `mkComp`, `mkDiv`, `entrants`, `featureKey`, `v1`, `check`, `tierOn` (all already in scope inside `passGrantsSuite`, unchanged).
- Produces: nothing later tasks depend on.

**Verified facts — this is the important one:** `scripts/smoke.ts` already has an existing "lock" check inside `passGrantsSuite` (lines 1839-1855) that retires a competition to `archived` via the real `PATCH /api/v1/competitions/:id` route and then calls `await bustOrgEntitlements(s, orgId);` immediately after, with a comment reading *"The status write does NOT invalidate the resolver's (org, competition, feature) cache, so bust it..."* — this is a **pre-existing, explicit workaround for the exact #287 bug**, already landed and already correctly diagnosing the problem in a comment. `bustOrgEntitlements` (`scripts/smoke.ts:7164-7182`) itself documents that it's a no-op when `REDIS_URL` is unset (locally/CI) and only matters "on any Redis-backed target (staging, a prod smoke run)". Once Task 1 lands, this manual call is dead weight and the comment is actively wrong — it must be removed, not just left alone, because leaving it in place would mask a future regression on exactly the staging/prod runs where this bug bites (the manual bust would silently paper over a broken `patchCompetition`). The OTHER two `bustOrgEntitlements` call sites (`scripts/smoke.ts:4114`, `:7255`) sit after **raw SQL** writes (`insertEntitlementOverride`, a plan-flip helper) that genuinely bypass the app and still need the manual bust — those are untouched.

- [ ] **Step 1: Replace the block (remove the workaround, add the `completed` + entrant-cap case)**

  Replace `scripts/smoke.ts:1839-1855` in full:

  ```ts
    // === lock (archived) — a pass stops lifting once its competition is
    // terminal (SPEC-4 §7/§13.5, isPassLocked). Every grant above held while
    // `passComp` ran; retire it to `archived` and the SAME create that a moment
    // ago succeeded under the pass — a tiered sponsor (sponsors.tiers, 201 as
    // passTier) — must now 402. sponsors.tiers is boolean and state-free, so it
    // flips cleanly, where the entrant cap (already at 128) would 402 either
    // way. v17 #287: the status write DOES invalidate the resolver's
    // (org, competition, feature) cache now — patchCompetition busts it inside
    // the same call — so, unlike every raw-SQL write elsewhere in this suite,
    // there is deliberately NO bustOrgEntitlements call below. If that
    // invalidation ever regresses, this 402 goes stale on any Redis-backed
    // target (staging, a prod smoke run) for up to the 300s TTL; locally/CI
    // REDIS_URL is normally unset so the cache is inert and this only proves
    // the resolver logic, not the invalidation itself (see the dedicated
    // Redis-gated suite, entitlements-cache-invalidation.redis.test.ts).
    const retire = await v1(s, `/api/v1/competitions/${passComp.id}`, "PATCH", { status: "archived" });
    check("pass grants/lock: the passed competition retires to archived (200)", retire.status === 200);
    const lockedTier = await tierOn(passComp.id, "locked");
    check(
      "pass grants/lock: once archived the pass no longer lifts sponsors.tiers — the create that held under the pass now 402s",
      lockedTier.status === 402 && featureKey(lockedTier) === "sponsors.tiers",
    );

    // === lock (completed) — the OTHER terminal status (isPassLocked's set is
    // {archived, completed}), on a fresh comp so it's independent of the
    // archived case above. Also proves the pass was genuinely lifting the
    // ENTRANT cap (not just a boolean flag): 65 seats past community's 64
    // while live, then the 66th 402s the instant the completing PATCH commits.
    const lockComp = await mkComp("Grants Lock Completed");
    await grantPass(orgId, lockComp.id);
    const lockDiv = await mkDiv(lockComp.id, "Lock Cap");
    const lockPast64 = await v1(s, `/api/v1/divisions/${lockDiv.id}/entrants`, "POST", entrants(65, 1, "L"));
    check(
      "pass grants/lock(completed): the pass seats 65 — past community's 64 — while the competition is live",
      lockPast64.status === 201,
    );
    const complete = await v1(s, `/api/v1/competitions/${lockComp.id}`, "PATCH", { status: "completed" });
    check("pass grants/lock(completed): the competition completes (200)", complete.status === 200);
    const overCap = await v1(s, `/api/v1/divisions/${lockDiv.id}/entrants`, "POST", entrants(1, 66, "L"));
    check(
      "pass grants/lock(completed): once completed the pass stops lifting entrants.per_division.max — the 66th create 402s with no stale-cache window",
      overCap.status === 402 && featureKey(overCap) === "entrants.per_division.max",
    );
  }
  ```

- [ ] **Step 2: Run to verify it fails on `main` (pre-Task-1 code) and passes on this branch**

  This step is informational only if run on this branch after Task 1 already landed (same branch, sequential tasks) — the `archived` half would already be silently fine even pre-fix (its old code called the manual bust), but the new `completed` half has no such crutch and is the genuine proof. Full local smoke run:

  ```bash
  cd /Users/ashokhein/github/seazn.club
  npm run build --workspace apps/web
  SKIP_TYPECHECK=1 DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
    AUTH_SECRET=ci-only-insecure-secret-please-change-in-prod-0123456789 \
    npm run start --workspace apps/web &
  # wait for http://localhost:3000/api/health, then:
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
    npm run test:smoke
  ```

  Expected: all `pass grants/lock*` checks green, including the two new `pass grants/lock(completed): ...` lines.

- [ ] **Step 3: (implementation already written in Step 1 — TypeScript-only change, no separate minimal-impl step)**

- [ ] **Step 4: (see Step 2's expected result)**

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/smoke.ts
  git commit -m "$(cat <<'EOF'
  test(smoke): pass lock on completed + drop redundant cache bust (#287)

  patchCompetition now busts the entitlement cache itself (Task 1), so the
  manual bustOrgEntitlements call after the archived-lock PATCH was dead
  weight that would mask a real regression on staging/prod smoke runs.
  Removed it, and added the completed-status + entrant-cap case the ticket
  asked for on a fresh competition.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: #288 — V338: `org_has_feature` gains the `incomplete` degrade arm

**Files:**
- Create: `db/migration/deltas/V338__org_has_feature_incomplete_degrade.sql`
- Test: `apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts` (add one `it()`)

**Interfaces:**
- Consumes: the current `org_has_feature` function body, copied forward from `db/migration/deltas/V334__org_has_feature_utc_pass_grace.sql:34-101` (read in full — reproduced verbatim below except the one new arm); `orgPlanKey`'s `incomplete` arm (`apps/web/src/lib/entitlements.ts:237-238`) as the TS side this migration brings SQL into parity with; the existing test helpers `seedOrg`, `sqlHasFeature`, `hasFeature`, `invalidateOrgEntitlements` already defined in `entitlements-sql-parity.test.ts`.
- Produces: `org_has_feature(p_org_id, p_feature_key, p_competition_id)` with the new arm — Task 6 adds a second test case against this same function, unchanged by that task.

**Verified facts:**
- `apps/web/src/lib/entitlements.ts:231-237` (TS, `orgPlanKey`) — `when s.status = 'incomplete' then 'community'`, positioned after the trial_end backstop arm and before the cancelled-subscription arm. Comment there: this closed #206/#223-B, where `incomplete` used to fold into the `past_due` 14-day grace and hand a never-paid subscriber full Pro for ~23h.
- `db/migration/deltas/V334__org_has_feature_utc_pass_grace.sql:41-70` (SQL, `org_has_feature`'s `plan` CTE) — has the suspended-org arm, the comped_until-lapse arm, the past_due 14-day arm, the trial_end backstop arm, and the cancelled-without-comp arm — but **no `incomplete` arm at all**. It falls through to `else coalesce(s.plan_key, 'community')`, i.e. `s.plan_key` verbatim — `'pro'` on a subscription whose first invoice never succeeded. This is read by `public_competitions_v` / `public_entrants_v` / `public_discovery_v` and anything else that calls the SQL function directly (public/embed surfaces), for the ~23h window before Stripe auto-expires the subscription.
- Full audit of "all Stripe sub statuses" (the design decision's actual instruction) against `STATUS_MAP` (`apps/web/src/lib/billing.ts:404-416`, the **one** writer of `subscriptions.status` via `syncSubscriptionForGroup`, `billing.ts:711`): `incomplete_expired` is mapped to our `canceled` and `unpaid` is mapped to our `past_due` **at write time** — neither literal string can ever land in the `status` column. They are not missing arms; they are non-issues, already covered by the existing `canceled` arm (immediate, both resolvers) and the existing `past_due` 14-day-grace arm (both resolvers) respectively. Proven, not just asserted, by two new tests in Task 6. This means the "audit ALL Stripe sub statuses in one pass" decision resolves to exactly **one** new arm, not three — the migration below reflects that finding.

- [ ] **Step 1: Write the failing test**

  In `apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts`, add inside the existing `describe.skipIf(!HAS_DB)("org_has_feature parity with lib/entitlements", ...)` block (before its closing `});` at line 355):

  ```ts
    // v17 #288: SQL org_has_feature was missing the 'incomplete' arm entirely
    // (fell through to coalesce(plan_key)='pro') while entitlements.ts's
    // orgPlanKey has carried it since #206/#223-B — a never-paid first
    // invoice read Pro on every SQL-resolved public surface until Stripe
    // auto-expired the subscription ~23h later. V338 copies the TS arm into
    // SQL verbatim.
    it("degrades an INCOMPLETE subscription (never-paid first invoice) to community", async () => {
      await sql`
        update subscriptions
        set plan_key = 'pro', status = 'incomplete', stripe_subscription_id = 'sub_incomplete'
        where id = (select subscription_id from organizations o where o.id = ${orgId})`;
      await invalidateOrgEntitlements(orgId);
      expect(await hasFeature(orgId, "realtime")).toBe(false);
      expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
    });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd apps/web
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
  npx vitest run src/lib/__tests__/entitlements-sql-parity.test.ts
  ```

  Expected: FAIL on `expect(await sqlHasFeature(orgId, "realtime")).toBe(false)` — SQL still resolves `'pro'` (`realtime`'s pro row is `true`), so `sqlHasFeature` returns `true` against the TS side's `false`. `hasFeature`'s assertion passes on its own (TS already had the arm); only the SQL assertion is red.

- [ ] **Step 3: Write minimal implementation**

  Create `db/migration/deltas/V338__org_has_feature_incomplete_degrade.sql`:

  ```sql
  -- V338 — org_has_feature gains the 'incomplete' degrade arm that
  -- lib/entitlements.ts's orgPlanKey has carried since #206/#223-B, closing
  -- v17 gap #287's SQL sibling (#288).
  --
  -- A subscription whose FIRST invoice never succeeded (an abandoned 3DS
  -- challenge, a declined card at the sheet) lands `status = 'incomplete'` —
  -- still a LIVE Stripe status (LIVE_SUBSCRIPTION_STATUSES), so a second
  -- checkout is blocked, but it must convey NO plan: the org has paid
  -- nothing. TS has resolved this to 'community' since #206/#223-B
  -- (entitlements.ts's orgPlanKey). The SQL resolver never got the arm, so
  -- it fell through to `coalesce(s.plan_key, 'community')` — Pro, on every
  -- public/embed surface the SQL function serves, for up to ~23h until
  -- Stripe auto-expires the subscription. Placed at the SAME position in
  -- the CASE as the TS version: after the trial_end backstop, before the
  -- cancelled-subscription arm (a subscription cannot be both).
  --
  -- Audit note (#288 "audit ALL Stripe sub statuses in one pass"): Stripe's
  -- other two "never really paid" statuses — `unpaid` and
  -- `incomplete_expired` — do NOT need their own arms here, in SQL or in
  -- TS. STATUS_MAP (lib/billing.ts, the ONE writer of subscriptions.status
  -- via syncSubscriptionForGroup) collapses them at write time — `unpaid`
  -- becomes our `past_due` (so it takes the existing 14-day dunning-grace
  -- arm, the same as any other renewal failure) and `incomplete_expired`
  -- becomes our `canceled` (so it takes the existing immediate
  -- canceled-arm, no grace). Neither literal string can ever reach this
  -- function's `s.status` column. Proven in
  -- apps/web/src/lib/__tests__/billing-grace-anchor.test.ts ("#288 audit"
  -- cases) and the suspended-org parity case this migration ships
  -- alongside (apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts).
  --
  -- The body is copied FORWARD from V334 (the current definition). The
  -- ONLY change is the new `when s.status = 'incomplete' then 'community'`
  -- arm. Every other arm — suspended org, comped_until lapse, past_due
  -- grace, trial_end backstop, cancelled-without-comp, the UTC pass-grace
  -- boundary, the override/pass/plan coalesce chain, the false default —
  -- is byte-for-byte V334.
  --
  -- Signature, security-definer and the pinned
  -- `search_path = ${flyway:defaultSchema}, pg_temp` are unchanged.
  -- Replacing the function body carries public_competitions_v /
  -- public_entrants_v / public_discovery_v unchanged — they call the
  -- FUNCTION, so no view is reissued here.

  create or replace function org_has_feature(
    p_org_id uuid,
    p_feature_key text,
    p_competition_id uuid
  ) returns boolean
    language sql stable security definer
    set search_path = ${flyway:defaultSchema}, pg_temp as $$
      with plan as (
        select case
          -- MODERATION, not billing (mirrors entitlements.ts): a suspended ORG
          -- resolves community whatever its group pays for, scoped to that one org
          -- so a moderator cannot degrade siblings that merely share a payer.
          when o.status = 'suspended' then 'community'
          when s.comped_until is not null and s.comped_until <= now()
               and (s.stripe_subscription_id is null
                    or coalesce(s.status, '') not in
                       ('trialing', 'active', 'past_due'))
               then 'community'
          when s.status = 'past_due'
               and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
               then 'community'
          -- Trial-end backstop: a trialing sub whose trial ended over a day ago is a
          -- MISSED transition webhook (Stripe moves trialing→active/past_due/canceled at
          -- trial_end). The resolver stops trusting the stale status, cron-free, the same
          -- way the past_due arm above does. 1-day grace absorbs Stripe's transition lag.
          -- trial_end IS null on a never-trialed sub → guard it so those stay on plan.
          when s.status = 'trialing'
               and s.trial_end is not null
               and s.trial_end <= now() - interval '1 day'
               then 'community'
          -- v17 #287/#288: a never-paid first invoice conveys NO plan (mirrors
          -- entitlements.ts's orgPlanKey — the arm this migration adds). Must NOT
          -- inherit the past_due grace above, which is for a renewal that failed on
          -- a subscription that WAS active; 'incomplete' never was.
          when s.status = 'incomplete' then 'community'
          -- A CANCELLED subscription does not convey its plan (V313). The
          -- comped_at guard keeps an INDEFINITE staff comp alive; a lapsed comp is
          -- already community via the comped_until arm above.
          when s.status = 'canceled' and s.comped_at is null
               then 'community'
          else coalesce(s.plan_key, 'community')
        end as plan_key
        from organizations o
        left join subscriptions s on s.id = o.subscription_id
        where o.id = p_org_id
      )
      select coalesce(
        (select bool_value from org_entitlement_overrides
          where org_id = p_org_id and feature_key = p_feature_key
            and (expires_at is null or expires_at > now())),
        -- Event Pass: community orgs only, competition in scope. A key absent from
        -- the pass matrix falls through to the plan row rather than denying. v17
        -- SPEC-4 §7: the pass stops applying once its competition is archived or
        -- long-ended (mirrors isPassLocked in lib/entitlements.ts). The grace
        -- boundary is the UTC calendar date (V334), matching isPassLocked's
        -- Date.UTC(getUTC*) — NOT the session-TZ `current_date`.
        (select pe.bool_value
           from competition_passes cp
           join competitions c on c.id = cp.competition_id
           join plan_entitlements pe
             on pe.plan_key = cp.pass_key and pe.feature_key = p_feature_key
          where p_competition_id is not null
            and cp.competition_id = p_competition_id
            and cp.org_id = p_org_id
            and (select plan_key from plan) = 'community'
            and not (c.status in ('archived', 'completed')
                     or (c.ends_on is not null
                         and c.ends_on + interval '7 days' < (now() at time zone 'utc')::date))),
        (select pe.bool_value from plan_entitlements pe
          where pe.feature_key = p_feature_key
            and pe.plan_key = (select plan_key from plan)),
        false)
    $$;
  ```

  Apply it:

  ```bash
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
  npm run db:apply
  ```

- [ ] **Step 4: Run test to verify it passes**

  Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add db/migration/deltas/V338__org_has_feature_incomplete_degrade.sql apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts
  git commit -m "$(cat <<'EOF'
  fix(entitlements): V338 — org_has_feature degrades incomplete (#288)

  SQL was missing the 'incomplete' arm the TS resolver has carried since
  #206/#223-B — a never-paid first invoice read Pro on every SQL-resolved
  public surface. Copies V334 forward with the one arm TS already has;
  audited all other Stripe sub statuses (unpaid, incomplete_expired) and
  confirmed they never reach subscriptions.status as those literal
  strings (STATUS_MAP collapses them), so no other arm is needed.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: #288 — coverage: suspended-org parity case + STATUS_MAP audit tests

**Files:**
- Modify: `apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts` (add one `it()`)
- Modify: `apps/web/src/lib/__tests__/billing-grace-anchor.test.ts` (add two `it()`s)

**Interfaces:**
- Consumes: `org_has_feature` from Task 5 (unchanged by this task — the suspended-org arm already existed before V338, in both resolvers); `syncSubscription(orgId, stripeSub): Promise<void>` (`apps/web/src/lib/billing.ts:687-689`) and the `stripeSub`/`readAnchor` helpers already defined in `billing-grace-anchor.test.ts:29-63`; `orgPlanKey(orgId): Promise<string>` (`apps/web/src/lib/entitlements.ts:182-273`, already imported in that file).
- Produces: nothing later tasks depend on — pure coverage.

Both cases here are **coverage additions, not regressions** — every assertion already passes on `main` (pre-V338) as well as on this branch. They exist because the design spec explicitly asked for "incomplete sub + suspended org" parity cases and an "audit ALL Stripe sub statuses in one pass"; the suspended-org arm and the STATUS_MAP collapse were both already correct but had zero test coverage proving it — this task closes that gap so a future change to either trips a test instead of shipping silently.

- [ ] **Step 1: Write the tests**

  In `apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts`, add inside the same `describe.skipIf(!HAS_DB)(...)` block, after Task 5's `it()`:

  ```ts
    // Coverage addition, not a regression: both resolvers already agreed a
    // suspended ORG resolves community regardless of its subscription's plan
    // (entitlements.ts:209, org_has_feature's first CASE arm) — this suite
    // never had a case proving it. Passes before AND after V338; it is here
    // so a future change to either arm trips this suite instead of shipping
    // silently.
    it("keeps a SUSPENDED org on community regardless of its subscription's plan", async () => {
      await sql`
        update subscriptions
        set plan_key = 'pro', status = 'active', stripe_subscription_id = 'sub_susp'
        where id = (select subscription_id from organizations o where o.id = ${orgId})`;
      await sql`update organizations set status = 'suspended' where id = ${orgId}`;
      await invalidateOrgEntitlements(orgId);
      expect(await hasFeature(orgId, "realtime")).toBe(false);
      expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
    });
  ```

  In `apps/web/src/lib/__tests__/billing-grace-anchor.test.ts`, add two `it()`s at the end of the existing `describe.skipIf(!HAS_DB)("incomplete never-paid grace hole (#206)", ...)` block (after the `"syncSubscription writes Stripe \`incomplete\` as our incomplete, not past_due"` test, before the block's closing `});` at line 169):

  ```ts
    it("syncSubscription writes Stripe 'unpaid' as our past_due — never a literal 'unpaid' row (#288 audit)", async () => {
      const orgId = await seedOrg();
      const subId = `sub_unpaid_${randomUUID().slice(0, 8)}`;
      await syncSubscription(orgId, stripeSub({ id: subId, status: "unpaid" }));
      // STATUS_MAP (lib/billing.ts) collapses 'unpaid' into 'past_due' at
      // write time — the resolver's existing past_due 14-day grace arm
      // degrades it, exactly like any other dunning failure. Neither
      // resolver needs its own 'unpaid' arm because the literal string
      // never reaches subscriptions.status.
      expect((await readAnchor(orgId)).status).toBe("past_due");
    });

    it("syncSubscription writes Stripe 'incomplete_expired' as our canceled — degrades immediately, no grace (#288 audit)", async () => {
      const orgId = await seedOrg();
      const subId = `sub_ie_${randomUUID().slice(0, 8)}`;
      await sql`update subscriptions set plan_key = 'pro'
                where id = (select subscription_id from organizations where id = ${orgId})`;
      await syncSubscription(orgId, stripeSub({ id: subId, status: "incomplete_expired" }));
      const row = await readAnchor(orgId);
      expect(row.status).toBe("canceled");
      // canceled + comped_at null is the immediate-degrade arm (no 14-day
      // grace) in BOTH resolvers — unlike past_due above. Proves the
      // DEGRADE from a paid-looking row, not just that plan_key already
      // happened to read community.
      expect(await orgPlanKey(orgId)).toBe("community");
    });
  ```

- [ ] **Step 2: Run tests to verify they pass**

  ```bash
  cd apps/web
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_smoke" DATABASE_SSL=disable \
  npx vitest run src/lib/__tests__/entitlements-sql-parity.test.ts src/lib/__tests__/billing-grace-anchor.test.ts
  ```

  Expected: PASS, all three new cases green on the first run (no implementation step needed — confirms the audit's finding).

- [ ] **Step 3: (no implementation step — coverage only)**

- [ ] **Step 4: (see Step 2)**

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts apps/web/src/lib/__tests__/billing-grace-anchor.test.ts
  git commit -m "$(cat <<'EOF'
  test(entitlements): suspended-org parity + STATUS_MAP audit (#288)

  Coverage, not a regression: proves the suspended-org arm already agreed
  between TS and SQL, and that Stripe's 'unpaid'/'incomplete_expired'
  never reach subscriptions.status as those literal strings (STATUS_MAP
  collapses them to past_due/canceled at write time) — closing out the
  "audit all Stripe sub statuses" part of #288 with evidence.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 7: #289 — `statusChangedTo` compares real enum values, typed to reject the rest

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts:9,12,194-199,226,310-319` (see exact hunks below)
- Create: `apps/web/src/server/usecases/__tests__/competition-lifecycle-event.test.ts`

**Interfaces:**
- Consumes: `CompetitionStatus` zod enum (`apps/web/src/server/api-v1/schemas.ts:20` — `z.enum(["draft", "published", "live", "completed", "archived"])`); `EVENTS.COMPETITION_STARTED` / `EVENTS.COMPETITION_COMPLETED` / `AnalyticsEvent` type (`apps/web/src/lib/analytics-events.ts:24,26,70`).
- Produces: `competitionLifecycleEvent(statusChangedTo: z.infer<typeof CompetitionStatus> | null): AnalyticsEvent | null` — a new named export from `competitions.ts`, mirroring the existing `shouldFireMadePublic` export (line 194) both in shape and in how it's unit-tested (see `apps/web/src/server/usecases/__tests__/competition-made-public.test.ts`, the exact precedent this task's test file follows).

**Verified facts:**
- `apps/web/src/server/api-v1/schemas.ts:20` — `export const CompetitionStatus = z.enum(["draft", "published", "live", "completed", "archived"]);`. `"active"` and `"complete"` are not, and can never be, members of this type.
- `apps/web/src/server/usecases/competitions.ts:226` — `let statusChangedTo: string | null = null;` (untyped against the enum — this is *why* tsc never caught the bug).
- `apps/web/src/server/usecases/competitions.ts:203-210` (`isRetirePatch`) — the CORRECT sibling comparison a few lines above the bug: `patch.status === "completed" || patch.status === "archived"`, using real enum members. The bug at lines 312-314 is the ONLY place in this file comparing against the wrong literals.
- `apps/web/src/server/usecases/competitions.ts:310-319` (current, buggy):
  ```ts
    // Lifecycle events (feature 1): tournament start/finish. `active` = play is on;
    // `complete` = it's wrapped up.
    if (statusChangedTo === "active" || statusChangedTo === "complete") {
      await captureServer({
        event: statusChangedTo === "active" ? EVENTS.COMPETITION_STARTED : EVENTS.COMPETITION_COMPLETED,
        distinctId: auth.userId ?? `org:${auth.orgId}`,
        orgId: auth.orgId,
        properties: { competition_id: id },
      });
    }
  ```
  `statusChangedTo` can only ever hold a `CompetitionStatus` member (it's assigned from `patch.status`, line 243). Comparing it to `"active"`/`"complete"` is comparing against strings the variable can never equal — the condition is always `false`, so `COMPETITION_STARTED`/`COMPETITION_COMPLETED` have never fired. The design's engineering default: `live` = started, `completed` = finished, and **`published` does NOT count as started** (a competition can sit published for weeks before its first fixture).

- [ ] **Step 1: Write the failing test**

  Create `apps/web/src/server/usecases/__tests__/competition-lifecycle-event.test.ts` (mirrors `competition-made-public.test.ts` in the same directory — a pure decision-helper test, no DB):

  ```ts
  import { describe, expect, it } from "vitest";
  import { EVENTS } from "@/lib/analytics-events";
  import { competitionLifecycleEvent } from "../competitions";

  // v17 #289: `statusChangedTo === "active" || statusChangedTo === "complete"`
  // compared against CompetitionStatus values that never exist — "live" and
  // "completed" are the real enum members (schemas.ts's CompetitionStatus) —
  // so COMPETITION_STARTED/COMPETITION_COMPLETED never fired. Pure decision
  // helper, mirrors shouldFireMadePublic — no DB needed.
  describe("competitionLifecycleEvent", () => {
    it("fires COMPETITION_STARTED on the transition to live", () => {
      expect(competitionLifecycleEvent("live")).toBe(EVENTS.COMPETITION_STARTED);
    });

    it("fires COMPETITION_COMPLETED on the transition to completed", () => {
      expect(competitionLifecycleEvent("completed")).toBe(EVENTS.COMPETITION_COMPLETED);
    });

    it("does NOT fire on a transition to published — published is not started", () => {
      expect(competitionLifecycleEvent("published")).toBeNull();
    });

    it("does not fire on a transition to draft or archived", () => {
      expect(competitionLifecycleEvent("draft")).toBeNull();
      expect(competitionLifecycleEvent("archived")).toBeNull();
    });

    it("does not fire when the status did not change (null — no transition)", () => {
      expect(competitionLifecycleEvent(null)).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd apps/web
  npx vitest run src/server/usecases/__tests__/competition-lifecycle-event.test.ts
  ```

  Expected: FAIL — `competitionLifecycleEvent` does not exist yet (`../competitions` has no such export); the import itself errors.

- [ ] **Step 3: Write minimal implementation**

  In `apps/web/src/server/usecases/competitions.ts`:

  Add `zod` and update the `analytics-events`/`schemas` imports (lines 9 and 12 in the current file — leave line 7, touched by Task 1, untouched):

  ```ts
  import { z } from "zod";
  ```

  (add this as a new import line right after `import "server-only";` and its doc-comment block, before `import { withTenant } from "@/lib/db";`)

  ```ts
  import { EVENTS, type AnalyticsEvent } from "@/lib/analytics-events";
  ```

  (replaces the current `import { EVENTS } from "@/lib/analytics-events";`)

  ```ts
  import { CompetitionStatus, type CreateCompetition, type PatchCompetition } from "@/server/api-v1/schemas";
  ```

  (replaces the current `import type { CreateCompetition, PatchCompetition } from "@/server/api-v1/schemas";`)

  Add the pure helper right after `shouldFireMadePublic` (after the current lines 194-199, before the `isRetirePatch` comment at line 201):

  ```ts
  /** v17 #289: `live` = play started; `completed` = wrapped up. `published`
   *  does NOT count as started — a competition can sit published for weeks
   *  before its first fixture. Pure like shouldFireMadePublic above, and
   *  typed on the zod enum (not `string`) so a typo'd literal fails tsc
   *  instead of silently comparing false forever — exactly how the
   *  pre-#289 bug shipped: `statusChangedTo === "active"` compared against
   *  values that could never equal any CompetitionStatus member. */
  export function competitionLifecycleEvent(
    statusChangedTo: z.infer<typeof CompetitionStatus> | null,
  ): AnalyticsEvent | null {
    if (statusChangedTo === "live") return EVENTS.COMPETITION_STARTED;
    if (statusChangedTo === "completed") return EVENTS.COMPETITION_COMPLETED;
    return null;
  }
  ```

  Narrow the variable's type (current line 226):

  ```ts
  let statusChangedTo: z.infer<typeof CompetitionStatus> | null = null;
  ```

  Replace the buggy comparison block (current lines 310-319):

  ```ts
    // Lifecycle events (feature 1): tournament start/finish. Pure helper so
    // the rule is unit-tested without a DB (mirrors shouldFireMadePublic).
    const lifecycleEvent = competitionLifecycleEvent(statusChangedTo);
    if (lifecycleEvent) {
      await captureServer({
        event: lifecycleEvent,
        distinctId: auth.userId ?? `org:${auth.orgId}`,
        orgId: auth.orgId,
        properties: { competition_id: id },
      });
    }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Same command as Step 2. Expected: PASS, all five cases.

  Also run `tsc` to confirm the narrowed type compiles clean and that `patch.status` (assigned into `statusChangedTo` at line 243, unchanged by this task) is still assignable:

  ```bash
  cd apps/web && npm run typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/src/server/usecases/competitions.ts apps/web/src/server/usecases/__tests__/competition-lifecycle-event.test.ts
  git commit -m "$(cat <<'EOF'
  fix(competitions): lifecycle event compares real statuses (#289)

  statusChangedTo === "active" | "complete" compared against strings
  outside CompetitionStatus — always false, so COMPETITION_STARTED/
  COMPETITION_COMPLETED never fired. Extracted a pure
  competitionLifecycleEvent helper (mirrors shouldFireMadePublic),
  compares "live"/"completed", and narrows statusChangedTo's type to the
  zod enum so a bogus literal fails tsc instead of shipping silent.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Wave-closing checklist

- [ ] `npm run typecheck --workspace apps/web` clean.
- [ ] `npm test --workspace apps/web` clean (non-Redis, non-DB unit suite; DB-gated suites skip locally without `DATABASE_URL`, same as CI's `test` job).
- [ ] Full DB-gated run green: `DATABASE_URL=... DATABASE_SSL=disable npx vitest run src/server src/lib src/app` from `apps/web`.
- [ ] Redis-gated run green: same DATABASE_URL plus `REDIS_URL=redis://127.0.0.1:6379 npx vitest run src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts src/lib/__tests__/rate-limit.redis.test.ts`.
- [ ] `npm run db:info` shows V338 applied on top of V337 (W1) with no gaps.
- [ ] Full local smoke (`npm run test:smoke` against a `next start` prod build) green, including the new `pass grants/lock(completed): ...` checks.
- [ ] `/code-review` on the branch before opening the PR (per Global Constraints — smoke CI only runs on PRs, so this and the manual smoke run above are the gate before merge).
- [ ] Merge via PR (never push straight to `main` for a wave branch).
