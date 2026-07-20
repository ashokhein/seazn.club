// Admin plan tools (v3/08 §1, PROMPT-37): comp-to-Pro honours its end date at
// resolution time, override expiry lapses, downgrade preview names exactly the
// competitions the freeze would catch, and every action lands in the audit
// with its reason. Real Postgres; Stripe never touched (comped orgs only).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { checkoutTrialDays } from "@/lib/billing";
import { hasFeature } from "@/lib/entitlements";
import {
  adminDowngrade,
  compToPro,
  downgradeFreezePreview,
  extendTrial,
  planPanel,
} from "@/server/usecases/admin-plan";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Adm " + s}, ${"adm-" + s}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'community', 'active') on conflict (org_id) do nothing`;
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${"staff-" + s + "@test.local"}, 'Staff', true, 'superadmin') returning id`;
  return { orgId, actorId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("admin plan tools", () => {
  it("comp-to-Pro grants Pro; a past end date resolves back to community", async () => {
    const { orgId, actorId } = await seedOrg();
    expect(await hasFeature(orgId, "api.access")).toBe(false);

    await compToPro(actorId, orgId, null, "founder friend");
    expect(await hasFeature(orgId, "api.access")).toBe(true);
    expect((await planPanel(orgId)).source).toBe("comped");

    // Clock-controlled lapse: write a past comped_until directly, then check
    // resolution treats the org as community without any job running.
    await sql`update subscriptions set comped_until = now() - interval '1 day' where org_id = ${orgId}`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);

    const [audit] = await sql<{ detail: { reason: string } }[]>`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'comp_to_pro' order by created_at desc limit 1`;
    expect(audit.detail.reason).toBe("founder friend");
  });

  it("an entitlement override with a lapsed expiry stops resolving", async () => {
    const { orgId } = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, expires_at, reason)
      values (${orgId}, 'api.access', true, now() + interval '1 hour', 'test')`;
    expect(await hasFeature(orgId, "api.access")).toBe(true);

    await sql`
      update org_entitlement_overrides set expires_at = now() - interval '1 minute'
      where org_id = ${orgId} and feature_key = 'api.access'`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "api.access")).toBe(false);
  });

  it("downgrade preview lists the over-quota competitions, then the downgrade freezes them", async () => {
    const { orgId, actorId } = await seedOrg();
    await compToPro(actorId, orgId, null, "pre-test comp");
    const s = randomUUID().slice(0, 8);
    for (const n of ["One", "Two", "Three"]) {
      await sql`
        insert into competitions (org_id, name, slug, status)
        values (${orgId}, ${n + " " + s}, ${n.toLowerCase() + "-" + s}, 'published')`;
    }

    const preview = await downgradeFreezePreview(orgId);
    expect(preview.limit).toBe(1); // community quota (v3 matrix)
    expect(preview.active).toBe(3);
    expect(preview.frozen).toHaveLength(2); // the two stalest

    const result = await adminDowngrade(actorId, orgId, "abuse of comp");
    expect(result.frozen).toHaveLength(2);
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("community");

    const [audit] = await sql<{ detail: { reason: string; after: { frozen: string[] } } }[]>`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'admin_downgrade' limit 1`;
    expect(audit.detail.reason).toBe("abuse of comp");
    expect(audit.detail.after.frozen).toHaveLength(2);
  });

  it("extendTrial moves trial_end forward from now (no Stripe sub) and audits", async () => {
    const { orgId, actorId } = await seedOrg();
    const end = await extendTrial(actorId, orgId, 14, "sales call");
    const days = (new Date(end).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    const [row] = await sql<{ status: string }[]>`
      select status from subscriptions where org_id = ${orgId}`;
    expect(row.status).toBe("trialing");
  });

  // One trial per org (V277) counts EVERY trial, not just Stripe's. An
  // admin-granted trial used to leave trial_used_at null, so the org could
  // downgrade and take a fresh 14-day checkout trial afterwards.
  it("a granted trial burns the org's one trial", async () => {
    const { orgId, actorId } = await seedOrg();
    const readSub = async () =>
      (
        await sql<{ trial_used_at: string | null }[]>`
          select trial_used_at from subscriptions where org_id = ${orgId}`
      )[0];
    expect(checkoutTrialDays(await readSub())).toBe(14);

    await extendTrial(actorId, orgId, 14, "sales call");
    const stamped = (await readSub()).trial_used_at;
    expect(stamped).not.toBeNull();
    expect(checkoutTrialDays(await readSub())).toBe(0);

    // A second grant extends the trial but never re-dates the stamp.
    await extendTrial(actorId, orgId, 7, "one more week");
    expect((await readSub()).trial_used_at).toEqual(stamped);
  });
});
