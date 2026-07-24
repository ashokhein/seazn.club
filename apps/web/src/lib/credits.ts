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

/** A CHECK-constraint violation (Postgres `23514`) — the only error
 *  `ai_credit_ledger`'s `balance_after >= 0` guard can raise. Distinguishes
 *  "this insert would have oversold the wallet" from any other DB failure. */
function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23514"
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

/** Calendar-month period the monthly grant is scoped to (server clock,
 *  `YYYY-MM`). The exact reset ANCHOR (billing-cycle for paid, creation-day
 *  calendar for Community — SPEC-2 §5.4) is the caller's job: this only needs
 *  a value that is stable within one grant window so the idempotency key
 *  can't double-fire, whatever schedule invokes it. */
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
      (wallet_id, delta, source, ref, spent_by_org_id, balance_after, idempotency_key)
    values (${row.walletId}, ${row.delta}, ${row.source}, ${row.ref ?? null},
            ${row.spentByOrgId ?? null}, ${balanceAfter}, ${row.idempotencyKey})
    on conflict (idempotency_key) do nothing
    returning id`;
  return inserted ?? null;
}

/**
 * The monthly grant: `ai.credits.monthly(planKey) * quantityPaid` credits
 * (SPEC-2 §5.4 D1, §11.2 — scales the grant to a billing group's paid seats;
 * a standalone org is `quantityPaid = 1`). **Use-or-lose**: this does not
 * carry a balance forward, it just adds this period's allowance on top of
 * whatever is left.
 *
 * **Idempotent** per `(wallet_id, 'monthly', period)` via `idempotency_key` —
 * a second call for the same wallet in the same calendar month is a no-op
 * (`ON CONFLICT DO NOTHING`), so a cron retry or webhook replay can't
 * double-grant. A plan with no `ai.credits.monthly` row (or `quantityPaid`
 * of 0) grants nothing.
 *
 * Returns the credits actually granted this call (0 if skipped).
 */
export async function grantMonthly(
  walletId: string,
  planKey: string,
  quantityPaid: number,
): Promise<number> {
  const [entitlement] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.monthly'`;
  const perSeat = entitlement?.int_value ?? 0;
  const delta = perSeat * quantityPaid;
  if (delta <= 0) return 0;

  return sql.begin(async (tx) => {
    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta,
      source: "monthly_grant",
      idempotencyKey: `monthly:${walletId}:${monthlyPeriod()}`,
    });
    return inserted ? delta : 0;
  });
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

    const [entitlement] = await tx<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = ${row.plan_key} and feature_key = 'ai.credits.trial'`;
    const delta = entitlement?.int_value ?? 0;
    if (delta <= 0) return 0;

    const walletId = row.subscription_id;
    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta,
      source: "trial_grant",
      idempotencyKey: `trial:${walletId}`,
    });
    if (!inserted) return 0;

    await tx`
      update subscriptions set trial_used_at = now()
       where id = ${walletId} and trial_used_at is null`;
    return delta;
  });
}

/**
 * Reserve `cost` credits against `walletId` for an AI run started by `orgId`
 * (SPEC-2 §5.2 step 2). The ledger's `source` CHECK has no distinct "hold"
 * value, so the hold IS the debit from the moment it's written — a
 * `run_spend` row with `ref` left `null` until `settle()` links the
 * eventual `ai_run_id`. Returns the row's id (the "hold id" `settle`/
 * `release` take).
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
 * (402) rather than a raw Postgres error.
 */
export async function reserve(walletId: string, orgId: string, cost: number): Promise<string> {
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new Error(`reserve: cost must be a positive integer, got ${cost}`);
  }
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;
      const inserted = await appendLedgerRow(tx, {
        walletId,
        delta: -cost,
        source: "run_spend",
        spentByOrgId: orgId,
        idempotencyKey: null,
      });
      // idempotencyKey is null, which never conflicts under the unique
      // constraint (Postgres treats every NULL as distinct) — appendLedgerRow
      // always inserts here, or the CHECK aborts the transaction first (see
      // catch below). `inserted` is therefore never null on this path; the
      // fallback is only to satisfy the type checker.
      return inserted?.id ?? "";
    });
  } catch (err) {
    if (isCheckViolation(err)) throw new PaymentRequiredError("ai.credits");
    throw err;
  }
}

/**
 * Settle a hold (SPEC-2 §5.2 step 4a): the AI run succeeded, so link the
 * hold row to the `ai_run_id` it paid for. No new row — the hold already
 * moved the balance when `reserve()` wrote it; this only backfills `ref`.
 *
 * **Idempotent:** the `where ref is null` guard means a second `settle()`
 * call for the same hold — whatever `aiRunId` it's called with — is a
 * no-op that leaves the original link untouched, rather than an error or a
 * silent overwrite.
 *
 * Returns whether this call was the one that linked it (`false` if the
 * hold doesn't exist, isn't a `run_spend` row, or was already settled).
 */
export async function settle(holdId: string, aiRunId: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    update ai_credit_ledger
       set ref = ${aiRunId}
     where id = ${holdId} and source = 'run_spend' and ref is null
    returning id`;
  return !!row;
}

/**
 * Release a hold (SPEC-2 §5.2 step 4b): the AI run failed, so refund the
 * cost via a compensating credit row (net zero — the user isn't charged
 * for our error) rather than deleting or editing the original hold (the
 * ledger is append-only, it's money).
 *
 * **Idempotent per hold:** the compensating row is keyed
 * `release:${holdId}`, so a second `release()` of the same hold is a
 * no-op (`ON CONFLICT DO NOTHING`) — no double refund.
 *
 * Returns the amount refunded (0 if the hold doesn't exist / isn't a
 * `run_spend` row, or was already released).
 */
export async function release(holdId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const [hold] = await tx<{ wallet_id: string; delta: number }[]>`
      select wallet_id, delta from ai_credit_ledger
       where id = ${holdId} and source = 'run_spend'`;
    if (!hold) throw new Error(`release: no hold ${holdId}`);

    const cost = -hold.delta;
    const inserted = await appendLedgerRow(tx, {
      walletId: hold.wallet_id,
      delta: cost,
      source: "refund",
      ref: holdId,
      idempotencyKey: `release:${holdId}`,
    });
    return inserted ? cost : 0;
  });
}

/**
 * The full spend cycle (SPEC-2 §5.2): reserve → run `fn` → settle on
 * success, or release + rethrow on failure. This is what the AI usecases
 * call (Task 4) instead of touching `reserve`/`settle`/`release` directly.
 *
 * `fn` is expected to perform the metered work (the model call) and return
 * the `ai_run_id` it produced alongside its own result — `settle` needs
 * that id to link the ledger row (SPEC-2 §5.3, `ref → ai_runs`). If `fn`
 * throws (model error, timeout, ...) the hold is released before the error
 * is rethrown, so a failed run never costs a credit. If the wallet has
 * insufficient balance, `reserve` throws `PaymentRequiredError` (402) and
 * `fn` never runs at all — no partial charge, no partial run.
 */
export async function spendCredit<T>(
  walletId: string,
  orgId: string,
  cost: number,
  fn: () => Promise<{ aiRunId: string; result: T }>,
): Promise<T> {
  const holdId = await reserve(walletId, orgId, cost);
  try {
    const { aiRunId, result } = await fn();
    await settle(holdId, aiRunId);
    return result;
  } catch (err) {
    await release(holdId);
    throw err;
  }
}
