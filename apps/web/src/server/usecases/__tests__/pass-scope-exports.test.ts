// Phase 2 pass-scoping sweep — `exports.branded` on the competition timetable.
//
// usecases/exports.ts `orgBranding` resolved `exports.branded` ORG-WIDE while
// holding the competition id in its own parameter list (it hands that same id
// to resolveSponsors two lines later). lib/entitlements.ts only consults
// competition_passes when a competition is in scope, so a community org that
// bought an Event Pass got an UNBRANDED pdf for the very competition it paid
// to brand — the grant was invisible to the resolver.
//
// The matrix makes this a real separation, not a coincidence:
//   exports.branded  community=false  event_pass=true
// so a passed competition must brand and an unpassed one in the SAME org must
// not. Both directions are asserted; a one-sided test would still pass if the
// gate leaked org-wide, which is the other half of the bug.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { buildCompetitionTimetable } from "../exports";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};
const PRINTED = "2026-07-21T09:00:00.000Z";

/** A COMMUNITY org with an explicit subscriptions row — `insert into
 *  organizations` alone leaves none, and the pass arm only fires while the
 *  resolved plan is 'community'. */
async function seedCommunityOrg(): Promise<{ orgId: string; orgName: string; auth: AuthCtx }> {
  const s = uniq();
  const orgName = "Brand Exp " + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${orgName}, ${"brand-exp-" + s})
    returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status) values (${orgId}, 'community', 'active')
    on conflict (org_id) do update set plan_key = 'community', status = 'active'`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgName, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

/** A competition with one (empty) division — enough for a timetable doc. */
async function seedCompetition(auth: AuthCtx, name: string): Promise<string> {
  const competition = await createCompetition(auth, { name, visibility: "private", branding: {} });
  await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  return competition.id;
}

/** Buy an Event Pass for one competition. */
async function buyPass(orgId: string, competitionId: string): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id) values (${competitionId}, ${orgId})
    on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(orgId);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("exports.branded is resolved against the competition being exported", () => {
  it("brands the passed competition's timetable and leaves an unpassed one plain", async () => {
    const { orgId, orgName, auth } = await seedCommunityOrg();
    const passedId = await seedCompetition(auth, "Passed Cup " + uniq());
    const plainId = await seedCompetition(auth, "Plain Cup " + uniq());
    await buyPass(orgId, passedId);

    const passed = await buildCompetitionTimetable(auth, passedId, { printedAt: PRINTED });
    const plain = await buildCompetitionTimetable(auth, plainId, { printedAt: PRINTED });

    // RED before the fix: `orgBranding` dropped the competition id, so the
    // resolver never saw the pass and BOTH docs came back undefined.
    expect(passed.branding?.orgName).toBe(orgName);
    // The other half: the pass lifts ONE competition. If the gate ever
    // resolves org-wide again this flips to branded and fails.
    expect(plain.branding).toBeUndefined();
  });
});
