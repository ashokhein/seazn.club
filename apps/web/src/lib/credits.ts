import "server-only";
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
    const [prior] = await tx<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger where wallet_id = ${walletId}`;
    const balanceAfter = Number(prior?.bal ?? 0) + delta;
    const [row] = await tx<{ id: string }[]>`
      insert into ai_credit_ledger
        (wallet_id, delta, source, balance_after, idempotency_key)
      values (${walletId}, ${delta}, 'monthly_grant', ${balanceAfter},
              ${`monthly:${walletId}:${monthlyPeriod()}`})
      on conflict (idempotency_key) do nothing
      returning id`;
    return row ? delta : 0;
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
    const [prior] = await tx<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger where wallet_id = ${walletId}`;
    const balanceAfter = Number(prior?.bal ?? 0) + delta;
    const [granted] = await tx<{ id: string }[]>`
      insert into ai_credit_ledger
        (wallet_id, delta, source, balance_after, idempotency_key)
      values (${walletId}, ${delta}, 'trial_grant', ${balanceAfter},
              ${`trial:${walletId}`})
      on conflict (idempotency_key) do nothing
      returning id`;
    if (!granted) return 0;

    await tx`
      update subscriptions set trial_used_at = now()
       where id = ${walletId} and trial_used_at is null`;
    return delta;
  });
}
