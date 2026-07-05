// Consent matrix + visibility + entitlement tests for the public read model
// (PROMPT-12 acceptance; doc 06 §4.7 — legal requirement, doc 09 §1/§4).
// Real Postgres required (views + SQL functions); skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx; orgId: string; suffix: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgId,
    suffix,
  };
}

async function seedPerson(
  orgId: string,
  fullName: string,
  consent: Record<string, boolean>,
): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, photo_path, consent)
    values (${orgId}, ${fullName}, '2011-04-03', 'f', ${"photos/" + fullName}, ${sql.json(consent)})
    returning id`;
  return id;
}

interface PublicScene {
  auth: AuthCtx;
  orgId: string;
  competitionId: string;
  divisionId: string;
  alice: string; // full consent
  bob: string; // no consent
}

async function seedPublicScene(): Promise<PublicScene> {
  const { auth, orgId } = await seedOrg();
  const alice = await seedPerson(orgId, "Alice Wonder", {
    public_name: true,
    public_photo: true,
  });
  const bob = await seedPerson(orgId, "Bob Builder", {});
  const competition = await createCompetition(auth, {
    name: "Open Day",
    visibility: "public",
    branding: { logo: "logos/x.png", banner: "banners/x.png" },
  });
  const division = await createDivision(auth, competition.id, {
    name: "U16",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(auth, division.id, [
    {
      kind: "pair",
      display_name: "Wonder & Builder",
      seed: 1,
      members: [
        { person_id: alice, squad_number: 7, default_position_key: null, is_captain: true, roles: [] },
        { person_id: bob, squad_number: 9, default_position_key: null, is_captain: false, roles: [] },
      ],
    },
  ]);
  return { auth, orgId, competitionId: competition.id, divisionId: division.id, alice, bob };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("public read model — consent matrix (doc 06 §4.7)", () => {
  it("renders initials + no person link + no photo without consent; full data with consent", async () => {
    const scene = await seedPublicScene();
    const [entrant] = await sql<{ members: Record<string, unknown>[] }[]>`
      select members from public_entrants_v where division_id = ${scene.divisionId}`;
    const members = entrant.members;
    const aliceRow = members.find((m) => m["person_id"] === scene.alice);
    const bobRow = members.find((m) => m["person_id"] === null);

    expect(aliceRow?.["name"]).toBe("Alice Wonder");
    expect(aliceRow?.["photo"]).toBe("photos/Alice Wonder");
    expect(aliceRow?.["squad_number"]).toBe(7);

    // Bob: initials only, no player-card link, no photo.
    expect(bobRow?.["name"]).toBe("B.B.");
    expect(bobRow?.["photo"]).toBeNull();
  });

  it("player card view contains only consented persons (the card 404s otherwise)", async () => {
    const scene = await seedPublicScene();
    const players = await sql<{ id: string }[]>`
      select id from public_players_v where org_id = ${scene.orgId}`;
    const ids = players.map((p) => p.id);
    expect(ids).toContain(scene.alice);
    expect(ids).not.toContain(scene.bob);
  });

  it("DOB and unconsented full names never appear in any public payload", async () => {
    const scene = await seedPublicScene();
    // Every public view that could carry person data, serialised whole.
    const payloads = JSON.stringify({
      competitions: await sql`select * from public_competitions_v where org_id = ${scene.orgId}`,
      divisions: await sql`select d.* from public_divisions_v d
        join public_competitions_v c on c.id = d.competition_id where c.org_id = ${scene.orgId}`,
      entrants: await sql`select * from public_entrants_v where division_id = ${scene.divisionId}`,
      players: await sql`select * from public_players_v where org_id = ${scene.orgId}`,
      fixtures: await sql`select * from public_fixtures_v where division_id = ${scene.divisionId}`,
    });
    expect(payloads).not.toContain("dob");
    expect(payloads).not.toContain("2011-04-03");
    expect(payloads).not.toContain("Bob Builder");
  });
});

describe.skipIf(!HAS_DB)("public read model — visibility (doc 09 §1)", () => {
  it("public + unlisted are served (with visibility flag); private never appears", async () => {
    const { auth, orgId } = await seedOrg();
    await createCompetition(auth, { name: "Open", visibility: "public", branding: {} });
    await createCompetition(auth, { name: "Hidden Link", visibility: "unlisted", branding: {} });
    await createCompetition(auth, { name: "Secret", visibility: "private", branding: {} });

    const rows = await sql<{ name: string; visibility: string }[]>`
      select name, visibility from public_competitions_v where org_id = ${orgId}`;
    expect(rows.map((r) => r.name).sort()).toEqual(["Hidden Link", "Open"]);
    expect(rows.find((r) => r.name === "Hidden Link")?.visibility).toBe("unlisted");
  });
});

describe.skipIf(!HAS_DB)("entitlement split (doc 09 §4, doc 10)", () => {
  it("nulls branding in the view for non-entitled (community) orgs, restores on override", async () => {
    const scene = await seedPublicScene();
    const [before] = await sql<{ branding: Record<string, unknown> }[]>`
      select branding from public_competitions_v where id = ${scene.competitionId}`;
    expect(before.branding).toEqual({});

    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${scene.orgId}, 'branding', true, 'test')`;
    const [after] = await sql<{ branding: Record<string, unknown> }[]>`
      select branding from public_competitions_v where id = ${scene.competitionId}`;
    expect(after.branding).toEqual({ logo: "logos/x.png", banner: "banners/x.png" });
  });

  it("community orgs hold at most one public competition (dashboard.public.max)", async () => {
    const { auth } = await seedOrg();
    await createCompetition(auth, { name: "First", visibility: "public", branding: {} });
    await expect(
      createCompetition(auth, { name: "Second", visibility: "public", branding: {} }),
    ).rejects.toThrow(PaymentRequiredError);

    // Unlisted/private don't count; flipping one to public re-checks the quota.
    const unlisted = await createCompetition(auth, {
      name: "Third",
      visibility: "unlisted",
      branding: {},
    });
    await expect(
      patchCompetition(auth, unlisted.id, { visibility: "public" }),
    ).rejects.toThrow(PaymentRequiredError);
  });
});
