// AI credit wallet — ledger balance + wallet resolution (v17 SPEC-2 §5.1, §11).
//
// The wallet is the BILLING ENTITY, not the org: wallet_id =
// coalesce(group_subscription_id, org_id). A grouped org resolves to the
// group's subscription id (the shared pool); a group-of-one org with no
// subscription row resolves to its own id. `balance` is sum(delta) over the
// append-only ledger.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, walletIdFor } from "@/lib/credits";
import { setOrgPlan, orgGroupId } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A bare org with NO billing group — a group-of-one whose wallet is its own id. */
async function seedUngroupedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Credits ${uniq()}`}, ${`credits-${uniq()}`})
    returning id`;
  return org!.id;
}

describe.skipIf(!HAS_DB)("ai credit wallet — balance + wallet resolution", () => {
  it("walletIdFor returns the group subscription id when the org is grouped", async () => {
    const orgId = await seedUngroupedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    expect(await orgGroupId(orgId)).toBe(subId);
    expect(await walletIdFor(orgId)).toBe(subId);
  });

  it("walletIdFor falls back to the org id when the org has no billing group", async () => {
    const orgId = await seedUngroupedOrg();
    expect(await orgGroupId(orgId)).toBeNull();
    expect(await walletIdFor(orgId)).toBe(orgId);
  });

  it("a fresh wallet has a balance of 0", async () => {
    const walletId = randomUUID();
    expect(await balance(walletId)).toBe(0);
  });

  it("balance sums the ledger deltas — a +40 grant reads back as 40", async () => {
    const walletId = randomUUID();
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${walletId}, 40, 'monthly_grant', 'grant', 40, ${`grant-${walletId}`})`;
    expect(await balance(walletId)).toBe(40);
  });
});
