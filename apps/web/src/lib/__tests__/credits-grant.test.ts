// AI credit wallet — monthly + trial grants (v17 SPEC-2 §5.4, §11.2).
//
// grantMonthly = ai.credits.monthly(plan) * quantityPaid, idempotent per
// (wallet_id, 'monthly', period) — a second call in the same calendar month
// is a no-op. Before adding a new period's allowance, grantMonthly expires
// whatever is left in the grant bucket from the prior period (D1, use-or-lose,
// Task 6 review fix) — a single `source='expiry'` row, leaving the pack
// bucket (D2) untouched. grantTrial = ai.credits.trial, once per org, guarded
// by the org's subscription trial_used_at — a second call is a no-op.
// Community / event_pass carry no ai.credits.trial row and get nothing.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, grantBalance, grantMonthly, grantTrial, packBalance } from "@/lib/credits";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

/** Seed a raw ledger row directly (bypassing grant helpers) so a test can set
 *  up "leftover from a prior period" without needing a real prior calendar
 *  month. Mirrors credits-spend.test.ts's seedWalletBalance. */
async function seedLedgerRow(
  walletId: string,
  delta: number,
  bucket: "grant" | "pack",
  source = "monthly_grant",
): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${walletId}, ${delta}, ${source}, ${bucket}, ${delta}, ${`seed-${randomUUID().slice(0, 8)}`})`;
}

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Credits ${uniq()}`}, ${`credits-${uniq()}`})
    returning id`;
  return org!.id;
}

describe.skipIf(!HAS_DB)("ai credit wallet — grants", () => {
  describe("grantMonthly", () => {
    it("grants ai.credits.monthly(plan) * quantityPaid", async () => {
      const walletId = randomUUID();
      const granted = await grantMonthly(walletId, "pro", 3);
      expect(granted).toBe(60 * 3);
      expect(await balance(walletId)).toBe(180);
    });

    it("is a no-op on a second call in the same period", async () => {
      const walletId = randomUUID();
      await grantMonthly(walletId, "pro_plus", 2);
      expect(await balance(walletId)).toBe(400);

      const secondGrant = await grantMonthly(walletId, "pro_plus", 2);
      expect(secondGrant).toBe(0);
      expect(await balance(walletId)).toBe(400);
    });

    it("grants nothing for a plan with no ai.credits.monthly row", async () => {
      const walletId = randomUUID();
      const granted = await grantMonthly(walletId, "nonexistent_plan", 1);
      expect(granted).toBe(0);
      expect(await balance(walletId)).toBe(0);
    });

    it("expires unspent grant-bucket leftover from the prior period on the new grant (D1, use-or-lose)", async () => {
      const walletId = randomUUID();
      // Simulate an unspent balance carried in from a prior period.
      await seedLedgerRow(walletId, 25, "grant");
      expect(await grantBalance(walletId)).toBe(25);

      const granted = await grantMonthly(walletId, "pro", 1);

      expect(granted).toBe(60);
      // Not 25 + 60 banked — the leftover 25 was expired, the grant bucket
      // holds exactly this period's fresh amount.
      expect(await grantBalance(walletId)).toBe(60);
      expect(await balance(walletId)).toBe(60);

      const [expiry] = await sql<{ delta: number; bucket: string }[]>`
        select delta, bucket from ai_credit_ledger
         where wallet_id = ${walletId} and source = 'expiry'`;
      expect(expiry?.delta).toBe(-25);
      expect(expiry?.bucket).toBe("grant");
    });

    it("leaves the pack bucket untouched by the grant reset", async () => {
      const walletId = randomUUID();
      await seedLedgerRow(walletId, 25, "grant");
      await seedLedgerRow(walletId, 40, "pack", "pack_purchase");
      expect(await packBalance(walletId)).toBe(40);

      await grantMonthly(walletId, "pro", 1);

      expect(await grantBalance(walletId)).toBe(60);
      expect(await packBalance(walletId)).toBe(40);
      expect(await balance(walletId)).toBe(100);
    });

    it("reset + grant is idempotent — a second call the same period does not re-expire or double-grant", async () => {
      const walletId = randomUUID();
      await seedLedgerRow(walletId, 25, "grant");

      const first = await grantMonthly(walletId, "pro", 1);
      expect(first).toBe(60);
      expect(await grantBalance(walletId)).toBe(60);

      const second = await grantMonthly(walletId, "pro", 1);
      expect(second).toBe(0);
      // Still exactly this period's amount — the second call's leftover
      // check saw the first call's own grant (60) but must NOT treat it as
      // "leftover to expire" since the period was already granted.
      expect(await grantBalance(walletId)).toBe(60);
      expect(await balance(walletId)).toBe(60);

      const expiryRows = await sql<{ id: string }[]>`
        select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'expiry'`;
      expect(expiryRows).toHaveLength(1); // only the ONE expiry from the first call's reset
    });

    it("a fresh wallet with no prior grant writes no expiry row", async () => {
      const walletId = randomUUID();

      await grantMonthly(walletId, "pro", 1);

      const expiryRows = await sql<{ id: string }[]>`
        select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'expiry'`;
      expect(expiryRows).toHaveLength(0);
      expect(await grantBalance(walletId)).toBe(60);
    });
  });

  describe("grantTrial", () => {
    it("grants ai.credits.trial once for a pro org", async () => {
      const orgId = await seedOrg();
      const subId = await setOrgPlan(orgId, "pro");

      const granted = await grantTrial(orgId);
      expect(granted).toBe(20);
      expect(await balance(subId)).toBe(20);
    });

    it("is a no-op on a second call for the same org", async () => {
      const orgId = await seedOrg();
      const subId = await setOrgPlan(orgId, "pro_plus");

      await grantTrial(orgId);
      expect(await balance(subId)).toBe(20);

      const secondGrant = await grantTrial(orgId);
      expect(secondGrant).toBe(0);
      expect(await balance(subId)).toBe(20);
    });

    it("is a no-op when trial_used_at is already set (trial used another way)", async () => {
      const orgId = await seedOrg();
      const subId = await setOrgPlan(orgId, "pro");
      await sql`update subscriptions set trial_used_at = now() where id = ${subId}`;

      const granted = await grantTrial(orgId);
      expect(granted).toBe(0);
      expect(await balance(subId)).toBe(0);
    });

    it("grants nothing for a community org (no ai.credits.trial row)", async () => {
      const orgId = await seedOrg();
      const subId = await setOrgPlan(orgId, "community");

      const granted = await grantTrial(orgId);
      expect(granted).toBe(0);
      expect(await balance(subId)).toBe(0);
    });

    it("grants nothing for an org with no billing group at all", async () => {
      const orgId = await seedOrg();
      const granted = await grantTrial(orgId);
      expect(granted).toBe(0);
    });
  });
});
