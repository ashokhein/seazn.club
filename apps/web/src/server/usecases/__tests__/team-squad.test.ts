// Persistent team squad: create a team under a club, manage its squad, and have
// that squad auto-seed an entrant roster on enrollment (filtered per sport).
// Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createClub } from "../clubs";
import { createTeam, setTeamSquad, getTeamSquad } from "../teams";
import { createPerson } from "../persons";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, getEntrant } from "../entrants";

const HAS_DB = !!process.env.DATABASE_URL;
const GENERIC = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

async function seedOrg(plan: "community" | "pro"): Promise<AuthCtx> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sq " + s}, ${"sq-" + s}) returning id`;
  if (plan !== "community") {
    await sql`insert into subscriptions (org_id, plan_key, status) values (${orgId}, ${plan}, 'active')
              on conflict (org_id) do update set plan_key = ${plan}`;
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
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function makeDivision(auth: AuthCtx, competitionId: string, sport: string) {
  return createDivision(auth, competitionId, {
    name: `D ${randomUUID().slice(0, 6)}`,
    sport_key: sport,
    variant_key: sport === "football" ? "default" : sport === "cricket" ? "t20" : "score",
    config: sport === "generic" ? GENERIC : {},
    eligibility: [],
  } as never);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("team squad", () => {
  it("creates a team under a club (Pro) and standalone (community, spec 3/7)", async () => {
    const pro = await seedOrg("pro");
    const club = await createClub(pro, { name: "Riverside FC" });
    const team = await createTeam(pro, { name: "Riverside U12", club_id: club.id });
    expect(team.name).toBe("Riverside U12");
    expect(team.club_id).toBe(club.id);

    // V291 (spec decision 3/7) opens clubs.hierarchy to every plan — a community
    // org can now create teams too; the teams.max cap is the brake, not a Pro
    // gate (that cap is covered in club-caps.test.ts).
    const comm = await seedOrg("community");
    const commTeam = await createTeam(comm, { name: "Comm Standalone" });
    expect(commTeam.club_id).toBeNull();
  });

  it("stores and replaces the squad", async () => {
    const auth = await seedOrg("pro");
    const club = await createClub(auth, { name: "Harbour FC" });
    const team = await createTeam(auth, { name: "Harbour U16", club_id: club.id });
    const p1 = await createPerson(auth, { full_name: "Ada", consent: {}, dob: null, gender: null, external_ref: null });
    const p2 = await createPerson(auth, { full_name: "Bea", consent: {}, dob: null, gender: null, external_ref: null });

    const saved = await setTeamSquad(auth, team.id, [
      { person_id: p1.id, squad_number: 7, is_captain: true, roles: [], default_position_key: null },
      { person_id: p2.id, squad_number: 9, is_captain: false, roles: [], default_position_key: null },
    ]);
    expect(saved.members).toHaveLength(2);
    expect(saved.members.find((m) => m.person_id === p1.id)!.is_captain).toBe(true);

    // Full replace: drop p2.
    await setTeamSquad(auth, team.id, [
      { person_id: p1.id, squad_number: 7, is_captain: true, roles: [], default_position_key: null },
    ]);
    const after = await getTeamSquad(auth, team.id);
    expect(after.members.map((m) => m.person_id)).toEqual([p1.id]);
  });

  it("auto-seeds an entrant roster from the squad on enrollment, filtered per sport", async () => {
    const auth = await seedOrg("pro");
    const club = await createClub(auth, { name: "Seed FC" });
    const team = await createTeam(auth, { name: "Seed U18", club_id: club.id });
    const p1 = await createPerson(auth, { full_name: "Keeper", consent: {}, dob: null, gender: null, external_ref: null });
    const p2 = await createPerson(auth, { full_name: "Back", consent: {}, dob: null, gender: null, external_ref: null });
    await setTeamSquad(auth, team.id, [
      { person_id: p1.id, squad_number: 1, is_captain: true, roles: ["captain"], default_position_key: "GK" },
      { person_id: p2.id, squad_number: 2, is_captain: false, roles: [], default_position_key: "DF" },
    ]);

    const comp = await createCompetition(auth, { name: "Seed Cup", visibility: "private", branding: {} });

    // Football division: squad seeds with its keys intact.
    const foot = await makeDivision(auth, comp.id, "football");
    const [inFoot] = await createEntrants(auth, foot.id, [{ kind: "team", team_id: team.id, members: [] }]);
    const footRoster = (await getEntrant(auth, inFoot!.id)).members as { person_id: string; default_position_key: string | null }[];
    expect(footRoster).toHaveLength(2); // seeded from squad
    expect(footRoster.find((m) => m.person_id === p1.id)!.default_position_key).toBe("GK");

    // Cricket division: members seed, GK (not a cricket position) dropped.
    const crick = await makeDivision(auth, comp.id, "cricket");
    const [inCrick] = await createEntrants(auth, crick.id, [{ kind: "team", team_id: team.id, members: [] }]);
    expect(inCrick!.roster_keys_dropped).toBeGreaterThanOrEqual(1);
    const crickRoster = (await getEntrant(auth, inCrick!.id)).members as { person_id: string; default_position_key: string | null }[];
    expect(crickRoster).toHaveLength(2);
    expect(crickRoster.find((m) => m.person_id === p1.id)!.default_position_key).toBeNull();
  });
});
