// Phase 2 pass-scoping sweep — `realtime` on the PUBLIC spectator surface.
//
// The gap Task 23 measured: `server/public-site/data.ts` resolved `realtime`
// ORG-WIDE in two places while the competition id sat in scope —
// `getPublicFixture` (which has `shell.competition.id`) and
// `fixtureRealtimeEligible` (whose join already selects `c.id`).
// lib/entitlements.ts only consults competition_passes when a competition is in
// scope, so a community org that bought an Event Pass got a 403 from
// `/api/v1/public/fixtures/{id}/realtime-token` for the very competition it paid
// to make live.
//
// The organiser-facing surfaces were already comp-scoped, which is what made
// this survive: the buyer saw live scoring work on their own noticeboard and
// for none of their audience. Live scoring nobody can watch is not the feature.
//
// The matrix makes this a real separation:
//   realtime  community=false  event_pass=true
// so a passed competition must be eligible and an unpassed one in the SAME org
// must not. Both directions are asserted — a one-sided test still passes if the
// gate leaks org-wide, which is the other half of the bug.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double `player-stats-public.test.ts` uses. Passthrough (not a memoising
// double) is deliberate here: caching a `realtime` answer across the passed and
// unpassed fixtures is exactly the failure mode under test.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { fixtureRealtimeEligible, getPublicFixture } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A COMMUNITY org with an explicit subscriptions row — `insert into
 *  organizations` alone leaves none, and the pass arm only fires while the
 *  resolved plan is 'community'. */
async function seedCommunityOrg(): Promise<{ orgId: string; orgSlug: string }> {
  const s = uniq();
  const orgSlug = "rt-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"RT Org " + s}, ${orgSlug})
    returning id`;
  await sql`
    with _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select created_by, 'community', 'active' from organizations where id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug };
}

/**
 * A PUBLIC competition with a division, stage and one fixture — the shape
 * `public_fixtures_v` needs. Rows are inserted directly rather than through the
 * usecases: the point is the entitlement read, and the scheduling engine would
 * drag entrants and a generated draw in for no added coverage.
 */
interface Seeded {
  fixtureId: string;
  competitionId: string;
  compSlug: string;
  divSlug: string;
}

async function seedPublicFixture(orgId: string, name: string): Promise<Seeded> {
  const s = uniq();
  const compSlug = "rt-comp-" + s;
  const divSlug = "open-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${name}, ${compSlug}, 'public', 'live') returning id`;
  const [{ id: divId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', 'active',
            ${sql.json({ resultMode: "score", allowDraws: true,
                         points: { w: 3, d: 1, l: 0 }, progressScore: false })}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divId}, ${stageId}, 1, 1, 1) returning id`;
  return { fixtureId, competitionId: compId, compSlug, divSlug };
}

/** Buy an Event Pass for one competition. */
async function buyPass(orgId: string, competitionId: string): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id)
    values (${competitionId}, ${orgId}) on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(orgId);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("public realtime is resolved against the fixture's competition", () => {
  // Both call sites are covered: the token route's gate
  // (`fixtureRealtimeEligible`) and the match page's own `realtime` flag
  // (`getPublicFixture`). They were the same one-line omission in two places,
  // and fixing one while leaving the other yields a page that renders a live
  // scorebug whose socket is refused — worse than either bug alone.
  it("the passed competition's fixture is eligible; an unpassed sibling is not", async () => {
    const { orgId } = await seedCommunityOrg();
    const passed = await seedPublicFixture(orgId, "Passed Live " + uniq());
    const plain = await seedPublicFixture(orgId, "Plain Live " + uniq());
    await buyPass(orgId, passed.competitionId);

    // RED before the fix: the 2-arg overload never saw the pass, so the token
    // route 403'd the fixture the organiser had paid to make live.
    expect(await fixtureRealtimeEligible(passed.fixtureId)).toBe(true);
    // The other half: the pass lifts ONE competition. If this ever resolves
    // org-wide again it flips true and fails.
    expect(await fixtureRealtimeEligible(plain.fixtureId)).toBe(false);
  });

  it("the match page's own realtime flag is comp-scoped too", async () => {
    const { orgId, orgSlug } = await seedCommunityOrg();
    const passed = await seedPublicFixture(orgId, "Passed Page " + uniq());
    const plain = await seedPublicFixture(orgId, "Plain Page " + uniq());
    await buyPass(orgId, passed.competitionId);

    const onPass = await getPublicFixture(
      orgSlug, passed.compSlug, passed.divSlug, passed.fixtureId,
    );
    const onPlain = await getPublicFixture(
      orgSlug, plain.compSlug, plain.divSlug, plain.fixtureId,
    );
    expect(onPass?.realtime).toBe(true);
    expect(onPlain?.realtime).toBe(false);
  });

  it("a community org with no pass at all is never eligible", async () => {
    const { orgId } = await seedCommunityOrg();
    const fixture = await seedPublicFixture(orgId, "No Pass " + uniq());
    expect(await fixtureRealtimeEligible(fixture.fixtureId)).toBe(false);
  });

  it("rejects a malformed fixture id without touching the database", async () => {
    expect(await fixtureRealtimeEligible("not-a-uuid")).toBe(false);
  });
});
