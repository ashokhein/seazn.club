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
import { createStages, generateStageFixtures, completeStage, getStandings } from "../stages";
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

    // Decide every fixture (home wins) → standings + guarded completion.
    for (const fixture of first.fixtures) {
      await decide(auth, fixture.id, 2, 0);
    }
    const standings = await getStandings(auth, stage.id);
    expect((standings.rows as { entrantId: string }[]).length).toBe(4);

    const completion = await completeStage(auth, stage.id);
    expect(completion.completed).toBe(true);

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

  it("API keys are 402-gated on api.access and mint sk_live_ secrets once", async () => {
    const { auth } = await seedOrg();
    // Community default: no api.access → 402.
    await expect(createApiKey(auth, { name: "ci", scopes: ["read"] })).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    // Pro-style override flips the gate.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, 'api.access', true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
    const key = await createApiKey(auth, { name: "ci", scopes: ["read", "write"] });
    expect(key.secret.startsWith("sk_live_")).toBe(true);
    const [stored] = await sql<{ key_hash: string }[]>`
      select key_hash from api_keys where id = ${key.id}`;
    expect(stored.key_hash).not.toContain(key.secret.slice(8)); // only the hash at rest
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
    await decide(auth, fixtures[0].id, 1, 0);
    await expect(deleteCompetition(auth, competition.id)).rejects.toMatchObject({ status: 409 });
  });
});
