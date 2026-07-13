// PROMPT-53 /me reads and writes: cross-org isolation (user A never sees
// user B's persons), RSVP upsert semantics, guardian-gated consent with tag
// revalidation, QR check-in defaulting. Real Postgres required.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { createPerson } from "../persons";
import {
  listMyFixtures,
  setMyAvailability,
  checkInToFixture,
  listMyPersons,
  setMyConsent,
} from "../me";

vi.mock("@/server/public-site/revalidate", () => ({
  fireDivisionRevalidate: vi.fn(),
}));
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(tag: string): Promise<{ orgId: string; ownerId: string; owner: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${`Me ${tag} ${suffix}`}, ${`me-${tag}-${suffix}`}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`insert into subscriptions (org_id, plan_key, status) values (${orgId}, 'pro', 'active')
            on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  return { orgId, ownerId, owner };
}

/** Division of 4 individual entrants, each backed by a person; fixtures generated + started. */
async function rig(owner: AuthCtx, opts: { dob?: string | null } = {}) {
  const competition = await createCompetition(owner, {
    name: "Me Cup " + randomUUID().slice(0, 6), visibility: "public", branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
  });
  const persons = [];
  for (const n of ["Ada", "Ben", "Cal", "Dee"]) {
    persons.push(
      await createPerson(owner, {
        full_name: n, consent: {}, dob: opts.dob ?? null,
      } as never),
    );
  }
  const entrants = await createEntrants(
    owner, division.id,
    persons.map((p, i) => ({
      kind: "individual" as const,
      display_name: p.full_name,
      seed: i + 1,
      members: [{
        person_id: p.id, squad_number: null, default_position_key: null,
        is_captain: false, roles: [],
      }],
    })),
  );
  const [stage] = await createStages(owner, division.id, {
    seq: 1, kind: "league", name: "L", config: {},
  });
  const { fixtures } = await generateStageFixtures(owner, stage.id);
  await startDivision(owner, division.id);
  return { competition, division, persons, entrants, fixtures };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("player home /me (PROMPT-53)", () => {
  it("cross-org isolation: my persons across orgs, nobody else's", async () => {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    const rigA = await rig(a.owner);
    const rigB = await rig(b.owner);
    const player = await makeUser("player");
    const stranger = await makeUser("stranger");
    // Claim Ada in org A and Ben in org B for the same login.
    await sql`update persons set user_id = ${player} where id = ${rigA.persons[0].id}`;
    await sql`update persons set user_id = ${player} where id = ${rigB.persons[1].id}`;

    const mine = await listMyFixtures(player);
    const orgs = new Set(mine.upcoming.map((f) => f.org_name));
    expect(orgs.size).toBe(2);
    // League of 4: each entrant plays 3.
    expect(mine.upcoming.filter((f) => f.person_id === rigA.persons[0].id)).toHaveLength(3);
    expect(mine.teams).toHaveLength(2);

    const theirs = await listMyFixtures(stranger);
    expect(theirs.upcoming).toHaveLength(0);
    expect(theirs.teams).toHaveLength(0);

    const personsList = await listMyPersons(player);
    expect(personsList.map((p) => p.full_name).sort()).toEqual(["Ada", "Ben"]);
    // dob never rides out on the /me payload.
    expect(Object.keys(personsList[0])).not.toContain("dob");
  });

  it("withdrawn entrants drop out of /me", async () => {
    const { owner } = await seedOrg("w");
    const { persons, entrants } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;
    expect((await listMyFixtures(player)).upcoming.length).toBeGreaterThan(0);
    await sql`update entrants set status = 'withdrawn' where id = ${entrants[0].id}`;
    expect((await listMyFixtures(player)).upcoming).toHaveLength(0);
  });

  it("RSVP upserts (in → out keeps one row), 403 on a fixture that isn't mine", async () => {
    const { owner } = await seedOrg("r");
    const { persons, fixtures } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;
    const myFixture = (await listMyFixtures(player)).upcoming[0];

    const first = await setMyAvailability(player, myFixture.id, { status: "in" });
    expect(first.status).toBe("in");
    const second = await setMyAvailability(player, myFixture.id, {
      status: "out", note: "away that weekend",
    });
    expect(second.status).toBe("out");
    expect(second.note).toBe("away that weekend");
    const rows = await sql`
      select 1 from fixture_availability
      where fixture_id = ${myFixture.id} and person_id = ${persons[0].id}`;
    expect(rows).toHaveLength(1);

    // A fixture between the OTHER entrants is not mine.
    const mineIds = (await listMyFixtures(player)).upcoming.map((f) => f.id);
    const other = fixtures.find((f) => !mineIds.includes(f.id))!;
    expect(other).toBeDefined();
    await expect(setMyAvailability(player, other.id, { status: "in" })).rejects.toMatchObject({
      status: 403,
      code: "NOT_YOUR_FIXTURE",
    });
  });

  it("check-in stamps presence, defaults RSVP to 'in', never clobbers an 'out'", async () => {
    const { owner } = await seedOrg("c");
    const { persons } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;
    const [f1, f2] = (await listMyFixtures(player)).upcoming;

    // Fresh row: turning up answers the RSVP.
    const fresh = await checkInToFixture(player, f1.id);
    expect(fresh?.status).toBe("in");
    expect(fresh?.checked_in_at).not.toBeNull();

    // Existing 'out' answer survives a check-in.
    await setMyAvailability(player, f2.id, { status: "out" });
    const kept = await checkInToFixture(player, f2.id);
    expect(kept?.status).toBe("out");
    expect(kept?.checked_in_at).not.toBeNull();

    // No claimed person on the fixture → null (claim-first interstitial).
    const stranger = await makeUser("stranger");
    expect(await checkInToFixture(stranger, f1.id)).toBeNull();
  });

  it("isPlayerOnly: claimed person + no org = true; members and strangers = false", async () => {
    const { owner, ownerId } = await seedOrg("po");
    const { persons } = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${persons[0].id}`;

    const { isPlayerOnly } = await import("../me");
    expect(await isPlayerOnly(player)).toBe(true); // claimed, no memberships
    expect(await isPlayerOnly(ownerId)).toBe(false); // org member
    expect(await isPlayerOnly(await makeUser("stranger"))).toBe(false); // neither
  });

  it("consent flip persists, revalidates the person's divisions; guardian gate 403s", async () => {
    const { owner } = await seedOrg("g");
    const adult = await rig(owner);
    const player = await makeUser("player");
    await sql`update persons set user_id = ${player} where id = ${adult.persons[0].id}`;

    vi.mocked(fireDivisionRevalidate).mockClear();
    const updated = await setMyConsent(player, adult.persons[0].id, { public_name: true });
    expect(updated.consent.public_name).toBe(true);
    expect(updated.consent_locked).toBe(false);
    expect(fireDivisionRevalidate).toHaveBeenCalledWith(
      adult.division.id,
      adult.competition.id,
    );

    // Under-16: read shows locked, write 403s, organiser values hold.
    const minor = await rig(owner, { dob: "2013-01-01" });
    const kid = await makeUser("kid");
    await sql`update persons set user_id = ${kid} where id = ${minor.persons[0].id}`;
    const [kidPerson] = await listMyPersons(kid);
    expect(kidPerson.consent_locked).toBe(true);
    await expect(setMyConsent(kid, minor.persons[0].id, { public_name: true })).rejects.toMatchObject({
      status: 403,
      code: "CONSENT_LOCKED",
    });

    // Not my person → 404 (no oracle about other users' persons).
    await expect(setMyConsent(player, minor.persons[0].id, { public_name: true })).rejects.toMatchObject({
      status: 404,
    });
  });
});
