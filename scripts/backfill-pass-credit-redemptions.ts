// One-off backfill for pass_credit_redemptions (V335, design 2026-07-26 §2).
//
// V335's lifetime cap (`pass_credit_redemptions_group_cap`) only sees
// redemptions written AFTER the table existed. A group that already redeemed
// an Event Pass credit BEFORE V335 shipped has no row, so the cap reads
// clean for it — and it can mint one more real credit, on a different pass,
// the moment it's deployed. This script closes that gap once, up front.
//
// The only durable record of a pre-V335 credit is the Stripe balance
// transaction itself: `creditPassTowardSubscription`
// (apps/web/src/server/usecases/pass-credit.ts) always stamps
// `metadata[pass_payment_intent]` (PASS_CREDIT_INTENT_KEY) and
// `metadata.org_id` on the transaction it creates — the same data
// `alreadyCredited` already reads back. This script walks every subscription
// with a `stripe_customer_id`, lists that customer's balance transactions,
// and reconstructs a redemption row from any transaction carrying that
// metadata.
//
// A group that (pre-V335) collected MORE THAN ONE pass credit is the exact
// stacking bug this whole feature exists to close, and it cannot be fixed
// retroactively here — Stripe has already paid out both. This script inserts
// exactly ONE row per group (the earliest credit, which is the one that
// should have capped it) to close the cap going forward, and prints a loud
// warning for every group where more than one was found, for staff to
// reconcile by hand.
//
// Idempotent / safe to re-run any number of times:
//   - a group that already holds a redemption row the lifetime cap counts
//     (live, or reversed-but-undetermined) is skipped outright
//   - every insert is `on conflict (payment_intent) do nothing`
//
// DRY RUN by default: prints every row it would insert (and every anomaly it
// found) without writing anything. Pass --write to actually insert.
//
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/backfill-pass-credit-redemptions.ts              # dry run
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/backfill-pass-credit-redemptions.ts --write       # applies it
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import Stripe from "stripe";

/** Must stay in sync with PASS_CREDIT_INTENT_KEY in
 *  apps/web/src/server/usecases/pass-credit.ts — this is the metadata key
 *  that marks a Stripe balance transaction as a pass credit. */
const PASS_CREDIT_INTENT_KEY = "pass_payment_intent";

/** The `limit` handed to `autoPagingToArray` below. Exported alongside
 *  `isBalanceHistoryTruncated` purely so the two are pinned together — the
 *  function is meaningless without knowing what cap it is being compared to. */
export const BALANCE_TXN_FETCH_CAP = 1000;

/**
 * Did fetching a customer's balance-transaction history hit the fetch cap
 * given to `autoPagingToArray`, rather than draining the real list?
 *
 * There is no lower bound on how many balance transactions a long-lived
 * Stripe customer can hold, and Stripe lists them NEWEST FIRST — so a
 * customer sitting above the cap silently loses exactly its OLDEST entries,
 * which is precisely where a pre-V335 pass credit lives. A truncated fetch
 * looks byte-for-byte identical to a complete one to everything downstream
 * (same shape array, same code path), so this is the ONLY place that can
 * still tell the difference: the SDK cannot return more than `cap` entries,
 * so an array landing exactly ON the cap means there may have been more that
 * were never fetched. A customer who happens to hold precisely `cap`
 * transactions and no more is a false positive — a wasted manual look — but
 * the alternative (treating it as complete) is a false negative that can
 * silently drop money. Loud-by-default is the only direction this bound can
 * safely be wrong in.
 */
export function isBalanceHistoryTruncated(fetchedCount: number, cap: number): boolean {
  return fetchedCount >= cap;
}

/**
 * Does this billing group already hold a redemption that the lifetime cap
 * counts? If so there is nothing to backfill for it — and nothing to even read
 * from Stripe.
 *
 * The predicate MUST mirror `pass_credit_redemptions_group_cap` exactly
 * (V335, widened by V337 / #286): `reversed_at is null or
 * reversal_undetermined_at is not null`. An UNDETERMINED reversal (reversed_at
 * stamped as the webhook-idempotency marker, but nothing actually clawed back)
 * still holds the index. Reading it as "free" is wrong in both directions at
 * once:
 *   - the group looks un-capped, so the script reconstructs a redemption for a
 *     group that already has one — a money leak, since the earlier credit was
 *     never recovered; and
 *   - the insert below is `on conflict (payment_intent) do nothing`, which only
 *     absorbs the SAME intent. A DIFFERENT intent for the same subscription
 *     raises 23505 on the group-cap index, and this loop body is NOT wrapped in
 *     a try/catch — one such group would abort the entire backfill run.
 *
 * Same shape as `groupAlreadyRedeemed` in
 * apps/web/src/server/usecases/pass-credit.ts; kept as a separate copy because
 * scripts/ cannot import from apps/web/src/lib (server-only). Exported so the
 * predicate can be pinned against a real database from apps/web's test suite.
 */
export async function groupAlreadyCapped(
  sql: ReturnType<typeof postgres>,
  subscriptionId: string,
): Promise<boolean> {
  const [row] = await sql<{ one: number }[]>`
    select 1 as one from pass_credit_redemptions
    where subscription_id = ${subscriptionId}
      and (reversed_at is null or reversal_undetermined_at is not null)
    limit 1`;
  return !!row;
}

interface Candidate {
  orgId: string;
  intent: string;
  amountMinor: number;
  currency: string;
  createdAt: Date;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set.");
    process.exit(1);
  }
  const WRITE = process.argv.includes("--write");
  console.log(`Stripe mode: ${key.includes("_test_") ? "TEST" : "LIVE"}`);
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
  const stripe = new Stripe(key);

  try {
    const subs = await sql<{ id: string; stripe_customer_id: string }[]>`
      select id, stripe_customer_id from subscriptions
      where stripe_customer_id is not null
      order by id`;
    console.log(`Scanning ${subs.length} subscription(s) with a Stripe customer...\n`);

    let alreadyCapped = 0;
    let candidatesFound = 0;
    let inserted = 0;
    let skippedNoCompetition = 0;
    let skippedGroupMismatch = 0;
    let skippedStripeUnreadable = 0;
    let skippedDbError = 0;
    const stackedGroups: string[] = [];
    const truncatedCustomers: string[] = [];

    for (const sub of subs) {
      // Already capped — nothing to backfill, and nothing to even look at on
      // Stripe for this group.
      if (await groupAlreadyCapped(sql, sub.id)) {
        alreadyCapped++;
        continue;
      }

      // A stale/deleted stripe_customer_id (real in a long-lived test
      // database, and not impossible in prod) must not kill the whole run —
      // "unproven state yields no credit" applies to a backfill too: skip
      // this one subscription and keep going.
      let txns: Stripe.CustomerBalanceTransaction[];
      try {
        txns = await stripe.customers
          .listBalanceTransactions(sub.stripe_customer_id, { limit: 100 })
          .autoPagingToArray({ limit: BALANCE_TXN_FETCH_CAP });
      } catch (err) {
        skippedStripeUnreadable++;
        console.warn(
          `SKIP subscription=${sub.id} customer=${sub.stripe_customer_id}: ` +
            `could not list balance transactions (${err instanceof Error ? err.message : err})`,
        );
        continue;
      }

      // The array coming back exactly AT the cap is the only signal that
      // there may be more history behind it — and Stripe lists newest first,
      // so anything beyond the cap is the OLDEST entries, exactly where a
      // pre-V335 credit lives. A truncated fetch prints and processes
      // identically to a complete one otherwise, so make this customer loud
      // rather than silently under-scanning it.
      if (isBalanceHistoryTruncated(txns.length, BALANCE_TXN_FETCH_CAP)) {
        truncatedCustomers.push(
          `subscription=${sub.id} customer=${sub.stripe_customer_id} ` +
            `(fetched ${txns.length} of possibly more balance transactions)`,
        );
        console.warn(
          `TRUNCATED: subscription=${sub.id} customer=${sub.stripe_customer_id}: ` +
            `balance-transaction history hit the ${BALANCE_TXN_FETCH_CAP}-transaction fetch ` +
            `cap. Stripe lists newest first, so OLDEST transactions — where a pre-V335 pass ` +
            `credit would be — may be missing from this scan. This run is INCOMPLETE for this ` +
            `customer; needs a manual look regardless of what (if anything) was found below.`,
        );
      }

      const candidates: Candidate[] = [];
      for (const txn of txns) {
        const intent = txn.metadata?.[PASS_CREDIT_INTENT_KEY];
        const orgId = txn.metadata?.org_id;
        if (!intent || !orgId) continue;
        // The grant is always NEGATIVE (a credit). A POSITIVE transaction
        // carrying this same metadata is the compensating reversal
        // (pass-credit.ts's lost-race path) — it must never be read back as
        // a live credit.
        if (txn.amount >= 0) continue;
        candidates.push({
          orgId,
          intent,
          amountMinor: -txn.amount,
          currency: txn.currency,
          createdAt: new Date(txn.created * 1000),
        });
      }
      if (candidates.length === 0) continue;
      candidatesFound++;

      // Oldest first: the earliest genuine grant is the one that should have
      // capped the group, so it's the one to backfill.
      candidates.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (candidates.length > 1) {
        stackedGroups.push(
          `subscription ${sub.id}: ${candidates.length} pass credits found ` +
            `(intents: ${candidates.map((c) => c.intent).join(", ")}, total ` +
            `${candidates.reduce((s, c) => s + c.amountMinor, 0)} minor units) — ` +
            `pre-V335 stacking, needs manual staff review; only the earliest is backfilled here`,
        );
      }

      const chosen = candidates[0]!;

      // competition_id is NOT NULL on pass_credit_redemptions and is not on
      // the Stripe transaction, so it has to come from the pass row the
      // credit was earned from.
      //
      // Same rule as the Stripe fetch above: a transient Postgres error here
      // (connection blip, pool exhaustion) must not abort the whole run —
      // skip THIS subscription and keep going, consistent with the
      // skip-and-continue already applied to the Stripe call.
      let pass: { competition_id: string } | undefined;
      try {
        [pass] = await sql<{ competition_id: string }[]>`
          select competition_id from competition_passes
          where org_id = ${chosen.orgId} and stripe_payment_intent = ${chosen.intent}
          limit 1`;
      } catch (err) {
        skippedDbError++;
        console.warn(
          `SKIP subscription=${sub.id} org=${chosen.orgId} intent=${chosen.intent}: ` +
            `could not read competition_passes (${err instanceof Error ? err.message : err}) ` +
            `— transient DB error, re-run to retry this subscription`,
        );
        continue;
      }
      if (!pass) {
        skippedNoCompetition++;
        console.warn(
          `SKIP subscription=${sub.id} org=${chosen.orgId} intent=${chosen.intent}: ` +
            `no matching competition_passes row (deleted?) — cannot backfill without a ` +
            `competition_id; needs manual review`,
        );
        continue;
      }

      // The org must still belong to THIS subscription — a group is the cap
      // key, so a stale metadata.org_id from an org that has since moved to
      // a different group would cap the wrong group.
      let org: { subscription_id: string | null } | undefined;
      try {
        [org] = await sql<{ subscription_id: string | null }[]>`
          select subscription_id from organizations where id = ${chosen.orgId}`;
      } catch (err) {
        skippedDbError++;
        console.warn(
          `SKIP subscription=${sub.id} org=${chosen.orgId} intent=${chosen.intent}: ` +
            `could not read organizations (${err instanceof Error ? err.message : err}) ` +
            `— transient DB error, re-run to retry this subscription`,
        );
        continue;
      }
      if (!org || org.subscription_id !== sub.id) {
        skippedGroupMismatch++;
        console.warn(
          `SKIP subscription=${sub.id} org=${chosen.orgId} intent=${chosen.intent}: ` +
            `org no longer belongs to this subscription (moved groups?) — needs manual review`,
        );
        continue;
      }

      console.log(
        `${WRITE ? "INSERT" : "WOULD INSERT"}: subscription=${sub.id} org=${chosen.orgId} ` +
          `competition=${pass.competition_id} intent=${chosen.intent} ` +
          `amount=${chosen.amountMinor} ${chosen.currency} ` +
          `redeemed_at=${chosen.createdAt.toISOString()}`,
      );

      if (WRITE) {
        const result = await sql`
          insert into pass_credit_redemptions
            (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency, redeemed_at)
          values (${sub.id}, ${chosen.orgId}, ${pass.competition_id}, ${chosen.intent},
                  ${chosen.amountMinor}, ${chosen.currency}, ${chosen.createdAt})
          on conflict (payment_intent) do nothing
          returning id`;
        if (result.length) inserted++;
      } else {
        inserted++;
      }
    }

    console.log("\n--- summary ---");
    console.log(`Subscriptions scanned: ${subs.length}`);
    console.log(`Already capped (row exists): ${alreadyCapped}`);
    console.log(`Groups with a pre-V335 credit found: ${candidatesFound}`);
    console.log(`${WRITE ? "Inserted" : "Would insert"}: ${inserted}`);
    console.log(`Skipped — no matching competition_passes row: ${skippedNoCompetition}`);
    console.log(`Skipped — org no longer in this group: ${skippedGroupMismatch}`);
    console.log(`Skipped — Stripe customer unreadable: ${skippedStripeUnreadable}`);
    console.log(`Skipped — transient DB error (re-run to retry): ${skippedDbError}`);
    console.log(
      `Balance history TRUNCATED (hit the ${BALANCE_TXN_FETCH_CAP}-transaction cap): ` +
        `${truncatedCustomers.length}`,
    );
    if (stackedGroups.length) {
      console.log(`\nSTACKED GROUPS — ${stackedGroups.length} found, needs manual staff review:`);
      for (const line of stackedGroups) console.log(`  ${line}`);
    }
    if (truncatedCustomers.length) {
      console.log(
        `\nTRUNCATED CUSTOMERS — ${truncatedCustomers.length} found. This run is INCOMPLETE ` +
          `for them: Stripe lists balance transactions newest first, so their OLDEST entries — ` +
          `exactly where a pre-V335 pass credit would be — were not scanned. Needs a manual ` +
          `look; do not trust a clean result for these customers:`,
      );
      for (const line of truncatedCustomers) console.log(`  ${line}`);
    }
    if (!WRITE) {
      console.log("\nDry run complete. Nothing was written. Re-run with --write to apply.");
    }
    // An incomplete run must not look identical to a complete one from the
    // exit code alone — CI or a human running this unattended needs a signal
    // that survives past the scrollback.
    if (truncatedCustomers.length) {
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

// Only run when invoked as a script.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
