// Unified "Add Entrant": enrolling an EXISTING club team into a division
// (season rollover, league + cup) with optional roster copy. Real Postgres
// required (RLS, triggers, the partial unique index); skipped without
// DATABASE_URL. Redis intentionally absent — entitlement reads hit the
// documented fail-open (cache miss → Postgres) path.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, listEntrants, getEntrant, divisionRoster } from "../entrants";
import { createPerson } from "../persons";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function setPlan(orgId: string, plan: "community" | "pro"): Promise<void> {
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
}

async function seedOrg(plan: "community" | "pro" = "community"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Enr " + suffix}, ${"enr-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog) values
      ('generic',  'Generic',  '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })}),
      ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)}),
      ('cricket',  'Cricket',  ${cricket.version}, ${sql.json(cricket.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system) values
      ('generic',  'score',   'Score',   ${sql.json({ resultMode: "score", points: { w: 3, d: 1, l: 0 } })}, true),
      ('football', 'default', 'Default', ${sql.json({})}, true),
      ('cricket',  't20',     'T20',     ${sql.json(cricket.variants.t20 as never)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

/** Teams are normally born in the CSV import; seed one directly (with a parent
 *  club) so the enroll flow has something to reference. */
async function seedTeam(
  auth: AuthCtx,
  name: string,
  clubName = "Riverside FC",
): Promise<{ id: string; name: string }> {
  return withTenant(auth.orgId, async (tx) => {
    const [club] = await tx<{ id: string }[]>`
      insert into clubs (org_id, name) values (${auth.orgId}, ${clubName}) returning id`;
    const [team] = await tx<{ id: string; name: string }[]>`
      insert into teams (org_id, name, club_id)
      values (${auth.orgId}, ${name}, ${club!.id}) returning id, name`;
    return team!;
  });
}

async function makeDivision(auth: AuthCtx, competitionId: string, sport: string) {
  return createDivision(auth, competitionId, {
    name: `Div ${randomUUID().slice(0, 6)}`,
    sport_key: sport,
    variant_key: sport === "football" ? "default" : sport === "cricket" ? "t20" : "score",
    config: sport === "generic" ? GENERIC_CONFIG : {},
    eligibility: [],
  } as never);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("enroll an existing team", () => {
  it("enrolls into a division, snapshotting the name; club filter returns it; 409 on repeat", async () => {
    // Seed under Pro (division + team creation are Pro), then DOWNGRADE to
    // community before enrolling — enrolling an existing team is ungated, so an
    // org that lost Pro keeps working with its imported teams.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: "Rollover Cup",
      visibility: "private",
      branding: {},
    });
    const team = await seedTeam(auth, "Riverside U12");
    const league = await makeDivision(auth, comp.id, "generic");
    const cup = await makeDivision(auth, comp.id, "generic");
    await setPlan(auth.orgId, "community");

    // Criterion 1: same team into two divisions → one team, two entrants.
    const [inLeague] = await createEntrants(auth, league.id, [
      { kind: "team", team_id: team.id, members: [] },
    ]);
    const [inCup] = await createEntrants(auth, cup.id, [
      { kind: "team", team_id: team.id, members: [] },
    ]);
    expect(inLeague!.display_name).toBe("Riverside U12"); // snapshotted from the team
    expect(inCup!.display_name).toBe("Riverside U12");
    expect(inLeague!.team_id).toBe(team.id);

    // Club facet returns the team's entrant in each division.
    const [{ id: clubId }] = await withTenant(
      auth.orgId,
      (tx) => tx<{ id: string }[]>`
      select club_id as id from teams where id = ${team.id}`,
    );
    const leagueByClub = await listEntrants(auth, league.id, { clubId });
    expect(leagueByClub.map((e) => e.id)).toContain(inLeague!.id);

    // Criterion 3: enrolling the same team into the same division again → 409.
    await expect(
      createEntrants(auth, league.id, [{ kind: "team", team_id: team.id, members: [] }]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("copies the roster, keeping keys within a sport and dropping invalid ones across sports", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: "Copy Cup",
      visibility: "private",
      branding: {},
    });
    const team = await seedTeam(auth, "Harbour U16");

    const p1 = await createPerson(auth, {
      full_name: "Ada Keeper",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const p2 = await createPerson(auth, {
      full_name: "Bea Back",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });

    // Source: football entrant with a position ("GK") and role ("captain").
    const foot1 = await makeDivision(auth, comp.id, "football");
    const [source] = await createEntrants(auth, foot1.id, [
      {
        kind: "team",
        team_id: team.id,
        members: [
          {
            person_id: p1.id,
            squad_number: 1,
            is_captain: true,
            roles: ["captain"],
            default_position_key: "GK",
          },
          {
            person_id: p2.id,
            squad_number: 2,
            is_captain: false,
            roles: [],
            default_position_key: "DF",
          },
        ],
      },
    ]);

    // Criterion 2a — same sport: keys carry over, nothing dropped.
    const foot2 = await makeDivision(auth, comp.id, "football");
    const [sameSport] = await createEntrants(auth, foot2.id, [
      {
        kind: "team",
        team_id: team.id,
        copy_roster_from_entrant_id: source!.id,
        members: [],
      },
    ]);
    expect(sameSport!.roster_keys_dropped ?? 0).toBe(0);
    const sameMembers = (await getEntrant(auth, sameSport!.id)).members as {
      person_id: string;
      default_position_key: string | null;
      roles: string[];
      is_captain: boolean;
    }[];
    expect(sameMembers).toHaveLength(2);
    const keeper = sameMembers.find((m) => m.person_id === p1.id)!;
    expect(keeper.default_position_key).toBe("GK");
    expect(keeper.roles).toEqual(["captain"]);
    expect(keeper.is_captain).toBe(true);

    // Criterion 2b — cross sport: members copy, invalid position dropped, count surfaced.
    const crick = await makeDivision(auth, comp.id, "cricket");
    const [crossSport] = await createEntrants(auth, crick.id, [
      {
        kind: "team",
        team_id: team.id,
        copy_roster_from_entrant_id: source!.id,
        members: [],
      },
    ]);
    expect(crossSport!.roster_keys_dropped).toBeGreaterThanOrEqual(1); // "GK" not a cricket position
    const crossMembers = (await getEntrant(auth, crossSport!.id)).members as {
      person_id: string;
      default_position_key: string | null;
    }[];
    expect(crossMembers).toHaveLength(2); // members kept
    expect(crossMembers.find((m) => m.person_id === p1.id)!.default_position_key).toBeNull(); // key dropped
  });

  it("divisionRoster maps every (person → team entrant) for the double-roster warning, org-scoped", async () => {
    const { auth } = await seedOrg("pro");
    const other = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: "Warn Cup",
      visibility: "private",
      branding: {},
    });
    const div = await makeDivision(auth, comp.id, "generic");
    const p = await createPerson(auth, {
      full_name: "Shared",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });

    // Same person on two team entrants in this division.
    const [red] = await createEntrants(auth, div.id, [
      {
        kind: "team",
        display_name: "Red",
        members: [{ person_id: p.id, is_captain: false, roles: [] }],
      },
    ]);
    const [blue] = await createEntrants(auth, div.id, [
      {
        kind: "team",
        display_name: "Blue",
        members: [{ person_id: p.id, is_captain: false, roles: [] }],
      },
    ]);

    const roster = await divisionRoster(auth, div.id);
    const forShared = roster
      .filter((r) => r.person_id === p.id)
      .map((r) => r.entrant_id)
      .sort();
    expect(forShared).toEqual([red!.id, blue!.id].sort()); // on both teams → conflict surfaces

    // Another org can't read this division's roster (RLS): empty.
    expect(await divisionRoster(other.auth, div.id)).toEqual([]);
  });

  it("leaves the entrant name unchanged after the team is renamed", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: "Rename Cup",
      visibility: "private",
      branding: {},
    });
    const team = await seedTeam(auth, "Old Name U14");
    const div = await makeDivision(auth, comp.id, "generic");
    const [entrant] = await createEntrants(auth, div.id, [
      { kind: "team", team_id: team.id, members: [] },
    ]);

    await withTenant(
      auth.orgId,
      (tx) => tx`update teams set name = ${"New Name U15"} where id = ${team.id}`,
    );

    // Criterion 5: standings read entrants.display_name — the snapshot holds.
    const after = await getEntrant(auth, entrant!.id);
    expect(after.display_name).toBe("Old Name U14");
  });

  it("a started division refuses new entrants — except open formats (ladder/americano)", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: "Lock Cup",
      visibility: "private",
      branding: {},
    });

    // Fixed-format division (league): active → 422 on add; withdraw untouched.
    const league = await makeDivision(auth, comp.id, "generic");
    await createEntrants(auth, league.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
    ]);
    await withTenant(
      auth.orgId,
      (tx) => tx`
      insert into stages (division_id, seq, kind, name, config)
      values (${league.id}, 1, 'league', 'League', '{}')`,
    );
    await withTenant(
      auth.orgId,
      (tx) => tx`
      update divisions set status = 'active' where id = ${league.id}`,
    );
    await expect(
      createEntrants(auth, league.id, [
        { kind: "individual", display_name: "Latecomer", members: [] },
      ]),
    ).rejects.toThrow(/started/);
    expect((await listEntrants(auth, league.id)).length).toBe(2);

    // Ladder divisions run over an open window — late joiners are the point.
    const ladder = await makeDivision(auth, comp.id, "generic");
    await withTenant(
      auth.orgId,
      (tx) => tx`
      insert into stages (division_id, seq, kind, name, config)
      values (${ladder.id}, 1, 'ladder', 'Ladder', '{}')`,
    );
    await withTenant(
      auth.orgId,
      (tx) => tx`
      update divisions set status = 'active' where id = ${ladder.id}`,
    );
    const [late] = await createEntrants(auth, ladder.id, [
      { kind: "individual", display_name: "Challenger", members: [] },
    ]);
    expect(late!.display_name).toBe("Challenger");
  });
});
