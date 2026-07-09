// Round-trip budget for fixture generation. generateStageFixtures used to
// insert fixtures and wire feeds one row per statement (and americano looked
// up every pair entrant individually) — a 32-entrant knockout cost ~85
// statements inside one transaction, which over a pooled remote connection is
// seconds of pure latency. These tests pin the statement budget so a per-row
// loop can't creep back in; they fail against the pre-batching code.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Rt " + suffix}, ${"rt-" + suffix})
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

async function seedDivision(auth: AuthCtx, names: string[], individualsWithPersons = false) {
  const comp = await createCompetition(auth, {
    name: "Rt Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth, division.id,
    await Promise.all(
      names.map(async (name, i) => ({
        kind: "individual" as const, display_name: name, seed: i + 1,
        members: individualsWithPersons
          ? [
              {
                person_id: (
                  await createPerson(auth, {
                    full_name: name, consent: {}, dob: null, gender: null, external_ref: null,
                  })
                ).id,
                is_captain: false, roles: [], default_position_key: null, squad_number: null,
              },
            ]
          : [],
      })),
    ),
  );
  return { division, entrants };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("fixture generation round-trip budget", () => {
  it("32-entrant knockout generates within the statement budget", async () => {
    const { auth } = await seedOrg();
    const names = Array.from({ length: 32 }, (_, i) => `K${i + 1}`);
    const { division } = await seedDivision(auth, names);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "knockout", name: "KO", config: {},
    });

    const before = statementCount();
    const { created } = await generateStageFixtures(auth, stage!.id);
    const used = statementCount() - before;

    expect(created).toBe(31);
    // Batched path uses ~25 statements incl. transaction chrome and the
    // fire-and-forget revalidate lookup; per-row inserts/feed-updates would
    // add ~60 more. Headroom, not exactness — the point is the order of
    // magnitude.
    expect(used).toBeLessThanOrEqual(40);
  });

  it("americano generation resolves pair entrants in bulk, not per match", async () => {
    const { auth } = await seedOrg();
    const names = Array.from({ length: 8 }, (_, i) => `P${i + 1}`);
    const { division } = await seedDivision(auth, names, true);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "americano" as never, name: "Padel",
      config: { mode: "americano", courtCount: 2, rounds: 3 },
    });

    const before = statementCount();
    const { created } = await generateStageFixtures(auth, stage!.id);
    const used = statementCount() - before;

    expect(created).toBe(6); // 2 courts × 3 rounds
    // Per-pair lookup/insert used to cost up to 5 statements for each of the
    // ~12 pairs; the batched resolver does it in 4 regardless of pair count.
    expect(used).toBeLessThanOrEqual(40);
  });
});
