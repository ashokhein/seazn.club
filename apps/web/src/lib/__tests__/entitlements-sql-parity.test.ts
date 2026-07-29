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
import {
  getLimit,
  hasFeature,
  invalidateOrgEntitlements,
  PASS_END_GRACE_DAYS,
  passLockReason,
} from "@/lib/entitlements";

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
    // Seeded from the UTC calendar date, NOT bare `current_date`. `current_date`
    // is the session's TimeZone GUC (Europe/London locally and in production),
    // and `isPassLocked` compares on the UTC date — so between 00:00 and 01:00
    // BST the two differ by a day, "8 days ago" lands inside the 7-day grace on
    // the TS side, and this test goes red for an hour a night with nothing
    // wrong. That is the exact V334 divergence the NEXT test pins deliberately;
    // this one is about the grace window, so it must not also depend on it.
    await sql`
      update competitions
         set ends_on = ((now() at time zone 'utc')::date - 8)::date
       where id = ${compId}`;
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
  // Both divergence directions, EVERY run. The previous version chose one arm
  // from the current UTC hour (`h >= 10`), and only that arm placed
  // `ends_on + grace` exactly ON the boundary — so for 14 hours of every day a
  // `<` → `<=` mutation in passLockReason shipped green (#346). Nightly and
  // scheduled runs sit squarely in the blind window.
  //
  // Dates are UTC-midnight STRINGS on purpose: `new Date()` carries a time of
  // day, so "N days ago" lands hours past the boundary the rule compares
  // against, and the off-by-one becomes invisible.
  const utcDayString = (offsetDays: number): string => {
    const now = new Date();
    const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return new Date(ms + offsetDays * 86_400_000).toISOString().slice(0, 10);
  };

  for (const [label, offsetDays, expectLocked] of [
    // ends_on + 7 lands exactly ON today: STILL APPLYING (the `<` is strict).
    ["exactly on the grace boundary", -PASS_END_GRACE_DAYS, false],
    // One day past: locked.
    ["one day past the grace boundary", -PASS_END_GRACE_DAYS - 1, true],
  ] as const) {
    it(`agrees with the TS resolver ${label}, under a non-UTC session TZ`, async () => {
      const compId = await seedCompetition(orgId, `tz-boundary-${offsetDays}`);
      const endsOn = utcDayString(offsetDays);
      await sql`update competitions set ends_on = ${endsOn}::date where id = ${compId}`;
      await sql`
        insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId})`;
      await invalidateOrgEntitlements(orgId);

      // TS resolver: always UTC-based, unaffected by the DB session's TZ.
      expect(passLockReason("live", endsOn) !== null).toBe(expectLocked);

      // The SQL twin, forced onto a session TZ that is a guaranteed day away
      // from the UTC date, so a session-TZ basis (the V334 bug shape) diverges
      // visibly instead of coinciding. `set local` reverts at commit.
      const sqlAnswer = await sql.begin(async (tx) => {
        await tx`set local time zone 'Etc/GMT-14'`;
        const [row] = await tx<{ v: boolean }[]>`
          select org_has_feature(${orgId}, 'realtime', ${compId}) as v`;
        return row.v;
      });
      expect(sqlAnswer).toBe(!expectLocked);
    });
  }

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

    // try/finally, not a bare trailing delete: this is the only test in the
    // suite that adds an `event_pass` row, and a failed assertion used to leak
    // it into the shared DB — where the rung-parity test below would then
    // report it as a genuine M-only key and fail for a second, misleading
    // reason on every later run.
    try {
      expect(await sqlHasFeature(orgId, key, passedId)).toBe(true);
      expect(await hasFeature(orgId, key, passedId)).toBe(true);
    } finally {
      await sql`delete from plan_entitlements where feature_key = ${key}`;
    }
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

  // v17 #288: SQL org_has_feature was missing the 'incomplete' arm entirely
  // (fell through to coalesce(plan_key)='pro') while entitlements.ts's
  // orgPlanKey has carried it since #206/#223-B — a never-paid first
  // invoice read Pro on every SQL-resolved public surface until Stripe
  // auto-expired the subscription ~23h later. V338 copies the TS arm into
  // SQL verbatim.
  it("degrades an INCOMPLETE subscription (never-paid first invoice) to community", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'incomplete', stripe_subscription_id = 'sub_incomplete'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
  });

  // Coverage addition, not a regression: both resolvers already agreed a
  // suspended ORG resolves community regardless of its subscription's plan
  // (entitlements.ts:209, org_has_feature's first CASE arm) — this suite
  // never had a case proving it. Passes before AND after V338; it is here
  // so a future change to either arm trips this suite instead of shipping
  // silently.
  it("keeps a SUSPENDED org on community regardless of its subscription's plan", async () => {
    await sql`
      update subscriptions
      set plan_key = 'pro', status = 'active', stripe_subscription_id = 'sub_susp'
      where id = (select subscription_id from organizations o where o.id = ${orgId})`;
    await sql`update organizations set status = 'suspended' where id = ${orgId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime")).toBe(false);
  });

  // v17 #294 — the L rung. Migration V341 derives event_pass_l's WHOLE matrix
  // from event_pass (INSERT...SELECT), overriding only two keys. This proves
  // the override landed and everything else really did copy across, using the
  // SAME probe key (`realtime`) the rest of this file already established.
  it("the L rung (event_pass_l) overrides entrants and divisions, unlike M", async () => {
    const compId = await seedCompetition(orgId, "l-rung");
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${compId}, ${orgId}, 'event_pass_l')`;
    await invalidateOrgEntitlements(orgId);

    // Unlimited (null cap) — diverges from M's 128.
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBeNull();
    // 20 divisions — diverges from M's 10.
    expect(await getLimit(orgId, "divisions.per_competition.max", compId)).toBe(20);
    // Everything else is DERIVED from M unchanged — realtime is the existing
    // probe key for this file (community false, pro true, event_pass true).
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(true);
  });

  // Both resolvers must drop an L pass on a finished competition exactly like
  // an M pass — org_has_feature (V328) and isPassLocked never branch on
  // pass_key, but this pins it directly rather than trusting that by
  // inspection. Mirrors the existing "both resolvers drop a pass on a
  // COMPLETED" test above, with pass_key='event_pass_l'.
  it("both resolvers drop an L pass on a COMPLETED competition, same lock as M", async () => {
    const compId = await seedCompetition(orgId, "l-completed");
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${compId}, ${orgId}, 'event_pass_l')`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(true);
    // The numeric override lifts too, while live.
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBeNull();

    await sql`update competitions set status = 'completed' where id = ${compId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(false);
    expect(await sqlHasFeature(orgId, "realtime", compId)).toBe(false);
    // Locked: falls all the way through to the org's actual plan (community —
    // no paid subscription seeded), whose current entrants cap is 64 (V319).
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBe(64);
  });

  // THE ENFORCEMENT for V341's drift guarantee. V341 derives event_pass_l's
  // matrix from event_pass with INSERT...SELECT, but that is a migration-time
  // SNAPSHOT, not a live constraint. Every historic matrix seed (V283, V292,
  // V293, V294, V295, V302, V306, V308, V310, V311, V319) wrote 'event_pass'
  // rows only — so the next feature migration will too, and L will silently
  // not get the twin.
  //
  // The failure mode is silent AND backwards: both resolvers INNER-join
  // plan_entitlements on cp.pass_key (entitlements.ts:315-316; org_has_feature
  // since V338), so a key present for M but MISSING for L makes the pass stop
  // applying for that key — the MORE EXPENSIVE rung falls through to the org's
  // plan and DENIES a feature the cheaper rung grants. No FK, no error, no
  // other failing test. Hence a full-outer-join diff: an orphan on EITHER side
  // is a failure, and the only tolerated divergences are the two documented
  // overrides.
  //
  // Adding a genuinely L-specific entitlement later is fine — it just has to be
  // added to OVERRIDES here, which is the point: the divergence becomes a
  // deliberate, reviewed edit instead of an accident.
  it("keeps the L rung's matrix identical to M's apart from the documented overrides", async () => {
    const OVERRIDES = ["divisions.per_competition.max", "entrants.per_division.max"];

    // `present` markers rather than `m.feature_key is null`: an explicit
    // marker, robust to a null-valued row and to a later `ON`-join rewrite. A
    // real row can hold null in both value columns, so no value column can
    // stand in for "row absent"; the marker can never be null on a row that
    // exists, whatever the join is rewritten to.
    //
    // (This comment used to justify the marker by claiming feature_key is not
    // addressable under FULL OUTER JOIN ... USING. That is FALSE — only the
    // UNQUALIFIED reference is coalesced; qualified `m.feature_key` is still
    // addressable and is null for right-only rows, so it would have worked.
    // The marker is still the better code, and a wrong reason for right code
    // rots into a wrong fix.)
    const diff = await sql<
      { feature_key: string; reason: string; m_value: string; l_value: string }[]
    >`
      select
        feature_key,
        case
          when m.present is null then 'present for event_pass_l but MISSING for event_pass'
          when l.present is null then 'present for event_pass but MISSING for event_pass_l'
          else 'value differs'
        end as reason,
        coalesce(m.bool_value::text, '-') || '/' || coalesce(m.int_value::text, 'unlimited') as m_value,
        coalesce(l.bool_value::text, '-') || '/' || coalesce(l.int_value::text, 'unlimited') as l_value
      from (
        select feature_key, bool_value, int_value, true as present
        from plan_entitlements where plan_key = 'event_pass'
      ) m
      full outer join (
        select feature_key, bool_value, int_value, true as present
        from plan_entitlements where plan_key = 'event_pass_l'
      ) l using (feature_key)
      where m.present is null
         or l.present is null
         or m.bool_value is distinct from l.bool_value
         or m.int_value  is distinct from l.int_value
      order by feature_key`;

    // Orphans first — this is the drift shape that silently denies, and it must
    // never be tolerated on either side. Joined into ONE STRING deliberately:
    // `toEqual([])` on an array serialises to "expected [ Array(1) ] to deeply
    // equal []" in vitest's JSON reporter, hiding the very key the failure is
    // about. Comparing strings puts the offending key straight in the message.
    const orphans = diff
      .filter((r) => r.reason !== "value differs")
      .map((r) => `${r.feature_key}: ${r.reason}`);
    expect(orphans.join(" | ")).toBe("");

    // Every remaining divergence must be a documented override — again as a
    // string so an unexpected key is named in the failure.
    expect(diff.map((r) => r.feature_key).join(", ")).toBe(OVERRIDES.join(", "));

    // And the overrides must still hold the values #294 decided, so this test
    // also fails if someone "fixes" the drift by copying M's caps back over L.
    expect(await sql`
      select int_value from plan_entitlements
      where plan_key = 'event_pass_l' and feature_key = 'entrants.per_division.max'`).toEqual([
      { int_value: null },
    ]);
    expect(await sql`
      select int_value from plan_entitlements
      where plan_key = 'event_pass_l' and feature_key = 'divisions.per_competition.max'`).toEqual([
      { int_value: 20 },
    ]);
  });
});
