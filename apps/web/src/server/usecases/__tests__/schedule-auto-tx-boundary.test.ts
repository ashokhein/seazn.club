// The auto pass must not hold a database transaction across the z3 solve.
//
// THE HAZARD. `withTenant` pins a pooled connection for the whole of its
// callback. Before the solver wave the in-transaction work was a synchronous
// `slotFixtures` pass — microseconds. It is now up to `AUTO_SOLVER_WALL_MS` of
// solving, plus a `resetZ3()` that must first queue behind any concurrent
// solve's `withZ3Lock`. A solve inside the transaction is therefore tens of
// seconds of idle-in-transaction per organiser click, and a handful of
// concurrent clicks exhausts the pool and stalls database traffic for the whole
// application — an outage reached from a feature that "works" in every
// functional test.
//
// WHY THIS IS A STRUCTURAL ASSERTION AND NOT A TIMING ONE. "The transaction was
// short" is a claim about a machine, not about the code: it passes on an idle
// laptop and flakes on a loaded CI box, and this repo already carries one
// wall-clock assertion that flakes for exactly that reason. So the test observes
// the SHAPE instead — it counts open `withTenant` frames and records the depth
// the solver was entered at. Depth 0 is the property; anything else means the
// solve is nested inside a transaction, however fast it happened to be.
//
// Both module mocks spread the real module, so everything except the two
// wrappers is the genuine implementation and the reads below hit a real
// Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/** Open `withTenant` frames, and the depth each solver entry point saw. */
const tx = vi.hoisted(() => ({ depth: 0, maxDepth: 0, solveDepths: [] as number[] }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    withTenant: async <T,>(orgId: string, fn: (sql: never) => Promise<T>): Promise<T> => {
      tx.depth++;
      tx.maxDepth = Math.max(tx.maxDepth, tx.depth);
      try {
        return await actual.withTenant(orgId, fn as never);
      } finally {
        tx.depth--;
      }
    },
  };
});

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    // Recorded at CALL time, before awaiting: the question is what was open when
    // the solver was entered, not what is open when it finishes.
    buildSchedule: (input: Parameters<typeof actual.buildSchedule>[0]) => {
      tx.solveDepths.push(tx.depth);
      return actual.buildSchedule(input);
    },
    repairSchedule: (input: Parameters<typeof actual.repairSchedule>[0]) => {
      tx.solveDepths.push(tx.depth);
      return actual.repairSchedule(input);
    },
  };
});

const { sql } = await import("@/lib/db");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings, applySchedule } = await import("../schedule");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedStage(): Promise<{ auth: AuthCtx; stageId: string }> {
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
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    name: "TX " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["C1", "C2"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id };
}

describe.skipIf(!HAS_DB)("autoSchedule holds no transaction across the solve", () => {
  beforeEach(() => {
    tx.depth = 0;
    tx.maxDepth = 0;
    tx.solveDepths = [];
  });

  it("enters the tier solver at transaction depth 0 (build)", async () => {
    const { auth, stageId } = await seedStage();
    tx.solveDepths = [];

    await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

    // The solver ran at all — otherwise `toEqual([0])` would be satisfied by an
    // empty array and this whole spec would assert nothing.
    expect(tx.solveDepths).toHaveLength(1);
    expect(tx.solveDepths).toEqual([0]);
    // …and a transaction really was opened during the call, so depth 0 at the
    // solve is a transaction that CLOSED, not one that never existed.
    expect(tx.maxDepth).toBeGreaterThan(0);
    // Nothing left open.
    expect(tx.depth).toBe(0);
  }, 120_000);

  it("enters the repair solver at transaction depth 0 (reflow)", async () => {
    const { auth, stageId } = await seedStage();
    // Put a board down so REFLOW has an incumbent and actually reaches the
    // repair solver rather than short-circuiting.
    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    await applySchedule(auth, stageId, {
      assignments: first.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });
    tx.solveDepths = [];
    tx.maxDepth = 0;

    await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });

    expect(tx.solveDepths).toHaveLength(1);
    expect(tx.solveDepths).toEqual([0]);
    expect(tx.maxDepth).toBeGreaterThan(0);
    expect(tx.depth).toBe(0);
  }, 120_000);

  it("enters the tier solver at transaction depth 0 (polish)", async () => {
    const { auth, stageId } = await seedStage();
    tx.solveDepths = [];

    await autoSchedule(auth, stageId, { only_unlocked: true, mode: "polish" });

    expect(tx.solveDepths).toEqual([0]);
    expect(tx.depth).toBe(0);
  }, 120_000);
});
