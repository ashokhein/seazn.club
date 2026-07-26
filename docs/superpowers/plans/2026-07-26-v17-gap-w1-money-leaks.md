# Wave 1: money-leaks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AI-credit-wallet balance being stranded when an org attaches to a billing group (#285), and stop an indeterminate Event Pass refund reversal from silently freeing the group's one-lifetime-credit cap (#286).
**Branch:** `fix/v17gap-w1-money-leaks` (git worktree — NEVER checkout in main repo dir)
**Issues:** #285 #286
**Depends on:** None — W1 is the first wave in the sequence (`docs/superpowers/specs/2026-07-26-v17-gap-remediation-design.md`, Wave order table).

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

## Wave-specific notes

- **No UI, no new user-facing strings.** Both #285 and #286 are backend money-safety fixes — no route contracts, no new HTTP response shapes, no new copy. The UI/i18n/375px rules above have nothing to apply to in this wave; the only content change is one paragraph in `apps/web/content/help/billing/credits.md` (Task 5), English-only (this repo's help content has no locale subtree — see `apps/web/content/help/`).
- **BILLING_LIVE relevance, checked up front:**
  - #285 (`mergeWalletOnAttach`) is pure-DB — no Stripe call of any kind. `attachOrgToGroup`'s only Stripe interaction (the subscription quantity sync) is untouched by this wave. No `billing-group*.live.test.ts` file exists today and none is needed.
  - #286 touches `reversePassCreditOnRefund`, which already has a live counterpart, `apps/web/src/server/usecases/__tests__/pass-credit-refund-reversal.live.test.ts`. The fix adds a DB column and widens a SQL predicate; it does not change any Stripe call shape or the "safe" (non-`unsafe`) reversal arithmetic that live test exercises. Task 7 runs it to confirm.

---

### Task 1: `mergeWalletOnAttach` — the wallet-merge primitive

**Files:**
- Create: `db/migration/deltas/V336__ai_credit_ledger_group_merge_source.sql`
- Modify: `apps/web/src/lib/credits.ts` (insert after `recordPackRefund`, which ends at line 773, before the `spentThisPeriodByOrg` doc comment at line 775)
- Test: `apps/web/src/lib/__tests__/credits-wallet-merge.test.ts` (new file)

**Interfaces:**
- Consumes: `appendLedgerRow` (credits.ts:152), `bucketBalance` (credits.ts:96), `balance`/`grantBalance`/`packBalance` (credits.ts:77/109/117) — all existing, same-file/exported helpers. `type Tx = postgres.TransactionSql` (credits.ts:19, unexported but structurally compatible with any `postgres.TransactionSql` a caller passes — same pattern `grantTrialForRow(tx: Tx, ...)` already uses across the `lib/billing.ts` boundary, credits.ts:391).
- Produces: `export async function mergeWalletOnAttach(tx: Tx, oldWalletId: string, newWalletId: string): Promise<{ grant: number; pack: number }>` — consumed by Task 2.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/credits-wallet-merge.test.ts`:

```ts
// AI credit wallet — merging a departing wallet into the group it joins
// (v17 gap #285, docs/superpowers/specs/2026-07-26-v17-gap-remediation-design.md
// §W1). attachOrgToGroup (server/usecases/billing-groups.ts) rewrites
// organizations.subscription_id with NO wallet merge: the org's own AI
// credit balance sat on ai_credit_ledger keyed to its OLD subscription id,
// and once that row is gone (dropEmptyGroup) nothing can ever resolve to it
// again — walletIdFor only ever returns coalesce(subscription_id, id), and
// the org's subscription_id now points at the group. mergeWalletOnAttach is
// the fix: two compensating ledger rows per non-zero bucket, written inside
// the SAME transaction that moves the org (Task 2), so the balance and the
// move commit or roll back together.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, grantBalance, mergeWalletOnAttach, packBalance } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;

/** Seed a wallet with a grant-bucket and/or pack-bucket balance via raw
 *  ledger rows, cumulative balance_after — mirrors credits-earn.test.ts's
 *  seedEarned (apps/web/src/lib/__tests__/credits-earn.test.ts:41). */
async function seedWallet(walletId: string, opts: { grant?: number; pack?: number }): Promise<void> {
  let running = 0;
  if (opts.grant) {
    running += opts.grant;
    await sql`insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, ${opts.grant}, 'monthly_grant', 'grant', ${running}, ${`seed-${randomUUID()}`})`;
  }
  if (opts.pack) {
    running += opts.pack;
    await sql`insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, ${opts.pack}, 'pack_purchase', 'pack', ${running}, ${`seed-${randomUUID()}`})`;
  }
}

describe.skipIf(!HAS_DB)("mergeWalletOnAttach (#285)", () => {
  it("moves BOTH buckets from the old wallet to the new one, bucket-preserving", async () => {
    const oldWallet = randomUUID();
    const newWallet = randomUUID();
    await seedWallet(oldWallet, { grant: 15, pack: 30 });
    await seedWallet(newWallet, { grant: 5 });

    const moved = await sql.begin((tx) => mergeWalletOnAttach(tx, oldWallet, newWallet));

    expect(moved).toEqual({ grant: 15, pack: 30 });
    // The old wallet is fully drained — nothing left stranded.
    expect(await balance(oldWallet)).toBe(0);
    // Landed in the SAME bucket it came from — never pooled into one row.
    expect(await grantBalance(newWallet)).toBe(20); // 5 (already there) + 15 (merged)
    expect(await packBalance(newWallet)).toBe(30); // the new wallet had no pack credits yet
  });

  it("is a no-op when the old wallet is empty", async () => {
    const oldWallet = randomUUID();
    const newWallet = randomUUID();
    await seedWallet(newWallet, { grant: 10 });

    const moved = await sql.begin((tx) => mergeWalletOnAttach(tx, oldWallet, newWallet));

    expect(moved).toEqual({ grant: 0, pack: 0 });
    expect(await balance(newWallet)).toBe(10); // untouched
    const rows = await sql`select 1 from ai_credit_ledger where wallet_id = ${oldWallet}`;
    expect(rows).toHaveLength(0); // no rows written for an empty wallet
  });

  it("compensating rows net to ZERO per bucket, for any starting balances (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ grant: fc.integer({ min: 0, max: 500 }), pack: fc.integer({ min: 0, max: 500 }) }),
        fc.record({ grant: fc.integer({ min: 0, max: 500 }), pack: fc.integer({ min: 0, max: 500 }) }),
        async (oldBal, newBal) => {
          const oldWallet = randomUUID();
          const newWallet = randomUUID();
          await seedWallet(oldWallet, oldBal);
          await seedWallet(newWallet, newBal);

          await sql.begin((tx) => mergeWalletOnAttach(tx, oldWallet, newWallet));

          expect(await balance(oldWallet)).toBe(0);
          expect(await grantBalance(newWallet)).toBe(oldBal.grant + newBal.grant);
          expect(await packBalance(newWallet)).toBe(oldBal.pack + newBal.pack);

          // The actual property: every group_merge row this call wrote nets
          // to zero PER BUCKET across the (old, new) pair — money moved,
          // none created or destroyed.
          const rows = await sql<{ bucket: string; net: string }[]>`
            select bucket, sum(delta)::text as net from ai_credit_ledger
             where source = 'group_merge' and wallet_id in (${oldWallet}, ${newWallet})
             group by bucket`;
          for (const row of rows) expect(Number(row.net)).toBe(0);
        },
      ),
      { numRuns: 15 },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`, with `DATABASE_URL` pointed at the local test PG):
```
npx vitest run src/lib/__tests__/credits-wallet-merge.test.ts
```
Expected: FAIL at compile/collection time — `"@/lib/credits"` has no exported member `mergeWalletOnAttach` (TS2305/module resolution error), since neither the function nor the `group_merge` source value exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `db/migration/deltas/V336__ai_credit_ledger_group_merge_source.sql`:

```sql
-- V336 — allow a `group_merge` source on the AI credit wallet ledger (#285,
-- docs/superpowers/specs/2026-07-26-v17-gap-remediation-design.md §W1).
--
-- attachOrgToGroup (server/usecases/billing-groups.ts) rewrites
-- `organizations.subscription_id` with NO wallet merge: the org's own AI
-- credit balance stays on `ai_credit_ledger` keyed to its OLD subscription
-- id. `walletIdFor` (lib/credits.ts) only ever resolves
-- `coalesce(subscription_id, id)` for a LIVE organizations row, so once the
-- org's subscription_id points at the group, nothing can ever address the
-- old wallet again — and if that old subscription was a bare community-of-
-- one, `dropEmptyGroup` deletes the row outright the moment the attach
-- commits (`ai_credit_ledger.wallet_id` carries no foreign key, so the
-- balance survives as an orphaned row rather than cascading away).
--
-- `mergeWalletOnAttach` (lib/credits.ts) is the fix: two compensating rows
-- per non-zero bucket (grant and pack tracked independently, V321), written
-- INSIDE attachOrgToGroup's own transaction so the org move and the wallet
-- merge commit or roll back together. `group_merge` is the new provenance
-- those rows carry, so they are attributable in the wallet run history/admin
-- adjustments log alongside monthly_grant, trial_grant, pack_purchase,
-- earn_grant and pass_grant.
--
-- Same drop-if-exists + re-add shape as V326/V330/V331; Flyway runs
-- -defaultSchema=seazn_club.
alter table ai_credit_ledger
  drop constraint if exists ai_credit_ledger_source_check;

alter table ai_credit_ledger
  add constraint ai_credit_ledger_source_check
    check (source in ('monthly_grant', 'trial_grant', 'pack_purchase',
                      'run_spend', 'refund', 'expiry', 'admin_adjust',
                      'earn_grant', 'pass_grant', 'group_merge'));
```

In `apps/web/src/lib/credits.ts`, insert immediately after `recordPackRefund` (the function ends at line 773) and before the `spentThisPeriodByOrg` doc comment (line 775):

```ts
/**
 * Merge one wallet's balance into another (#285): called INSIDE
 * attachOrgToGroup's own transaction, immediately after
 * `organizations.subscription_id` is rewritten, so the credit balance the
 * departing wallet held moves atomically with the org — otherwise it is
 * stranded on a subscription id nothing points at any more (and
 * dropEmptyGroup can delete the row outright).
 *
 * Bucket-preserving (SPEC-2 §5.4 / V321): each non-zero bucket gets its OWN
 * pair of compensating rows — a debit on `oldWalletId`, a credit on
 * `newWalletId` — so a grant-bucket balance lands back in `grant` and a
 * pack-bucket balance lands back in `pack`, never pooled into one row.
 * `recordEarnGrant`'s `LIFETIME_EARN_CAP` sums `source = 'earn_grant'` rows
 * only (credits.ts:592-596) — a `group_merge` row never carries that source,
 * so merged earn credits do NOT retroactively count against the new wallet's
 * earn cap (decided default).
 *
 * **Locks both wallets, sorted, to avoid deadlock:** unlike every other write
 * in this module (one wallet, one lock), this touches two wallets in the
 * same transaction. Taking the locks in a fixed (lexicographic) order
 * regardless of which one is "old" or "new" is what stops two concurrent
 * attaches whose old/new pairs share a wallet from deadlocking each other.
 *
 * Transaction-atomic, not idempotency-keyed: this only ever runs once per
 * successful attach, inside the SAME transaction that rewrites
 * `organizations.subscription_id` — if anything later in that transaction
 * fails, the whole thing (org move + merge) rolls back together, and a
 * caller retrying `attachOrgToGroup` for the same org+group sees it already
 * moved and skips the merge entirely (attachOrgToGroup's own idempotency
 * guard, billing-groups.ts:654).
 *
 * Returns the credits moved per bucket (0/0 when the old wallet was empty —
 * the common case for an org that never spun up any AI runs).
 */
export async function mergeWalletOnAttach(
  tx: Tx,
  oldWalletId: string,
  newWalletId: string,
): Promise<{ grant: number; pack: number }> {
  if (oldWalletId === newWalletId) return { grant: 0, pack: 0 };
  const [lo, hi] = [oldWalletId, newWalletId].sort();
  await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + lo}))`;
  await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + hi}))`;

  const moved = { grant: 0, pack: 0 };
  for (const bucket of ["grant", "pack"] as const) {
    const amount = Math.max(0, await bucketBalance(tx, oldWalletId, bucket));
    if (amount <= 0) continue;
    await appendLedgerRow(tx, {
      walletId: oldWalletId,
      delta: -amount,
      source: "group_merge",
      bucket,
      ref: newWalletId,
      idempotencyKey: null,
    });
    await appendLedgerRow(tx, {
      walletId: newWalletId,
      delta: amount,
      source: "group_merge",
      bucket,
      ref: oldWalletId,
      idempotencyKey: null,
    });
    moved[bucket] = amount;
  }
  return moved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Apply the migration to the local test DB, then rerun:
```
npm run db:apply
npx vitest run src/lib/__tests__/credits-wallet-merge.test.ts
```
Expected: PASS — 3/3.

- [ ] **Step 5: Commit**
```
git add db/migration/deltas/V336__ai_credit_ledger_group_merge_source.sql apps/web/src/lib/credits.ts apps/web/src/lib/__tests__/credits-wallet-merge.test.ts
git commit -m "$(cat <<'EOF'
feat(credits): merge a wallet's balance on attach (#285)

attachOrgToGroup rewrote organizations.subscription_id with no wallet
merge, stranding whatever AI credits the joining org's own wallet held
on a subscription id nothing can ever resolve to again. mergeWalletOnAttach
is the primitive; wiring it into attachOrgToGroup is the next commit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the merge into `attachOrgToGroup`

**Files:**
- Modify: `apps/web/src/server/usecases/billing-groups.ts:22` (new import), `:699-700` (call site)
- Test: `apps/web/src/server/usecases/__tests__/billing-group-move.test.ts` (new `it` inside the existing `describe.skipIf(!HAS_DB)("attach", ...)` block)

**Interfaces:**
- Consumes: `mergeWalletOnAttach` (Task 1, `@/lib/credits`); existing test helpers `makeUser` (billing-group-move.test.ts:190), `makeGroup` (:211), `makeOrg` (:236), `makeLooseOrg` (:246).
- Produces: `attachOrgToGroup` now merges wallets — no new exported symbol, a behaviour change on the existing `AttachResult` return (unchanged shape).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/billing-group-move.test.ts`, inside the `describe.skipIf(!HAS_DB)("attach", ...)` block (after the existing "is idempotent" test, before the "lets an org join a TRIALING group" test):

```ts
  it("merges the joining org's own wallet balance into the group's, bucket-preserving (#285)", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer, { stripeSubId: "sub_wallet_" + uniq(), quantityPaid: 1 });
    await makeOrg(group, payer);
    // The group's own wallet already holds some credits.
    await sql`insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${group}, 20, 'monthly_grant', 'grant', 20, ${"seed-" + uniq()})`;

    const joiner = await makeLooseOrg(payer);
    // The joining org's OWN solo wallet (its subscription-of-one) holds
    // credits of its own, in BOTH buckets.
    await sql`insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${joiner.subId}, 15, 'monthly_grant', 'grant', 15, ${"seed-" + uniq()})`;
    await sql`insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${joiner.subId}, 30, 'pack_purchase', 'pack', 45, ${"seed-" + uniq()})`;

    await attachOrgToGroup({ actorUserId: payer, orgId: joiner.orgId, subscriptionId: group });

    // The old wallet (the joiner's solo subscription) is fully drained.
    const [oldBal] = await sql<{ bal: string }[]>`
      select coalesce(sum(delta),0)::text as bal from ai_credit_ledger where wallet_id = ${joiner.subId}`;
    expect(Number(oldBal.bal)).toBe(0);

    // The group's wallet now holds BOTH balances, each in its own bucket.
    const [grantBal] = await sql<{ bal: string }[]>`
      select coalesce(sum(delta),0)::text as bal from ai_credit_ledger
       where wallet_id = ${group} and bucket = 'grant'`;
    const [packBal] = await sql<{ bal: string }[]>`
      select coalesce(sum(delta),0)::text as bal from ai_credit_ledger
       where wallet_id = ${group} and bucket = 'pack'`;
    expect(Number(grantBal.bal)).toBe(35); // 20 (group's own) + 15 (joiner's)
    expect(Number(packBal.bal)).toBe(30); // joiner's pack, nothing pooled from grant
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/server/usecases/__tests__/billing-group-move.test.ts -t "merges the joining org's own wallet balance"
```
Expected: FAIL — `oldBal` is 45 (nothing drained), `grantBal`/`packBal` on the group wallet are still 20/0 (nothing merged in): `attachOrgToGroup` never touched `ai_credit_ledger`.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/server/usecases/billing-groups.ts`, add the import before line 22's existing entitlements import:

```ts
import { mergeWalletOnAttach } from "@/lib/credits";
```

Then change the end of the transaction body (currently lines 699-700):

```ts
    await tx`update organizations set subscription_id = ${subscriptionId} where id = ${orgId}`;
    return { from: org.subscription_id, moved: true };
```

to:

```ts
    await tx`update organizations set subscription_id = ${subscriptionId} where id = ${orgId}`;
    // #285: merge whatever AI credits the org's OWN wallet held into the
    // group's, in the SAME transaction as the move — org.subscription_id
    // here is still the PRE-move value (read at the top of this function,
    // before the UPDATE above), i.e. the wallet the org is leaving.
    const oldWalletId = org.subscription_id ?? orgId;
    await mergeWalletOnAttach(tx, oldWalletId, subscriptionId);
    return { from: org.subscription_id, moved: true };
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/server/usecases/__tests__/billing-group-move.test.ts
```
Expected: PASS — the whole file (this new test plus every pre-existing `attach`/`detach`/`transfer` test, unaffected by this change).

- [ ] **Step 5: Commit**
```
git add apps/web/src/server/usecases/billing-groups.ts apps/web/src/server/usecases/__tests__/billing-group-move.test.ts
git commit -m "$(cat <<'EOF'
fix(billing): merge wallet balance when an org attaches (#285)

attachOrgToGroup now calls mergeWalletOnAttach inside its own
transaction right after rewriting organizations.subscription_id, so an
org's own AI credit balance moves with it into the group instead of
being stranded on a subscription id nothing can resolve to again.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Detach leaves an audit trail, takes no wallet share

**Files:**
- Modify: `apps/web/src/lib/credits.ts` (insert after Task 1's `mergeWalletOnAttach`), `apps/web/src/server/usecases/billing-groups.ts:22` (extend Task 2's import), `:873` (call site)
- Test: `apps/web/src/server/usecases/__tests__/billing-group-move.test.ts` (new `describe` block after the existing `"detach"` block)

**Interfaces:**
- Consumes: `bucketBalance` (credits.ts:96, internal same-file helper); `Tx` (credits.ts:19); existing `staff_audit_log` table (`db/migration/deltas/V103__admin.sql:14-22`, columns `actor_id, action, target_type, target_id, detail jsonb`); postgres.js `tx.json(...)` (already used at credits.ts:1118 inside `adminAdjust`).
- Produces: `export async function auditWalletForfeitedOnDetach(tx: Tx, actorUserId: string, orgId: string, oldWalletId: string, newWalletId: string): Promise<void>` — used only by `detachOrgFromGroup`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/billing-group-move.test.ts`, as a new top-level `describe` block placed right after the closing `});` of the existing `describe.skipIf(!HAS_DB)("detach", ...)` block:

```ts
describe.skipIf(!HAS_DB)("detach leaves an audit trail for the wallet it does not carry (#285)", () => {
  it("records the forfeited balance in staff_audit_log without moving any credits", async () => {
    const payer = await makeUser("payer");
    const clubOwner = await makeUser("clubowner");
    const group = await makeGroup(payer, { stripeSubId: "sub_wallet_det_" + uniq() });
    await makeOrg(group, payer);
    const orgId = await makeOrg(group, clubOwner);
    // The group's shared wallet holds some AI credits.
    await sql`insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${group}, 40, 'monthly_grant', 'grant', 40, ${"seed-" + uniq()})`;

    const res = await detachOrgFromGroup({ actorUserId: clubOwner, orgId });

    // The wallet balance is untouched — the group keeps every credit
    // ("leaver takes no wallet share on detach", decided default).
    const [bal] = await sql<{ bal: string }[]>`
      select coalesce(sum(delta),0)::text as bal from ai_credit_ledger where wallet_id = ${group}`;
    expect(Number(bal.bal)).toBe(40);
    // The departing org starts a fresh, empty wallet — no share carried.
    const [newBal] = await sql<{ bal: string }[]>`
      select coalesce(sum(delta),0)::text as bal from ai_credit_ledger where wallet_id = ${res.subscription_id}`;
    expect(Number(newBal.bal)).toBe(0);

    const [audit] = await sql<
      { detail: { old_wallet_balance_left_behind?: { grant: number; pack: number } } }[]
    >`
      select detail from staff_audit_log
       where target_id = ${orgId} and action = 'billing_group.detach_wallet_not_carried'
       order by created_at desc limit 1`;
    expect(audit?.detail?.old_wallet_balance_left_behind).toEqual({ grant: 40, pack: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/server/usecases/__tests__/billing-group-move.test.ts -t "records the forfeited balance"
```
Expected: FAIL — no `staff_audit_log` row with `action = 'billing_group.detach_wallet_not_carried'` exists (`audit` is `undefined`, so `audit?.detail?...` is `undefined`, not the expected object).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/lib/credits.ts`, right after `mergeWalletOnAttach` (Task 1):

```ts
/**
 * Record, for accountability, that `orgId` left a shared wallet holding
 * `oldWalletId`'s balance behind (#285, "leaver takes no wallet share" —
 * a decided default, not a bug: a shared group wallet has no notion of a
 * per-org share to carry out, so `detachOrgFromGroup` mints the departing
 * org a brand-new, empty wallet at `newWalletId` rather than attempting to
 * split anything off `oldWalletId`).
 *
 * Writes to `staff_audit_log` (V103), not the money ledger: no credits
 * actually move, so there is nothing for `ai_credit_ledger` — append-only
 * TRUTH about money, SPEC-2 §5.1 — to record. `staff_audit_log` is the only
 * generic actor+target+detail audit sink the schema has (`db/migration/
 * deltas/V103__admin.sql`); `actor_id` carries no `is_staff` constraint at
 * the database level, and every detach (staff-initiated or self-service) is
 * exactly the kind of money-adjacent event that table exists to leave a
 * trail for.
 *
 * Called INSIDE detachOrgFromGroup's own transaction, right after the fresh
 * subscription row is minted, so the snapshot and the move commit together.
 */
export async function auditWalletForfeitedOnDetach(
  tx: Tx,
  actorUserId: string,
  orgId: string,
  oldWalletId: string,
  newWalletId: string,
): Promise<void> {
  const grant = Math.max(0, await bucketBalance(tx, oldWalletId, "grant"));
  const pack = Math.max(0, await bucketBalance(tx, oldWalletId, "pack"));
  await tx`
    insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
    values (${actorUserId}, 'billing_group.detach_wallet_not_carried', 'org', ${orgId},
            ${tx.json({
              old_wallet_id: oldWalletId,
              new_wallet_id: newWalletId,
              old_wallet_balance_left_behind: { grant, pack },
            } as never)})`;
}
```

In `apps/web/src/server/usecases/billing-groups.ts`, extend Task 2's import:

```ts
import { auditWalletForfeitedOnDetach, mergeWalletOnAttach } from "@/lib/credits";
```

Then, in `detachOrgFromGroup`'s transaction body, right after the org-row update (currently line 873):

```ts
    await tx`update organizations set subscription_id = ${fresh.id} where id = ${orgId}`;
```

add:

```ts
    await tx`update organizations set subscription_id = ${fresh.id} where id = ${orgId}`;
    // #285: no wallet merge on detach (the departing org takes no share of
    // the group's pool — decided default) — just an audit trail of what was
    // left behind, for accountability.
    await auditWalletForfeitedOnDetach(tx, actorUserId, orgId, group.id, fresh.id);
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/server/usecases/__tests__/billing-group-move.test.ts
```
Expected: PASS — the whole file, including every pre-existing detach test (none of them assert on `staff_audit_log`, so none regress).

- [ ] **Step 5: Commit**
```
git add apps/web/src/lib/credits.ts apps/web/src/server/usecases/billing-groups.ts apps/web/src/server/usecases/__tests__/billing-group-move.test.ts
git commit -m "$(cat <<'EOF'
feat(billing): audit the wallet a detach leaves behind (#285)

detachOrgFromGroup writes a staff_audit_log row recording the group
wallet balance the departing org does NOT take with it (leaver takes
no wallet share — decided default), so the forfeiture has a trail
even though no ai_credit_ledger row moves.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: One-off reconciliation script for already-stranded wallets (staging only)

**Files:**
- Create: `scripts/reconcile-stranded-wallets.ts`
- Test: `apps/web/src/lib/__tests__/reconcile-stranded-wallets-select-target.test.ts` (new file)

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (a standalone script — see note below on why it cannot import `@/lib/credits`). Deliberately re-implements the SAME bucket-preserving compensating-row shape as `mergeWalletOnAttach` (Task 1), including the sorted dual advisory lock.
- Produces: `export function chooseReconcileTarget(rows: { spent_by_org_id: string | null }[]): string | null` — the only pure, independently-testable piece; consumed by nothing else in this wave.

**Why this can't just call `mergeWalletOnAttach`:** every existing one-off script in this repo (`scripts/backfill-pass-credit-redemptions.ts`) is self-contained with its own `postgres()` client, never importing from `apps/web/src/lib/*`. `apps/web/src/lib/credits.ts` starts with `import "server-only";`, and the `server-only` package only resolves inside Next's bundler alias (`node_modules/next/dist/compiled/server-only`) — there is no top-level `node_modules/server-only` a plain `node --experimental-strip-types` script can resolve. The merge logic is therefore duplicated here on purpose, matching the established script convention.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/reconcile-stranded-wallets-select-target.test.ts`:

```ts
// Pure-function coverage for `chooseReconcileTarget`
// (scripts/reconcile-stranded-wallets.ts, #285 one-off staging cleanup).
//
// The script must never GUESS which org a stranded wallet belongs to — a
// wallet with no spend attribution at all is reported for manual review,
// not merged on a hunch. This pins that decision directly, the same way
// `isBalanceHistoryTruncated` is pinned in pass-credit-backfill-truncation.
// test.ts without touching Postgres.
import { describe, expect, it } from "vitest";
import { chooseReconcileTarget } from "../../../../../scripts/reconcile-stranded-wallets";

describe("chooseReconcileTarget", () => {
  it("returns null when nothing carries a spend attribution", () => {
    expect(chooseReconcileTarget([])).toBeNull();
    expect(chooseReconcileTarget([{ spent_by_org_id: null }, { spent_by_org_id: null }])).toBeNull();
  });

  it("returns the first (most recent, given created_at desc ordering) attributed org", () => {
    expect(
      chooseReconcileTarget([
        { spent_by_org_id: "org-newest" },
        { spent_by_org_id: "org-older" },
      ]),
    ).toBe("org-newest");
  });

  it("skips leading nulls to find the first real attribution", () => {
    expect(
      chooseReconcileTarget([{ spent_by_org_id: null }, { spent_by_org_id: "org-x" }]),
    ).toBe("org-x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/lib/__tests__/reconcile-stranded-wallets-select-target.test.ts
```
Expected: FAIL — `scripts/reconcile-stranded-wallets.ts` does not exist yet (module resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/reconcile-stranded-wallets.ts`:

```ts
// One-off reconciliation for AI-credit wallets stranded by the pre-#285
// attachOrgToGroup bug (db/migration/deltas/V336, docs/superpowers/specs/
// 2026-07-26-v17-gap-remediation-design.md §W1).
//
// Before V336/mergeWalletOnAttach shipped, attaching an org into a billing
// group rewrote `organizations.subscription_id` with NO wallet merge: any AI
// credit balance sitting on `ai_credit_ledger` keyed to the org's OLD
// subscription id was left behind. If that old subscription was a bare
// community-of-one (no Stripe ids), dropEmptyGroup then deleted the
// `subscriptions` row outright — `ai_credit_ledger.wallet_id` carries no
// foreign key (it's a subscription id OR an org id, so it can't reference
// one table), so the balance survives as a ledger row nothing can ever
// resolve to again. `walletIdFor` only ever returns
// coalesce(subscription_id, id) for a LIVE organizations row, so a wallet
// whose id matches neither any current `organizations.id` nor any current
// `subscriptions.id` is provably unreachable.
//
// STAGING ONLY. #284's decision means production starts at V336 with no
// pre-existing data, so this script exists purely for whatever staging/dev
// data already carries the pre-fix stranding — never intended to run
// against prod.
//
// For each stranded wallet, the only local attribution the ledger carries is
// `run_spend`'s `spent_by_org_id` — which org actually burned credits from
// it while it was still that org's own solo wallet. A wallet with no spend
// at all (pure unspent grant, never used) has no such trace: rather than
// guess, this script reports it for manual staff review and merges nothing.
//
// Idempotent / safe to re-run: a wallet already reconciled (drained to 0)
// simply has nothing left to find on a second pass; every insert is
// `on conflict (idempotency_key) do nothing`.
//
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/reconcile-stranded-wallets.ts              # dry run
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/reconcile-stranded-wallets.ts --write        # applies it
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Which org (if any) a stranded wallet's balance should be routed to: the
 * first non-null `spent_by_org_id` in `rows`, which the caller queries
 * ordered `created_at desc` — the MOST RECENT org known to have spent from
 * this wallet. Returns null when nothing in `rows` carries one (a pure
 * unspent grant/pack) — there is no safe guess for who owns it.
 */
export function chooseReconcileTarget(rows: { spent_by_org_id: string | null }[]): string | null {
  for (const row of rows) if (row.spent_by_org_id) return row.spent_by_org_id;
  return null;
}

interface BucketBalances {
  grant: number;
  pack: number;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const WRITE = process.argv.includes("--write");
  console.log(
    WRITE
      ? "WRITE mode: rows WILL be inserted."
      : "DRY RUN: nothing will be written. Pass --write to apply.",
  );

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });

  try {
    const stranded = await sql<{ wallet_id: string; grant: string; pack: string }[]>`
      select l.wallet_id,
             coalesce(sum(l.delta) filter (where l.bucket = 'grant'), 0)::text as grant,
             coalesce(sum(l.delta) filter (where l.bucket = 'pack'), 0)::text as pack
        from ai_credit_ledger l
       where not exists (select 1 from organizations o where o.id::text = l.wallet_id)
         and not exists (select 1 from subscriptions s where s.id::text = l.wallet_id)
       group by l.wallet_id
      having coalesce(sum(l.delta), 0) <> 0
       order by l.wallet_id`;
    console.log(`Found ${stranded.length} stranded wallet(s) with a non-zero balance.\n`);

    let merged = 0;
    let needsReview = 0;

    for (const w of stranded) {
      const balances: BucketBalances = { grant: Number(w.grant), pack: Number(w.pack) };

      const spenders = await sql<{ spent_by_org_id: string | null }[]>`
        select spent_by_org_id from ai_credit_ledger
         where wallet_id = ${w.wallet_id} and spent_by_org_id is not null
         order by created_at desc`;
      const targetOrgId = chooseReconcileTarget(spenders);
      if (!targetOrgId) {
        needsReview++;
        console.warn(
          `MANUAL REVIEW: wallet=${w.wallet_id} grant=${balances.grant} pack=${balances.pack} ` +
            `— no spend attribution on this wallet, cannot determine an owning org.`,
        );
        continue;
      }

      const [org] = await sql<{ subscription_id: string | null; deleted_at: Date | null }[]>`
        select subscription_id, deleted_at from organizations where id = ${targetOrgId}`;
      if (!org || org.deleted_at) {
        needsReview++;
        console.warn(
          `MANUAL REVIEW: wallet=${w.wallet_id} attributed org=${targetOrgId} no longer exists ` +
            `(deleted) — cannot determine a live wallet to merge into.`,
        );
        continue;
      }
      const targetWalletId = org.subscription_id ?? targetOrgId;
      if (targetWalletId === w.wallet_id) {
        // Should be impossible (the wallet is provably stranded above), but
        // never merge a wallet into itself.
        needsReview++;
        console.warn(`MANUAL REVIEW: wallet=${w.wallet_id} resolves back to itself — skipping.`);
        continue;
      }

      console.log(
        `${WRITE ? "MERGE" : "WOULD MERGE"}: wallet=${w.wallet_id} grant=${balances.grant} ` +
          `pack=${balances.pack} -> org=${targetOrgId} wallet=${targetWalletId}`,
      );

      if (WRITE) {
        await sql.begin(async (tx) => {
          const [lo, hi] = [w.wallet_id, targetWalletId].sort();
          await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + lo}))`;
          await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + hi}))`;
          for (const [bucket, amount] of [
            ["grant", balances.grant],
            ["pack", balances.pack],
          ] as const) {
            if (amount <= 0) continue;
            const [priorOld] = await tx<{ bal: string | null }[]>`
              select coalesce(sum(delta), 0)::text as bal from ai_credit_ledger
               where wallet_id = ${w.wallet_id}`;
            await tx`
              insert into ai_credit_ledger
                (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
              values (${w.wallet_id}, ${-amount}, 'group_merge', ${bucket}, ${targetWalletId},
                      ${Number(priorOld?.bal ?? 0) - amount},
                      ${`reconcile-${w.wallet_id}-${bucket}`})
              on conflict (idempotency_key) do nothing`;
            const [priorNew] = await tx<{ bal: string | null }[]>`
              select coalesce(sum(delta), 0)::text as bal from ai_credit_ledger
               where wallet_id = ${targetWalletId}`;
            await tx`
              insert into ai_credit_ledger
                (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
              values (${targetWalletId}, ${amount}, 'group_merge', ${bucket}, ${w.wallet_id},
                      ${Number(priorNew?.bal ?? 0) + amount},
                      ${`reconcile-${targetWalletId}-from-${w.wallet_id}-${bucket}`})
              on conflict (idempotency_key) do nothing`;
          }
        });
      }
      merged++;
    }

    console.log("\n--- summary ---");
    console.log(`Stranded wallets found: ${stranded.length}`);
    console.log(`${WRITE ? "Merged" : "Would merge"}: ${merged}`);
    console.log(`Needs manual review (no attribution / stale org): ${needsReview}`);
    if (!WRITE) console.log("\nDry run complete. Nothing was written. Re-run with --write to apply.");
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/lib/__tests__/reconcile-stranded-wallets-select-target.test.ts
```
Expected: PASS — 3/3. Then (manually, not part of CI) verify the script's dry run runs cleanly against the local test DB: `node --experimental-strip-types scripts/reconcile-stranded-wallets.ts` prints "Found 0 stranded wallet(s)" on a fresh schema.

- [ ] **Step 5: Commit**
```
git add scripts/reconcile-stranded-wallets.ts apps/web/src/lib/__tests__/reconcile-stranded-wallets-select-target.test.ts
git commit -m "$(cat <<'EOF'
chore(credits): one-off reconciliation for stranded wallets (#285)

Staging-only script (production starts at V336 with no pre-existing
data — #284) to merge any AI-credit wallet balance stranded by the
pre-fix attachOrgToGroup bug. Dry-run by default; --write to apply.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: smoke.ts touch + help doc update for #285

**Files:**
- Modify: `scripts/smoke.ts` (new helper after `walletBalance`, ~line 4021; new assertions in the billing-group attach flow, ~lines 384-400)
- Modify: `apps/web/content/help/billing/credits.md` (append to the "Shared across a billing group" section, after line 29)

**Interfaces:**
- Consumes: existing smoke helpers `walletIdForOrg`, `walletBalance` (smoke.ts:~4010), `topUpWallet` (smoke.ts:4052), `smokeDb` (smoke.ts:~4067) — all already defined and already used by the `v4AiSuite` wallet checks.
- Produces: `walletBalanceByWalletId(walletId: string): Promise<number>` — a smoke-local helper, used only by the new assertions in this task.

This task has no isolated "unit" to TDD (smoke.ts is a script exercised end-to-end against a running app, not vitest), so it follows the spirit of the template with a manual before/after check instead of an automated red/green step.

- [ ] **Step 1: Write the change (smoke.ts)**

Immediately after the existing `walletBalance` function in `scripts/smoke.ts` (the function currently ends, per its closing brace, right before the `drainWallet` doc comment):

```ts
/** Same as `walletBalance` but takes the wallet id directly — used to prove
 *  a wallet a billing-group move stepped AWAY from (its old subscription/
 *  group id, before the attach) is left holding nothing, rather than
 *  resolving through an org's CURRENT (post-move) wallet like
 *  `walletBalance` does. */
async function walletBalanceByWalletId(walletId: string): Promise<number> {
  const sql = smokeDb();
  try {
    const [row] = await sql<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger where wallet_id = ${walletId}`;
    return Number(row?.bal ?? 0);
  } finally {
    await sql.end();
  }
}
```

In the billing-group attach block, right before step "3. OPT-IN ATTACH" (immediately after the existing checks that end with `"a brand-new org is on its own group, distinct from the payer's (#212)"`), add:

```ts
    // v17 gap #285: the group wallet a joining org leaves behind must not be
    // stranded — its balance has to land in the group's shared wallet, not
    // vanish on a subscription row nothing can resolve to any more.
    await topUpWallet(org2.id, 7);
    const org2OldWalletId = org2Group!.id;
    const groupBalanceBeforeAttach = await walletBalance(org.id);
```

Then, right after the existing `"billing-group: attach moves the org into the payer's group"` check (immediately following the `attached = ...` call and its `check(...)`), add:

```ts
    check(
      "billing-group: attach merges the joining org's wallet balance into the group's (#285)",
      (await walletBalance(org.id)) === groupBalanceBeforeAttach + 7,
    );
    check(
      "billing-group: the joining org's OLD wallet is left holding nothing, not stranded (#285)",
      (await walletBalanceByWalletId(org2OldWalletId)) === 0,
    );
```

- [ ] **Step 2: Verify manually**

Run the smoke suite locally against a running dev/prod-build app (per `feedback_run_live_billing_tests`/local recipe — prod build + app on its smoke port):
```
npm run test:smoke
```
Before Task 2's fix this would print two FAILs for the two new checks (the group balance would not include the +7, and the old wallet would still hold it). After Task 2/3 land, expect both new checks to print PASS alongside the existing billing-group checks.

- [ ] **Step 3: Write minimal implementation (help doc)**

In `apps/web/content/help/billing/credits.md`, in the "Shared across a billing group" section, insert a new paragraph directly after line 29 (the "Credits tab shows a 'shared across N organisations' note..." sentence) and before the "## Run history and export" heading:

```markdown
Any credits your organisation already holds **move with it**: joining a group merges your unspent balance straight into the shared pool — monthly-grant credits stay monthly-grant credits, purchased and earned credits stay in their own never-expiring pool, exactly as before. Leaving a group works the other way: you take **no share** of the pool with you. Your new bill starts a fresh, empty wallet, and the credits you were sharing stay with the group.
```

- [ ] **Step 4: Verify**

No automated test for the markdown copy (help content has no test harness in this repo — confirmed by grepping for a help-content test runner; none exists). Manually confirm the page still renders: `npm run dev` (or the smoke app), visit `/help/billing/credits`, check the new paragraph reads correctly under "Shared across a billing group".

- [ ] **Step 5: Commit**
```
git add scripts/smoke.ts apps/web/content/help/billing/credits.md
git commit -m "$(cat <<'EOF'
test(smoke): prove attach merges the wallet, not strands it (#285)

Also documents the join/leave wallet behaviour on the AI credits help
page — previously silent on what happens to your balance when you
share or leave a billing group.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `reversal_undetermined_at` keeps the group cap held (#286)

**Files:**
- Create: `db/migration/deltas/V337__pass_credit_reversal_undetermined.sql`
- Modify: `apps/web/src/server/usecases/pass-credit.ts:258-274` (`groupAlreadyRedeemed`), `:627-631` (the final `UPDATE` in `reversePassCreditOnRefund`)
- Test: `apps/web/src/server/usecases/__tests__/pass-credit-refund-reversal.test.ts` (extend 2 existing tests, add 2 new tests)

**Interfaces:**
- Consumes: nothing from Tasks 1-5 (independent bug, different files). Existing `otherCreditActivitySince` (pass-credit.ts:460), `reversePassCreditOnRefund` (pass-credit.ts:499), `groupAlreadyRedeemed` (pass-credit.ts:258), `creditPassTowardSubscription` (pass-credit.ts:288) — all unchanged in signature.
- Produces: no new exported symbols; `pass_credit_redemptions.reversal_undetermined_at` is a new column read only inside this file.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/server/usecases/__tests__/pass-credit-refund-reversal.test.ts`:

1. Extend `redemptionRow` (currently lines 130-135) to also select the new column:

```ts
async function redemptionRow(intent: string) {
  const [row] = await sql<
    {
      reversed_at: string | null;
      reversed_minor: number | null;
      amount_minor: number;
      reversal_undetermined_at: string | null;
    }[]
  >`select reversed_at, reversed_minor, amount_minor, reversal_undetermined_at
    from pass_credit_redemptions where payment_intent = ${intent}`;
  return row;
}
```

2. Extend the top-level import (currently line 58) to pull in `creditPassTowardSubscription` and `groupAlreadyRedeemed`:

```ts
import {
  PASS_CREDIT_INTENT_KEY,
  creditPassTowardSubscription,
  groupAlreadyRedeemed,
  reversePassCreditOnRefund,
} from "../pass-credit";
```

3. Add one assertion line to the EXISTING "skips the Stripe reversal and alerts 'undetermined'..." test (currently lines 290-319), right after its `expect(row?.reversed_minor).toBe(0);` (line 312):

```ts
    expect(row?.reversal_undetermined_at).not.toBeNull();
```

4. Add the same assertion to the EXISTING "fails closed (treated as unsafe)..." test (currently lines 321-344), right after its `expect(row?.reversed_minor).toBe(0);` (line 340):

```ts
    expect(row?.reversal_undetermined_at).not.toBeNull();
```

5. Add a small local helper (near the top, after `seedRedemption`) for seeding a SECOND pass on the same org:

```ts
/** A second Event Pass for `orgId`, distinct competition + intent from
 *  whatever `seedRedemption` already recorded — used to prove
 *  `creditPassTowardSubscription` refuses a second mint while the group's
 *  only redemption is undetermined. */
async function seedCompetitionPass(orgId: string, intent: string): Promise<void> {
  const suffix = uniq();
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Second Pass " + suffix}, ${"second-pass-" + suffix}) returning id`;
  await sql`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent, purchased_at)
    values (${competitionId}, ${orgId}, ${intent}, now())`;
}
```

6. Add two new `it` blocks inside the `describe.skipIf(!HAS_DB)("reversePassCreditOnRefund", ...)` block, after the existing "only the WINNER of two concurrent deliveries..." test:

```ts
  it("keeps the group's lifetime cap HELD after an undetermined reversal — the money bug this closes", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    ledger.push(grantEntry(intent));
    ledger.push({ amount: -500, currency: "gbp" }); // unrelated credit -> unsafe
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });

    await reversePassCreditOnRefund(intent);

    // Pre-fix, reversed_at alone freed pass_credit_redemptions_group_cap the
    // moment this ran, even though nothing was actually clawed back.
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(true);

    const row = await redemptionRow(intent);
    expect(row?.reversed_at).not.toBeNull(); // idempotency stamp still set
    expect(row?.reversal_undetermined_at).not.toBeNull(); // the actual fix
  });

  it("refuses a second mint while the group's only redemption is undetermined", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    ledger.push(grantEntry(intent));
    ledger.push({ amount: 1500, currency: "gbp" });
    ledger.push({ amount: -500, currency: "gbp" }); // unrelated credit -> unsafe
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });
    await reversePassCreditOnRefund(intent);

    // A SECOND, different pass for the same group attempts to mint a fresh
    // credit — exactly the double-£25 shape the bug allowed.
    const secondIntent = "pi_" + uniq();
    await seedCompetitionPass(orgId, secondIntent);
    stripeMock.createBalance.mockClear();

    const second = await creditPassTowardSubscription(orgId);

    expect(second.outcome).toBe("group_already_redeemed");
    expect(second.amountMinor).toBe(0);
    // Caught by the CHEAP pre-check (groupAlreadyRedeemed) — never even
    // reaches a Stripe call.
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/server/usecases/__tests__/pass-credit-refund-reversal.test.ts
```
Expected: FAIL — 4 failures: the two extended existing tests fail on `expect(row?.reversal_undetermined_at).not.toBeNull()` (the column doesn't exist yet, so the query itself errors, or once the column is added by a later step but the code isn't, the value is `null`); the "keeps the group's lifetime cap HELD" test fails with `groupAlreadyRedeemed` returning `false` (pre-fix, `reversed_at` alone frees the cap); the "refuses a second mint" test fails with `second.outcome === "credited"` and `stripeMock.createBalance` called a second time.

- [ ] **Step 3: Write minimal implementation**

Create `db/migration/deltas/V337__pass_credit_reversal_undetermined.sql`:

```sql
-- V337 — undetermined pass-credit reversals keep the group cap HELD (#286,
-- docs/superpowers/specs/2026-07-26-v17-gap-remediation-design.md §W1).
--
-- reversePassCreditOnRefund (server/usecases/pass-credit.ts) stamps
-- `reversed_at` on every call, even along the `otherCreditActivitySince()`
-- "unsafe" branch where NOTHING is actually clawed back (the customer keeps
-- the £/$ subscription credit) — which frees V335's partial-index lifetime
-- cap (`pass_credit_redemptions_group_cap`, `where reversed_at is null`) the
-- moment that happens, letting the SAME group redeem a second real Event
-- Pass credit while still holding the first, unreversed one.
--
-- `reversal_undetermined_at` is the new, separate marker for that branch.
-- `reversed_at` keeps being stamped on every call (it still doubles as the
-- "this webhook delivery has been handled" idempotency guard the function's
-- own early-return reads), but `reversal_undetermined_at` is ALSO stamped
-- when `otherCreditActivitySince()` returned unsafe — "I could not prove
-- what to do, so nothing moved". Staff resolution of an undetermined row is
-- phase 2 (deferred, design decisions table).
alter table pass_credit_redemptions
  add column if not exists reversal_undetermined_at timestamptz;

comment on column pass_credit_redemptions.reversal_undetermined_at is
  'Set (#286) when otherCreditActivitySince() could not prove the customer '
  'balance pool was pass-money-only: reversed_at is still stamped (webhook- '
  'replay idempotency guard) but nothing was actually clawed back. NOT NULL '
  'here means pass_credit_redemptions_group_cap must keep treating the row '
  'as live. Staff resolution is phase 2 (deferred).';

-- THE CAP, corrected: V335's predicate (`where reversed_at is null`) is
-- exactly what let this bug free the cap — an undetermined row now has
-- reversed_at SET (still the idempotency stamp) but must still hold the
-- cap, so the predicate widens to also cover it.
drop index if exists pass_credit_redemptions_group_cap;
create unique index if not exists pass_credit_redemptions_group_cap
  on pass_credit_redemptions (subscription_id)
  where reversed_at is null or reversal_undetermined_at is not null;

comment on table pass_credit_redemptions is
  'Durable record of an Event Pass credited toward a subscription (design '
  '2026-07-26 §2). Group-keyed: pass_credit_redemptions_group_cap is a '
  'partial unique index on subscription_id where reversed_at is null OR '
  'reversal_undetermined_at is not null (#286, V337) — an undetermined '
  'reversal still holds the cap even though reversed_at is stamped. '
  'Survives deletion of the competition_passes row it was earned from.';
```

In `apps/web/src/server/usecases/pass-credit.ts`, replace `groupAlreadyRedeemed` (currently lines 258-274):

```ts
export async function groupAlreadyRedeemed(subscriptionId: string): Promise<boolean> {
  try {
    const [row] = await sql<{ one: number }[]>`
      select 1 as one from pass_credit_redemptions
      where subscription_id = ${subscriptionId} and reversed_at is null limit 1`;
    return !!row;
  } catch {
    return true;
  }
}
```

with:

```ts
export async function groupAlreadyRedeemed(subscriptionId: string): Promise<boolean> {
  try {
    const [row] = await sql<{ one: number }[]>`
      select 1 as one from pass_credit_redemptions
      where subscription_id = ${subscriptionId}
        and (reversed_at is null or reversal_undetermined_at is not null)
      limit 1`;
    return !!row;
  } catch {
    return true;
  }
}
```

Then replace the final `UPDATE` inside `reversePassCreditOnRefund` (currently lines 627-631):

```ts
  const [won] = await sql<{ payment_intent: string }[]>`
    update pass_credit_redemptions
    set reversed_at = now(), reversed_minor = ${reverseAmount}
    where payment_intent = ${intent} and reversed_at is null
    returning payment_intent`;
```

with:

```ts
  // #286: `reversed_at` is stamped on every call — it still doubles as the
  // "this webhook delivery has been handled" idempotency guard the
  // early-return at the top of this function reads (line 524). But when
  // `unsafe` is true nothing was actually clawed back, so
  // `reversal_undetermined_at` is ALSO stamped, and V337's widened partial
  // index keeps pass_credit_redemptions_group_cap HELD for this row even
  // though reversed_at is set — the bug this migration exists to close.
  const [won] = unsafe
    ? await sql<{ payment_intent: string }[]>`
        update pass_credit_redemptions
        set reversed_at = now(), reversed_minor = ${reverseAmount}, reversal_undetermined_at = now()
        where payment_intent = ${intent} and reversed_at is null
        returning payment_intent`
    : await sql<{ payment_intent: string }[]>`
        update pass_credit_redemptions
        set reversed_at = now(), reversed_minor = ${reverseAmount}
        where payment_intent = ${intent} and reversed_at is null
        returning payment_intent`;
```

- [ ] **Step 4: Run test to verify it passes**

```
npm run db:apply
npx vitest run src/server/usecases/__tests__/pass-credit-refund-reversal.test.ts
```
Expected: PASS — all tests in the file, including the 2 extended and 2 new ones. Then run the full pre-existing pass-credit suite set to confirm nothing else regressed:
```
npx vitest run src/server/usecases/__tests__/pass-credit.test.ts src/server/usecases/__tests__/billing-events-pass-credit.test.ts src/server/usecases/__tests__/pass-credit-backfill-truncation.test.ts src/lib/__tests__/billing-reconcile-pass-credit.test.ts
```
Expected: PASS — these are the other pass-credit suites (53-54 tests total across the non-live pass-credit files) that must stay green; none of them assert on `pass_credit_redemptions_group_cap`'s exact predicate SQL, only on behaviour, so the widened predicate should not disturb them.

- [ ] **Step 5: Commit**
```
git add db/migration/deltas/V337__pass_credit_reversal_undetermined.sql apps/web/src/server/usecases/pass-credit.ts apps/web/src/server/usecases/__tests__/pass-credit-refund-reversal.test.ts
git commit -m "$(cat <<'EOF'
fix(billing): undetermined pass reversal keeps the group cap held (#286)

reversePassCreditOnRefund stamped reversed_at unconditionally, even
when otherCreditActivitySince() could not prove anything was safe to
claw back — freeing pass_credit_redemptions_group_cap while the
customer kept the original credit, letting the same group mint a
second real Event Pass credit. reversal_undetermined_at is the new,
separate marker; V337 widens the partial-index predicate to keep the
cap held whenever it is set.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wave verification and PR prep

**Files:** none created or modified — verification only.

**Interfaces:** N/A.

- [ ] **Step 1: Typecheck**

From `apps/web`:
```
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 2: Full targeted test run**

From `apps/web`:
```
npx vitest run src/lib/__tests__/credits-wallet-merge.test.ts \
  src/lib/__tests__/reconcile-stranded-wallets-select-target.test.ts \
  src/server/usecases/__tests__/billing-group-move.test.ts \
  src/server/usecases/__tests__/pass-credit-refund-reversal.test.ts \
  src/server/usecases/__tests__/pass-credit.test.ts \
  src/server/usecases/__tests__/billing-events-pass-credit.test.ts \
  src/server/usecases/__tests__/pass-credit-backfill-truncation.test.ts \
  src/lib/__tests__/billing-reconcile-pass-credit.test.ts
```
Expected: PASS, 0 failures. Then run the whole workspace suite to catch anything this wave's shared-file edits (`credits.ts`, `billing-groups.ts`, `pass-credit.ts`) might have touched elsewhere:
```
npm run test --workspace apps/web
```
Expected: PASS.

- [ ] **Step 3: BILLING_LIVE relevance check (per wave-specific note above)**

No live suite exists for #285 (confirmed: no `billing-group*.live.test.ts` file, and `mergeWalletOnAttach`/`auditWalletForfeitedOnDetach` make zero Stripe calls) — nothing to run there. For #286, run the existing live counterpart against test-mode Stripe to confirm the "safe" reversal path (the one this wave did NOT change the arithmetic of) still passes end-to-end:
```
BILLING_LIVE=1 npx vitest run src/server/usecases/__tests__/pass-credit-refund-reversal.live.test.ts --testTimeout=60000
```
Expected: PASS (skipped cleanly if no `STRIPE_SECRET_KEY`/`BILLING_LIVE` env is available in this environment — note that in the PR description rather than silently skipping unnoticed).

- [ ] **Step 4: Smoke (local, prod build)**

Per the local e2e/smoke recipe (prod build + smoke target), run:
```
npm run test:smoke
```
Expected: PASS, including the two new `(#285)`-tagged checks from Task 5.

- [ ] **Step 5: Push and open the PR**
```
git push -u origin fix/v17gap-w1-money-leaks
```
Then run `/code-review` on the branch (per the global constraint), address anything it raises with new commits (never amend), and open the PR via `gh pr create` referencing `#285` and `#286`.
