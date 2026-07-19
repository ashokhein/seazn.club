// Clubs W1 regression net — the "enroll an existing team" contract, end to end
// at the usecase layer. A first-time enrollment (no prior entrant, no explicit
// members) must seed the entrant roster from the team's persistent squad, and
// the console logo map must fall through entrant badge → team logo → CLUB
// crest so a squad-only club team never renders as a bare monogram.
// Real Postgres required.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { listEntrantLogoUrls, setTeamSquad } from "../teams";

const HAS_DB = !!process.env.DATABASE_URL;

// publicStorageUrl returns "" without this — the logo-map assertions below
// need real URLs (same stub as the sibling badge suite).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sq " + suffix}, ${"sq-" + suffix})
    returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'pro', 'active')
    on conflict (org_id) do update set plan_key = 'pro'`;
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

async function seedDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    name: "Sq Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {},
  });
  return createDivision(auth, comp.id, {
    name: "Sq Div", slug: "sq-div", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
}

/** Club → team (no own logo) → two squad persons, mirroring the console flow. */
async function seedClubTeamSquad(auth: AuthCtx) {
  const [{ id: clubId }] = await sql<{ id: string }[]>`
    insert into clubs (org_id, name, logo_path)
    values (${auth.orgId}, ${"Seed FC " + randomUUID().slice(0, 6)}, ${"orgs/x/clubs/crest.png"})
    returning id`;
  const [{ id: teamId }] = await sql<{ id: string }[]>`
    insert into teams (org_id, name, club_id)
    values (${auth.orgId}, ${"Seed U12 " + randomUUID().slice(0, 6)}, ${clubId})
    returning id`;
  const persons: string[] = [];
  for (const name of ["Ana Seed", "Bo Seed"]) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${auth.orgId}, ${name}, '{}') returning id`;
    persons.push(id);
  }
  await setTeamSquad(
    auth,
    teamId,
    persons.map((person_id, i) => ({
      person_id,
      squad_number: i + 1,
      default_position_key: i === 0 ? "ghost_position" : null, // stripped by the sport filter
      is_captain: i === 0,
      roles: ["player"], // not in generic's role catalog — stripped, member kept
    })),
  );
  return { clubId, teamId, persons };
}

describe.skipIf(!HAS_DB)("enroll-existing-team seeding (clubs W1)", () => {
  it("first enrollment seeds the roster from the team squad; filter strips keys, never members", async () => {
    const { auth } = await seedOrg();
    const division = await seedDivision(auth);
    const { teamId, persons } = await seedClubTeamSquad(auth);

    const [entrant] = await createEntrants(auth, division.id, [
      { kind: "team", team_id: teamId, members: [] }, // the panel's enroll modal payload (zod defaults members to [])
    ]);
    if (!entrant) throw new Error("no entrant created");
    expect(entrant.display_name).toContain("Seed U12");

    const members = await sql<{ person_id: string; default_position_key: string | null; roles: unknown }[]>`
      select person_id, default_position_key, roles from entrant_members
      where entrant_id = ${entrant.id} order by squad_number`;
    // Both squad members carried over — the sport filter strips unknown
    // position/role KEYS but must never drop a person.
    expect(members.map((m) => m.person_id)).toEqual(persons);
    expect(members[0]!.default_position_key).toBeNull(); // ghost_position stripped
    expect(members.every((m) => Array.isArray(m.roles) && (m.roles as unknown[]).length === 0)).toBe(true);
  });

  it("logo map falls through to the club crest for a team with no own badge", async () => {
    const { auth } = await seedOrg();
    const division = await seedDivision(auth);
    const { teamId } = await seedClubTeamSquad(auth);
    const [entrant] = await createEntrants(auth, division.id, [{ kind: "team", team_id: teamId, members: [] }]);

    const map = await listEntrantLogoUrls(auth, division.id);
    const url = map[entrant!.id];
    // No entrant badge, no team logo → the CLUB crest must resolve (the
    // entrants-tab regression: rows ignored this map and showed monograms).
    expect(url).toBeTruthy();
    expect(url).toContain("orgs/x/clubs/crest.png");
  });

  it("an own team logo beats the club crest in the map", async () => {
    const { auth } = await seedOrg();
    const division = await seedDivision(auth);
    const { teamId } = await seedClubTeamSquad(auth);
    await sql`update teams set logo_path = 'orgs/x/teams/own.png' where id = ${teamId}`;
    const [entrant] = await createEntrants(auth, division.id, [{ kind: "team", team_id: teamId, members: [] }]);

    const map = await listEntrantLogoUrls(auth, division.id);
    expect(map[entrant!.id]).toContain("orgs/x/teams/own.png");
  });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});
