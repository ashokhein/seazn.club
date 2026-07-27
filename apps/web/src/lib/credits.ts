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
  return walletBalance(sql, walletId);
}

/** `sum(delta)` over the whole wallet, against any executor — the shared read
 *  behind `balance()` (plain client) and the in-transaction balance readbacks
 *  `adminAdjust` returns after a locked grant/deduct. */
async function walletBalance(exec: Executor, walletId: string): Promise<number> {
  const [row] = await exec<{ bal: string | null }[]>`
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
 *  `YYYY-MM`) — the ONLY anchor `grantMonthly` uses, for every wallet, paid
 *  or Community (SPEC-2 §5.4 Cadence: "grant is monthly regardless of
 *  billing cadence"). Deliberately has no notion of a subscription's Stripe
 *  billing cycle at all — an annual-billed plan's `current_period_end` only
 *  advances once a year, so keying off it (a prior version of this module
 *  did, for paid wallets) collapses 12 monthly grants into a single lump on
 *  the renewal date, which is the exact regression this cadence rule exists
 *  to forbid. */
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
    // Attribution for staff-written rows (admin_adjust, SPEC-3 §1/§2): who and
    // why. Null on every machine-written row (grant/spend/refund/expiry).
    createdBy?: string | null;
    reason?: string | null;
  },
): Promise<{ id: string } | null> {
  const [prior] = await tx<{ bal: string | null }[]>`
    select coalesce(sum(delta), 0)::text as bal
      from ai_credit_ledger where wallet_id = ${row.walletId}`;
  const balanceAfter = Number(prior?.bal ?? 0) + row.delta;
  const [inserted] = await tx<{ id: string }[]>`
    insert into ai_credit_ledger
      (wallet_id, delta, source, bucket, ref, spent_by_org_id, balance_after,
       idempotency_key, created_by, reason)
    values (${row.walletId}, ${row.delta}, ${row.source}, ${row.bucket}, ${row.ref ?? null},
            ${row.spentByOrgId ?? null}, ${balanceAfter}, ${row.idempotencyKey},
            ${row.createdBy ?? null}, ${row.reason ?? null})
    on conflict (idempotency_key) do nothing
    returning id`;
  return inserted ?? null;
}

/**
 * The monthly grant: `ai.credits.monthly(planKey) * quantityPaid` credits
 * (SPEC-2 §5.4 D1, §11.2 — scales the grant to a billing group's paid seats;
 * a standalone org is `quantityPaid = 1`).
 *
 * **Cadence is monthly regardless of billing interval (SPEC-2 §5.4 Cadence
 * — CRITICAL regression fix):** the period is always the calendar month
 * (`monthlyPeriod()`, `YYYY-MM`, server clock), for every wallet, paid or
 * Community. An annual-billed Pro subscription ($159/yr) still gets 60/mo
 * granted 12 times across the year — NOT a single 720 lump on its one
 * yearly renewal. This function has no notion of Stripe's billing cycle at
 * all; it must never be keyed off `subscriptions.current_period_end` — a
 * prior version of the cron (`grantMonthlyForAllWallets`) did exactly that
 * for paid wallets, which collapses to one grant per YEAR for any
 * annual-interval plan, since `current_period_end` only advances on the
 * true (yearly) renewal.
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
): Promise<number> {
  const [entitlement] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.monthly'`;
  const perSeat = entitlement?.int_value ?? 0;
  const delta = perSeat * quantityPaid;
  if (delta <= 0) return 0;

  const period = monthlyPeriod();
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
 * **Anchor (README §7 item 7; Task 6 re-review CRITICAL fix): calendar month
 * for EVERY wallet, paid or Community — never `current_period_end`.** An
 * earlier version of this sweep keyed paid subscriptions off
 * `subscriptions.current_period_end` on the theory that it tracked "the real
 * billing cycle" — but SPEC-2 §5.4's Cadence rule is explicit that the grant
 * is monthly *regardless of billing cadence* (an annual Pro at $159/yr must
 * still get 60/mo × 12, not a single 720 lump). Since `current_period_end`
 * for an annual-interval subscription only advances once a year, that
 * anchor silently collapsed 12 grants into 1 for every annual org — a
 * cadence regression, not an approximation. `grantMonthly`'s own
 * `monthlyPeriod()` (plain `YYYY-MM`, server clock) is now the only anchor
 * this function uses, for both paid and Community wallets alike; every live
 * wallet gets a fresh grant once per calendar month, independent of what
 * Stripe's billing interval or renewal date happen to be.
 *
 * One wallet's failure (a bad plan_key, a transient DB error) is logged and
 * skipped rather than aborting the whole sweep, matching
 * `reconcileGroupQuantities`'s per-group try/catch — `failed` is returned
 * (mirroring `reconcileGroupQuantities`'s own `{checked, corrected, failed}`
 * shape) so the caller (the cron route, then `billing-grant.yml`) can warn
 * on a persistent per-wallet grant failure instead of it going unnoticed.
 */
export async function grantMonthlyForAllWallets(): Promise<{
  wallets: number;
  granted: number;
  failed: number;
}> {
  const rows = await sql<{ id: string; plan_key: string; quantity_paid: number }[]>`
    select s.id, s.plan_key, s.quantity_paid from subscriptions s
     where s.status in ('trialing', 'active', 'past_due')
       and exists (
             select 1 from organizations o
              where o.subscription_id = s.id and o.deleted_at is null)`;
  let granted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const qty = row.plan_key === "community" ? 1 : row.quantity_paid;
      granted += await grantMonthly(row.id, row.plan_key, qty);
    } catch (err) {
      failed++;
      console.error(`[credits] monthly grant failed for wallet ${row.id}`, err);
    }
  }
  return { wallets: rows.length, granted, failed };
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
 * Record a paid credit pack (SPEC-2 §5.1/§6, v17 Phase 3 Task 1): append a
 * `pack_purchase` row (`bucket='pack'`, never-expire per D2) to the wallet —
 * the ledger row IS the purchase record, per the plan's "prefer the ledger
 * row" note; there is no separate purchases table.
 *
 * **Idempotent on the Stripe id:** `stripeRef` (a payment_intent id, or the
 * checkout session id when no intent is present) becomes both `ref` (the
 * ledger's "which Stripe object paid for this" column, SPEC-2 §5.1) and the
 * `idempotency_key` (`pack:${stripeRef}`) — a webhook replay of the SAME
 * completed checkout conflicts on the unique constraint and no-ops rather
 * than double-crediting, exactly like `grantMonthly`'s per-period key and
 * `grantTrialForRow`'s per-org key.
 *
 * Same advisory-lock idiom as `reserve()`/`grantMonthly()`, even though a
 * pure credit can never trip the `balance_after >= 0` CHECK by itself: without
 * it, two concurrent credits to one wallet (this pack racing another pack, or
 * an admin_adjust) could each read the same prior sum and each write a
 * `balance_after` snapshot that undercounts the other's credit. That is
 * cosmetic for `balance()`/`packBalance()` (always a live `sum(delta)`), but
 * the reconcile job (SPEC-2 §5.3) asserts `balance_after` against that same
 * running sum, so it has to stay accurate.
 *
 * Returns the credits actually granted (0 if this Stripe id was already
 * recorded — a replay).
 */
export async function recordPackPurchase(
  walletId: string,
  credits: number,
  stripeRef: string,
): Promise<number> {
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error(`recordPackPurchase: credits must be a positive integer, got ${credits}`);
  }
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;
    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta: credits,
      source: "pack_purchase",
      bucket: "pack",
      ref: stripeRef,
      idempotencyKey: `pack:${stripeRef}`,
    });
    return inserted ? credits : 0;
  });
}

/**
 * The one-time Event Pass credit grant (SPEC-1 fn3 / SPEC-2 §5, SPEC-6 §A7): a
 * paid Event Pass tops the buyer's wallet up by a fixed one-off grant (the
 * `PASS_CREDIT_GRANT` the /pricing card advertises). Unlike `grantMonthly`, this
 * is NOT a resetting allowance — there is no `ai.credits.monthly` row for
 * `event_pass`, deliberately, so `grantMonthly` never re-grants it; the pass is
 * a single purchase-time top-up, so it lands in the never-expiring **`pack`**
 * bucket (SPEC-2 §5.4 D2) exactly like a bought credit pack, not the use-or-lose
 * `grant` bucket.
 *
 * **Idempotent on the payment intent, falling back to the competition:** the
 * anchor is `paymentIntent ?? competitionId`. A real paid pass carries a Stripe
 * payment intent (unique per purchase); keying `pass_grant:${paymentIntent}`
 * makes a webhook/reconcile replay of that SAME payment conflict on the unique
 * idempotency key and no-op rather than double-granting — while a genuine
 * RE-purchase of the same competition (after a refund revoked the first pass)
 * carries a NEW intent, so it re-grants fresh (review MINOR-2; keying on the
 * competition alone would wrongly suppress the re-grant, since the deleted
 * pass's grant row still occupies `pass_grant:${competitionId}`). A staff-
 * granted / legacy pass carries no intent and falls back to the competition id
 * (always present, and unique per V271's ON CONFLICT (competition_id) — so two
 * intent-less passes for one competition still can't double-grant). The anchor
 * is also stamped as `ref` so the claw-back (`recordPassRefund`) can find this
 * grant by the same value, and for the money trace.
 *
 * Same advisory-lock idiom as `recordPackPurchase` — a pure credit can't trip
 * the `balance_after >= 0` CHECK, but the lock keeps the `balance_after`
 * snapshot accurate under a concurrent credit to the same wallet (the reconcile
 * job asserts against it).
 *
 * Returns the credits actually granted (0 if this purchase's grant was already
 * recorded — a replay).
 */
export async function recordPassGrant(
  walletId: string,
  credits: number,
  competitionId: string,
  paymentIntent?: string | null,
): Promise<number> {
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error(`recordPassGrant: credits must be a positive integer, got ${credits}`);
  }
  const anchor = paymentIntent ?? competitionId;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;
    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta: credits,
      source: "pass_grant",
      bucket: "pack",
      ref: anchor,
      idempotencyKey: `pass_grant:${anchor}`,
    });
    return inserted ? credits : 0;
  });
}

/**
 * Per-source earn amounts + the lifetime cap (SPEC-5 §2 — the PLG "earn free
 * credits" loop). All three are tunable knobs that bound COGS: the two grant
 * amounts are what an org gets for each milestone, and `LIFETIME_EARN_CAP` is
 * the hard ceiling on how many `earn_grant` credits ANY single wallet can ever
 * accrue across all earn sources combined — so the loop can never mint unbounded
 * free credits no matter how many milestones an org hits (or a referral source a
 * later task adds). Defaults: 10 for onboarding, 10 for the first paid
 * competition, 100 lifetime — a new org can earn its way to at most 100 free
 * credits ($25 of COGS at $0.25/credit) before every further earn no-ops.
 */
export const ONBOARDING_EARN = 10;
export const FIRST_PAID_EARN = 10;
export const LIFETIME_EARN_CAP = 100;

/** Referrer's reward when a referred org reaches its first paid competition (SPEC-5 §2). */
export const REFERRAL_EARN = 20;
/** A newly-referred org's welcome credits at signup-via-referral (SPEC-5 §2). */
export const REFERRAL_WELCOME_EARN = 10;

/**
 * Grant an org free AI credits for a growth milestone (SPEC-5 §2): onboarding
 * completion or its first paid competition. Mirror of `recordPassGrant` — the
 * credits land in the never-expire **`pack`** bucket (SPEC-2 §5.4 D2, earned
 * credits are kept, not the monthly-reset `grant` bucket), `source='earn_grant'`,
 * under the same wallet advisory lock every credit write takes.
 *
 * **Idempotent on `earn:${reason}:${ref}`:** the caller chooses `ref` so each
 * milestone fires at most once — `ref = orgId` for BOTH sources here. Onboarding
 * is naturally once-per-org (one org, one onboarding). "First paid competition"
 * is made once-per-ORG by keying on the org, NOT the competition:
 * `earn:first_paid:${orgId}` — so the org's first paid competition grants and
 * every later paid competition conflicts on the unique key and no-ops (simpler
 * and correct vs a separate "has any prior paid comp" query). A replay of the
 * same milestone grants nothing.
 *
 * **Lifetime earn cap (money-safety):** before granting, sum this wallet's
 * existing `earn_grant` credits and grant only `min(amount, LIFETIME_EARN_CAP −
 * alreadyEarned)`, floored at 0 — so the total earned can never exceed the cap
 * even across sources (a wallet 5 below the cap earning 10 gets exactly 5; a
 * wallet at the cap gets 0 and writes no row). The read+cap+insert all sit under
 * the advisory lock so two concurrent earns can't both see the same headroom and
 * jointly overshoot the cap.
 *
 * Returns the credits actually granted this call (`{ granted: 0 }` on a replay
 * or when the cap leaves no headroom).
 */
export async function recordEarnGrant(
  walletId: string,
  orgId: string,
  reason: "onboarding" | "first_paid" | "referral" | "referral_welcome",
  ref: string,
  amount: number,
): Promise<{ granted: number }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`recordEarnGrant: amount must be a positive integer, got ${amount}`);
  }
  const key = `earn:${reason}:${ref}`;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;

    // Idempotency pre-check under the lock (same shape as grantMonthly): a
    // milestone already granted (or a cap-floored partial grant already
    // recorded) short-circuits to a no-op before we touch the ledger again.
    const [already] = await tx<{ id: string }[]>`
      select id from ai_credit_ledger where idempotency_key = ${key}`;
    if (already) return { granted: 0 };

    // Lifetime earn cap: how much this wallet has earned across ALL earn
    // sources, so the ceiling is enforced pool-wide, not per source.
    const [earned] = await tx<{ total: string | null }[]>`
      select coalesce(sum(delta), 0)::text as total
        from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'earn_grant'`;
    const alreadyEarned = Math.max(0, Number(earned?.total ?? 0));
    const grantable = Math.max(0, Math.min(amount, LIFETIME_EARN_CAP - alreadyEarned));
    if (grantable <= 0) return { granted: 0 };

    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta: grantable,
      source: "earn_grant",
      bucket: "pack",
      ref,
      spentByOrgId: orgId,
      idempotencyKey: key,
    });
    return { granted: inserted ? grantable : 0 };
  });
}

/**
 * Best-effort wrapper around `recordEarnGrant` for the growth-loop HOOK sites
 * (onboarding-complete route + the Event Pass checkout webhook, SPEC-5 §2 B/C).
 * Resolves the wallet and grants, but NEVER throws — a credit-grant failure must
 * not fail the onboarding flow or the money-row webhook it rides on (same
 * discipline as the other post-commit grants in `billing-events.ts` and the
 * bootstrap grant in `createOrgForUser`). Logs and returns 0 on any error.
 *
 * `ref = orgId` for both sources: onboarding is one-per-org, and first_paid is
 * keyed on the org (not the competition) so ONLY the org's first paid
 * competition grants (see `recordEarnGrant`'s idempotency note).
 */
export async function tryEarnGrant(
  orgId: string,
  reason: "onboarding" | "first_paid" | "referral" | "referral_welcome",
  amount: number,
): Promise<number> {
  try {
    const walletId = await walletIdFor(orgId);
    const { granted } = await recordEarnGrant(walletId, orgId, reason, orgId, amount);
    return granted;
  } catch (err) {
    console.error(`[credits] earn grant failed (org ${orgId}, ${reason})`, err);
    return 0;
  }
}

/**
 * Claw back a refunded / disputed Event Pass grant (SPEC-2 §5, money-safety):
 * a `charge.refunded` or a lost dispute on a pass charge revokes the pass, so
 * the one-time `PASS_CREDIT_GRANT` it added must be pulled back — mirror of
 * `recordPackRefund` for the pass's `pass_grant` row. Without this the pass
 * entitlement is revoked but the 25 credits stay (a ~$6.25/cycle leak, farmable
 * by cycling buy→refund).
 *
 * `anchor` is the same value `recordPassGrant` stamped as `ref` and keyed on:
 * the Stripe payment intent for a real paid pass (the revoke paths carry it on
 * the charge / dispute), or the competition id for an intent-less pass. The buy
 * and refund paths MUST agree on it or nothing matches.
 *
 * **Never over-claws, never goes negative, never touches `grant`:** the debit
 * is `min(originalGrant, packBalance)` — capped so it can neither exceed what
 * the pass granted NOR drive the `pack` bucket below zero (credits the buyer
 * already spent are gone; we don't retro-charge them). Only the never-expire
 * `pack` bucket the grant landed in is read/written; the resetting `grant`
 * bucket (monthly/trial) is a separate pool a pass refund must never expire.
 *
 * **Under the SAME wallet advisory lock the spend path takes** (`reserve`): the
 * `packBalance` read and the debit insert sit inside one `pg_advisory_xact_lock`'d
 * transaction on the wallet, so a spend racing this claw-back can't lost-update
 * the balance. The immutable `pass_grant` row (its `wallet_id` never changes) is
 * read first to LEARN which wallet to lock; the balance-sensitive read+write
 * then all sit under the lock.
 *
 * **Idempotent on `pass_refund:${anchor}`:** a replayed refund, a
 * refund-then-dispute, or a double webhook conflict on the unique idempotency
 * key and no-op (`ON CONFLICT DO NOTHING`) — the pass is clawed back exactly
 * once. Uses the existing `refund` source (already enumerated by the ledger's
 * source CHECK — no new migration); a pass refund's `ref` is the anchor, never
 * a `run_spend` hold id, so it can't match a hold in `spentThisPeriodByOrg`
 * (identical to how `recordPackRefund`'s refund rows stay out of that derive).
 *
 * Returns `{matched:false}` when no `pass_grant` row exists for this anchor
 * (a non-pass charge, or an intent-less pass never granted). Otherwise
 * `{matched:true, clawedBack}` where `clawedBack` is the credits debited THIS
 * call (0 if all were already spent, or on a replay the earlier call clawed).
 */
export async function recordPassRefund(
  anchor: string,
): Promise<{ clawedBack: number; matched: boolean }> {
  return sql.begin(async (tx) => {
    const [grant] = await tx<{ wallet_id: string; delta: number }[]>`
      select wallet_id, delta from ai_credit_ledger
       where source = 'pass_grant' and ref = ${anchor}`;
    if (!grant) return { clawedBack: 0, matched: false };

    const walletId = grant.wallet_id;
    await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;

    const originalGrant = grant.delta;
    const pb = await bucketBalance(tx, walletId, "pack");
    const clawback = Math.min(originalGrant, Math.max(0, pb));
    if (clawback <= 0) return { clawedBack: 0, matched: true };

    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta: -clawback,
      source: "refund",
      bucket: "pack",
      ref: anchor,
      idempotencyKey: `pass_refund:${anchor}`,
    });
    return { clawedBack: inserted ? clawback : 0, matched: true };
  });
}

/**
 * Claw back a refunded credit pack (SPEC-2 §5, v17 Phase 3 Task 4): a Stripe
 * `charge.refunded` for a pack purchase debits ONLY the credits the customer
 * has not yet spent from the `pack` bucket. `stripeRef` is the same value
 * `recordPackPurchase` stamped as `ref` (the payment_intent id) — the buy and
 * refund paths MUST agree on it or nothing matches.
 *
 * **Never over-claws, never goes negative, never touches `grant`:** the debit
 * is `min(originalGrant, packBalance)` — capped so it can neither exceed what
 * the purchase granted (a customer who bought two packs and spent from one
 * keeps the other's credits) NOR drive the `pack` bucket below zero (credits
 * already spent are gone; we don't retro-charge them). Only the `pack` bucket
 * is read/written; the resetting `grant` bucket (monthly/trial) is a separate
 * pool and a refund of a paid pack must never expire free grant credits.
 *
 * **Under the SAME wallet advisory lock the spend path takes** (`reserve`):
 * the `packBalance` read and the debit insert happen inside one
 * `pg_advisory_xact_lock`'d transaction on the wallet, so a spend racing this
 * refund can't lost-update the balance — without it, a concurrent reserve and
 * this claw-back could both read the same `packBalance` and each write a
 * `balance_after` that individually satisfies `>= 0` while the true post-write
 * total oversells (the exact hazard `reserve`'s lock exists for). The
 * immutable `pack_purchase` row (its `wallet_id` never changes) is read first
 * to LEARN which wallet to lock; the balance-sensitive read+write then all sit
 * under the lock.
 *
 * **Idempotent on `pack_refund:${stripeRef}`:** a replayed `charge.refunded`
 * conflicts on the unique idempotency key and no-ops (`ON CONFLICT DO
 * NOTHING`) — the pack is clawed back exactly once no matter how many times
 * Stripe redelivers the event.
 *
 * Returns `{matched:false}` when no `pack_purchase` row exists for this ref
 * (the caller decides silent-no-op vs staff-alert — a non-pack charge vs a
 * paid-but-never-granted pack). Otherwise `{matched:true, clawedBack}` where
 * `clawedBack` is the credits debited THIS call (0 if all were already spent,
 * or on a replay the earlier call already clawed).
 */
export async function recordPackRefund(
  stripeRef: string,
): Promise<{ clawedBack: number; matched: boolean }> {
  return sql.begin(async (tx) => {
    const [purchase] = await tx<{ wallet_id: string; delta: number }[]>`
      select wallet_id, delta from ai_credit_ledger
       where source = 'pack_purchase' and ref = ${stripeRef}`;
    if (!purchase) return { clawedBack: 0, matched: false };

    const walletId = purchase.wallet_id;
    await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;

    const originalGrant = purchase.delta;
    const pb = await bucketBalance(tx, walletId, "pack");
    const clawback = Math.min(originalGrant, Math.max(0, pb));
    if (clawback <= 0) return { clawedBack: 0, matched: true };

    const inserted = await appendLedgerRow(tx, {
      walletId,
      delta: -clawback,
      source: "refund",
      bucket: "pack",
      ref: stripeRef,
      idempotencyKey: `pack_refund:${stripeRef}`,
    });
    return { clawedBack: inserted ? clawback : 0, matched: true };
  });
}

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
 *
 * **Also used by the ATTACH path**, which reaches the same forfeit whenever the
 * old group still holds live sibling orgs (attachOrgToGroup, billing-groups.ts)
 * — that wallet is a shared pool too, so the joiner takes no share of it and
 * only a SOLE org's wallet is merged. Both paths write the same action name, so
 * `via` records which one produced the row; without it the two are
 * indistinguishable in `staff_audit_log`.
 */
export async function auditWalletForfeitedOnDetach(
  tx: Tx,
  actorUserId: string,
  orgId: string,
  oldWalletId: string,
  newWalletId: string,
  via: "attach" | "detach",
): Promise<void> {
  const grant = Math.max(0, await bucketBalance(tx, oldWalletId, "grant"));
  const pack = Math.max(0, await bucketBalance(tx, oldWalletId, "pack"));
  await tx`
    insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
    values (${actorUserId}, 'billing_group.detach_wallet_not_carried', 'org', ${orgId},
            ${tx.json({
              old_wallet_id: oldWalletId,
              new_wallet_id: newWalletId,
              via,
              old_wallet_balance_left_behind: { grant, pack },
            } as never)})`;
}

/**
 * Net credits `orgId` has spent on `walletId` THIS calendar month (SPEC-5 §1) —
 * the derived quantity the operator allocation cap is checked against. There is
 * deliberately NO `spent_this_period` counter: the ledger is the single source
 * of truth (no reset job, no drift, no reserve/settle race), and the spend is
 * already recorded as the `run_spend` hold tagged `spent_by_org_id = orgId`.
 *
 * **Nets refunds via the ref link, not a tag.** A failed run's `release()`
 * writes a `source='refund'` row with `ref = hold.id` and NO `spent_by_org_id`
 * (it doesn't re-tag the org), so the derive nets each hold by summing the
 * refund rows that reference it — a released/failed run correctly gives its
 * allowance back without touching `release()`. Pack refunds also use
 * `source='refund'` but `ref` = a payment-intent id, never a `run_spend` row
 * id, so they can't match a hold here.
 *
 * **Period bound** = `date_trunc('month', now())`, the same calendar-month
 * anchor `grantMonthly` resets on — so the cap resets implicitly with the grant
 * cycle. A hold from a prior month is excluded (its refund, if any, is moot —
 * only holds inside the period are summed). Runs inside the caller's executor
 * (`reserve`'s advisory-locked tx) so the check sees this reserve's own prior
 * writes. Returns a non-negative integer.
 *
 * Exported (Phase 6 Task 2, SPEC-5 §1) so the operator allocation console
 * (`server/usecases/operator-allocation.ts`) reports each member org's burn
 * from the SAME derive the `reserve()` cap gate checks against — one source of
 * truth for the period-spend rule. The console passes the plain `sql` client
 * (a read, no transaction); `reserve` passes its advisory-locked `tx`.
 */
export async function spentThisPeriodByOrg(
  exec: Executor,
  walletId: string,
  orgId: string,
): Promise<number> {
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
       and h.created_at >= date_trunc('month', now())`;
  return Math.max(0, Number(row?.spent ?? 0));
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

      // Operator allocation cap (SPEC-5 §1): a member org on a shared group
      // wallet can be capped to a per-month credit share. NO row = free-for-all
      // (spend up to the pool); NULL cap = unlimited share; a number = a HARD
      // cap. Checked HERE, inside the advisory lock and BEFORE the bucket cuts,
      // so the derive sees this reserve's own prior holds and the cap stays
      // tight under concurrency (no over-spend race). A cap hit emits a DISTINCT
      // 402 `ai.credits.allocation` (UI: "ask your operator to raise your cap")
      // vs the pool-empty `ai.credits` ("buy credits") thrown by the CHECK below.
      const [alloc] = await tx<{ monthly_cap: number | null }[]>`
        select monthly_cap from org_credit_allocation
         where wallet_id = ${walletId} and org_id = ${orgId}`;
      if (alloc && alloc.monthly_cap != null) {
        const spent = await spentThisPeriodByOrg(tx, walletId, orgId);
        if (spent + cost > alloc.monthly_cap) {
          throw new PaymentRequiredError("ai.credits.allocation");
        }
      }

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

/**
 * A staff credit DEDUCT that would drive the wallet (or a bucket) below zero
 * (SPEC-3 §2 "no adjustment can push a balance below 0"). Thrown by
 * `adminAdjust`; the admin credits route maps it to HTTP 422. A distinct typed
 * error (not the spend path's `PaymentRequiredError`/402) because this is a
 * staff mis-click on an over-large clawback, not an org running out of credit
 * mid-run.
 */
export class InsufficientBalanceError extends Error {
  constructor(message = "This deduction would drive the wallet below zero.") {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

/**
 * The staff grant/deduct primitive (SPEC-3 §1, the first adjustment
 * write-path; reuses SPEC-2 §5.1's `admin_adjust` source + `created_by` +
 * `reason` — no new store). Appends attributed `admin_adjust` ledger row(s)
 * to a wallet the caller has already resolved via `walletIdFor(orgId)` (SPEC-2
 * §11), so the adjustment benefits every org in a billing group.
 *
 * **Bucket (SPEC-2 §5.4 / V321):** a POSITIVE grant lands in the resetting
 * `grant` bucket — the bucket `admin_adjust` writes per V321's own column
 * comment — unless `opts.bucket` pins it (e.g. a comped pack into `pack`). A
 * DEDUCT burns grant-first then pack (the same spend order `reserve()` uses),
 * so a clawback never wastes a paid pack credit while free grant remains, and
 * writes one row per bucket it touches.
 *
 * **Never below zero (§2):** the whole read→compute→insert runs inside one
 * transaction serialized per wallet by the same
 * `pg_advisory_xact_lock(hashtext('ai-credit-wallet:' || walletId))` idiom
 * `reserve()`/`grantMonthly()` take, so a deduct racing a spend can't
 * lost-update the balance. A deduct larger than the wallet's total balance is
 * refused with `InsufficientBalanceError` before any row is written — the
 * ledger stays append-only (a deduct is a negative row, never an edit/delete).
 *
 * **Idempotent (§2 "no double-grant on double-click"):** a replay of the same
 * `idempotencyKey` finds the prior row (checked under the lock) and no-ops,
 * returning `{ applied: false, balanceAfter: <current> }`. A straddling deduct
 * writes its second (pack) row under a derived key so both rows satisfy the
 * unique constraint while a replay still conflicts on the base key.
 *
 * **Self-audits atomically (PR-B follow-up):** when `opts.audit` is given, the
 * `staff_audit_log` row for this adjustment is written INSIDE this same
 * `sql.begin` transaction, right after the ledger delta — so the money move
 * and its audit trail commit or roll back together (a crash between the
 * ledger write and a separate post-commit `logStaffAction` call used to be
 * able to leave an adjustment with no audit row). Only written on a real
 * applied adjustment: the idempotent-replay early-return above skips it, so a
 * double-click never writes a second audit row either.
 */
export async function adminAdjust(
  walletId: string,
  delta: number,
  opts: {
    createdBy: string;
    reason: string;
    idempotencyKey: string;
    bucket?: Bucket;
    /** Staff-audit target for this adjustment. Omit only for a caller that
     *  audits itself some other way; every current caller (the admin credits
     *  route) passes this. `target_type` is always `"org"` here. */
    audit?: { orgId: string; action: string; details?: Record<string, unknown> };
  },
): Promise<{ applied: boolean; balanceAfter: number }> {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error(`adminAdjust: delta must be a non-zero integer, got ${delta}`);
  }
  const { createdBy, reason, idempotencyKey, audit } = opts;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + walletId}))`;

    const [already] = await tx<{ id: string }[]>`
      select id from ai_credit_ledger where idempotency_key = ${idempotencyKey}`;
    if (already) {
      return { applied: false, balanceAfter: await walletBalance(tx, walletId) };
    }

    async function auditApplied(balanceAfter: number): Promise<void> {
      if (!audit) return;
      await tx`
        insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
        values (${createdBy}, ${audit.action}, 'org', ${audit.orgId},
                ${tx.json({ ...audit.details, balance_after: balanceAfter } as never)})`;
    }

    if (delta > 0) {
      await appendLedgerRow(tx, {
        walletId,
        delta,
        source: "admin_adjust",
        bucket: opts.bucket ?? "grant",
        createdBy,
        reason,
        idempotencyKey,
      });
      const balanceAfter = await walletBalance(tx, walletId);
      await auditApplied(balanceAfter);
      return { applied: true, balanceAfter };
    }

    const need = -delta;
    const grantAvail = Math.max(0, await bucketBalance(tx, walletId, "grant"));
    const packAvail = Math.max(0, await bucketBalance(tx, walletId, "pack"));
    if (grantAvail + packAvail < need) {
      throw new InsufficientBalanceError(
        `adminAdjust: deduct of ${need} exceeds wallet ${walletId} balance ${grantAvail + packAvail}`,
      );
    }
    const grantCut = Math.min(need, grantAvail);
    const packCut = need - grantCut;
    let usedKey = false;
    for (const [bucket, cut] of [
      ["grant", grantCut],
      ["pack", packCut],
    ] as const) {
      if (cut <= 0) continue;
      await appendLedgerRow(tx, {
        walletId,
        delta: -cut,
        source: "admin_adjust",
        bucket,
        createdBy,
        reason,
        idempotencyKey: usedKey ? `${idempotencyKey}#${bucket}` : idempotencyKey,
      });
      usedKey = true;
    }
    const balanceAfter = await walletBalance(tx, walletId);
    await auditApplied(balanceAfter);
    return { applied: true, balanceAfter };
  });
}

/**
 * The org-facing label for a staff credit adjustment in the org's OWN history
 * (SPEC-3 §5) — "+20 credits — Seazn goodwill". The internal `reason_code`
 * (`sales_comp`, etc.) is operational and stays internal; this maps it to warm
 * public phrasing and must NEVER echo the raw code. A deduct reads as a
 * neutral "Account adjustment" regardless of code (a removal isn't goodwill),
 * and any unrecognised code falls back to the same neutral phrase rather than
 * leaking. The org-history VIEW that renders this is SPEC-6; this is data only.
 */
export function friendlyAdjustLabel(deltaSign: 1 | -1, reason_code: string): string {
  if (deltaSign < 0) return "Account adjustment";
  switch (reason_code) {
    case "support_goodwill":
    case "promo":
    case "bug_fix":
      return "Seazn goodwill";
    case "sales_comp":
      return "Account credit";
    case "refund_adjust":
      return "Refund adjustment";
    default:
      return "Account adjustment";
  }
}
