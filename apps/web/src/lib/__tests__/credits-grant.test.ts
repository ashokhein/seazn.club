// AI credit wallet — monthly + trial grants (v17 SPEC-2 §5.4, §11.2).
//
// grantMonthly = ai.credits.monthly(plan) * quantityPaid, idempotent per
// (wallet_id, 'monthly', period) — a second call in the same calendar month
// is a no-op. grantTrial = ai.credits.trial, once per org, guarded by the
// org's subscription trial_used_at — a second call is a no-op. Community /
// event_pass carry no ai.credits.trial row and get nothing.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, grantMonthly, grantTrial } from "@/lib/credits";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

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
