import "server-only";
import postgres from "postgres";
import { PaymentRequiredError } from "@/lib/errors";
// AI credit wallet — the metered axis of v17 (design/v17-pricing-entitlements/
// SPEC-2 §5, §11). AI runs are available on EVERY tier; the gate is a prepaid
// credit balance, not the boolean entitlement resolver.
//
// This module owns the wallet: where an org's credits live, and how much is in
// the pool. Grant (Task 2) and reserve/settle/release spend (Task 3) build on
// `walletIdFor` + `balance`; the AI usecases call the spend wrapper, never the
// ledger directly.
//
// The ledger (`ai_credit_ledger`, V320) is append-only truth: corrections are
// compensating rows, never UPDATE/DELETE — it is money. `balance_after` is a
// cached snapshot carrying a `>= 0` CHECK that makes oversell impossible
// atomically; `balance()` here reads the authoritative running sum.
import { sql } from "@/lib/db";

type Tx = postgres.TransactionSql;
/** Anything the ledger's tagged-template queries can run against: the shared
 *  `sql` client for a plain read, or a transaction handle when the caller
 *  already holds one (`grantTrial`'s `for update`, `reserve`'s advisory
 *  lock, ...). */
type Executor = Tx | ReturnType<typeof postgres>;

/** Which independently-resettable pool a ledger row affects (SPEC-2 §5.4,
 *  V321): `grant` for monthly/trial/earn grants (use-or-lose, resets each
 *  cycle), `pack` for purchased packs (never expire). `run_spend`/`refund`/
 *  `expiry` rows carry whichever bucket they debit, credit back, or expire. */
type Bucket = "grant" | "pack";

/** The `ai_credit_ledger_balance_after_check` CHECK-constraint violation
 *  (Postgres `23514`) — the only failure mode that means "this insert would
 *  have oversold the wallet". `ai_credit_ledger` carries two other `23514`
 *  CHECKs (`source`, `bucket` enums) that share the same Postgres error code
 *  but mean "caller passed a bad enum value", not "402 out of credits" — this
 *  must key on the constraint name, not just the code, or those enum bugs
 *  would masquerade as a normal insufficient-balance response. */
const BALANCE_CHECK_CONSTRAINT = "ai_credit_ledger_balance_after_check";
function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23514" &&
    (err as { constraint_name?: string }).constraint_name === BALANCE_CHECK_CONSTRAINT
  );
}

/**
 * The wallet an org spends from: `coalesce(group_subscription_id, org_id)`
 * (SPEC-2 §11.1).
 *
 * A grouped org resolves to its group's `subscription_id` — every org in a
 * billing group shares ONE credit pool, so buying once lets any org in the
 * group spend (`ai_credit_ledger.spent_by_org_id` records who, for reporting).
 * An org with no subscription row is a group-of-one and resolves to its own id.
 *
 * Ids are uuids in the database but the ledger keys them as `text` (a wallet is
 * either a subscription id OR an org id, so it carries no single foreign key);
 * this returns the id as a string to match.
 */
export async function walletIdFor(orgId: string): Promise<string> {
  const [row] = await sql<{ wallet_id: string }[]>`
    select coalesce(subscription_id, id)::text as wallet_id
      from organizations where id = ${orgId}`;
  if (!row) throw new Error(`walletIdFor: no organization ${orgId}`);
  return row.wallet_id;
}

/**
 * Credits currently in the wallet: `sum(delta)` over the ledger (SPEC-2 §5.1).
 *
 * The signed deltas are the truth (grants +, spends −, refunds +, expiries −);
 * `balance_after` is only a per-row snapshot + the oversell guard. A wallet with
 * no rows is 0.
 */
export async function balance(walletId: string): Promise<number> {
  const [row] = await sql<{ bal: string | null }[]>`
    select coalesce(sum(delta), 0)::text as bal
      from ai_credit_ledger where wallet_id = ${walletId}`;
  return Number(row?.bal ?? 0);
}

/**
 * `sum(delta)` scoped to one bucket (SPEC-2 §5.4, V321) — the primitive
 * `grantBalance`/`packBalance` share, and `reserve()` uses (under its own
 * transaction/lock) to compute the grant-first split.
 */
async function bucketBalance(exec: Executor, walletId: string, bucket: Bucket): Promise<number> {
  const [row] = await exec<{ bal: string | null }[]>`
    select coalesce(sum(delta), 0)::text as bal
      from ai_credit_ledger where wallet_id = ${walletId} and bucket = ${bucket}`;
  return Number(row?.bal ?? 0);
}

/**
 * Credits left in the resetting **grant** bucket (monthly/trial/earn grants —
 * SPEC-2 §5.4 D1, use-or-lose). `reserve()` always burns this bucket first;
 * `grantMonthly`'s reset is a single `expiry` row against this bucket only,
 * leaving `packBalance` untouched.
 */
export async function grantBalance(walletId: string): Promise<number> {
  return bucketBalance(sql, walletId, "grant");
}

/**
 * Credits left in the **pack** bucket (purchased packs — SPEC-2 §5.4 D2,
 * never expire). `reserve()` only dips into this once `grantBalance` is 0.
 */
export async function packBalance(walletId: string): Promise<number> {
  return bucketBalance(sql, walletId, "pack");
}

/** Calendar-month period the monthly grant is scoped to (server clock,
 *  `YYYY-MM`). This is the FALLBACK anchor — used as-is for Community (no
 *  Stripe subscription to anchor on; README §7 item 7's "creation-day
 *  calendar" is an accepted simplification here, see
 *  `grantMonthlyForAllWallets`'s docstring) and as the default when a caller
 *  (e.g. a direct `grantMonthly` call, or a test) doesn't pass an explicit
 *  `periodKey`. */
function monthlyPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * The one shared write primitive every ledger row goes through: read the
 * current running balance, compute this row's `balance_after` snapshot, and
 * insert — inside the caller's transaction, so the read+write is atomic with
 * whatever locking/guards the caller already holds (`grantTrial`'s `for
 * update of s`, `reserve`'s advisory lock, ...).
 *
 * `idempotencyKey: null` always inserts (Postgres unique constraints never
 * treat two NULLs as conflicting) — callers that don't need idempotency
 * (`reserve`, each hold is its own row) simply omit a key. Callers that do
 * (`grantMonthly`, `grantTrial`, `release`) pass one and get `ON CONFLICT DO
 * NOTHING` — the return is `null` when a prior call already won.
 *
 * Returns the inserted row's id, or `null` if the insert was skipped by the
 * idempotency guard. If the `balance_after >= 0` CHECK would be violated
 * (an oversell), the insert throws and the whole transaction rolls back —
 * that error is the caller's (`reserve`'s) to catch and translate.
 */
async function appendLedgerRow(
  tx: Tx,
  row: {
    walletId: string;
    delta: number;
    source: string;
    bucket: Bucket;
    ref?: string | null;
    spentByOrgId?: string | null;
    idempotencyKey: string | null;
  },
): Promise<{ id: string } | null> {
  const [prior] = await tx<{ bal: string | null }[]>`
    select coalesce(sum(delta), 0)::text as bal
      from ai_credit_ledger where wallet_id = ${row.walletId}`;
  const balanceAfter = Number(prior?.bal ?? 0) + row.delta;
  const [inserted] = await tx<{ id: string }[]>`
    insert into ai_credit_ledger
      (wallet_id, delta, source, bucket, ref, spent_by_org_id, balance_after, idempotency_key)
    values (${row.walletId}, ${row.delta}, ${row.source}, ${row.bucket}, ${row.ref ?? null},
            ${row.spentByOrgId ?? null}, ${balanceAfter}, ${row.idempotencyKey})
    on conflict (idempotency_key) do nothing
    returning id`;
  return inserted ?? null;
}

/**
 * The monthly grant: `ai.credits.monthly(planKey) * quantityPaid` credits
 * (SPEC-2 §5.4 D1, §11.2 — scales the grant to a billing group's paid seats;
 * a standalone org is `quantityPaid = 1`).
 *
 * **Use-or-lose (D1, Task 6 review CRITICAL 1):** before adding this period's
 * allowance, whatever is left in the `grant` bucket from the PRIOR period is
 * expired — a single compensating `source='expiry'`, `bucket='grant'` row
 * whose `delta` is the negative of the current grant-bucket balance. Net
 * effect: after this call the `grant` bucket holds exactly this period's
 * amount, never a carried-forward bank. The `pack` bucket (purchased packs,
 * D2) is never touched here — `bucketBalance`/`appendLedgerRow` are scoped to
 * `bucket = 'grant'` throughout.
 *
 * **`periodKey`** identifies "this period" for both the expiry guard and the
 * grant idempotency key. Callers that have a real billing-cycle boundary
 * (a subscription's `current_period_end`, which only changes when Stripe
 * actually rolls the period — see `grantMonthlyForAllWallets`) should pass
 * that; it defaults to the calendar month (`monthlyPeriod()`) for direct
 * callers/tests and for wallets with no such boundary (Community).
 *
 * **Atomic + idempotent per `(wallet_id, period)`:** the whole
 * expire-then-grant sequence runs inside one transaction, serialized per
 * wallet by the same `pg_advisory_xact_lock` idiom `reserve()` uses (so two
 * overlapping cron invocations for the same wallet can't race each other). A
 * pre-check for an existing `monthly:${walletId}:${period}` row short-circuits
 * to a no-op BEFORE the expiry runs — so a second call in the same period
 * neither re-expires nor double-grants, even though by then the grant bucket
 * again holds a positive balance (this period's own grant) that would
 * otherwise look like "leftover to expire". A plan with no
 * `ai.credits.monthly` row (or `quantityPaid` of 0) grants nothing and never
 * touches the ledger (no expiry either — nothing to reset against a grant
 * that never happens).
 *
 * Returns the credits actually granted this call (0 if skipped).
 */
export async function grantMonthly(
  walletId: string,
  planKey: string,
  quantityPaid: number,
  periodKey?: string,
): Promise<number> {
  const [entitlement] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.monthly'`;
  const perSeat = entitlement?.int_value ?? 0;
  const delta = perSeat * quantityPaid;
  if (delta <= 0) return 0;

  const period = periodKey ?? monthlyPeriod();
  const key = `monthly:${walletId}:${period}`;

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;

    const [already] = await tx<{ id: string }[]>`
      select id from ai_credit_ledger where idempotency_key = ${key}`;
    if (already) return 0; // this period already granted — no re-expiry, no double grant.

    const leftover = await bucketBalance(tx, walletId, "grant");
    if (leftover > 0) {
      await appendLedgerRow(tx, {
        walletId,
        delta: -leftover,
        source: "expiry",
        bucket: "grant",
        idempotencyKey: `monthly-expiry:${walletId}:${period}`,
      });
    }

    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta,
      source: "monthly_grant",
      bucket: "grant",
      idempotencyKey: key,
    });
    return inserted ? delta : 0;
  });
}

/**
 * Cron entry point (Task 6, `api/cron/billing-grant`): grant every LIVE
 * subscription row its monthly allowance for this period.
 *
 * Every org — paid or Community — has a `subscriptions` row (a group-of-one
 * when not actually grouped, `lib/auth.ts`'s `createOrgForUser`), so a single
 * scan of `subscriptions` covers both halves of SPEC-2 §11.2 without a
 * separate "orgs with no group" pass: a paid plan grants
 * `ai.credits.monthly(plan) * quantity_paid` (scaled to seats); `community`
 * grants a FLAT 10 regardless of `quantity_paid` — §11.2 is explicit that
 * Community is "never grouped" and never seat-scaled, even though its
 * group-of-one row technically carries a `quantity_paid` column.
 *
 * The `exists (... organizations ...)` guard skips a group with no live org
 * left in it (an orphan the empty-group cleanup hasn't caught yet, or a
 * community group whose org was soft-deleted) — no wallet left to spend a
 * grant from.
 *
 * **Anchor (Task 6 review MEDIUM, README §7 item 7):** paid subscriptions
 * key their period off `current_period_end` — the exact Stripe billing-cycle
 * boundary Stripe itself only advances via webhook sync on the true renewal
 * day, so `periodKey = cpe:<current_period_end>` naturally changes exactly
 * once per real billing cycle (many daily cron polls between renewals see
 * the same value and no-op via `grantMonthly`'s idempotency check; the poll
 * right after a renewal sync sees a new value and grants+resets). This is
 * the real billing-cycle anchor the design calls for, not an approximation.
 * **Accepted simplification:** Community rows carry no Stripe subscription
 * and so no `current_period_end` (`createOrgForUser` never sets one) —
 * these fall back to `monthlyPeriod()`'s plain calendar month rather than a
 * true creation-day anchor, which would need day-of-month/month-length
 * clamping (e.g. an org created on the 31st) for no real benefit (Community
 * grants a flat, non-scaled 10/mo regardless of anchor day). This is safe:
 * calendar-month can grant up to ~29 days later/earlier than the "true"
 * creation-day, but per `grantMonthly`'s own idempotency it can never
 * double-grant or skip a month either way.
 *
 * One wallet's failure (a bad plan_key, a transient DB error) is logged and
 * skipped rather than aborting the whole sweep, matching
 * `reconcileGroupQuantities`'s per-group try/catch.
 */
export async function grantMonthlyForAllWallets(): Promise<{ wallets: number; granted: number }> {
  const rows = await sql<
    { id: string; plan_key: string; quantity_paid: number; current_period_end: string | Date | null }[]
  >`
    select s.id, s.plan_key, s.quantity_paid, s.current_period_end from subscriptions s
     where s.status in ('trialing', 'active', 'past_due')
       and exists (
             select 1 from organizations o
              where o.subscription_id = s.id and o.deleted_at is null)`;
  let granted = 0;
  for (const row of rows) {
    try {
      const qty = row.plan_key === "community" ? 1 : row.quantity_paid;
      const periodKey = row.current_period_end
        ? `cpe:${new Date(row.current_period_end).toISOString()}`
        : undefined; // Community — no Stripe period boundary; grantMonthly falls back to calendar month.
      granted += await grantMonthly(row.id, row.plan_key, qty, periodKey);
    } catch (err) {
      console.error(`[credits] monthly grant failed for wallet ${row.id}`, err);
    }
  }
  return { wallets: rows.length, granted };
}

/**
 * The one-time trial grant (SPEC-2 §5.4): `ai.credits.trial` (default 20,
 * pro / pro_plus only — community and event_pass carry no matrix row for
 * this key, so they simply grant nothing). **Once per org**, guarded by the
 * org's billing-group `subscriptions.trial_used_at` — the same "has this org
 * ever had a paid trial" marker `checkoutTrialDays` reads (`lib/billing.ts`,
 * V277's one-trial-per-org flag). Reusing it is deliberate, not incidental:
 * SPEC-2 §5.4 names `trial_used_at` as the guard, bundling the 14-day
 * checkout trial and the 20 free AI credits into one "first time on Pro"
 * moment rather than tracking two independent one-shot flags. Wiring exactly
 * when this is called relative to checkout/sync is a later task; this
 * function only owns the guard-and-grant, atomically (`for update` on the
 * subscription row) so two concurrent calls can't both see it unused.
 *
 * An org with no billing group at all (never subscribed) has no
 * `subscriptions` row to guard on and gets nothing here — expected, since
 * Community never carries `ai.credits.trial` either.
 *
 * Returns the credits actually granted this call (0 if ineligible or the
 * trial was already used).
 */
export async function grantTrial(orgId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const [row] = await tx<
      { subscription_id: string; plan_key: string | null; trial_used_at: string | null }[]
    >`
      select s.id as subscription_id, s.plan_key, s.trial_used_at
        from organizations o
        join subscriptions s on s.id = o.subscription_id
       where o.id = ${orgId}
       for update of s`;
    if (!row || row.trial_used_at) return 0;
    return grantTrialForRow(tx, row.subscription_id, row.plan_key);
  });
}

/**
 * The trial-grant primitive `grantTrial` (above) and `syncSubscriptionForGroup`
 * (`lib/billing.ts`, v17 Task 6) both build on: given a subscription row
 * ALREADY locked (`for update`) by the caller in an open transaction, and the
 * plan key to grant against, insert the `ai.credits.trial` row and stamp
 * `trial_used_at` if eligible.
 *
 * Split out so `syncSubscriptionForGroup` can decide the grant from the SAME
 * lock it takes to stamp `trial_used_at` itself — sharing one transaction is
 * what makes "trial credits land before/with the stamp, never after" atomic
 * rather than a best-effort ordering. The caller is responsible for the
 * `for update` lock and for checking `trial_used_at is null` first (this
 * function does not re-check — `grantTrial` above checks via its own `row`
 * read; `syncSubscriptionForGroup` checks via its own).
 *
 * Takes `planKey` explicitly rather than re-reading `subscriptions.plan_key`:
 * a caller mid-sync (a brand-new paid subscription is still `'community'` in
 * the DB until its own UPDATE commits) must pass the plan this grant is
 * ABOUT to apply, or the `ai.credits.trial` matrix lookup silently reads the
 * wrong (usually pre-upgrade) plan and grants 0.
 */
export async function grantTrialForRow(
  tx: Tx,
  subscriptionId: string,
  planKey: string | null,
): Promise<number> {
  const [entitlement] = await tx<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.trial'`;
  const delta = entitlement?.int_value ?? 0;
  if (delta <= 0) return 0;

  const inserted = await appendLedgerRow(tx, {
    walletId: subscriptionId,
    delta,
    source: "trial_grant",
    bucket: "grant",
    idempotencyKey: `trial:${subscriptionId}`,
  });
  if (!inserted) return 0;

  await tx`
    update subscriptions set trial_used_at = now()
     where id = ${subscriptionId} and trial_used_at is null`;
  return delta;
}

/**
 * Reserve `cost` credits against `walletId` for an AI run started by `orgId`
 * (SPEC-2 §5.2 step 2, §5.4 spend order). The ledger's `source` CHECK has no
 * distinct "hold" value, so the hold IS the debit from the moment it's
 * written — one or two `run_spend` rows (see below) with `ref` left `null`
 * until `settle()` links the eventual `ai_run_id`.
 *
 * **Grant-first spend order (§5.4):** the debit draws from `grantBalance`
 * before touching `packBalance` — `g = min(cost, grantBalance)`,
 * `p = cost - g` — so a run never wastes a paid pack credit while free/trial
 * grant balance remains. This writes **one ledger row per non-zero bucket**
 * (never a mixed-bucket row, so a future grant reset stays a single `expiry`
 * row against the grant bucket alone, untouched packs and all). Returns the
 * row id(s) as a comma-joined "hold id" — a single id when the whole cost
 * came from one bucket (the common case), two comma-joined ids when the
 * spend straddled both. `settle`/`release` below both accept either shape.
 *
 * **Oversell guard:** the ledger has no counter row to `select ... for
 * update`, so two concurrent reserves against the same wallet are
 * serialized with a `pg_advisory_xact_lock` on the wallet id (the same
 * idiom `schedule.ts`/`stages.ts` use to serialize per-division writes) —
 * without it, two transactions could both read the same prior sum and both
 * insert a `balance_after` that individually satisfies `>= 0` while the
 * true post-insert total goes negative (classic lost-update; the CHECK
 * alone can't see other rows). With the lock, the second reserve computes
 * its balance from the first's committed result and its insert either
 * succeeds or trips the CHECK — translated here to `PaymentRequiredError`
 * (402) rather than a raw Postgres error. Both the grant-bucket and
 * pack-bucket debit for one reserve happen inside this same locked section,
 * so a split spend is atomic too.
 */
export async function reserve(walletId: string, orgId: string, cost: number): Promise<string> {
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new Error(`reserve: cost must be a positive integer, got ${cost}`);
  }
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;

      const grantAvailable = Math.max(0, await bucketBalance(tx, walletId, "grant"));
      const grantCut = Math.min(cost, grantAvailable);
      const packCut = cost - grantCut;

      const ids: string[] = [];
      for (const [bucket, cut] of [
        ["grant", grantCut],
        ["pack", packCut],
      ] as const) {
        if (cut <= 0) continue;
        const inserted = await appendLedgerRow(tx, {
          walletId,
          delta: -cut,
          source: "run_spend",
          bucket,
          spentByOrgId: orgId,
          idempotencyKey: null,
        });
        // idempotencyKey is null, which never conflicts under the unique
        // constraint (Postgres treats every NULL as distinct) — appendLedgerRow
        // always inserts here, or the CHECK aborts the transaction first (see
        // catch below). `inserted` is therefore never null on this path; the
        // fallback is only to satisfy the type checker.
        ids.push(inserted?.id ?? "");
      }
      return ids.join(",");
    });
  } catch (err) {
    if (isCheckViolation(err)) throw new PaymentRequiredError("ai.credits");
    throw err;
  }
}

/**
 * Settle a hold (SPEC-2 §5.2 step 4a): the AI run succeeded, so link every
 * row of the hold to the `ai_run_id` it paid for (a hold is one row, or two
 * comma-joined ids when `reserve()` split the spend across both buckets —
 * see `reserve`). No new row — the hold already moved the balance when
 * `reserve()` wrote it; this only backfills `ref`.
 *
 * **Idempotent:** the `where ref is null` guard means a second `settle()`
 * call for the same hold — whatever `aiRunId` it's called with — is a
 * no-op that leaves the original link(s) untouched, rather than an error or
 * a silent overwrite.
 *
 * Returns whether this call was the one that linked it (`false` if the
 * hold doesn't exist, isn't a `run_spend` row, or was already settled).
 */
export async function settle(holdId: string, aiRunId: string): Promise<boolean> {
  const ids = holdId.split(",");
  const rows = await sql<{ id: string }[]>`
    update ai_credit_ledger
       set ref = ${aiRunId}
     where id in ${sql(ids)} and source = 'run_spend' and ref is null
    returning id`;
  return rows.length > 0;
}

/**
 * Release a hold (SPEC-2 §5.2 step 4b): the AI run failed, so refund the
 * cost via a compensating credit row per original row (net zero — the user
 * isn't charged for our error) rather than deleting or editing the original
 * hold (the ledger is append-only, it's money). Each refund lands back in
 * the same bucket its debit came from, so a split grant+pack spend refunds
 * to grant and pack independently.
 *
 * **Not-yet-settled guard:** only holds with `ref is null` are refunded — a
 * hold with `ref` already set means the AI run genuinely happened and
 * incurred real COGS (`settle()` linked it), so releasing it would hand back
 * a credit for consumed work rather than for our error. This mirrors
 * `settle()`'s own `ref is null` check from the other direction.
 *
 * **Idempotent per hold:** each compensating row is keyed
 * `release:${rowId}`, so a second `release()` of the same hold is a
 * no-op (`ON CONFLICT DO NOTHING`) — no double refund.
 *
 * Throws if no row of the hold exists at all (a caller bug — an unknown
 * `holdId`). Returns the total refunded across the hold's row(s) — 0 if
 * every row was already settled or already released.
 */
export async function release(holdId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const ids = holdId.split(",");
    const holds = await tx<{ id: string; wallet_id: string; delta: number; bucket: Bucket; ref: string | null }[]>`
      select id, wallet_id, delta, bucket, ref from ai_credit_ledger
       where id in ${tx(ids)} and source = 'run_spend'`;
    if (holds.length === 0) throw new Error(`release: no hold ${holdId}`);

    let total = 0;
    for (const hold of holds) {
      if (hold.ref !== null) continue; // already settled — a real run
      // happened and incurred real COGS; refunding it would hand back a
      // credit for consumed work, not for our error.
      const cost = -hold.delta;
      const inserted = await appendLedgerRow(tx, {
        walletId: hold.wallet_id,
        delta: cost,
        source: "refund",
        bucket: hold.bucket,
        ref: hold.id,
        idempotencyKey: `release:${hold.id}`,
      });
      if (inserted) total += cost;
    }
    return total;
  });
}

/**
 * The full spend cycle (SPEC-2 §5.2): reserve → run `fn` → settle on
 * success, or release + rethrow on failure. This is what the AI usecases
 * call (Task 4) instead of touching `reserve`/`settle`/`release` directly.
 *
 * `fn` is expected to perform the metered work (the model call) and return
 * the `ai_run_id` it produced alongside its own result — `settle` needs
 * that id to link the ledger row (SPEC-2 §5.3, `ref → ai_runs`). If the
 * wallet has insufficient balance, `reserve` throws `PaymentRequiredError`
 * (402) and `fn` never runs at all — no partial charge, no partial run.
 *
 * **Only a failure of `fn` itself refunds.** If `fn` throws (model error,
 * timeout, ...) no run happened and no COGS was incurred, so the hold is
 * released before the error is rethrown — a failed run never costs a
 * credit. But if `fn` *succeeds* and it is `settle()` that then throws (a DB
 * blip linking `ref`, say), the run genuinely happened and genuinely cost
 * real COGS — releasing in that case would hand back a credit for consumed
 * work, exactly what `release()`'s not-yet-settled guard exists to prevent.
 * So that failure is only logged and rethrown, never released.
 */
export async function spendCredit<T>(
  walletId: string,
  orgId: string,
  cost: number,
  fn: () => Promise<{ aiRunId: string; result: T }>,
): Promise<T> {
  const holdId = await reserve(walletId, orgId, cost);
  let ran: { aiRunId: string; result: T };
  try {
    ran = await fn();
  } catch (err) {
    await release(holdId);
    throw err;
  }
  try {
    await settle(holdId, ran.aiRunId);
  } catch (err) {
    console.error(
      `[credits] settle failed for hold ${holdId} (run ${ran.aiRunId}) — NOT releasing, the run already consumed COGS`,
      err,
    );
    throw err;
  }
  return ran.result;
}
