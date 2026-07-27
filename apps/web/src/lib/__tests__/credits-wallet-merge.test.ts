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
