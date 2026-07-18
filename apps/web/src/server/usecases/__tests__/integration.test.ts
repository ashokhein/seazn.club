// Integration tests for the /api/v1 service layer (PROMPT-11). Real Postgres
// required (RLS, org triggers, advisory locks); skipped without DATABASE_URL —
// the CI smoke job runs them against its service container.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, deleteCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, deleteStage, listStages, generateStageFixtures, completeStage, getStandings } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createApiKey } from "../api-keys";
import { publicStandings } from "../public";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx; suffix: string }> {
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
    suffix,
  };
}

// Drive one fixture to a decided outcome through the scoring path.
async function decide(auth: AuthCtx, fixtureId: string, homeScore: number, awayScore: number) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  return scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: homeScore, p2Score: awayScore },
  });
}

// End AND uncache the shared client: with isolate:false another DB test file
// may run in this worker afterwards and must get a fresh connection.
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("/api/v1 service layer", () => {
  it("drives the full league lifecycle: create → generate → score → standings → public", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, {
      name: "Summer Cup",
      visibility: "public",
      branding: {},
    });
    expect(competition.slug).toBe("summer-cup");

    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    expect(division.module_version).toBe("1.0.0");

    const entrants = await createEntrants(
      auth,
      division.id,
      ["A", "B", "C", "D"].map((name, i) => ({
        kind: "individual" as const,
        display_name: name,
        seed: i + 1,
        members: [],
      })),
    );
    expect(entrants).toHaveLength(4);

    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });

    // 4-entrant single round robin = 6 fixtures; regeneration is a no-op diff.
    const first = await generateStageFixtures(auth, stage.id);
    expect(first.created).toBe(6);
    expect(first.existing).toBe(0);
    const again = await generateStageFixtures(auth, stage.id);
    expect(again.created).toBe(0);
    expect(again.existing).toBe(6);

    // Scoring opens only after the explicit start (doc 12 §1, PROMPT-17).
    await expect(decide(auth, first.fixtures[0].id, 2, 0)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "WRONG_PHASE"),
    );
    const started = await startDivision(auth, division.id);
    expect(started.status).toBe("active");

    // Decide every fixture (home wins) → standings + guarded completion.
    for (const fixture of first.fixtures) {
      await decide(auth, fixture.id, 2, 0);
    }
    const standings = await getStandings(auth, stage.id);
    expect((standings.rows as { entrantId: string }[]).length).toBe(4);

    const completion = await completeStage(auth, stage.id);
    expect(completion.completed).toBe(true);
    // Last stage of the graph → the division itself completes.
    expect(completion.division_completed).toBe(true);
    const [{ status: divisionStatus }] = await sql<{ status: string }[]>`
      select status from divisions where id = ${division.id}`;
    expect(divisionStatus).toBe("completed");
    // Adding a follow-up stage reopens it.
    const [finals] = await createStages(auth, division.id, {
      seq: 2, kind: "knockout", name: "Finals", config: {}, qualification: { topN: 2 },
    });
    const [{ status: reopened }] = await sql<{ status: string }[]>`
      select status from divisions where id = ${division.id}`;
    expect(reopened).toBe("active");
    const gen = await generateStageFixtures(auth, finals.id);
    expect(gen.created).toBe(1); // top-2 → single final

    // Public read model sees the (public) standings without auth.
    const org = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${auth.orgId}`;
    const pub = (await publicStandings(org[0].slug, competition.slug, division.slug)) as {
      standings: unknown[];
    };
    expect(pub.standings.length).toBeGreaterThan(0);
  });

  it("scoring: undo via core.void, idempotent replays, stale seq → SEQ_CONFLICT", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, { name: "Winter", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    await startDivision(auth, division.id);
    const fixtureId = fixtures[0].id;

    const started = await scoreEvent(auth, fixtureId, {
      expected_seq: 0, type: "core.start", payload: {}, idempotency_key: "start-1",
    });
    expect(started.seq).toBe(1);

    // Stale seq → SEQ_CONFLICT with the current tip in data.
    await expect(
      scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.note", payload: { text: "x" } }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SEQ_CONFLICT"));

    const note = await scoreEvent(auth, fixtureId, {
      expected_seq: 1, type: "core.note", payload: { text: "rain delay" },
    });

    // Undo: core.void through the same path (doc 08 §4).
    const events = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${fixtureId} order by seq`;
    const voided = await scoreEvent(auth, fixtureId, {
      expected_seq: note.seq,
      type: "core.void",
      payload: { event_id: events[1].id },
    });
    expect(voided.seq).toBe(3);

    // Undo the deciding event: fixture must fall back to in_play, outcome gone.
    const decided = await scoreEvent(auth, fixtureId, {
      expected_seq: 3, type: "generic.result", payload: { p1Score: 2, p2Score: 1 },
    });
    expect(decided.status).toBe("decided");
    const [{ id: deciderId }] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fixtureId} and seq = 4`;
    const reverted = await scoreEvent(auth, fixtureId, {
      expected_seq: 4, type: "core.void", payload: { event_id: deciderId },
    });
    expect(reverted.outcome).toBeNull();
    expect(reverted.status).toBe("in_play");
    const [fixtureRow] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${fixtureId}`;
    expect(fixtureRow.status).toBe("in_play");
    expect(fixtureRow.outcome).toBeNull();
  });

  it("knockout: byes auto-advance and winners fill their bracket slots", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, { name: "KO Cup", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    // 3 entrants → bracket of 4 → one bye: seed 1 auto-advances to the final.
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "One", seed: 1, members: [] },
      { kind: "individual", display_name: "Two", seed: 2, members: [] },
      { kind: "individual", display_name: "Three", seed: 3, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "KO", config: {} });
    const generated = await generateStageFixtures(auth, stage.id);
    await startDivision(auth, division.id);

    const semis = generated.fixtures.filter((f) => f.round_no === 1);
    const final = generated.fixtures.find((f) => f.round_no === 2);
    expect(final).toBeDefined();
    // The bye semi is already forfeited with an award outcome, and its winner
    // has been propagated into the final.
    const bye = semis.find((f) => f.status === "forfeited");
    expect(bye).toBeDefined();
    expect(final?.home_entrant_id ?? final?.away_entrant_id).not.toBeNull();

    // Decide the real semi → the winner must land in the final's open slot.
    const playable = semis.find((f) => f.status === "scheduled");
    expect(playable).toBeDefined();
    const result = await decide(auth, playable!.id, 3, 1);
    expect((result.outcome as { kind: string }).kind).toBe("win");
    const [finalRow] = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${final!.id}`;
    expect(finalRow.home_entrant_id).not.toBeNull();
    expect(finalRow.away_entrant_id).not.toBeNull();
  });

  it("group pools → knockout: snake pools, per-pool standings, qualification seeds the KO", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, { name: "Worlds", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    const entrants = await createEntrants(
      auth,
      division.id,
      Array.from({ length: 8 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );

    // Stage graph: 2-pool group, then a knockout taking A1,B2,B1,A2 (doc 05 §2.3
    // cross-pool template: winners meet runners-up of the other pool).
    const stages = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2, kind: "knockout", name: "KO", config: {},
        qualification: { take: [
          { pool: "A", rank: 1 }, { pool: "B", rank: 2 },
          { pool: "B", rank: 1 }, { pool: "A", rank: 2 },
        ] },
      },
    ]);
    const [groups, knockout] = stages;

    // 8 entrants / 2 pools → 4 each → two 6-fixture round robins.
    const generated = await generateStageFixtures(auth, groups.id);
    expect(generated.created).toBe(12);
    const pools = await sql<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${groups.id} order by key`;
    expect(pools.map((p) => p.key)).toEqual(["A", "B"]);
    const byPool = new Map(pools.map((p) => [p.id, 0]));
    for (const f of generated.fixtures) {
      expect(f.pool_id).not.toBeNull();
      byPool.set(f.pool_id as string, (byPool.get(f.pool_id as string) ?? 0) + 1);
    }
    expect([...byPool.values()]).toEqual([6, 6]);
    // Snake distribution: seeds 1,4,5,8 → pool A; 2,3,6,7 → pool B.
    const poolA = await sql<{ home: string | null; away: string | null }[]>`
      select home_entrant_id as home, away_entrant_id as away
      from fixtures where stage_id = ${groups.id} and pool_id = ${pools[0].id}`;
    const aMembers = new Set(poolA.flatMap((f) => [f.home, f.away]));
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed]));
    expect([...aMembers].map((id) => seedOf.get(id as string)).sort()).toEqual([1, 4, 5, 8]);

    await startDivision(auth, division.id);
    // Generating the KO before the group stage completes must refuse — it
    // would otherwise bracket every division entrant, not the qualifiers.
    await expect(generateStageFixtures(auth, knockout.id)).rejects.toMatchObject({
      code: "STAGE_NOT_READY",
    });
    // Decide everything (home wins), complete → KO gets seeded.
    for (const fixture of generated.fixtures) await decide(auth, fixture.id, 1, 0);
    const completion = await completeStage(auth, groups.id);
    expect(completion.completed).toBe(true);
    expect(completion.qualified?.stage_id).toBe(knockout.id);
    expect(completion.qualified?.entrants).toHaveLength(4);
    // Completion auto-generates the seeded stage: 2 semis + final.
    expect(completion.next_stage_fixtures).toBe(3);
    // Re-complete is idempotent: same seeded list, no duplicate fixtures.
    const again = await completeStage(auth, groups.id);
    expect(again.qualified?.entrants).toEqual(completion.qualified?.entrants);
    expect(again.next_stage_fixtures).toBe(0);

    // Explicit re-generate is a no-op; fixtures came from the qualified order
    // (its order IS the seeding).
    const ko = await generateStageFixtures(auth, knockout.id);
    expect(ko.created).toBe(0);
    expect(ko.fixtures).toHaveLength(3);
    const semis = ko.fixtures.filter((f) => f.round_no === 1);
    const q = completion.qualified!.entrants;
    const pairs = semis.map((f) => new Set([f.home_entrant_id, f.away_entrant_id]));
    // Seed fold: qualified[0] meets qualified[3], qualified[1] meets qualified[2].
    expect(pairs).toContainEqual(new Set([q[0], q[3]]));
    expect(pairs).toContainEqual(new Set([q[1], q[2]]));

    // Play the KO through; the final fills from the semi winners.
    for (const semi of semis) await decide(auth, semi.id, 1, 0);
    const [final] = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select home_entrant_id, away_entrant_id from fixtures
      where stage_id = ${knockout.id} and round_no = 2`;
    expect(final.home_entrant_id).not.toBeNull();
    expect(final.away_entrant_id).not.toBeNull();
  });

  it("API keys are 402-gated on api.access and mint sc_ secrets once", async () => {
    const { auth } = await seedOrg();
    // Community default: no api.access → 402.
    await expect(createApiKey(auth, { name: "ci", scopes: ["read"] })).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    // Pro-style override flips the read-key gate; Pro Plus-style override
    // (V290) flips the write-key gate for the manage scope below.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, 'api.access', true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, 'api.write', true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
    // v3/08 §2: scope choice is the org's own — legacy "write" input is
    // accepted and stored as manage.
    const key = await createApiKey(auth, { name: "ci", scopes: ["read", "write"] });
    expect(key.secret.startsWith("sc_")).toBe(true);
    expect(key.scopes).toContain("manage");
    expect(key.scopes).not.toContain("write");
    const [stored] = await sql<{ key_hash: string }[]>`
      select key_hash from api_keys where id = ${key.id}`;
    expect(stored.key_hash).not.toContain(key.secret.slice(3)); // only the hash at rest
  });

  it("refuses to delete a competition with recorded play", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, { name: "Keep", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    await startDivision(auth, division.id);
    await decide(auth, fixtures[0].id, 1, 0);
    await expect(deleteCompetition(auth, competition.id)).rejects.toMatchObject({ status: 409 });
  });

  it("deleteStage: last stage only, refused once fixtures are played", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, { name: "Prune", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
      { kind: "individual", display_name: "C", seed: 3, members: [] },
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    const [league, finals] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "League", config: {} },
      { seq: 2, kind: "knockout", name: "Finals", config: {}, qualification: { topN: 2 } },
    ]);

    // Not the last stage → refused; the graph would lose its middle.
    await expect(deleteStage(auth, league.id)).rejects.toMatchObject({ status: 409 });

    // Last stage, nothing played → gone (cascade removes its fixtures/pools).
    await deleteStage(auth, finals.id);
    expect((await listStages(auth, division.id)).map((s) => s.id)).toEqual([league.id]);

    // Played fixtures pin the stage.
    const { fixtures } = await generateStageFixtures(auth, league.id);
    await startDivision(auth, division.id);
    await decide(auth, fixtures[0].id, 2, 0);
    await expect(deleteStage(auth, league.id)).rejects.toMatchObject({ status: 409 });
  });
});
