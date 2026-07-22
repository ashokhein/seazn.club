// Phase 2 pass-scoping sweep — `entrants.per_division.max` on public submit.
//
// usecases/registrations.ts `submitRegistration` bounds intake by the plan's
// entrant quota so it never accepts money for a spot the plan cannot
// materialise. It resolved that quota ORG-WIDE (`getLimit(ctx.org_id, …)`)
// twelve lines after using `ctx.competition_id` for the paid-intake gate, so
// an Event Pass never raised the cap on the competition it was bought for:
// entry 33 was waitlisted on a passed competition exactly as on a free one.
//
// The matrix makes this a real separation:
//   entrants.per_division.max  community=32  event_pass=64
// so with 32 spots already taken the 33rd entry must be ACCEPTED on the passed
// competition and WAITLISTED on an unpassed one in the same org. Asserting only
// the accepted side would still pass if the raised cap leaked org-wide.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { putRegistrationSettings, submitRegistration } from "../registrations";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

const SETTINGS_BASE = {
  enabled: true,
  entrant_kind: "individual" as const,
  opens_at: null,
  closes_at: null,
  // Unlimited by the organiser's own choice, so the PLAN quota is the only
  // thing that can waitlist anyone — otherwise the assertion measures capacity.
  capacity: null,
  currency: "gbp",
  refund_lock_at: null,
  form_fields: [],
  payment_method: "offline" as const,
  fee_cents: 0,
};

const SUBMIT_BASE = {
  display_name: "Entry 33",
  contact_email: "entry33@test.local",
  dob: null,
  gender: null,
  guardian_name: null,
  guardian_consent: false,
  privacy_consent: true,
  answers: {},
  players: [],
};

async function seedCommunityOrg(): Promise<{ orgId: string; orgSlug: string; auth: AuthCtx }> {
  const s = uniq();
  const orgSlug = "cap-org-" + s;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`cap-${s}@test.local`}, 'Cap Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Cap Org " + s}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  // A raw org insert leaves NO subscriptions row; the pass arm only fires while
  // the resolved plan is 'community', so pin it rather than rely on fallback.
  await sql`with _owner as (
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
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, auth: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null } };
}

/** An UNLISTED competition with one open-registration division, pre-loaded with
 *  `taken` spot-holding entries (inserted directly — 32 round trips through
 *  submitRegistration would only slow the suite down).
 *
 *  Unlisted, not public: public submit accepts both (registrations.ts guards
 *  `["public","unlisted"]`), but community holds only ONE public competition
 *  (`dashboard.public.max` = 1) and this rig needs two side by side. */
async function seedFullDivision(
  auth: AuthCtx,
  orgId: string,
  taken: number,
): Promise<{ competitionId: string; compSlug: string; divisionId: string }> {
  const s = uniq();
  const competition = await createCompetition(auth, {
    name: "Cap Cup " + s, visibility: "unlisted", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  await putRegistrationSettings(auth, division.id, SETTINGS_BASE);
  await sql`
    insert into registrations
      (division_id, org_id, status, display_name, contact_email, ref_code,
       access_token_hash, payment_method)
    select ${division.id}, ${orgId}, 'pending',
           'Seed ' || g, 'seed-' || g || '-' || ${s} || '@test.local',
           ${"SZ-" + s.toUpperCase() + "-"} || lpad(g::text, 4, '0'),
           ${s + "-"} || g, 'offline'
    from generate_series(1, ${taken}) g`;
  return { competitionId: competition.id, compSlug: competition.slug, divisionId: division.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("entrants.per_division.max is resolved against the competition being entered", () => {
  it("accepts entry 33 on the passed competition and waitlists it on an unpassed one", async () => {
    const { orgId, orgSlug, auth } = await seedCommunityOrg();
    const passed = await seedFullDivision(auth, orgId, 32);
    const plain = await seedFullDivision(auth, orgId, 32);
    await sql`
      insert into competition_passes (competition_id, org_id)
      values (${passed.competitionId}, ${orgId}) on conflict (competition_id) do nothing`;
    await invalidateOrgEntitlements(orgId);

    // Guard against a vacuous pass: the two quotas must actually differ, or
    // both arms below would agree for reasons that have nothing to do with
    // scoping. 32 spots taken sits exactly on the community cap.
    expect(await getLimit(orgId, "entrants.per_division.max")).toBe(32);
    expect(await getLimit(orgId, "entrants.per_division.max", passed.competitionId)).toBe(64);

    const onPassed = await submitRegistration(
      orgSlug, passed.compSlug,
      { ...SUBMIT_BASE, division_id: passed.divisionId },
      "https://test.local",
    );
    const onPlain = await submitRegistration(
      orgSlug, plain.compSlug,
      { ...SUBMIT_BASE, division_id: plain.divisionId },
      "https://test.local",
    );

    // RED before the fix: the quota was resolved org-wide, so the passed
    // competition capped at 32 too and this came back 'waitlisted'.
    expect(onPassed.registration.status).toBe("pending");
    // The pass lifts ONE competition — the sibling stays on the community cap.
    expect(onPlain.registration.status).toBe("waitlisted");
  });
});
