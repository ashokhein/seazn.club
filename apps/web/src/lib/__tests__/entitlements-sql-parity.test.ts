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

  // v17 SPEC-4 §7: an Event Pass stops applying once its competition is over.
  // Both resolvers must agree the pass is LOCKED, not just that it is honoured on
  // a live competition — so an archived comp and a long-ended comp are proven in
  // lockstep here, next to the honoured case above.
  it("both resolvers drop a pass on an ARCHIVED competition", async () => {
    const compId = await seedCompetition(orgId, "archived");
    await sql`
      insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    // Honoured while live…
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(true);
    // …dropped once archived, in BOTH resolvers.
    await sql`update competitions set status = 'archived' where id = ${compId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(false);
  });

  it("both resolvers drop a pass on a COMPLETED (finished) competition", async () => {
    const compId = await seedCompetition(orgId, "completed");
    await sql`
      insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(true);
    await sql`update competitions set status = 'completed' where id = ${compId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(false);
  });

  it("both resolvers drop a pass on a competition ended beyond the grace window", async () => {
    const compId = await seedCompetition(orgId, "ended");
    await sql`
      update competitions set ends_on = (current_date - 8)::date where id = ${compId}`;
    await sql`
      insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(false);
  });

  // V334: the pass-lock grace boundary must be the UTC calendar date on BOTH
  // sides, not the DB session's TimeZone GUC. Before the fix, the SQL arm
  // compared against bare `current_date` (the session's TimeZone GUC —
  // Europe/London in production) while the TS resolver (isPassLocked) always
  // computes on the UTC calendar date, so around the moment the session's
  // date rolls over the two can disagree on whether a pass is locked.
  //
  // Etc/GMT-14 (UTC+14) only rolls the session date FORWARD a day once the
  // real UTC hour has reached 10 (10 + 14 = 24 wraps); Etc/GMT+12 (UTC-12) is
  // the mirror — it rolls the date BACKWARD a day whenever the UTC hour is
  // under 12. Between the two, every possible real-clock UTC hour gets a
  // guaranteed one-day divergence from the UTC date, so this test can't
  // spuriously pass by running during a UTC hour where a fixed tz offset
  // happens not to cross midnight. `set local time zone` is scoped to a
  // transaction (a single pinned connection via sql.begin) so it reverts
  // automatically at commit — no other test or connection in the pool
  // inherits it.
  it("agrees with the TS resolver at the grace boundary under a non-UTC session TZ", async () => {
    const compId = await seedCompetition(orgId, "tz-boundary");
    const [{ h }] = await sql<{ h: number }[]>`
      select extract(hour from now() at time zone 'utc')::int as h`;
    const forward = h >= 10;

    if (forward) {
      // Session date lands one day AHEAD of the UTC date — production's
      // Europe/London BST bug shape. `ends_on + 7 days` sits exactly ON the
      // UTC boundary (not locked under UTC), so the buggy SQL (comparing
      // against a date one day further on) wrongly locks it.
      await sql`
        update competitions
        set ends_on = ((now() at time zone 'utc')::date - interval '7 days')::date
        where id = ${compId}`;
    } else {
      // Mirror divergence: session date lands one day BEHIND the UTC date.
      // `ends_on + 7 days` sits exactly on the SESSION date (not locked under
      // the buggy session-TZ basis), one day short of the UTC boundary, so
      // the buggy SQL wrongly leaves it unlocked while UTC says locked.
      await sql`
        update competitions
        set ends_on = ((now() at time zone 'utc')::date - interval '8 days')::date
        where id = ${compId}`;
    }
    await sql`
      insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId})`;
    await invalidateOrgEntitlements(orgId);

    // TS resolver: always UTC-based, unaffected by the DB session's TZ.
    // Forward case is just inside the grace window (pass lifts); the mirror
    // case is one day past it (pass is locked).
    const expected = forward;
    expect(await hasFeature(orgId, "realtime", compId)).toBe(expected);

    // SQL resolver, forced onto a session TZ a calendar day off from UTC.
    const sqlAnswer = await sql.begin(async (tx) => {
      if (forward) {
        await tx`set local time zone 'Etc/GMT-14'`;
      } else {
        await tx`set local time zone 'Etc/GMT+12'`;
      }
      const [row] = await tx<{ v: boolean }[]>`
        select org_has_feature(${orgId}, 'realtime', ${compId}) as v`;
      return row.v;
    });
    expect(sqlAnswer).toBe(expected);
  });

  it("coalesces a null-bool Event Pass row THROUGH to the plan, not into a deny", async () => {
    // A pass row whose bool_value is null is NO answer, not a deny: it must fall
    // through to the plan row, exactly as org_has_feature's coalesce does.
    // Latent today — no shipped pass key is null-bool where community is true —
    // so a run-unique key builds precisely that shape. Before the fix the TS
    // resolver took the pass row as authoritative and denied while SQL allowed.
    // See issue #209.
    const key = `passnull-${uniq()}`;
    await sql`
      insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
      values ('community',  ${key}, true, null),
             ('event_pass', ${key}, null, 7)`;
    const passedId = await seedCompetition(orgId, "passnull");
    await sql`
      insert into competition_passes (competition_id, org_id) values (${passedId}, ${orgId})`;
    await invalidateOrgEntitlements(orgId);

    expect(await sqlHasFeature(orgId, key, passedId)).toBe(true);
    expect(await hasFeature(orgId, key, passedId)).toBe(true);

    await sql`delete from plan_entitlements where feature_key = ${key}`;
  });

  // Trial-end backstop (fix/trialing-trial-end-backstop): the resolver never
  // read trial_end before, so a trialing sub whose trial had ended kept
  // granting Pro for ever once its transition webhook went missing. Both
  // resolvers must agree at every point around the 1-day grace boundary.
  it("keeps a MID-TRIAL subscription on its paid plan", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'trialing', stripe_subscription_id = 'sub_test',
          trial_end = now() + interval '5 days'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(true);
  });

  it("degrades a trialing sub whose trial_end is 2 days past", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'trialing', stripe_subscription_id = 'sub_test',
          trial_end = now() - interval '2 days'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
  });

  it("does NOT degrade a trialing sub within the 1-day grace (trial_end 12h ago)", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'trialing', stripe_subscription_id = 'sub_test',
          trial_end = now() - interval '12 hours'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(true);
  });

  it("keeps a trialing sub with a NULL trial_end on its paid plan", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'trialing', stripe_subscription_id = 'sub_test',
          trial_end = null
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(true);
  });

  it("leaves an ACTIVE subscription unaffected by the trial-end backstop", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'active', stripe_subscription_id = 'sub_test'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(true);
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
