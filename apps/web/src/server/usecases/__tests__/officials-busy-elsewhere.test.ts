// Cross-org "booked elsewhere" derived read (v11.1 follow-up): blackout dates
// already fan out person-wide, but a real assignment is tenant-isolated — org
// B assigns blind when org A already booked the same claimed official. This
// read must surface ONLY { official_id, scheduled_at } for MY org's officials
// — never which org/competition/fixture the other assignment belongs to.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { claimPerson } from "../person-claims";
import {
  createOfficial,
  inviteOfficial,
  listOfficialBusyElsewhere,
  patchFixtureOfficials,
} from "../officials";
import { setMyOfficiatingResponse } from "../me-officiating";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<{ id: string; email: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true)
    returning id`;
  return { id, email };
}

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Busy " + suffix}, ${"busy-" + suffix}, ${owner.id}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: owner.id, role: "owner", keyId: null } };
}

/** Division with a FUTURE scheduled fixture — the busy-elsewhere filter drops
 *  anything more than a day in the past. */
async function seedFutureDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    name: "Busy Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  await createEntrants(
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
  const t0 = Date.now() + 7 * 86_400_000;
  for (let i = 0; i < fixtures.length; i++) {
    await sql`
      update fixtures
      set scheduled_at = ${new Date(t0 + i * 30 * 60_000).toISOString()},
          court_label = 'Court 1'
      where id = ${fixtures[i]!.id}`;
  }
  return { division, fixtures };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("cross-org booked-elsewhere read (v11.1)", () => {
  it("surfaces the other org's timestamp for a claimed official shared across orgs", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const ref = await makeUser("shared-ref");

    const officialA = await createOfficial(orgA.auth, { display_name: "Ref A-side", role_keys: ["referee"] });
    const officialB = await createOfficial(orgB.auth, { display_name: "Ref B-side", role_keys: ["referee"] });
    const invitedA = await inviteOfficial(orgA.auth, officialA.id, ref.email);
    const invitedB = await inviteOfficial(orgB.auth, officialB.id, ref.email);
    await claimPerson(invitedA.secret, ref.id, ref.email);
    await claimPerson(invitedB.secret, ref.id, ref.email);

    // Before any assignment, neither side is busy.
    expect(await listOfficialBusyElsewhere(orgB.auth)).toEqual([]);

    const { fixtures } = await seedFutureDivision(orgA.auth);
    const fixtureId = fixtures[0]!.id;
    await patchFixtureOfficials(orgA.auth, fixtureId, {
      set: [{ official_id: officialA.id, role_key: "referee", locked: false }],
    });

    const [{ scheduled_at: expectedAt }] = await sql<{ scheduled_at: string }[]>`
      select scheduled_at from fixtures where id = ${fixtureId}`;

    // Org B now sees ITS OWN official (officialB) flagged busy, timestamp only.
    const busyForB = await listOfficialBusyElsewhere(orgB.auth);
    expect(busyForB).toHaveLength(1);
    expect(busyForB[0]!.official_id).toBe(officialB.id);
    expect(new Date(busyForB[0]!.scheduled_at).toISOString()).toBe(
      new Date(expectedAt).toISOString(),
    );
    // Leak regression: the row carries ONLY official_id + scheduled_at — no
    // org name/id, no fixture/competition/division, no role.
    expect(Object.keys(busyForB[0]!).sort()).toEqual(["official_id", "scheduled_at"]);

    // Org A's own read of ITS OWN officials must not show its own booking as
    // "elsewhere" (the busy read is cross-org only).
    expect(await listOfficialBusyElsewhere(orgA.auth)).toEqual([]);

    // A decline retracts the busy signal — the other organiser has released
    // the slot in all but name, and a pending re-pick shouldn't stay flagged.
    await setMyOfficiatingResponse(ref.id, fixtureId, { response: "declined" });
    expect(await listOfficialBusyElsewhere(orgB.auth)).toEqual([]);
  });

  it("never flags an unclaimed official, even one that shares a display name", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const ref = await makeUser("claimed-ref");

    const officialA = await createOfficial(orgA.auth, { display_name: "Claimed Ref", role_keys: ["referee"] });
    const unclaimed = await createOfficial(orgB.auth, { display_name: "Unclaimed Ref", role_keys: ["referee"] });
    const invitedA = await inviteOfficial(orgA.auth, officialA.id, ref.email);
    await claimPerson(invitedA.secret, ref.id, ref.email);
    // orgB's official is never invited/claimed — no persons.user_id link at all.

    const { fixtures } = await seedFutureDivision(orgA.auth);
    await patchFixtureOfficials(orgA.auth, fixtures[0]!.id, {
      set: [{ official_id: officialA.id, role_key: "referee", locked: false }],
    });

    const busyForB = await listOfficialBusyElsewhere(orgB.auth);
    expect(busyForB.find((b) => b.official_id === unclaimed.id)).toBeUndefined();
    expect(busyForB).toEqual([]);
  });
});
