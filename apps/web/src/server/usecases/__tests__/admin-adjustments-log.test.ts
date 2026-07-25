// SPEC-3 §3 — the unified per-org adjustments log. DB-backed: seed
// staff_audit_log rows across several actions for one org (+ noise) and assert
// the scope filter, the category/reversible/reason derivation, keyset paging,
// and the actor-name join. Real Postgres required.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { adjustmentsForOrg, ADJUSTMENT_ACTIONS } from "../admin-adjustments-log";

const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(name: string): Promise<{ id: string; email: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true) returning id`;
  return { id, email };
}

async function makeOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Adj " + suffix}, ${"adj-" + suffix})
    returning id`;
  return id;
}

/** Insert a staff_audit_log row with an explicit created_at so ordering is
 *  deterministic. detail lands as real jsonb (sql.json) so detail->> reads work. */
async function seedLog(
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> | null,
  createdAt: string,
): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into staff_audit_log (actor_id, action, target_type, target_id, detail, created_at)
    values (${actorId}, ${action}, ${targetType}, ${targetId},
            ${detail ? sql.json(detail as never) : null}, ${createdAt})
    returning id`;
  return id;
}

const created: string[] = [];
async function log(
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> | null,
  createdAt: string,
): Promise<string> {
  const id = await seedLog(actorId, action, targetType, targetId, detail, createdAt);
  created.push(id);
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  if (created.length) await sql`delete from staff_audit_log where id = any(${created})`;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n, 0)).toISOString();

describe.skipIf(!HAS_DB)("adjustmentsForOrg (SPEC-3 §3)", () => {
  it("returns only this org's adjustment rows, newest first, excluding noise", async () => {
    const staff = await makeUser("staffer");
    const orgId = await makeOrg();
    const otherOrgId = await makeOrg();

    const credit = await log(staff.id, "credit_adjust", "org", orgId, { reason_code: "promo" }, t(1));
    const addon = await log(staff.id, "addon_grant", "org", orgId, { reason: "sales comp" }, t(2));
    const override = await log(staff.id, "entitlement_override", "org", orgId, {}, t(3));
    const comp = await log(staff.id, "comp_to_pro", "org", orgId, {}, t(4));

    // Noise that must NOT surface:
    await log(staff.id, "credit_adjust", "org", otherOrgId, {}, t(5)); // different org
    await log(staff.id, "impersonate_start", "org", orgId, {}, t(6)); // non-adjustment action
    await log(staff.id, "remove_payment_method", "user", staff.id, {}, t(7)); // target_type=user

    const entries = await adjustmentsForOrg(orgId);
    expect(entries.map((e) => e.id)).toEqual([comp, override, addon, credit]);
  });

  it("derives category, reversible and reason per action", async () => {
    const staff = await makeUser("staffer");
    const orgId = await makeOrg();
    await log(staff.id, "credit_adjust", "org", orgId, { reason_code: "bug_fix" }, t(1));
    await log(staff.id, "addon_revoke", "org", orgId, { reason: "downgrade" }, t(2));
    await log(staff.id, "entitlement_override_removed", "org", orgId, {}, t(3));
    await log(staff.id, "admin_downgrade", "org", orgId, {}, t(4));

    const byAction = Object.fromEntries(
      (await adjustmentsForOrg(orgId)).map((e) => [e.action, e]),
    );
    expect(byAction.credit_adjust).toMatchObject({
      category: "credits",
      reversible: true,
      reason: "bug_fix",
    });
    expect(byAction.addon_revoke).toMatchObject({
      category: "addon",
      reversible: false,
      reason: "downgrade",
    });
    expect(byAction.entitlement_override_removed).toMatchObject({
      category: "cap",
      reversible: false,
      reason: null,
    });
    expect(byAction.admin_downgrade).toMatchObject({ category: "plan", reversible: false });
  });

  it("prefers detail.reason over detail.reason_code", async () => {
    const staff = await makeUser("staffer");
    const orgId = await makeOrg();
    await log(staff.id, "credit_adjust", "org", orgId, { reason: "note wins", reason_code: "promo" }, t(1));
    const [e] = await adjustmentsForOrg(orgId);
    expect(e!.reason).toBe("note wins");
  });

  it("pages with limit + before cursor", async () => {
    const staff = await makeUser("staffer");
    const orgId = await makeOrg();
    // 5 rows at minutes 1..5
    for (let i = 1; i <= 5; i++) {
      await log(staff.id, "credit_adjust", "org", orgId, { reason_code: `r${i}` }, t(i));
    }
    const page1 = await adjustmentsForOrg(orgId, { limit: 2 });
    expect(page1.map((e) => e.createdAt)).toEqual([t(5), t(4)]);

    const page2 = await adjustmentsForOrg(orgId, { limit: 2, before: page1[1]!.createdAt });
    expect(page2.map((e) => e.createdAt)).toEqual([t(3), t(2)]);

    const page3 = await adjustmentsForOrg(orgId, { limit: 2, before: page2[1]!.createdAt });
    expect(page3.map((e) => e.createdAt)).toEqual([t(1)]);
  });

  it("joins the actor name from users (display_name/email)", async () => {
    const staff = await makeUser("Casey Staff");
    const orgId = await makeOrg();
    await log(staff.id, "credit_adjust", "org", orgId, {}, t(1));
    const [e] = await adjustmentsForOrg(orgId);
    expect(e!.actorId).toBe(staff.id);
    expect(e!.actorName).toBe("Casey Staff");
  });

  it("ADJUSTMENT_ACTIONS excludes non-per-org catalog/view actions", () => {
    expect(ADJUSTMENT_ACTIONS).toContain("credit_adjust");
    expect(ADJUSTMENT_ACTIONS).not.toContain("impersonate_start");
    expect(ADJUSTMENT_ACTIONS).not.toContain("size_pack_upsert");
  });
});
