// PROMPT-60 §2 — bulk enrolment: CreateEntrant.members accepts a new person
// inline ({ new_person: { full_name } }) beside existing person_id members, all
// created/linked in ONE transaction. Plus the entrant badge upload (storage
// mocked; the bucket write is supabase's concern, the path/column ours).
import { describe, expect, it, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, setEntrantBadge } from "../entrants";
import { createPerson } from "../persons";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Bk " + suffix}, ${"bk-" + suffix})
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
    name: "Bk Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  return division;
}

async function personCount(orgId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from persons where org_id = ${orgId}`;
  return n;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("inline new-person members + badge upload (PROMPT-60 §2)", () => {
  it("creates new persons in the same tx and links them beside existing members", async () => {
    const { auth } = await seedOrg();
    const division = await seedDivision(auth);
    const existing = await createPerson(auth, { full_name: "Keeper", consent: {} } as never);

    const [entrant] = await createEntrants(auth, division.id, [
      {
        kind: "team",
        display_name: "Mexico",
        members: [
          { person_id: existing.id, squad_number: 1, is_captain: true, roles: [] },
          { new_person: { full_name: "Striker Nine" }, squad_number: 9, is_captain: false, roles: [] },
          { new_person: { full_name: "Winger Seven" }, squad_number: 7, is_captain: false, roles: [] },
        ],
      } as never,
    ]);

    const members = await sql<{ person_id: string; squad_number: number | null; full_name: string }[]>`
      select em.person_id, em.squad_number, p.full_name
      from entrant_members em join persons p on p.id = em.person_id
      where em.entrant_id = ${entrant!.id} order by em.squad_number`;
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.full_name).sort()).toEqual(["Keeper", "Striker Nine", "Winger Seven"]);
    expect(await personCount(auth.orgId)).toBe(3); // 1 existing + 2 inline
  });

  it("is atomic: an unknown person_id in the mix leaves no orphan inline persons", async () => {
    const { auth } = await seedOrg();
    const division = await seedDivision(auth);
    const before = await personCount(auth.orgId);
    await expect(
      createEntrants(auth, division.id, [
        {
          kind: "team",
          display_name: "Broken",
          members: [
            { new_person: { full_name: "Orphan Risk" }, is_captain: false, roles: [] },
            { person_id: randomUUID(), is_captain: false, roles: [] }, // unknown
          ],
        } as never,
      ]),
    ).rejects.toMatchObject({ status: 422 });
    expect(await personCount(auth.orgId)).toBe(before); // rolled back
  });

  it("setEntrantBadge stores a storage path in badge_url and DELETE clears it", async () => {
    const { auth } = await seedOrg();
    const division = await seedDivision(auth);
    const [entrant] = await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "Solo", members: [] },
    ]);
    const row = await setEntrantBadge(auth, entrant!.id, {
      contentType: "image/png",
      bytes: Buffer.from("fake-png-bytes"),
    });
    expect(row.badge_url).toMatch(/^orgs\/.+\/entrant-badges\/.+\.png$/);

    const cleared = await setEntrantBadge(auth, entrant!.id, null);
    expect(cleared.badge_url).toBeNull();
  });
});
