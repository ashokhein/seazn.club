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
// `--write` is additionally gated behind RECONCILE_ALLOW=1 so that "staging
// only" is enforced rather than merely documented (see `writeGateBlocked`).
//
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/reconcile-stranded-wallets.ts              # dry run
//   RECONCILE_ALLOW=1 node --env-file-if-exists=apps/web/.env.local \
//     --experimental-strip-types \
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

export type WalletDisposition = "merge" | "no_positive_balance";

/**
 * Whether a stranded wallet has anything that can actually be moved.
 *
 * The stranded SELECT filters on the wallet's NET balance (`<> 0`) so that a
 * NEGATIVE net still gets surfaced — that is a real data-integrity signal and
 * suppressing it would hide it. But nothing can be merged out of such a
 * wallet: each insert is capped at `Math.max(0, bucketBalance)` (mirroring
 * `mergeWalletOnAttach`), and `ai_credit_ledger`'s `balance_after >= 0` CHECK
 * would reject the attempt regardless. Deciding this here keeps the caller
 * from opening a transaction and taking two advisory locks to move zero.
 */
export function classifyBucketAmounts(b: BucketBalances): WalletDisposition {
  return b.grant > 0 || b.pack > 0 ? "merge" : "no_positive_balance";
}

/**
 * Whether a `--write` run must be refused. This script is STAGING ONLY —
 * per #284 production starts at V336 with no pre-existing stranded data, so a
 * `--write` run against prod could only ever be unreviewed ledger surgery.
 * A comment cannot enforce that; this gate can.
 *
 * Requires `RECONCILE_ALLOW` to be exactly `"1"`: near-misses like `"true"`
 * are far likelier to be a mistake than a considered opt-in. A dry run is
 * always permitted — it writes nothing.
 */
export function writeGateBlocked(write: boolean, allow: string | undefined): boolean {
  return write && allow !== "1";
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const WRITE = process.argv.includes("--write");
  if (writeGateBlocked(WRITE, process.env.RECONCILE_ALLOW)) {
    console.error(
      "REFUSED: --write is gated behind RECONCILE_ALLOW=1.\n" +
        "This script is STAGING ONLY: per #284 production starts at V336 with no " +
        "pre-existing stranded data, so there is nothing for it to fix in prod and a " +
        "--write run there would be unreviewed ledger surgery.\n" +
        "Confirm DATABASE_URL points at staging/dev, then re-run with RECONCILE_ALLOW=1.",
    );
    process.exit(1);
  }
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
    let noop = 0;
    let needsReview = 0;

    for (const w of stranded) {
      // Indicative only: read outside any lock, so it is good enough to
      // report and to screen on, but NEVER to size a write. The amount that
      // actually moves is re-read inside the transaction, after both locks.
      const balances: BucketBalances = { grant: Number(w.grant), pack: Number(w.pack) };

      try {
        if (classifyBucketAmounts(balances) === "no_positive_balance") {
          needsReview++;
          console.warn(
            `MANUAL REVIEW: wallet=${w.wallet_id} grant=${balances.grant} pack=${balances.pack} ` +
              `— negative or zero positive balance, data integrity: no merge is possible.`,
          );
          continue;
        }

        const spenders = await sql<{ spent_by_org_id: string | null }[]>`
          select spent_by_org_id from ai_credit_ledger
           where wallet_id = ${w.wallet_id} and spent_by_org_id is not null
           order by created_at desc, id desc`;
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

        if (!WRITE) {
          merged++;
          console.log(
            `WOULD MERGE: wallet=${w.wallet_id} grant=${balances.grant} ` +
              `pack=${balances.pack} -> org=${targetOrgId} wallet=${targetWalletId}`,
          );
          continue;
        }

        const moved = await sql.begin(async (tx) => {
          const result = { grant: 0, pack: 0, wrote: false };
          const [lo, hi] = [w.wallet_id, targetWalletId].sort();
          await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + lo}))`;
          await tx`select pg_advisory_xact_lock(hashtext(${"ai-credit-wallet:" + hi}))`;
          for (const bucket of ["grant", "pack"] as const) {
            // Re-read the bucket INSIDE the transaction, after both locks —
            // exactly as mergeWalletOnAttach does (credits.ts:821). The
            // pre-loop aggregate was taken with no lock held; debiting that
            // stale number could overdraw the bucket and trip the ledger's
            // `balance_after >= 0` CHECK.
            const [cur] = await tx<{ bal: string | null }[]>`
              select coalesce(sum(delta), 0)::text as bal from ai_credit_ledger
               where wallet_id = ${w.wallet_id} and bucket = ${bucket}`;
            const amount = Math.max(0, Number(cur?.bal ?? 0));
            if (amount <= 0) continue;

            const [priorOld] = await tx<{ bal: string | null }[]>`
              select coalesce(sum(delta), 0)::text as bal from ai_credit_ledger
               where wallet_id = ${w.wallet_id}`;
            const [debited] = await tx<{ id: string }[]>`
              insert into ai_credit_ledger
                (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
              values (${w.wallet_id}, ${-amount}, 'group_merge', ${bucket}, ${targetWalletId},
                      ${Number(priorOld?.bal ?? 0) - amount},
                      ${`reconcile-${w.wallet_id}-${bucket}-to-${targetWalletId}`})
              on conflict (idempotency_key) do nothing
              returning id`;
            // Conflict = this exact debit already landed on an earlier run.
            // Skip the matching credit too: the pair is written in one
            // transaction, so a present debit means the credit is present.
            if (!debited) continue;

            const [priorNew] = await tx<{ bal: string | null }[]>`
              select coalesce(sum(delta), 0)::text as bal from ai_credit_ledger
               where wallet_id = ${targetWalletId}`;
            await tx<{ id: string }[]>`
              insert into ai_credit_ledger
                (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
              values (${targetWalletId}, ${amount}, 'group_merge', ${bucket}, ${w.wallet_id},
                      ${Number(priorNew?.bal ?? 0) + amount},
                      ${`reconcile-${targetWalletId}-from-${w.wallet_id}-${bucket}`})
              on conflict (idempotency_key) do nothing
              returning id`;
            result[bucket] = amount;
            result.wrote = true;
          }
          return result;
        });

        if (moved.wrote) {
          merged++;
          console.log(
            `MERGED: wallet=${w.wallet_id} grant=${moved.grant} pack=${moved.pack} ` +
              `-> org=${targetOrgId} wallet=${targetWalletId}`,
          );
        } else {
          noop++;
          console.log(
            `NO-OP: wallet=${w.wallet_id} -> org=${targetOrgId} wallet=${targetWalletId} ` +
              `— already reconciled, or nothing left to move once locked.`,
          );
        }
      } catch (err) {
        // One bad wallet must not abort the remaining run.
        needsReview++;
        console.warn(
          `MANUAL REVIEW: wallet=${w.wallet_id} failed — ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Nothing was written for it (its transaction rolled back); investigate and re-run.`,
        );
      }
    }

    console.log("\n--- summary ---");
    console.log(`Stranded wallets found: ${stranded.length}`);
    console.log(`${WRITE ? "Merged" : "Would merge"}: ${merged}`);
    if (WRITE) console.log(`No-op (already reconciled / nothing left to move): ${noop}`);
    console.log(
      `Needs manual review (no attribution / stale org / no positive balance / failed): ` +
        `${needsReview}`,
    );
    if (!WRITE) console.log("\nDry run complete. Nothing was written. Re-run with --write to apply.");
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
