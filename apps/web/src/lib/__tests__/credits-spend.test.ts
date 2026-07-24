// AI credit wallet — reserve/settle/release spend (v17 SPEC-2 §5.2).
//
// reserve() writes the debit row immediately (the "hold" IS a `run_spend` row
// from the start — the ledger's `source` CHECK has no separate hold enum,
// SPEC-2 §5.1) with `ref` left null; settle() backfills `ref = ai_run_id`
// once the model call succeeds; release() writes a compensating `refund` row
// (net zero) when it doesn't. `spendCredit()` chains reserve → fn → settle,
// or release + rethrow on failure.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, release, reserve, settle, spendCredit } from "@/lib/credits";
import { PaymentRequiredError } from "@/lib/errors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Seed a wallet balance directly (bypassing grant helpers — these tests are
 *  about spend, not grant). */
async function seedWalletBalance(
  walletId: string,
  delta: number,
  source = "monthly_grant",
): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, balance_after, idempotency_key)
    values (${walletId}, ${delta}, ${source}, ${delta}, ${`seed-${uniq()}`})`;
}

describe.skipIf(!HAS_DB)("ai credit wallet — spend (reserve/settle/release)", () => {
  it("reserve debits the wallet by cost", async () => {
    const walletId = randomUUID();
    const orgId = randomUUID();
    await seedWalletBalance(walletId, 10);

    await reserve(walletId, orgId, 4);
    expect(await balance(walletId)).toBe(6);
  });

  it("blocks oversell — two concurrent reserves past the balance: one succeeds, one is rejected", async () => {
    const walletId = randomUUID();
    const orgId = randomUUID();
    await seedWalletBalance(walletId, 5);

    const results = await Promise.allSettled([
      reserve(walletId, orgId, 3),
      reserve(walletId, orgId, 3),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PaymentRequiredError);
    // Never negative — the second reserve's debit never landed.
    expect(await balance(walletId)).toBe(2);
  });

  it("spend order — burns grant credits before dipping into paid packs", async () => {
    const walletId = randomUUID();
    const orgId = randomUUID();
    await seedWalletBalance(walletId, 10, "monthly_grant");
    await seedWalletBalance(walletId, 5, "pack_purchase");
    expect(await balance(walletId)).toBe(15);

    // Cost exceeds the grant-only balance (10) — the spend must draw across
    // the whole pool (dipping into the pack credits) rather than being
    // blocked as though grant credits were the only spendable balance.
    await reserve(walletId, orgId, 12);
    expect(await balance(walletId)).toBe(3);
  });

  it("settle links the ai_run id and is idempotent", async () => {
    const walletId = randomUUID();
    const orgId = randomUUID();
    const aiRunId = randomUUID();
    await seedWalletBalance(walletId, 10);
    const holdId = await reserve(walletId, orgId, 4);

    expect(await settle(holdId, aiRunId)).toBe(true);
    const [row] = await sql<{ ref: string | null }[]>`
      select ref from ai_credit_ledger where id = ${holdId}`;
    expect(row?.ref).toBe(aiRunId);

    // Second call for the same hold/run is a no-op, not an error, and does
    // not create a second row or otherwise move the balance.
    expect(await settle(holdId, aiRunId)).toBe(false);
    const [rowAfter] = await sql<{ ref: string | null }[]>`
      select ref from ai_credit_ledger where id = ${holdId}`;
    expect(rowAfter?.ref).toBe(aiRunId);
    expect(await balance(walletId)).toBe(6);
  });

  it("release nets a hold back to zero and is idempotent per hold", async () => {
    const walletId = randomUUID();
    const orgId = randomUUID();
    await seedWalletBalance(walletId, 10);
    const holdId = await reserve(walletId, orgId, 4);
    expect(await balance(walletId)).toBe(6);

    expect(await release(holdId)).toBe(4);
    expect(await balance(walletId)).toBe(10);

    // A second release of the same hold is a no-op — no double refund.
    expect(await release(holdId)).toBe(0);
    expect(await balance(walletId)).toBe(10);
  });

  describe("spendCredit", () => {
    it("reserves, runs fn, and settles on success", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      const aiRunId = randomUUID();
      await seedWalletBalance(walletId, 10);

      const result = await spendCredit(walletId, orgId, 4, async () => ({
        aiRunId,
        result: "ok" as const,
      }));

      expect(result).toBe("ok");
      expect(await balance(walletId)).toBe(6);
      const [row] = await sql<{ ref: string | null; source: string }[]>`
        select ref, source from ai_credit_ledger
         where wallet_id = ${walletId} and delta = -4`;
      expect(row?.source).toBe("run_spend");
      expect(row?.ref).toBe(aiRunId);
    });

    it("releases and rethrows on failure — net zero, no charge for our error", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      await seedWalletBalance(walletId, 10);

      await expect(
        spendCredit(walletId, orgId, 4, async () => {
          throw new Error("model call failed");
        }),
      ).rejects.toThrow("model call failed");

      expect(await balance(walletId)).toBe(10);
    });

    it("throws PaymentRequiredError (402) without running fn when the wallet is empty", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      let ran = false;

      await expect(
        spendCredit(walletId, orgId, 1, async () => {
          ran = true;
          return { aiRunId: randomUUID(), result: "ok" as const };
        }),
      ).rejects.toBeInstanceOf(PaymentRequiredError);
      expect(ran).toBe(false);
      expect(await balance(walletId)).toBe(0);
    });
  });
});
