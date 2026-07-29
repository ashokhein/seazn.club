// An Event Pass under a PAID plan (v17 gap #327/#337).
//
// Until V344 the resolver stopped consulting the pass the moment the resolved
// plan was paid, on the premise that Pro was a strict superset of any pass. The
// L rung (#294) ended that: `entrants.per_division.max` is 256 on Pro and
// UNLIMITED on L. So an organiser who bought L for a competition and then
// subscribed to Pro silently lost unlimited entrants on the competition they
// had already paid to unlock — a PAID action that took something away.
//
// What ships instead is the BETTER of the two, per axis. This suite pins all
// four directions of that, because getting any one of them backwards is a
// money-facing bug:
//
//   * pass better  → pass wins   (entrants: L unlimited vs Pro 256)
//   * plan better  → plan wins   (divisions: Pro unlimited vs L's 20)
//   * lower better → smaller wins (registration.fee_percent: Pro 2% vs pass 5%)
//   * pass says false → plan's true survives (the pass never revokes)
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(): Promise<string> {
  const s = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`passplan-${s}@test.local`}, 'Pass Plan Owner', true) returning id`;
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status)
    values (${ownerId}, 'community', 'active') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${"Pass Plan " + s}, ${"pass-plan-" + s}, ${ownerId}, ${subId}) returning id`;
  return orgId;
}

async function seedCompetition(orgId: string): Promise<string> {
  const s = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Passed " + s}, ${"passed-" + s}) returning id`;
  return id;
}

async function setPlan(orgId: string, planKey: string): Promise<void> {
  await sql`
    update subscriptions set plan_key = ${planKey}, status = 'active'
     where id = (select subscription_id from organizations where id = ${orgId})`;
  await invalidateOrgEntitlements(orgId);
}

async function grantPass(orgId: string, compId: string, rung: string): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id, pass_key)
    values (${compId}, ${orgId}, ${rung})`;
  await invalidateOrgEntitlements(orgId);
}

/** The SQL resolver's answer, which must never disagree with the TS one. */
async function sqlHasFeature(orgId: string, key: string, compId?: string): Promise<boolean> {
  const [row] = await sql<{ v: boolean }[]>`
    select org_has_feature(${orgId}, ${key}, ${compId ?? null}) as v`;
  return row!.v;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("an Event Pass under a paid plan (#327/#337)", () => {
  let orgId = "";
  let compId = "";
  beforeEach(async () => {
    orgId = await seedOrg();
    compId = await seedCompetition(orgId);
  });

  it("keeps the pass's unlimited entrants when the org upgrades to Pro", async () => {
    // #337 itself. Community + L = unlimited; the upgrade to Pro must not put a
    // 256 ceiling back on a competition the org already paid to unlock.
    await grantPass(orgId, compId, "event_pass_l");
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBeNull();

    await setPlan(orgId, "pro");
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBeNull();
  });

  it("keeps the PLAN's unlimited divisions rather than the pass's 20", async () => {
    // The other direction, and the one a naive "pass wins" overlay gets wrong:
    // L caps divisions at 20 and Pro does not cap them at all, so taking the
    // pass wholesale would make the purchase a downgrade on that axis.
    await setPlan(orgId, "pro");
    await grantPass(orgId, compId, "event_pass_l");
    expect(await getLimit(orgId, "divisions.per_competition.max", compId)).toBeNull();
  });

  it("charges the PLAN's lower entry-fee percentage, not the pass's higher one", async () => {
    // The money case. Pro takes 2%, both rungs take 5%. A plain max-of-both
    // would bill a Pro organiser 5% on every entry to their passed competition
    // — the pass they bought making them worse off.
    await setPlan(orgId, "pro");
    const planFee = await getLimit(orgId, "registration.fee_percent", compId);
    await grantPass(orgId, compId, "event_pass_l");
    expect(await getLimit(orgId, "registration.fee_percent", compId)).toBe(planFee);
    expect(planFee).toBe(2);
  });

  it("does not let the pass switch off a feature the plan grants", async () => {
    // `dashboard.branding` is true on Pro and false on both rungs. Before #327
    // the pass arm never ran under a paid plan so this could not arise; now it
    // does, and a coalesce that took the pass's `false` first would strip a
    // Pro-only feature from exactly the competition the org paid extra for.
    await setPlan(orgId, "pro");
    await grantPass(orgId, compId, "event_pass_l");
    expect(await hasFeature(orgId, "dashboard.branding", compId)).toBe(true);
    expect(await sqlHasFeature(orgId, "dashboard.branding", compId)).toBe(true);
  });

  it("still lifts a community org's blocked feature, in both resolvers", async () => {
    // The pre-existing behaviour this change must not disturb, asserted in SQL
    // as well: V344 rewrote the pass arm of org_has_feature, and
    // entitlements-sql-parity is the tie between the two resolvers.
    await grantPass(orgId, compId, "event_pass");
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(true);
    // Scoped to the competition that holds it, exactly as before.
    const other = await seedCompetition(orgId);
    expect(await hasFeature(orgId, "realtime", other)).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime", other)).toBe(false);
  });

  it("grants a pass-only feature to a PAID org too, in both resolvers", async () => {
    // The bool half of #327: a key the pass says true and the plan does not.
    // Both resolvers have to agree, or the public views and the app disagree
    // about the same competition.
    await setPlan(orgId, "pro");
    await grantPass(orgId, compId, "event_pass_l");
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements
       where plan_key = 'event_pass_l' and feature_key = 'realtime' and bool_value`;
    // Canary: if the matrix ever stops granting this on the rung, the assertion
    // below would pass for the wrong reason.
    expect(row!.n).toBe(1);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(true);
  });
});
