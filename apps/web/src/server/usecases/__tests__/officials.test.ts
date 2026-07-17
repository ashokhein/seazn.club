// Integration tests for PROMPT-22 (Jul3/02): officials CRUD, auto → apply,
// manual set/lock, hide-names public read, entitlement gates. Real Postgres
// required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import {
  createOfficial,
  listOfficials,
  importOfficials,
  autoAssignOfficials,
  applyOfficialAssignments,
  patchFixtureOfficials,
} from "../officials";
import { acceptedOfficialCovers, fixtureScope } from "../scorers";
import {
  makeUser as makeSeedUser,
  seedOrg as seedSeedOrg,
  seedFutureDivision,
} from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Off " + suffix}, ${"off-" + suffix})
    returning id`;
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

// competition + division + 4 entrants + league fixtures, all scheduled on one
// court in 30-minute slots.
async function seedScheduledDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    name: "Officials Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    // full config override: the shared test DB's variant row may be a stale
    // partial — don't depend on it
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const, display_name: name, seed: i + 1, members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "League", config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const t0 = Date.UTC(2026, 6, 10, 9, 0, 0);
  for (let i = 0; i < fixtures.length; i++) {
    await sql`
      update fixtures
      set scheduled_at = ${new Date(t0 + i * 30 * 60_000).toISOString()},
          court_label = 'Court 1'
      where id = ${fixtures[i]!.id}`;
  }
  return { comp, division, stage: stage!, fixtures, entrants };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("officials assignment (Jul3/02)", () => {
  it("auto-proposes, applies, caches, and ledgers the assignment", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedScheduledDivision(auth);
    await createOfficial(auth, { display_name: "Ref One", role_keys: ["referee"] });
    await createOfficial(auth, { display_name: "Ref Two", role_keys: ["referee"] });

    const proposal = await autoAssignOfficials(auth, division.id, {
      policy: {
        roles: ["referee"], poolLock: false, blockStay: true, fairness: "tournament",
        teamRefKeepDivision: false, restMinMinutes: 0, blockGapMinutes: 30,
      },
      rng_seed: "t",
    });
    expect(proposal.assignments).toHaveLength(fixtures.length);
    expect(proposal.conflicts.filter((c) => c.severity === "block")).toEqual([]);

    const officials = await listOfficials(auth);
    const idByName = new Map(officials.map((o) => [o.display_name, o.id]));
    const { applied } = await applyOfficialAssignments(auth, division.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixtureId, official_id: a.officialId, role_key: a.roleKey,
        locked: false,
      })),
    });
    expect(applied).toBe(fixtures.length);
    expect(idByName.size).toBe(2);

    // read cache + ledger + chain
    const [cached] = await sql<{ officials: { name: string; role: string }[] }[]>`
      select officials from fixtures where id = ${fixtures[0]!.id}`;
    expect(cached!.officials).toHaveLength(1);
    expect(cached!.officials[0]).toMatchObject({ role: "referee" });
    const [ev] = await sql<{ type: string; broken: string | null }[]>`
      select type, verify_division_events_chain(division_id)::text as broken
      from division_events
      where division_id = ${division.id} and type = 'officials_assigned'`;
    expect(ev).toMatchObject({ type: "officials_assigned", broken: null });
  });

  it("team-as-referee is never assigned to its own fixture", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures, entrants } = await seedScheduledDivision(auth);
    // one team-ref official belonging to entrant A — plays in 3 of 6 fixtures
    await createOfficial(auth, {
      display_name: "Team A (ref)", role_keys: ["referee"], entrant_id: entrants[0]!.id,
    });
    const proposal = await autoAssignOfficials(auth, division.id, {
      policy: {
        roles: ["referee"], poolLock: false, blockStay: false, fairness: "tournament",
        teamRefKeepDivision: false, restMinMinutes: 0, blockGapMinutes: 30,
      },
      rng_seed: "t",
    });
    const aFixtures = new Set(
      fixtures
        .filter((f: { home_entrant_id: string | null; away_entrant_id: string | null }) =>
          f.home_entrant_id === entrants[0]!.id || f.away_entrant_id === entrants[0]!.id)
        .map((f: { id: string }) => f.id),
    );
    for (const a of proposal.assignments) {
      expect(aFixtures.has(a.fixtureId)).toBe(false);
    }
  });

  it("locked assignments survive apply; re-apply keeps them", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedScheduledDivision(auth);
    const ref = await createOfficial(auth, { display_name: "Pinned", role_keys: ["referee"] });
    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: ref.id, role_key: "referee", locked: true }],
    });
    await applyOfficialAssignments(auth, division.id, { assignments: [] });
    const [row] = await sql<{ locked: boolean }[]>`
      select locked from fixture_officials where fixture_id = ${fixtures[0]!.id}`;
    expect(row).toMatchObject({ locked: true });
  });

  it("hide-names strips officials from the public read (25 Jun)", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedScheduledDivision(auth);
    const ref = await createOfficial(auth, { display_name: "Secret Ref", role_keys: ["referee"] });
    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: ref.id, role_key: "referee", locked: false }],
    });
    // publish so timetable fields (and officials) are public at all
    await sql`update divisions set status = 'scheduled' where id = ${division.id}`;
    const before = await sql<{ officials: unknown[] }[]>`
      select officials from public_fixtures_v where id = ${fixtures[0]!.id}`;
    expect(before[0]!.officials).toHaveLength(1);

    await patchDivision(auth, division.id, { officials_hide_names: true });
    const after = await sql<{ officials: unknown[] }[]>`
      select officials from public_fixtures_v where id = ${fixtures[0]!.id}`;
    expect(after[0]!.officials).toEqual([]);
  });

  it("Community: manual single-role free; multi-role and auto 402", async () => {
    const { auth } = await seedOrg("community");
    const { division, fixtures } = await seedScheduledDivision(auth);
    const ref = await createOfficial(auth, { display_name: "Solo", role_keys: ["referee"] });
    await patchFixtureOfficials(auth, fixtures[0]!.id, {
      set: [{ official_id: ref.id, role_key: "referee", locked: false }],
    });

    await expect(
      createOfficial(auth, { display_name: "Multi", role_keys: ["referee", "judge"] }),
    ).rejects.toMatchObject({ featureKey: "officials.roles_multi" });

    await expect(
      autoAssignOfficials(auth, division.id, {
        policy: {
          roles: ["referee"], poolLock: false, blockStay: false, fairness: "tournament",
          teamRefKeepDivision: false, restMinMinutes: 0, blockGapMinutes: 30,
        },
        rng_seed: "t",
      }),
    ).rejects.toMatchObject({ featureKey: "officials.auto" });
  });

  it("bulk officials import is idempotent on display name", async () => {
    const { auth } = await seedOrg();
    const csv = "Name,Roles,MaxPerDay\nUma Umpire,referee,4\nJay Judge,referee judge,\n";
    const first = await importOfficials(auth, "officials.csv", "text/csv", Buffer.from(csv));
    expect(first).toEqual({ created: 2, skipped: 0 });
    const again = await importOfficials(auth, "officials.csv", "text/csv", Buffer.from(csv));
    expect(again).toEqual({ created: 0, skipped: 2 });
    const officials = await listOfficials(auth);
    expect(officials.find((o) => o.display_name === "Jay Judge")?.role_keys).toEqual([
      "referee", "judge",
    ]);
  });
});

describe.skipIf(!HAS_DB)("non-member official fixture access rule", () => {
  it("accepted official (no org_members row) covers only their fixture, in-org", async () => {
    const { auth } = await seedSeedOrg("pro");
    const { fixtures } = await seedFutureDivision(auth);
    const fixtureId = fixtures[0]!.id;
    const user = await makeSeedUser("Ref Three"); // deliberately NOT inserted into org_members
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Ref Three', ${user.id}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref Three', ${sql.json(["umpire"])}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'umpire', 'accepted')`;

    const members = await sql`select 1 from org_members where user_id = ${user.id}`;
    expect(members.length).toBe(0); // still a non-member — Option 2

    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(true);
    const scope = await fixtureScope(fixtureId);
    expect(scope?.org_id).toBe(auth.orgId);
  });
});
