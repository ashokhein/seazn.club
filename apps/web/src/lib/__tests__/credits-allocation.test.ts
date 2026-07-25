// AI credit wallet — operator per-org monthly allocation cap (v17 SPEC-5 §1).
//
// A Pro Plus operator runs ONE shared group wallet (SPEC-2 §11); every member
// org spends from the same pool. org_credit_allocation (V329) lets the operator
// set a per-member HARD monthly cap, enforced at spend time INSIDE reserve()'s
// advisory-lock transaction (derive-then-check-then-write, so it's tight under
// concurrency). The org's spend-this-period is DERIVED from the ledger (no
// counter): the sum of its run_spend holds since date_trunc('month', now()),
// each netted by its refund row (refund.ref = hold.id) so a failed/released run
// gives its allowance back. A cap hit emits a DISTINCT 402
// `ai.credits.allocation` (vs the pool-empty `ai.credits`).
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, release, reserve } from "@/lib/credits";
import { PaymentRequiredError } from "@/lib/errors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Seed a wallet balance directly (bypassing grant helpers). */
async function seedWalletBalance(
  walletId: string,
  delta: number,
  bucket: "grant" | "pack" = "grant",
): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${walletId}, ${delta}, 'monthly_grant', ${bucket}, ${delta}, ${`seed-${uniq()}`})`;
}

/** A real org row — org_credit_allocation.org_id FKs organizations(id). */
async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Alloc ${uniq()}`}, ${`alloc-${uniq()}`})
    returning id`;
  return org!.id;
}

/** Set (or clear) a per-(wallet, org) monthly cap. cap === null → unlimited. */
async function seedAllocation(
  walletId: string,
  orgId: string,
  cap: number | null,
): Promise<void> {
  await sql`
    insert into org_credit_allocation (wallet_id, org_id, monthly_cap)
    values (${walletId}, ${orgId}, ${cap})`;
}

describe.skipIf(!HAS_DB)("ai credit wallet — operator allocation cap", () => {
  it("1. no allocation row → free-for-all: org spends up to the whole pool", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    await seedWalletBalance(walletId, 10);

    await reserve(walletId, orgId, 10); // no cap row → allowed to drain the pool
    expect(await balance(walletId)).toBe(0);
  });

  it("2. NULL cap → unlimited: org is pool-bounded only", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    await seedWalletBalance(walletId, 10);
    await seedAllocation(walletId, orgId, null);

    await reserve(walletId, orgId, 10);
    expect(await balance(walletId)).toBe(0);
  });

  it("3. under cap → allowed: cap 5, spent 3, a 1-credit run succeeds", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    await seedWalletBalance(walletId, 100);
    await seedAllocation(walletId, orgId, 5);

    await reserve(walletId, orgId, 3); // spent = 3
    await reserve(walletId, orgId, 1); // 3 + 1 = 4 <= 5 → allowed
    expect(await balance(walletId)).toBe(96);
  });

  it("4. at/over cap → 402 ai.credits.allocation, and writes NO hold", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    await seedWalletBalance(walletId, 100);
    await seedAllocation(walletId, orgId, 5);

    await reserve(walletId, orgId, 5); // spent = 5, exactly at cap
    expect(await balance(walletId)).toBe(95);

    let thrown: unknown;
    try {
      await reserve(walletId, orgId, 1); // 5 + 1 = 6 > 5 → blocked
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PaymentRequiredError);
    expect((thrown as PaymentRequiredError).featureKey).toBe("ai.credits.allocation");
    // No hold written — the gate fires before the bucket cut.
    expect(await balance(walletId)).toBe(95);
  });

  it("5. a failed run refunds the allocation (ref-join derive nets it out)", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    await seedWalletBalance(walletId, 100);
    await seedAllocation(walletId, orgId, 2);

    const holdId = await reserve(walletId, orgId, 2); // spent = 2, at cap
    await release(holdId); // failed run → refund nets spent-this-period back to 0

    // Without the ref-join net the original hold would still count (2 + 2 > 2)
    // and this would 402. It must be allowed.
    await reserve(walletId, orgId, 2);
    expect(await balance(walletId)).toBe(98);
  });

  it("6. pool-empty still wins with its own code (ai.credits, not allocation)", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    // Generous cap, but the pool is empty.
    await seedAllocation(walletId, orgId, 100);

    let thrown: unknown;
    try {
      await reserve(walletId, orgId, 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PaymentRequiredError);
    expect((thrown as PaymentRequiredError).featureKey).toBe("ai.credits");
  });

  it("7. per-org isolation: org A at its cap is blocked, org B still runs", async () => {
    const walletId = randomUUID();
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    await seedWalletBalance(walletId, 100);
    await seedAllocation(walletId, orgA, 2); // A is capped; B has no row

    await reserve(walletId, orgA, 2); // A at cap
    await expect(reserve(walletId, orgA, 1)).rejects.toMatchObject({
      featureKey: "ai.credits.allocation",
    });

    // B shares the wallet but has no cap → pool-bounded only, still runs.
    await reserve(walletId, orgB, 5);
    expect(await balance(walletId)).toBe(93); // 100 - 2 (A) - 5 (B)
  });

  it("8. period-scoped: a hold stamped last month does not count toward the cap", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    await seedWalletBalance(walletId, 100);
    await seedAllocation(walletId, orgId, 1);

    // A big spend by this org, but backdated to a prior calendar month — it
    // must be excluded from this period's derive (else 5 > cap 1 would block).
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, spent_by_org_id, balance_after,
         idempotency_key, created_at)
      values (${walletId}, -5, 'run_spend', 'grant', ${orgId}, 95,
              ${`old-${uniq()}`}, now() - interval '2 months')`;

    // This-period spend is 0, so a 1-credit run is under the cap.
    await reserve(walletId, orgId, 1);
    expect(await balance(walletId)).toBe(94); // 100 - 5 (last month) - 1 (now)
  });
});
