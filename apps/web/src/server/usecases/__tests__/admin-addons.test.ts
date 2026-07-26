// v17 SPEC-3 §1 row 3 — the staff GRANT / REVOKE add-on adjustment. Writes
// org_addons rows (status='granted', stripe_item_id=null) that the resolver
// already sums (lib/entitlements.addonBonus), and freezes-not-deletes on revoke.
//
// These drive grantAddon/revokeAddon against real Postgres and assert on the
// real resolver (getLimit). Since #272's sweep, the staff_audit_log row is
// written INSIDE grantAddon/revokeAddon's own tx (not via a mocked
// logStaffAction), so audit is asserted by counting REAL rows — and ACTOR must
// be a real users.id, because staff_audit_log.actor_id is a live FK. The ent
// cache is disabled so a just-written row is seen at once.
//
// Real Postgres required; skipped without DATABASE_URL. Run on the fresh v17
// schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit } from "@/lib/entitlements";
import { grantAddon, revokeAddon } from "../admin-addons";

const HAS_DB = !!process.env.DATABASE_URL;
const FEATURE = "members.max";
// A real staff user — actor_id is an FK, so the audit insert now needs one.
let ACTOR: string;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`addon-${uniq()}@test.local`}, 'Addon Admin', true) returning id`;
  return id;
}

/** Count real staff_audit_log rows for an org + action (replaces the old
 *  logStaffAction spy now that the audit commits inside the write's own tx). */
async function auditCount(orgId: string, action: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from staff_audit_log
    where target_id = ${orgId} and action = ${action}`;
  return n;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  ACTOR = await makeUser();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("grantAddon", () => {
  it("writes one granted row (stripe_item_id null) and lifts the cap by delta_each*qty", async () => {
    const org = await createOrgForUser(await makeUser(), "Addon Grant Org");
    const walletId = await walletIdFor(org.id);
    const base = await getLimit(org.id, FEATURE);
    expect(base).not.toBeNull();

    const { id, applied } = await grantAddon(ACTOR, org.id, {
      featureKey: FEATURE,
      deltaEach: 2,
      qty: 3,
      targetOrgId: null,
      reason: "sales_comp: launch deal",
      idempotencyKey: `grant-${uniq()}-abcd`,
    });
    expect(applied).toBe(true);

    expect(await getLimit(org.id, FEATURE)).toBe((base as number) + 6);
    const rows = await sql<{ status: string; stripe_item_id: string | null }[]>`
      select status, stripe_item_id from org_addons where id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "granted", stripe_item_id: null });
    expect(await auditCount(org.id, "addon_grant")).toBe(1);
  });

  it("a target_org_id grant lifts only that org; a sibling on the same wallet is unaffected", async () => {
    // Two orgs sharing ONE wallet (a billing group): org B is re-pointed at
    // org A's subscription, so walletIdFor(A) === walletIdFor(B).
    const orgA = await createOrgForUser(await makeUser(), "Addon Target A");
    const orgB = await createOrgForUser(await makeUser(), "Addon Target B");
    const walletA = await walletIdFor(orgA.id);
    await sql`update organizations set subscription_id = ${walletA} where id = ${orgB.id}`;
    expect(await walletIdFor(orgB.id)).toBe(walletA);

    const baseA = (await getLimit(orgA.id, FEATURE)) as number;
    const baseB = (await getLimit(orgB.id, FEATURE)) as number;

    await grantAddon(ACTOR, orgA.id, {
      featureKey: FEATURE,
      deltaEach: 4,
      qty: 1,
      targetOrgId: orgA.id,
      reason: "sales_comp",
      idempotencyKey: `target-${uniq()}-abcd`,
    });

    expect(await getLimit(orgA.id, FEATURE)).toBe(baseA + 4);
    expect(await getLimit(orgB.id, FEATURE)).toBe(baseB); // sibling untouched
  });

  it("rejects a target_org_id that is not in the granting org's wallet/group, with no row written", async () => {
    // org and foreignOrg are on two DIFFERENT (standalone) wallets — a typo'd
    // or foreign target_org_id must not resolve as an inert, misleading grant.
    const org = await createOrgForUser(await makeUser(), "Addon Group Guard Org");
    const foreignOrg = await createOrgForUser(await makeUser(), "Addon Group Guard Foreign");
    const walletId = await walletIdFor(org.id);
    expect(await walletIdFor(foreignOrg.id)).not.toBe(walletId);

    await expect(
      grantAddon(ACTOR, org.id, {
        featureKey: FEATURE,
        deltaEach: 2,
        qty: 1,
        targetOrgId: foreignOrg.id,
        reason: "sales_comp",
        idempotencyKey: `foreign-${uniq()}-abcd`,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(0);
    expect(await auditCount(org.id, "addon_grant")).toBe(0);
  });

  it("rejects a NONEXISTENT target_org_id with the same typed 422 (not a 500), no row written", async () => {
    // A mistyped/nonexistent target_org_id must reject the same way as a real
    // foreign org — walletIdFor would THROW a plain Error on a missing org,
    // which would otherwise fall through handler()'s catch-all to a 500.
    const org = await createOrgForUser(await makeUser(), "Addon Nonexistent Target Org");
    const walletId = await walletIdFor(org.id);
    const bogusOrgId = randomUUID();

    await expect(
      grantAddon(ACTOR, org.id, {
        featureKey: FEATURE,
        deltaEach: 2,
        qty: 1,
        targetOrgId: bogusOrgId,
        reason: "sales_comp",
        idempotencyKey: `bogus-${uniq()}-abcd`,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(0);
    expect(await auditCount(org.id, "addon_grant")).toBe(0);
  });

  it("rejects delta_each <= 0 and qty <= 0 with no row written", async () => {
    const org = await createOrgForUser(await makeUser(), "Addon Bad Input");
    const walletId = await walletIdFor(org.id);
    await expect(
      grantAddon(ACTOR, org.id, {
        featureKey: FEATURE,
        deltaEach: 0,
        qty: 1,
        targetOrgId: null,
        reason: "promo",
        idempotencyKey: `bad-${uniq()}-abcd`,
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      grantAddon(ACTOR, org.id, {
        featureKey: FEATURE,
        deltaEach: 2,
        qty: 0,
        targetOrgId: null,
        reason: "promo",
        idempotencyKey: `bad2-${uniq()}-abcd`,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(0);
    expect(await auditCount(org.id, "addon_grant")).toBe(0);
  });

  it("is idempotent on the key — a replay makes one row, applied:false, one audit row", async () => {
    const org = await createOrgForUser(await makeUser(), "Addon Idem Org");
    const walletId = await walletIdFor(org.id);
    const key = `idem-${uniq()}-abcd`;
    const base = (await getLimit(org.id, FEATURE)) as number;

    const first = await grantAddon(ACTOR, org.id, {
      featureKey: FEATURE, deltaEach: 5, qty: 1, targetOrgId: null, reason: "promo", idempotencyKey: key,
    });
    const second = await grantAddon(ACTOR, org.id, {
      featureKey: FEATURE, deltaEach: 5, qty: 1, targetOrgId: null, reason: "promo", idempotencyKey: key,
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await getLimit(org.id, FEATURE)).toBe(base + 5); // lifted once, not twice
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(1);
    expect(await auditCount(org.id, "addon_grant")).toBe(1); // logged once, not on replay
  });

  it("atomicity: a bogus (nonexistent) actor trips the audit FK and rolls the GRANT back too", async () => {
    // staff_audit_log.actor_id is a real FK to users(id): a grant whose audit
    // insert fails must roll the org_addons row back with it — both-or-neither.
    const org = await createOrgForUser(await makeUser(), "Addon Atomic Org");
    const walletId = await walletIdFor(org.id);
    const bogusActor = randomUUID(); // names no users row

    await expect(
      grantAddon(bogusActor, org.id, {
        featureKey: FEATURE, deltaEach: 3, qty: 1, targetOrgId: null, reason: "promo",
        idempotencyKey: `atomic-${uniq()}-abcd`,
      }),
    ).rejects.toThrow();

    // Neither row survives: the grant and its audit committed together, or not at all.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(0);
    expect(await auditCount(org.id, "addon_grant")).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("revokeAddon", () => {
  it("flips a granted row to canceled — cap falls back, the row survives", async () => {
    const org = await createOrgForUser(await makeUser(), "Addon Revoke Org");
    const base = (await getLimit(org.id, FEATURE)) as number;
    const { id } = await grantAddon(ACTOR, org.id, {
      featureKey: FEATURE, deltaEach: 3, qty: 2, targetOrgId: null, reason: "sales_comp", idempotencyKey: `rev-${uniq()}-abcd`,
    });
    expect(await getLimit(org.id, FEATURE)).toBe(base + 6);

    const res = await revokeAddon(ACTOR, org.id, id, "bug_fix");
    expect(res.revoked).toBe(true);
    expect(await getLimit(org.id, FEATURE)).toBe(base); // fell back to plan base
    const [row] = await sql<{ status: string }[]>`select status from org_addons where id = ${id}`;
    expect(row.status).toBe("canceled"); // freeze-not-delete: still present
    expect(await auditCount(org.id, "addon_revoke")).toBe(1);
  });

  it("revoking again is a no-op: {revoked:false}, no error, no second audit row", async () => {
    const org = await createOrgForUser(await makeUser(), "Addon Revoke Twice");
    const { id } = await grantAddon(ACTOR, org.id, {
      featureKey: FEATURE, deltaEach: 3, qty: 1, targetOrgId: null, reason: "promo", idempotencyKey: `rev2-${uniq()}-abcd`,
    });
    await revokeAddon(ACTOR, org.id, id, "promo");

    const res = await revokeAddon(ACTOR, org.id, id, "promo");
    expect(res.revoked).toBe(false);
    expect(await auditCount(org.id, "addon_revoke")).toBe(1); // the replay logged nothing new
  });

  it("refuses a Stripe-paid active row and another org's row — both untouched", async () => {
    const org = await createOrgForUser(await makeUser(), "Addon Refuse Org");
    const walletId = await walletIdFor(org.id);

    // A Stripe-paid 'active' row on this org's wallet — billing-events' to cancel.
    const [{ id: paidId }] = await sql<{ id: string }[]>`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty, stripe_item_id, status)
      values (${walletId}, ${org.id}, ${FEATURE}, 1, 1, ${`pi_${uniq()}`}, 'active') returning id`;
    await expect(revokeAddon(ACTOR, org.id, paidId, "bug_fix")).rejects.toMatchObject({ status: 409 });
    const [paid] = await sql<{ status: string }[]>`select status from org_addons where id = ${paidId}`;
    expect(paid.status).toBe("active"); // untouched

    // Another org's granted row (different wallet).
    const other = await createOrgForUser(await makeUser(), "Addon Other Org");
    const { id: otherId } = await grantAddon(ACTOR, other.id, {
      featureKey: FEATURE, deltaEach: 2, qty: 1, targetOrgId: null, reason: "promo", idempotencyKey: `other-${uniq()}-abcd`,
    });
    await expect(revokeAddon(ACTOR, org.id, otherId, "bug_fix")).rejects.toMatchObject({ status: 404 });
    const [otherRow] = await sql<{ status: string }[]>`select status from org_addons where id = ${otherId}`;
    expect(otherRow.status).toBe("granted"); // untouched
  });
});
