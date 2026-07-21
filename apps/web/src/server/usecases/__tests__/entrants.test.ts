// Entrant-shape write validation (spec 2026-07-18): createEntrants and the
// members-replacing PATCH path enforce the division's EFFECTIVE entrant model
// (module declaration ← division config override) — allowed kinds + structural
// roster caps. Real Postgres required (RLS, the config column); skipped without
// DATABASE_URL. Seeds the REAL boardgame catalog (never an empty stub) so this
// shared test DB stays usable by sibling suites.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { createPerson } from "../persons";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Es " + suffix}, ${"es-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  // Shared-DB rule: seed the REAL module catalog (positions + a real variant),
  // never an empty stub — an empty catalog would poison other suites.
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('boardgame', 'Board game', ${boardgame.version}, ${sql.json(boardgame.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('boardgame', 'classical', 'Classical', ${sql.json(boardgame.variants.classical as never)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedBoardgameDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    name: "Chess Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  return createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: {},
    eligibility: [],
  } as never);
}

async function seedPerson(auth: AuthCtx, name: string): Promise<{ id: string }> {
  return createPerson(auth, {
    full_name: name,
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  } as never);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("entrant shapes: write-path validation (G-entrant-shapes)", () => {
  it("boardgame rejects a team kind and a >1 individual roster; an override widens kinds", async () => {
    const { auth } = await seedOrg();
    const division = await seedBoardgameDivision(auth);

    // 1) kind not allowed — boardgame's model is individual-only.
    await expect(
      createEntrants(auth, division.id, [
        { kind: "team", display_name: "Blunders FC", members: [] },
      ]),
    ).rejects.toMatchObject({
      status: 422,
      code: "ENTRANT_KIND_NOT_ALLOWED",
    });

    // 2) roster too big for an individual (structural cap = 1, not configurable).
    const m1 = await seedPerson(auth, "Head One");
    const m2 = await seedPerson(auth, "Head Two");
    await expect(
      createEntrants(auth, division.id, [
        {
          kind: "individual",
          display_name: "Two Heads",
          members: [
            { person_id: m1.id, is_captain: false, roles: [] },
            { person_id: m2.id, is_captain: false, roles: [] },
          ],
        },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "ENTRANT_ROSTER_TOO_BIG" });

    // 3) a division config override widens the allowed kinds (raw SQL — the
    // boardgame configSchema folds `entrants` away on create).
    await sql`
      update divisions set config = config || ${sql.json({ entrants: { kinds: ["individual", "team"] } })}
      where id = ${division.id}`;
    const ok = await createEntrants(auth, division.id, [
      { kind: "team", display_name: "Allowed Now", members: [] },
    ]);
    expect(ok[0]!.kind).toBe("team");
  });

  it("caps a squad-seeded roster resolved from team_id (resolved-roster backstop)", async () => {
    const { auth } = await seedOrg();
    const division = await seedBoardgameDivision(auth);

    // A team with a 2-person persistent squad (inserted raw — team_members'
    // trg_set_org trigger fills org_id from the parent team).
    const p1 = await seedPerson(auth, "Squad One");
    const p2 = await seedPerson(auth, "Squad Two");
    const [{ id: teamId }] = await sql<{ id: string }[]>`
      insert into teams (org_id, name)
      values (${auth.orgId}, ${"Pair Squad " + randomUUID().slice(0, 6)})
      returning id`;
    await sql`
      insert into team_members (team_id, person_id, is_captain, roles)
      values (${teamId}, ${p1.id}, false, ${sql.json([])}),
             (${teamId}, ${p2.id}, false, ${sql.json([])})`;

    // Enrolling this team as an INDIVIDUAL (cap 1) with no explicit members
    // squad-seeds 2 people. The early explicit-members check saw 0; the
    // resolved-roster backstop must reject it.
    await expect(
      createEntrants(auth, division.id, [{ kind: "individual", team_id: teamId, members: [] }]),
    ).rejects.toMatchObject({ status: 422, code: "ENTRANT_ROSTER_TOO_BIG" });
  });

  it("PATCH members replacement rechecks the roster cap against the entrant's kind", async () => {
    const { auth } = await seedOrg();
    const division = await seedBoardgameDivision(auth);
    const [solo] = await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "Solo", members: [] },
    ]);
    const m1 = await seedPerson(auth, "P One");
    const m2 = await seedPerson(auth, "P Two");

    // Replacing an individual's roster with two people exceeds the cap.
    await expect(
      patchEntrant(auth, solo!.id, {
        members: [
          { person_id: m1.id, is_captain: false, roles: [] },
          { person_id: m2.id, is_captain: false, roles: [] },
        ],
      }),
    ).rejects.toMatchObject({ status: 422, code: "ENTRANT_ROSTER_TOO_BIG" });

    // One member fits.
    const patched = await patchEntrant(auth, solo!.id, {
      members: [{ person_id: m1.id, is_captain: false, roles: [] }],
    });
    expect(patched.members).toHaveLength(1);
  });
});
