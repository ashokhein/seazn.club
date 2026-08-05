// SPEC-3 §3 — the unified per-org adjustments log. DB-backed: seed
// staff_audit_log rows across several actions for one org (+ noise) and assert
// the scope filter, the category/reversible/reason derivation, keyset paging,
// and the actor-name join. Real Postgres required.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { DISCOVERY_AUDIT_ACTIONS, SUSPENSION_ACTIONS } from "@/lib/admin";
import { ADJUSTMENT_LABELS } from "@/app/admin/orgs/[id]/adjustment-labels";
import { setOrgSuspension } from "@/server/usecases/admin-orgs";
import {
  adjustmentsForOrg,
  ADJUSTMENT_ACTIONS,
  ADJUSTMENT_CATEGORY,
  ADJUSTMENT_REVERSIBLE,
} from "../admin-adjustments-log";

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

/** Register for cleanup every audit row a REAL writer left on this org — the
 *  writers below are driven end to end, so their row ids are not known up front. */
async function trackLogsFor(targetId: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    select id from staff_audit_log where target_id = ${targetId}`;
  for (const r of rows) created.push(r.id);
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
    // The real writer (entitlement-override route) logs target_type='entitlement'
    // with target_id=org id — seed that true shape so the log's type filter is
    // exercised, not a fiction. Fails if adjustmentsForOrg only reads 'org'.
    const override = await log(staff.id, "entitlement_override", "entitlement", orgId, {}, t(3));
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
    await log(staff.id, "entitlement_override_removed", "entitlement", orgId, {}, t(3));
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

  // Auditing a moderation action is only worth doing if a human can FIND it.
  // Driven through the REAL writer rather than seeded rows: the second arm is
  // spelled `reactivate`, and an allowlist written from memory says `unsuspend`
  // — a dead entry that leaves the real action just as invisible as before.
  // Only the writer can settle which string lands in the table.
  it("surfaces suspend and reactivate, driven through setOrgSuspension", async () => {
    const staff = await makeUser("Moderator");
    const orgId = await makeOrg();

    await setOrgSuspension(staff.id, orgId, "suspend", "abuse report 12");
    await setOrgSuspension(staff.id, orgId, "reactivate", "appeal upheld");
    await trackLogsFor(orgId);

    const entries = await adjustmentsForOrg(orgId);
    const byAction = Object.fromEntries(entries.map((e) => [e.action, e]));
    expect(Object.keys(byAction).sort()).toEqual(["reactivate", "suspend"]);
    expect(byAction.suspend).toMatchObject({
      actorId: staff.id,
      category: "moderation",
      reversible: true,
      reason: "abuse report 12",
    });
    // Reactivation IS the compensating half — there is nothing to undo about it.
    expect(byAction.reactivate).toMatchObject({
      category: "moderation",
      reversible: false,
      reason: "appeal upheld",
    });
  });

  // Discovery curation writes `discovery_${action}` against the COMPETITION's
  // org (target_type 'org', target_id comp.org_id), so the rows are org-scoped
  // and should read back here. The strings are pinned against the constant the
  // route's own zod enum is derived from, so the two cannot drift apart.
  it("surfaces every discovery-curation action", async () => {
    const staff = await makeUser("Curator");
    const orgId = await makeOrg();

    let minute = 1;
    for (const action of DISCOVERY_AUDIT_ACTIONS) {
      await log(
        staff.id,
        action,
        "org",
        orgId,
        { reason: `${action} reason`, competition_id: randomUUID() },
        t(minute++),
      );
    }

    const entries = await adjustmentsForOrg(orgId);
    expect(entries.map((e) => e.action).sort()).toEqual([...DISCOVERY_AUDIT_ACTIONS].sort());
    const byAction = Object.fromEntries(entries.map((e) => [e.action, e]));
    for (const action of DISCOVERY_AUDIT_ACTIONS) {
      expect(byAction[action]).toMatchObject({
        category: "discovery",
        reason: `${action} reason`,
      });
    }
    // feature/block are the acts; unfeature/unblock are their undo, so only the
    // first pair is reversible (the file's own convention).
    expect(byAction.discovery_feature!.reversible).toBe(true);
    expect(byAction.discovery_block!.reversible).toBe(true);
    expect(byAction.discovery_unfeature!.reversible).toBe(false);
    expect(byAction.discovery_unblock!.reversible).toBe(false);
  });

  it("ADJUSTMENT_ACTIONS excludes non-per-org catalog/view actions", () => {
    expect(ADJUSTMENT_ACTIONS).toContain("credit_adjust");
    expect(ADJUSTMENT_ACTIONS).not.toContain("impersonate_start");
    expect(ADJUSTMENT_ACTIONS).not.toContain("size_pack_upsert");
  });
});

// No DB: this is the guard over the four maps an allowlisted action has to
// appear in. Three of them are `Record<AdjustmentAction, …>` so tsc already
// refuses an omission — this test is what stands behind the fourth (the label
// map lives in the /admin tree, where a page module cannot export it) and what
// fails loudly if any of those types is ever widened back to `string`.
describe("every allowlisted adjustment action is fully described", () => {
  it("has a category, a reversibility and a label", () => {
    for (const action of ADJUSTMENT_ACTIONS) {
      expect(ADJUSTMENT_CATEGORY[action], `no category for ${action}`).toBeTruthy();
      expect(typeof ADJUSTMENT_REVERSIBLE[action], `no reversibility for ${action}`).toBe("boolean");
      expect(ADJUSTMENT_LABELS[action], `no label for ${action}`).toBeTruthy();
    }
  });

  // The label is what an operator reads; a slug leaking through means the map
  // was keyed on `string` again and the compile-time guard is gone.
  it("labels no action with its own raw slug", () => {
    for (const action of ADJUSTMENT_ACTIONS) {
      expect(ADJUSTMENT_LABELS[action]).not.toBe(action);
    }
  });

  // The whole point of deriving: the verbs the discovery route accepts and the
  // actions it audits are one list. If someone re-types the enum, this fails.
  it("covers exactly the discovery verbs the route accepts", () => {
    expect([...DISCOVERY_AUDIT_ACTIONS]).toEqual([
      "discovery_feature",
      "discovery_unfeature",
      "discovery_block",
      "discovery_unblock",
    ]);
    for (const action of DISCOVERY_AUDIT_ACTIONS) {
      expect(ADJUSTMENT_ACTIONS).toContain(action);
    }
  });

  // The trap this whole change exists to close: the second suspension arm is
  // `reactivate`. An allowlist carrying `unsuspend` type-checks, reads like a
  // fix, and leaves the real action exactly as invisible as before.
  it("allowlists the suspension arms the writer actually logs", () => {
    expect([...SUSPENSION_ACTIONS]).toEqual(["suspend", "reactivate"]);
    expect(ADJUSTMENT_ACTIONS).not.toContain("unsuspend");
    for (const action of SUSPENSION_ACTIONS) {
      expect(ADJUSTMENT_ACTIONS).toContain(action);
    }
  });
});
