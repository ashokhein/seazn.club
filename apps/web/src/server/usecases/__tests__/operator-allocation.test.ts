// Operator allocation console — set member caps + read burn (v17 SPEC-5 §1).
//
// The WRITE (setOrgAllocation) and READ (allocationConsole) API a Pro Plus
// operator uses to cap each member org's share of the ONE shared group wallet
// (SPEC-2 §11) and to see each member's burn against the pool. The cap is
// enforced at spend time in reserve() (Task 1); this proves the write path
// actually drives that enforcement (the money proof below) and that the console
// reports the same period-spend derive the gate checks.
//
// Payer-only: gating reuses subscriptionIsOwnedBy (the exact helper attach/
// detach/transfer gate on) — a member org's owner is NOT its group's payer.
//
// Real Postgres required; skipped without DATABASE_URL. Fresh v17 schema:
// DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, release, reserve } from "@/lib/credits";
import { HttpError } from "@/lib/errors";
import { PaymentRequiredError } from "@/lib/errors";
import { allocationConsole, setOrgAllocation } from "../operator-allocation";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(tag: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${tag}-${uniq()}@test.local`}, ${`User ${tag}`}, true) returning id`;
  return id;
}

/** A group (subscription) owned by `ownerId`. Its id IS the wallet id. */
async function makeGroup(ownerId: string, plan = "pro_plus"): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
    values (${ownerId}, ${plan}, 'active', 1) returning id`;
  return id;
}

/** A member org in group `subId`. */
async function makeOrg(subId: string, ownerId: string, name?: string): Promise<string> {
  const s = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${name ?? `Alloc ${s}`}, ${`alloc-${s}`}, ${ownerId}, ${subId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${id}, ${ownerId}, 'owner')`;
  return id;
}

/** Fund the shared wallet directly (bypassing grant helpers). */
async function fundWallet(walletId: string, credits: number): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${walletId}, ${credits}, 'monthly_grant', 'grant', ${credits}, ${`seed-${uniq()}`})`;
}

const capRow = async (walletId: string, orgId: string) =>
  (
    await sql<{ monthly_cap: number | null; updated_by: string | null }[]>`
      select monthly_cap, updated_by from org_credit_allocation
       where wallet_id = ${walletId} and org_id = ${orgId}`
  )[0];

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe.skipIf(!HAS_DB)("operator allocation — setOrgAllocation", () => {
  it("1. payer sets a cap, then updates it (idempotent on the PK, audited)", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer);
    const org = await makeOrg(group, payer);

    await setOrgAllocation(payer, org, 5);
    let row = await capRow(group, org);
    expect(row?.monthly_cap).toBe(5);
    expect(row?.updated_by).toBe(payer);

    await setOrgAllocation(payer, org, 10); // second call updates, no PK conflict
    row = await capRow(group, org);
    expect(row?.monthly_cap).toBe(10);

    // Still exactly one row for (wallet, org).
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from org_credit_allocation
       where wallet_id = ${group} and org_id = ${org}`;
    expect(n).toBe("1");
  });

  it("2. an org NOT in the payer's group is refused, and no row is written", async () => {
    const payer = await makeUser("payer");
    await makeGroup(payer); // the payer has a group, but the target is elsewhere

    const stranger = await makeUser("stranger");
    const otherGroup = await makeGroup(stranger);
    const foreignOrg = await makeOrg(otherGroup, stranger);

    await expect(setOrgAllocation(payer, foreignOrg, 5)).rejects.toMatchObject({ status: 403 });
    expect(await capRow(otherGroup, foreignOrg)).toBeUndefined();
  });

  it("3. a non-payer caller (a member org owner) is refused by the payer gate", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer);
    const org = await makeOrg(group, payer);

    const nonPayer = await makeUser("nonpayer");
    await sql`insert into org_members (org_id, user_id, role) values (${org}, ${nonPayer}, 'owner')`;

    await expect(setOrgAllocation(nonPayer, org, 5)).rejects.toBeInstanceOf(HttpError);
    await expect(setOrgAllocation(nonPayer, org, 5)).rejects.toMatchObject({ status: 403 });
    expect(await capRow(group, org)).toBeUndefined();
  });

  it("rejects a negative or non-integer cap with a 400", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer);
    const org = await makeOrg(group, payer);

    await expect(setOrgAllocation(payer, org, -1)).rejects.toMatchObject({ status: 400 });
    await expect(setOrgAllocation(payer, org, 2.5)).rejects.toMatchObject({ status: 400 });
    expect(await capRow(group, org)).toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("operator allocation — allocationConsole", () => {
  it("4. returns every member with its cap, burn this period, and the pool balance", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer);
    const orgA = await makeOrg(group, payer, "Alpha");
    const orgB = await makeOrg(group, payer, "Bravo");
    await fundWallet(group, 100);

    // Cap Alpha at 5; leave Bravo uncapped. Alpha has prior burn of 3.
    await setOrgAllocation(payer, orgA, 5);
    await reserve(group, orgA, 3);

    const console = await allocationConsole(payer);
    expect(console.walletId).toBe(group);
    expect(console.poolBalance).toBe(97); // 100 - 3

    const members = new Map(console.members.map((m) => [m.orgId, m]));
    expect(members.get(orgA)).toMatchObject({
      orgName: "Alpha",
      monthlyCap: 5,
      spentThisPeriod: 3,
    });
    expect(members.get(orgB)).toMatchObject({
      orgName: "Bravo",
      monthlyCap: null, // no row → unlimited share
      spentThisPeriod: 0,
    });
    // Ordered by name.
    expect(console.members.map((m) => m.orgName)).toEqual(["Alpha", "Bravo"]);
  });

  it("refuses a caller who is not a payer of any group", async () => {
    const nobody = await makeUser("nobody");
    await expect(allocationConsole(nobody)).rejects.toMatchObject({ status: 403 });
  });
});

describe.skipIf(!HAS_DB)("operator allocation — the money proof", () => {
  it("5. set cap 2 → member's 3rd reserve 402s allocation → raise cap → succeeds", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer);
    const org = await makeOrg(group, payer);
    await fundWallet(group, 100); // pool is deep — the cap, not the pool, is the limit

    await setOrgAllocation(payer, org, 2);

    await reserve(group, org, 1); // spent 1
    await reserve(group, org, 1); // spent 2, exactly at cap

    let thrown: unknown;
    try {
      await reserve(group, org, 1); // 2 + 1 > 2 → blocked by the Task 1 gate
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PaymentRequiredError);
    expect((thrown as PaymentRequiredError).featureKey).toBe("ai.credits.allocation");

    // Operator raises the cap via the write path — the very thing this proves.
    await setOrgAllocation(payer, org, 10);
    await reserve(group, org, 1); // now allowed
    expect(await balance(group)).toBe(97); // 100 - 3 spent
  });

  it("6. cap=null clears to unlimited: an at-limit member runs again", async () => {
    const payer = await makeUser("payer");
    const group = await makeGroup(payer);
    const org = await makeOrg(group, payer);
    await fundWallet(group, 100);

    await setOrgAllocation(payer, org, 2);
    await reserve(group, org, 2); // at cap
    await expect(reserve(group, org, 1)).rejects.toMatchObject({
      featureKey: "ai.credits.allocation",
    });

    await setOrgAllocation(payer, org, null); // clear to unlimited share
    const row = await capRow(group, org);
    expect(row?.monthly_cap).toBeNull(); // NULL row, not a delete — audit trail kept
    expect(row?.updated_by).toBe(payer);

    await reserve(group, org, 1); // unlimited share → pool-bounded only, runs
    expect(await balance(group)).toBe(97); // 100 - 3
  });
});
