// AI credit wallet — reserve/settle/release spend (v17 SPEC-2 §5.2, §5.4).
//
// reserve() writes the debit row(s) immediately (the "hold" IS a `run_spend`
// row from the start — the ledger's `source` CHECK has no separate hold
// enum, SPEC-2 §5.1) with `ref` left null; settle() backfills `ref =
// ai_run_id` once the model call succeeds; release() writes a compensating
// `refund` row (net zero) when it doesn't, but only for a hold that isn't
// already settled. `spendCredit()` chains reserve → fn → settle, releasing
// only when `fn` itself throws — never when a post-success `settle()` fails,
// since that would refund a run that genuinely happened.
//
// Spend draws grant-bucket credits before pack-bucket ones (§5.4); a spend
// that straddles both writes one row per bucket sharing a single comma-joined
// "hold id" (see reserve()'s doc comment in lib/credits.ts).
//
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  balance,
  grantBalance,
  packBalance,
  release,
  reserve,
  settle,
  spendCredit,
} from "@/lib/credits";
import { PaymentRequiredError } from "@/lib/errors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

// spendCredit's settle()/release() calls are internal to lib/credits.ts, so a
// vi.spyOn(creditsModule, "settle") does NOT intercept them (same-module ESM
// calls bind directly, not through the exported namespace — verified: a spy
// there sees 0 calls while the real settle() still runs). @/lib/db is a real
// module boundary credits.ts imports across, so wrapping ITS `sql` export
// lets one test force a single settle() query to throw a genuine error
// without touching credits.ts or faking a DB outage for every query.
let failNextSettleQuery = false;
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const sqlProxy = new Proxy(actual.sql, {
    apply(target, thisArg, args) {
      const strings = args[0];
      const text = Array.isArray(strings) ? strings.join(" ") : "";
      // "set ref =" only appears in settle()'s UPDATE — reserve()/release()
      // never set that column (insert-only), so this can't misfire on them.
      if (failNextSettleQuery && text.includes("set ref =")) {
        failNextSettleQuery = false;
        throw new Error("simulated settle failure (DB blip)");
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  return { ...actual, sql: sqlProxy };
});

/** Seed a wallet balance directly (bypassing grant helpers — these tests are
 *  about spend, not grant). Defaults to the grant bucket (a monthly grant);
 *  pass bucket: "pack" to seed a purchased-pack balance instead. */
async function seedWalletBalance(
  walletId: string,
  delta: number,
  source = "monthly_grant",
  bucket: "grant" | "pack" = "grant",
): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${walletId}, ${delta}, ${source}, ${bucket}, ${delta}, ${`seed-${uniq()}`})`;
}

describe.skipIf(!HAS_DB)("ai credit wallet — spend (reserve/settle/release)", () => {
  afterEach(() => {
    failNextSettleQuery = false;
  });

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
    await seedWalletBalance(walletId, 10, "monthly_grant", "grant");
    await seedWalletBalance(walletId, 5, "pack_purchase", "pack");
    expect(await balance(walletId)).toBe(15);

    // Cost exceeds the grant-only balance (10) — the spend must draw across
    // the whole pool (dipping into the pack credits) rather than being
    // blocked as though grant credits were the only spendable balance.
    await reserve(walletId, orgId, 12);
    expect(await balance(walletId)).toBe(3);
    // The pooled total (3) is compatible with several splits — pin the
    // per-bucket accounting explicitly (SPEC-2 §5.4): grant is drained to 0
    // first, only the excess (2) comes out of pack (5 - 2 = 3).
    expect(await grantBalance(walletId)).toBe(0);
    expect(await packBalance(walletId)).toBe(3);
  });

  it("bucket accounting — grant 3 + pack 5, spend 4: grantBalance 0 / packBalance 4, not pooled", async () => {
    const walletId = randomUUID();
    const orgId = randomUUID();
    await seedWalletBalance(walletId, 3, "monthly_grant", "grant");
    await seedWalletBalance(walletId, 5, "pack_purchase", "pack");
    expect(await balance(walletId)).toBe(8);

    await reserve(walletId, orgId, 4);

    // A pooled ledger would just show 4 left; bucket accounting must show
    // the grant bucket fully drained (3 of the 4 came from grant) and only
    // the 1-credit remainder taken from pack.
    expect(await grantBalance(walletId)).toBe(0);
    expect(await packBalance(walletId)).toBe(4);
    expect(await balance(walletId)).toBe(4);
  });

  it("an expiry row against the grant bucket leaves the pack bucket untouched", async () => {
    const walletId = randomUUID();
    await seedWalletBalance(walletId, 10, "monthly_grant", "grant");
    await seedWalletBalance(walletId, 6, "pack_purchase", "pack");
    expect(await grantBalance(walletId)).toBe(10);
    expect(await packBalance(walletId)).toBe(6);

    // Simulate a future grant reset (Task 6): a single compensating `expiry`
    // row against the grant bucket only.
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, -10, 'expiry', 'grant', 6, ${`expire-${uniq()}`})`;

    expect(await grantBalance(walletId)).toBe(0);
    expect(await packBalance(walletId)).toBe(6);
    expect(await balance(walletId)).toBe(6);
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

  it("refuses to refund an already-settled hold — the run happened, it is not our error", async () => {
    const walletId = randomUUID();
    const orgId = randomUUID();
    const aiRunId = randomUUID();
    await seedWalletBalance(walletId, 10);
    const holdId = await reserve(walletId, orgId, 4);
    expect(await settle(holdId, aiRunId)).toBe(true);
    expect(await balance(walletId)).toBe(6);

    // release() must NOT refund a settled hold — the run genuinely consumed
    // the credit. If it did, this would silently hand back a credit for
    // work that already incurred real COGS.
    expect(await release(holdId)).toBe(0);
    expect(await balance(walletId)).toBe(6);
    const [row] = await sql<{ source: string }[]>`
      select source from ai_credit_ledger where ref = ${holdId}`;
    expect(row).toBeUndefined(); // no compensating refund row was written
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

    it("does NOT refund when fn succeeds but settle() throws — the run already happened and cost COGS", async () => {
      const walletId = randomUUID();
      const orgId = randomUUID();
      const aiRunId = randomUUID();
      await seedWalletBalance(walletId, 10);
      failNextSettleQuery = true;

      // fn() itself succeeds (the model call ran and returned a result) —
      // only the settle() that links the ledger row afterward fails.
      await expect(
        spendCredit(walletId, orgId, 4, async () => ({ aiRunId, result: "ok" as const })),
      ).rejects.toThrow("simulated settle failure");

      // The hold must stay debited — refunding here would be a free credit
      // for a run that genuinely happened (Finding #2). Contrast with the
      // "releases and rethrows on failure" test above, where fn() itself
      // throwing DOES refund (net zero) because no run happened there.
      expect(await balance(walletId)).toBe(6);
      const [row] = await sql<{ ref: string | null }[]>`
        select ref from ai_credit_ledger where wallet_id = ${walletId} and delta = -4`;
      expect(row?.ref).toBeNull(); // settle() never got to link the run id
    });
  });
});
