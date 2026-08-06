// A build refused by the solver QUEUE must be answered immediately.
//
// THE HAZARD. `buildSchedule` returns `solver_busy` (a greedy board) WITHOUT
// taking `withZ3Lock` once two builds are already in flight — build.ts's cap
// check is a single integer read placed ahead of everything else precisely so
// the third caller need not wait. `withZ3Lock` is a strict FIFO promise chain
// and `resetZ3` takes it too, so any `finally { await resetZ3() }` wrapped
// around that call goes to the BACK of the queue behind every solve already
// waiting: the caller who was excused from queuing then waits out two full
// solver budgets anyway, and the HTTP response an organiser is watching lands
// tens of seconds after the answer was computed. The engine's own `z3-load.ts`
// names that exact spelling as the anti-pattern, and owns teardown itself
// (`withZ3LockAndReset` inside both `buildSchedule` and `repairSchedule`), so a
// reset at this seam is a guaranteed no-op with a queue wait attached.
//
// STRUCTURAL, NOT TIMED. The assertion is not "the third call was fast" — that
// is a claim about a machine. The z3 lock is HELD by this test for the whole
// window, so a call that touches the queue at all cannot settle, and one that
// does not touch it settles immediately. The 10-second race is the failure
// mode's shape, not a threshold: with the wrapper present the promise is
// pending until the gate opens, however fast the box is.
//
// NON-VACUITY. The third call must come back reporting `solver_busy` from the
// greedy path. Without that, a run where the lock was never actually contended
// — two calls that finished before the third started — would settle promptly
// and pass while proving nothing.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/** Builds that have ENTERED the engine's `buildSchedule`, counted after the
 *  call so the engine's own synchronous `queued++` has certainly happened. */
const solver = vi.hoisted(() => ({ entered: 0 }));

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

const { sql } = await import("@/lib/db");
const { withZ3Lock, resetZ3 } = await import("@seazn/engine/scheduling");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings } = await import("../schedule");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
/** How long the third call is given to settle while the lock is held. Generous
 *  on purpose: under the fix it settles in milliseconds, and under the bug it
 *  cannot settle at all, so the size only affects how long a RED run takes. */
const SETTLE_MS = 10_000;
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    ends_on: "2030-12-31",
    name: "Busy " + suffix,
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

describe.skipIf(!HAS_DB)("a queue-refused build is answered without queuing", () => {
  it("returns solver_busy while the z3 lock is still held by someone else", async () => {
    const { auth, stageId } = await seedStage();
    solver.entered = 0;

    // Hold the z3 lock for the whole window. Everything that touches the queue
    // — a solve, and a `resetZ3()` — is pending behind this until it opens.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holder = withZ3Lock(() => gate);

    const build = () => autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    const first = build();
    const second = build();
    void first.catch(() => {});
    void second.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Wait until BOTH are inside the engine, i.e. the queue is at its cap of
      // two. Polling the wrapper rather than sleeping: the two calls each do a
      // database read first, and how long that takes is not this test's claim.
      const deadline = Date.now() + 30_000;
      while (solver.entered < 2) {
        if (Date.now() > deadline) throw new Error("the first two builds never reached the solver");
        await sleep(25);
      }

      const third = build();
      void third.catch(() => {});
      const outcome = await Promise.race([
        third.then((result) => ({ kind: "settled" as const, result })),
        new Promise<{ kind: "pending" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "pending" }), SETTLE_MS);
        }),
      ]);

      expect(outcome.kind).toBe("settled");
      // Narrowed by the assertion above; the guard keeps tsc honest.
      if (outcome.kind !== "settled") throw new Error("unreachable");
      // …and it settled because the QUEUE refused it, not because the lock was
      // never contended. This is what stops a run where the first two builds
      // finished early from passing on an empty queue.
      expect(outcome.result.solver.status).toBe("solver_busy");
      expect(outcome.result.solver.engine).toBe("greedy");
      // A greedy board is still a board: the organiser gets a timetable, which
      // is the whole reason the cap answers rather than refusing.
      expect(outcome.result.assignments.length).toBeGreaterThan(0);
    } finally {
      if (timer) clearTimeout(timer);
      open();
      await holder.catch(() => {});
      await Promise.allSettled([first, second]);
    }
  }, 180_000);
});
