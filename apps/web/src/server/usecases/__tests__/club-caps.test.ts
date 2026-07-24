// Cap enforcement (W1 §4): community grids cap clubs at 5, teams at 8, and squad
// at 20 (V319 plan_entitlements). createClub/createTeam/setTeamSquad must throw
// PaymentRequiredError(featureKey) once a create would cross the plan limit.
// Each test seeds a fresh org (unique orgId → unique entitlement cache key), so
// the 300s entitlement cache never leaks a limit across tests. Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createClub } from "../clubs";
import { createTeam, setTeamSquad } from "../teams";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Cap " + suffix}, ${"cap-" + suffix})
    returning id`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("club/team caps", () => {
  it("blocks the 6th club on community with PaymentRequiredError(clubs.max)", async () => {
    const auth = await seedOrg(); // fixture org is community by default
    for (const name of ["Cap One", "Cap Two", "Cap Three", "Cap Four", "Cap Five"]) {
      await createClub(auth, { name }); // community cap is 5 (V319)
    }
    await expect(createClub(auth, { name: "Cap Six" })).rejects.toMatchObject({
      featureKey: "clubs.max",
    });
  });

  it("blocks the 9th team org-wide on community with teams.max", async () => {
    const auth2 = await seedOrg(); // fresh org fixture
    const club = await createClub(auth2, { name: "T Cap" });
    await createTeam(auth2, { name: "T1", club_id: club.id });
    // Fill to the community teams cap of 8 (V319); standalone teams count too.
    for (const name of ["T2", "T3", "T4", "T5", "T6", "T7", "T8"]) {
      await createTeam(auth2, { name });
    }
    await expect(createTeam(auth2, { name: "T9" })).rejects.toMatchObject({
      featureKey: "teams.max",
    });
  });

  it("blocks a 21-person squad on community with teams.squad_max", async () => {
    const auth3 = await seedOrg(); // fresh community org fixture (cap = 20)
    const team = await createTeam(auth3, { name: "Squad Cap" }); // standalone is fine
    const members = [];
    for (let i = 0; i < 21; i++) {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${auth3.orgId}, ${"P" + i}) returning id`;
      members.push({ person_id: id, squad_number: null, default_position_key: null, is_captain: false, roles: [] });
    }
    await expect(setTeamSquad(auth3, team.id, members)).rejects.toMatchObject({
      featureKey: "teams.squad_max",
    });
  });
});
