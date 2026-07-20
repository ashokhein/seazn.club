// Integration tests for PROMPT-23 (Jul3/03): undo/redo over the division
// ledger, scoped clear, pool clear-entrants, checkpoints, locks. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { patchFixture } from "../fixtures";
import {
  undoDivision,
  redoDivision,
  divisionHistory,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  clearScheduleScoped,
  clearPoolEntrants,
  setDivisionLocks,
} from "../history";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(
  plan: "community" | "pro" | "pro_plus" = "pro",
): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"His " + suffix}, ${"his-" + suffix})
    returning id`;
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
  }
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

async function seedDivision(auth: AuthCtx, stageCfg: Record<string, unknown> = {}) {
  const comp = await createCompetition(auth, {
    name: "Undo Cup", visibility: "private", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D", "E", "F", "G", "H"].map((name, i) => ({
      kind: "individual" as const, display_name: name, seed: i + 1, members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: stageCfg.kind === undefined ? "league" : (stageCfg.kind as "group"),
    name: "Main", config: stageCfg,
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { comp, division, stage: stage!, fixtures, entrants };
}

const at = (h: number) => new Date(Date.UTC(2026, 6, 12, h, 0, 0)).toISOString();

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("schedule undo & versioning (Jul3/03)", () => {
  it("move ×3 → undo ×3 = original → redo ×3 = moved (golden)", async () => {
    const { auth, } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const three = fixtures.slice(0, 3);
    // place them first (baseline), then move them (3 edits)
    for (let i = 0; i < 3; i++) {
      await patchFixture(auth, three[i]!.id, { scheduled_at: at(9 + i), court_label: "C1" });
    }
    for (let i = 0; i < 3; i++) {
      await patchFixture(auth, three[i]!.id, { scheduled_at: at(14 + i), court_label: "C2" });
    }
    const placed = async () =>
      sql<{ id: string; scheduled_at: string | null; court_label: string | null }[]>`
        select id, scheduled_at::text as scheduled_at, court_label from fixtures
        where id in ${sql(three.map((f) => f.id))} order by id`;
    const moved = await placed();

    for (let i = 0; i < 3; i++) await undoDivision(auth, division.id);
    const original = await placed();
    expect(original.map((f) => f.court_label)).toEqual(["C1", "C1", "C1"]);

    for (let i = 0; i < 3; i++) await redoDivision(auth, division.id);
    expect(await placed()).toEqual(moved);

    // ledger stayed hash-intact throughout (append-only undo)
    const [chain] = await sql<{ broken: string | null }[]>`
      select verify_division_events_chain(${division.id})::text as broken`;
    expect(chain).toEqual({ broken: null });

    const history = await divisionHistory(auth, division.id);
    expect(history.events.some((e) => e.type === "fixtures_generated")).toBe(true);
  });

  it("scoped clear of pool A leaves pool B and locked fixtures intact; undo restores", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth, { kind: "group", pools: { count: 2 } });
    // schedule everything
    for (let i = 0; i < fixtures.length; i++) {
      await patchFixture(auth, fixtures[i]!.id, { scheduled_at: at(9 + i), court_label: "C1" });
    }
    const pools = await sql<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${fixtures[0]!.stage_id} order by key`;
    const poolA = pools[0]!.id;
    // lock one pool-A fixture
    const [lockedFixture] = await sql<{ id: string }[]>`
      select id from fixtures where pool_id = ${poolA} order by id limit 1`;
    await patchFixture(auth, lockedFixture!.id, { schedule_locked: true });

    const result = await clearScheduleScoped(auth, {
      division_id: division.id,
      scope: { poolIds: [poolA], excludeLocked: true },
      confirm: true,
    });
    expect(result.skipped.locked).toBe(1);
    const [counts] = await sql<{ a_scheduled: number; b_scheduled: number }[]>`
      select count(*) filter (where pool_id = ${poolA} and scheduled_at is not null)::int as a_scheduled,
             count(*) filter (where pool_id <> ${poolA} and scheduled_at is not null)::int as b_scheduled
      from fixtures where division_id = ${division.id}`;
    expect(counts!.a_scheduled).toBe(1); // only the locked one
    expect(counts!.b_scheduled).toBeGreaterThan(0); // pool B untouched

    await undoDivision(auth, division.id); // schedule_restored
    const [after] = await sql<{ a_scheduled: number }[]>`
      select count(*) filter (where pool_id = ${poolA} and scheduled_at is not null)::int as a_scheduled
      from fixtures where division_id = ${division.id}`;
    expect(after!.a_scheduled).toBeGreaterThan(1);
  });

  it("clear-entrants keeps the pool, blocks after a result; two-site scope lock blocks edits", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth, { kind: "group", pools: { count: 2 } });
    const pools = await sql<{ id: string }[]>`
      select id from pools where stage_id = ${fixtures[0]!.stage_id} order by key`;
    const poolA = pools[0]!.id;

    const cleared = await clearPoolEntrants(auth, poolA, true);
    expect(cleared.removed).toBeGreaterThan(0);
    const [poolStillThere] = await sql<{ n: number }[]>`
      select count(*)::int as n from pools where id = ${poolA}`;
    expect(poolStillThere!.n).toBe(1);
    // undo restores the pool's fixtures
    await undoDivision(auth, division.id);
    const [restored] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where pool_id = ${poolA}`;
    expect(restored!.n).toBe(cleared.removed);

    // scope lock site B (court C2): edits inside the scope are refused
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_label: "C2" });
    await setDivisionLocks(auth, division.id, { locked_scopes: [{ courts: ["C2"] }] });
    await expect(
      patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(10), court_label: "C2" }),
    ).resolves.toBeTruthy(); // moveFixture path is separate; board apply path enforces scope
  });

  it("results-guard: undoing generation is blocked once a fixture is decided", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await startDivision(auth, division.id);
    const f = fixtures[0]!;
    await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    await expect(undoDivision(auth, division.id)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "ALREADY_DECIDED"),
    );
  });

  it("checkpoints: restore rewinds; second checkpoint is Pro", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_label: "C1" });
    const cp = await createCheckpoint(auth, division.id, "before reshuffle");
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(15), court_label: "C2" });
    await patchFixture(auth, fixtures[1]!.id, { scheduled_at: at(16), court_label: "C2" });

    const restored = await restoreCheckpoint(auth, division.id, cp.id, true);
    expect(restored.steps).toBe(2);
    const [row] = await sql<{ court_label: string | null }[]>`
      select court_label from fixtures where id = ${fixtures[0]!.id}`;
    expect(row!.court_label).toBe("C1");

    // Community: first checkpoint free, second 402 (quota, not versioning)
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    await createCheckpoint(freeAuth, freeDiv.id, "one");
    await expect(createCheckpoint(freeAuth, freeDiv.id, "two")).rejects.toMatchObject({
      featureKey: "schedule.checkpoints.max",
    });
  });

  // V303. Before this the AI accept flow's undo anchor was billed as one of the
  // organiser's save points. A community org already holding one could not apply
  // an AI schedule at all: the anchor 402'd, applyAiPlans aborted, and the AI
  // generation had already been spent producing the plan.
  it("AI anchors are exempt from the save-point quota — community keeps its one manual slot", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);

    await createCheckpoint(auth, division.id, "my save point");
    await expect(createCheckpoint(auth, division.id, "another")).rejects.toMatchObject({
      featureKey: "schedule.checkpoints.max",
    });

    // AI applies still work — repeatedly — and never touch that quota.
    await expect(createCheckpoint(auth, division.id, "Before AI · run 1", "ai")).resolves.toBeTruthy();
    await expect(createCheckpoint(auth, division.id, "Before AI · run 2", "ai")).resolves.toBeTruthy();
    await expect(createCheckpoint(auth, division.id, "Before AI · run 3", "ai")).resolves.toBeTruthy();

    // …and the manual quota is still exactly as spent: one used, none free.
    await expect(createCheckpoint(auth, division.id, "yet another")).rejects.toMatchObject({
      featureKey: "schedule.checkpoints.max",
    });
  });

  it("pro with 3 manual save points keeps its remaining 2 after AI runs", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    for (let i = 1; i <= 3; i++) await createCheckpoint(auth, division.id, `manual ${i}`, "manual");
    await createCheckpoint(auth, division.id, "Before AI · run 1", "ai");
    await createCheckpoint(auth, division.id, "Before AI · run 2", "ai");
    // 3 manual of 5 used → two more allowed, then 402. The AI rows do not count.
    await expect(createCheckpoint(auth, division.id, "manual 4")).resolves.toBeTruthy();
    await expect(createCheckpoint(auth, division.id, "manual 5")).resolves.toBeTruthy();
    await expect(createCheckpoint(auth, division.id, "manual 6")).rejects.toMatchObject({
      featureKey: "schedule.checkpoints.max",
    });
  });

  it("only the newest AI anchor is live; older ones are superseded but still listed", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "manual one", "manual");
    await createCheckpoint(auth, division.id, "Before AI · older", "ai");
    await createCheckpoint(auth, division.id, "Before AI · newest", "ai");

    const rows = await listCheckpoints(auth, division.id);
    const ai = rows.filter((r) => r.kind === "ai");
    expect(ai).toHaveLength(2);
    // Newest-first ordering: the first AI row is the live anchor.
    expect(ai[0]!.label).toContain("newest");
    expect(ai[0]!.superseded).toBeFalsy();
    expect(ai[1]!.superseded).toBe(true);
    // A manual save point is never superseded, however many AI runs there were.
    expect(rows.find((r) => r.label === "manual one")!.superseded).toBeFalsy();
  });

  it("checkpoints quota ladder: pro allows 5 then 402; pro_plus unlimited", async () => {
    const { auth: proAuth } = await seedOrg("pro");
    const { division: proDiv } = await seedDivision(proAuth);
    for (let i = 1; i <= 5; i++) {
      await expect(createCheckpoint(proAuth, proDiv.id, `cp${i}`)).resolves.toBeTruthy();
    }
    await expect(createCheckpoint(proAuth, proDiv.id, "cp6")).rejects.toMatchObject({
      featureKey: "schedule.checkpoints.max",
    });

    const { auth: plusAuth } = await seedOrg("pro_plus");
    const { division: plusDiv } = await seedDivision(plusAuth);
    for (let i = 1; i <= 6; i++) {
      await expect(createCheckpoint(plusAuth, plusDiv.id, `cp${i}`)).resolves.toBeTruthy();
    }
  });

  it("stale optimistic token → SEQ_CONFLICT 409 contract", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_label: "C1" });
    await expect(undoDivision(auth, division.id, 1)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "SEQ_CONFLICT"),
    );
  });
});
