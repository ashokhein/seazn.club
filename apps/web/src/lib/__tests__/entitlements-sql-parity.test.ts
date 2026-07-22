// The SQL resolver (org_has_feature, V228) and the TS resolver
// (lib/entitlements.ts) answer the SAME question for two different callers —
// public views resolve in SQL, the app resolves in TS. V228 was written before
// override expiry + comped_until (V266), Event Passes (V270/V271) and the
// past_due grace anchor (V291) existed, so it has silently drifted four
// mechanisms behind, plus a fifth semantic fork on a null bool_value.
//
// This suite is the tie: every assertion pairs a TS answer with the SQL answer
// for the same org, so the two cannot diverge again without failing here.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Community org with an explicit subscriptions row. A raw
 *  `insert into organizations` does NOT create one (only lib/auth.ts does), and
 *  the resolvers' LEFT JOIN would then take a different arm than production. */
async function seedOrg(): Promise<string> {
  const s = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`parity-${s}@test.local`}, 'Parity Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Parity " + s}, ${"parity-" + s}, ${ownerId}) returning id`;
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  return orgId;
}

/** competitions has no `sport` column — sport lives on divisions. Only
 *  (org_id, name, slug) are NOT NULL without a default; slug is unique per org. */
async function seedCompetition(orgId: string, label: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${label + " " + uniq()}, ${label + "-" + uniq()}) returning id`;
  return id;
}

/** The SQL resolver must agree with the TS resolver on every mechanism the TS
 *  one implements — including taking a competition, which is what an Event Pass
 *  is scoped by. The 3-arg overload does not exist yet; that IS the drift. */
async function sqlHasFeature(orgId: string, key: string, compId?: string) {
  const [row] = await sql<{ v: boolean }[]>`
    select org_has_feature(${orgId}, ${key}, ${compId ?? null}) as v`;
  return row.v;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// The probe key is `realtime`, not `branding`: V310 made branding free for
// community, so it can no longer show a DEGRADE (community and pro both answer
// true) or a pass LIFT. `realtime` keeps the shape this suite needs —
// community false, pro true, event_pass true.
describe.skipIf(!HAS_DB)("org_has_feature parity with lib/entitlements", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await seedOrg();
    await invalidateOrgEntitlements(orgId);
  });

  it("ignores an EXPIRED override, like the TS resolver does", async () => {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, expires_at)
      values (${orgId}, 'realtime', true, now() - interval '1 day')`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
  });

  it("degrades a LAPSED comp to community", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', comped_until = now() - interval '1 day',
          stripe_subscription_id = null, status = 'active'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
  });

  it("degrades past_due beyond the 14-day grace", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'past_due',
          status_changed_at = now() - interval '15 days',
          stripe_subscription_id = 'sub_test'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
  });

  // V313's arm. It had to be added in BOTH resolvers: the public surfaces
  // (public_competitions_v's branding, the realtime reads in public-site/data.ts)
  // go through the SQL function and never touch lib/entitlements.ts, so a
  // TypeScript-only fix would have left half the app conveying Pro to departed
  // orgs.
  it("degrades a cancelled subscription that was never comped", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'canceled', stripe_subscription_id = 'sub_gone'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
  });

  // And the guard, in both: an indefinite staff comp writes comped_until = null,
  // so only comped_at separates it from the row above.
  it("keeps an indefinite comp alive on a cancelled subscription", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'canceled', stripe_subscription_id = 'sub_gone',
          comped_until = null, comped_at = now()
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(true);
  });

  it("honours an Event Pass for the competition in scope, and only that one", async () => {
    const passedId = await seedCompetition(orgId, "passed");
    const otherId = await seedCompetition(orgId, "other");
    await sql`
      insert into competition_passes (competition_id, org_id) values (${passedId}, ${orgId})`;
    await invalidateOrgEntitlements(orgId);

    expect(await hasFeature(orgId, "realtime", passedId)).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime", passedId)).toBe(true);
    expect(await hasFeature(orgId, "realtime", otherId)).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime", otherId)).toBe(false);
  });

  it("treats a null-bool override as no answer, not as a deny", async () => {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value)
      values (${orgId}, 'exports', null, 5)`;
    await invalidateOrgEntitlements(orgId);
    // community has exports=true since V285; an int-only override must not deny it.
    expect(await hasFeature(orgId, "exports")).toBe(true);
    expect(await sqlHasFeature(orgId, "exports")).toBe(true);
  });
});
