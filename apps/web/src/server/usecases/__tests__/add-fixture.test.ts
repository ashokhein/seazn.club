// PROMPT-66 — ad-hoc single fixture (`addFixture`): league/group/swiss accept a
// manual match (it folds into standings like any other result); bracket kinds
// reject it (no slot in the tree); ladder/americano point at their own
// mechanisms. Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { addFixture, createStages, generateStageFixtures } from "../stages";
import { appendEvent, recomputeStandings } from "@/server/engine-db";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Af " + suffix}, ${"af-" + suffix})
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

async function seedDivision(auth: AuthCtx, count: number) {
  const comp = await createCompetition(auth, {
    name: "Af Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth, division.id,
    Array.from({ length: count }, (_, i) => ({
      kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [],
    })),
  );
  return { division, entrants: entrants.map((e) => e.id) };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("addFixture (PROMPT-66)", () => {
  it("league: inserts a scheduled fixture that folds into the standings once scored", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, 3);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "league", name: "League", config: {}, qualification: null,
    });
    await generateStageFixtures(auth, stage!.id);
    const [{ count: before }] = await sql<{ count: number }[]>`
      select count(*)::int as count from fixtures where stage_id = ${stage!.id}`;

    const { fixture_id } = await addFixture(auth, stage!.id, {
      home_entrant_id: entrants[0]!,
      away_entrant_id: entrants[1]!,
      scheduled_at: "2026-08-01T10:00:00Z",
      venue: "Court 9",
    });

    const [fx] = await sql<
      { round_no: number; seq_in_round: number; status: string; ext_key: string; venue: string | null }[]
    >`select round_no, seq_in_round, status, ext_key, venue from fixtures where id = ${fixture_id}`;
    expect(fx.status).toBe("scheduled");
    expect(fx.ext_key.startsWith("adhoc-")).toBe(true);
    expect(fx.venue).toBe("Court 9");
    const [{ count: after }] = await sql<{ count: number }[]>`
      select count(*)::int as count from fixtures where stage_id = ${stage!.id}`;
    expect(after).toBe(before + 1);

    // Score it — the standings fold every fixture, so the extra match counts.
    await appendEvent(auth.orgId, fixture_id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, fixture_id, 1, {
      type: "generic.result", payload: { p1Score: 2, p2Score: 0 },
    });
    const rows = await recomputeStandings(auth.orgId, stage!.id);
    const home = rows.find((r) => r.entrantId === entrants[0]);
    // Only decided fixtures fold into the table — the ad-hoc win is the sole
    // result, and it counts (played 1, full win points).
    expect(home?.played).toBe(1);
    expect(home?.points).toBe(3);
  });

  it("group: lands in the entrants' pool (inferred) with the next seq_in_round", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, 8);
    const [stage] = await createStages(auth, division.id, {
      seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } }, qualification: null,
    });
    await generateStageFixtures(auth, stage!.id);
    // Pick a real generated pairing so both entrants share a pool.
    const [pair] = await sql<
      { pool_id: string; home_entrant_id: string; away_entrant_id: string; round_no: number }[]
    >`select pool_id, home_entrant_id, away_entrant_id, round_no from fixtures
      where stage_id = ${stage!.id} and pool_id is not null limit 1`;

    const { fixture_id } = await addFixture(auth, stage!.id, {
      home_entrant_id: pair.home_entrant_id,
      away_entrant_id: pair.away_entrant_id,
    });
    const [fx] = await sql<{ pool_id: string | null }[]>`
      select pool_id from fixtures where id = ${fixture_id}`;
    expect(fx.pool_id).toBe(pair.pool_id);

    // Entrants from different pools → 422.
    const [foreign] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures
      where stage_id = ${stage!.id} and pool_id is not null and pool_id != ${pair.pool_id} limit 1`;
    await expect(
      addFixture(auth, stage!.id, {
        home_entrant_id: pair.home_entrant_id,
        away_entrant_id: foreign.home_entrant_id,
      }),
    ).rejects.toMatchObject({ status: 422 });
    void entrants;
  });

  it("rejects bracket kinds, self-play, foreign entrants and completed stages", async () => {
    const { auth } = await seedOrg();
    const { division, entrants } = await seedDivision(auth, 4);
    const [ko] = await createStages(auth, division.id, {
      seq: 1, kind: "knockout", name: "KO", config: {}, qualification: null,
    });
    await generateStageFixtures(auth, ko!.id);
    await expect(
      addFixture(auth, ko!.id, { home_entrant_id: entrants[0]!, away_entrant_id: entrants[1]! }),
    ).rejects.toMatchObject({ status: 422 });

    // A second division provides a league stage + a foreign entrant.
    const other = await seedDivision(auth, 3);
    const [league] = await createStages(auth, other.division.id, {
      seq: 1, kind: "league", name: "League", config: {}, qualification: null,
    });
    await expect(
      addFixture(auth, league!.id, {
        home_entrant_id: other.entrants[0]!,
        away_entrant_id: other.entrants[0]!,
      }),
    ).rejects.toMatchObject({ status: 422 }); // self-play
    await expect(
      addFixture(auth, league!.id, {
        home_entrant_id: other.entrants[0]!,
        away_entrant_id: entrants[0]!, // belongs to the first division
      }),
    ).rejects.toMatchObject({ status: 422 });

    await sql`update stages set status = 'complete' where id = ${league!.id}`;
    await expect(
      addFixture(auth, league!.id, {
        home_entrant_id: other.entrants[0]!,
        away_entrant_id: other.entrants[1]!,
      }),
    ).rejects.toMatchObject({ status: 422 }); // complete stage refuses
  });
});
