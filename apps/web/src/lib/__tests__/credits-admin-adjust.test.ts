// Admin AI-credit grant/deduct — the first SPEC-3 adjustment write-path
// (design/v17-pricing-entitlements/SPEC-3-admin-adjustments.md §1/§2, SPEC-2
// §5.1). `adminAdjust` appends an attributed `admin_adjust` ledger row (±N,
// created_by + reason), never mutates a balance, never drives the wallet (or a
// bucket) below zero, and is idempotent on its key. `friendlyAdjustLabel` is
// the org-side public phrasing that must never leak the internal reason_code
// (§5).
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  adminAdjust,
  balance,
  friendlyAdjustLabel,
  grantBalance,
  packBalance,
  InsufficientBalanceError,
} from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Seed a raw ledger row directly so a test can stand up a starting balance in
 *  a specific bucket without going through a grant helper. Mirrors
 *  credits-grant.test.ts's seedLedgerRow. */
async function seedBalance(
  walletId: string,
  delta: number,
  bucket: "grant" | "pack" = "grant",
): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${walletId}, ${delta}, 'monthly_grant', ${bucket}, ${delta}, ${`seed-${uniq()}`})`;
}

async function adjustRowCount(walletId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from ai_credit_ledger
     where wallet_id = ${walletId} and source = 'admin_adjust'`;
  return Number(row!.n);
}

describe.skipIf(!HAS_DB)("adminAdjust", () => {
  it("grant +N writes one attributed admin_adjust row and raises the balance", async () => {
    const walletId = randomUUID();
    const res = await adminAdjust(walletId, 20, {
      createdBy: "staff-1",
      reason: "sales_comp: POC top-up",
      idempotencyKey: `adj-${uniq()}`,
    });
    expect(res).toEqual({ applied: true, balanceAfter: 20 });
    expect(await balance(walletId)).toBe(20);
    expect(await adjustRowCount(walletId)).toBe(1);

    const [row] = await sql<{ delta: number; source: string; bucket: string; created_by: string; reason: string }[]>`
      select delta, source, bucket, created_by, reason from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'admin_adjust'`;
    expect(row).toMatchObject({
      delta: 20,
      source: "admin_adjust",
      bucket: "grant", // SPEC-2 §5.4 / V321: admin_adjust writes the grant bucket
      created_by: "staff-1",
      reason: "sales_comp: POC top-up",
    });
  });

  it("deduct -N within balance lowers the balance with an append-only negative row", async () => {
    const walletId = randomUUID();
    await seedBalance(walletId, 30, "grant");
    const res = await adminAdjust(walletId, -10, {
      createdBy: "staff-1",
      reason: "bug_fix: refunded a botched run",
      idempotencyKey: `adj-${uniq()}`,
    });
    expect(res).toEqual({ applied: true, balanceAfter: 20 });
    expect(await balance(walletId)).toBe(20);
    // append-only: the seed row is untouched, a new negative row was added.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from ai_credit_ledger where wallet_id = ${walletId}`;
    expect(Number(n)).toBe(2);
    expect(await adjustRowCount(walletId)).toBe(1);
  });

  it("refuses a deduct beyond balance: throws, balance unchanged, no row written", async () => {
    const walletId = randomUUID();
    await seedBalance(walletId, 5, "grant");
    await expect(
      adminAdjust(walletId, -10, {
        createdBy: "staff-1",
        reason: "bug_fix: too much",
        idempotencyKey: `adj-${uniq()}`,
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await balance(walletId)).toBe(5);
    expect(await adjustRowCount(walletId)).toBe(0);
  });

  it("is idempotent on its key: a replay is a no-op returning the current balance", async () => {
    const walletId = randomUUID();
    const key = `adj-${uniq()}`;
    const first = await adminAdjust(walletId, 15, {
      createdBy: "staff-1",
      reason: "promo: launch credits",
      idempotencyKey: key,
    });
    expect(first).toEqual({ applied: true, balanceAfter: 15 });

    const replay = await adminAdjust(walletId, 15, {
      createdBy: "staff-1",
      reason: "promo: launch credits",
      idempotencyKey: key,
    });
    expect(replay).toEqual({ applied: false, balanceAfter: 15 });
    expect(await balance(walletId)).toBe(15);
    expect(await adjustRowCount(walletId)).toBe(1);
  });

  it("deducts grant-first when the wallet straddles both buckets, never below zero per bucket", async () => {
    const walletId = randomUUID();
    await seedBalance(walletId, 8, "grant");
    await seedBalance(walletId, 8, "pack");
    // Deduct 12 → 8 from grant (emptied), 4 from pack.
    const res = await adminAdjust(walletId, -12, {
      createdBy: "staff-1",
      reason: "refund_adjust: correction",
      idempotencyKey: `adj-${uniq()}`,
    });
    expect(res).toEqual({ applied: true, balanceAfter: 4 });
    expect(await grantBalance(walletId)).toBe(0);
    expect(await packBalance(walletId)).toBe(4);
  });

  it("two concurrent grants both apply with no lost update", async () => {
    const walletId = randomUUID();
    const [a, b] = await Promise.all([
      adminAdjust(walletId, 10, { createdBy: "s", reason: "promo: a", idempotencyKey: `adj-${uniq()}` }),
      adminAdjust(walletId, 10, { createdBy: "s", reason: "promo: b", idempotencyKey: `adj-${uniq()}` }),
    ]);
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    expect(await balance(walletId)).toBe(20);
    expect(await adjustRowCount(walletId)).toBe(2);
  });
});

describe("friendlyAdjustLabel", () => {
  const codes = ["support_goodwill", "sales_comp", "promo", "bug_fix", "refund_adjust", "anything_else"];

  it("never echoes the internal reason_code for any code or sign", () => {
    for (const code of codes) {
      for (const sign of [1, -1] as const) {
        const label = friendlyAdjustLabel(sign, code);
        expect(label).not.toContain(code);
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });

  it("maps goodwill-family codes to a warm public phrase for a grant", () => {
    expect(friendlyAdjustLabel(1, "support_goodwill")).toBe("Seazn goodwill");
    expect(friendlyAdjustLabel(1, "promo")).toBe("Seazn goodwill");
    expect(friendlyAdjustLabel(1, "bug_fix")).toBe("Seazn goodwill");
    expect(friendlyAdjustLabel(1, "sales_comp")).toBe("Account credit");
    expect(friendlyAdjustLabel(1, "refund_adjust")).toBe("Refund adjustment");
  });
});
