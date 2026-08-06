// The per-ORG cooldown on the auto pass (AUTO_SCHEDULE_COOLDOWN).
//
// WHAT IT PROTECTS. `autoSchedule` had no rate limit at all, and its per-call
// cost went from a sub-millisecond greedy pass to up to `AUTO_SOLVER_WALL_MS`
// (8s) of z3 that is SERIALISED across the whole process — `withZ3Lock` is a
// correctness device (`resetZ3` kills pthreads process-wide), not a throughput
// knob. So one authenticated organiser clicking repeatedly stalls every other
// org's solver on that instance. The key is the ORG, not the instance: the
// failure mode is one tenant monopolising a shared serialised queue, and a
// global limiter would refuse the victims along with the offender.
//
// WHY THE CACHE IS MOCKED. `rateLimit` is backed solely by Upstash, and
// `incrWindow` returns null when no REDIS_URL is configured — which is every
// local run, every worktree and CI. The limiter is INERT there and allows
// unconditionally, so a test that simply called `autoSchedule` eleven times
// would pass with the limiter deleted. The counter has to be real for any
// assertion here to mean anything, so `incrWindow` is mocked and `cacheGet` and
// friends are spread through untouched (entitlement resolution runs on them).
//
// NON-VACUITY. A `rejects 429` on its own cannot tell a LIMIT from a COUNTER
// that fires after the expensive work: both refuse the eleventh call, and only
// one of them saved the solver. So every case here also asserts whether the
// engine was ENTERED — `solver.entered` must not advance on the refused call,
// and must advance on the allowed one, or the "allowed" case is proving nothing
// about a path that reaches z3 at all.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/** Builds that reached the engine, counted after the call so the engine's own
 *  synchronous queue accounting has certainly happened. */
const solver = vi.hoisted(() => ({ entered: 0 }));

/** The fixed-window counter `rateLimit` reads. Keyed exactly as Redis would be
 *  (`rl:` + the limiter's key), so the assertions below can name the real key. */
const limiter = vi.hoisted(() => ({ counts: new Map<string, number>(), calls: [] as string[] }));

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    buildSchedule: (input: Parameters<typeof actual.buildSchedule>[0]) => {
      const run = actual.buildSchedule(input);
      solver.entered++;
      return run;
    },
  };
});

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    incrWindow: (key: string) => {
      limiter.calls.push(key);
      const next = (limiter.counts.get(key) ?? 0) + 1;
      limiter.counts.set(key, next);
      return Promise.resolve(next);
    },
  };
});

const { sql } = await import("@/lib/db");
const { resetZ3 } = await import("@seazn/engine/scheduling");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings, AUTO_SCHEDULE_COOLDOWN } = await import("../schedule");
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
    insert into organizations (name, slug) values (${"Cool " + suffix}, ${"cool-" + suffix})
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
    ends_on: "2030-12-31",
    name: "Cooldown " + suffix,
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

afterAll(async () => {
  if (!HAS_DB) return;
  await resetZ3();
  await sql.end({ timeout: 5 });
});

beforeEach(() => {
  solver.entered = 0;
  limiter.counts.clear();
  limiter.calls.length = 0;
});

describe.skipIf(!HAS_DB)("autoSchedule per-org cooldown", () => {
  it("refuses with 429 once the org's window is spent, without entering the solver", async () => {
    const { auth, stageId } = await seedStage();
    const key = `rl:auto-schedule:${auth.orgId}`;
    // The window already at its cap. Pre-seeding rather than making `max` real
    // calls keeps this a test of the LIMIT instead of a ten-solve benchmark, and
    // the boundary is exactly the one `rateLimit` applies (`count > max`).
    limiter.counts.set(key, AUTO_SCHEDULE_COOLDOWN.max);

    await expect(autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" })).rejects
      .toMatchObject({ status: 429 });

    // THE HALF THAT MATTERS. A counter that increments after the expensive call
    // also rejects here; only a LIMIT stops the work happening. If this ever
    // reads 1, the limiter has been moved below the solve and is decoration.
    expect(solver.entered).toBe(0);
    expect(limiter.calls).toEqual([key]);
  });

  it("allows the run that sits exactly ON the cap, and reaches the solver", async () => {
    const { auth, stageId } = await seedStage();
    const key = `rl:auto-schedule:${auth.orgId}`;
    // One below: this call takes the count TO `max`, which `rateLimit` permits.
    // Without this case the suite would pass with a limiter that refuses
    // everything, which is a far worse bug than the one being fixed.
    limiter.counts.set(key, AUTO_SCHEDULE_COOLDOWN.max - 1);

    const out = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

    expect(out.assignments.length).toBeGreaterThan(0);
    expect(solver.entered).toBe(1);
  });

  it("counts per ORG — a second org's window is untouched by the first", async () => {
    // The whole design claim. A global limiter passes both cases above and fails
    // this one, because it would refuse the second org for the first org's
    // spending — which is precisely the tenant this change exists to protect.
    const a = await seedStage();
    const b = await seedStage();
    limiter.counts.set(`rl:auto-schedule:${a.auth.orgId}`, AUTO_SCHEDULE_COOLDOWN.max);

    await expect(
      autoSchedule(a.auth, a.stageId, { only_unlocked: false, mode: "build" }),
    ).rejects.toMatchObject({ status: 429 });

    const out = await autoSchedule(b.auth, b.stageId, { only_unlocked: false, mode: "build" });
    expect(out.assignments.length).toBeGreaterThan(0);
    expect(solver.entered).toBe(1);
  });
});
