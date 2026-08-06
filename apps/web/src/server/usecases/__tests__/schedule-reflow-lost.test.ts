// REFLOW's `lost` counter is a TRIPWIRE, and this file is the proof it is armed.
//
// WHY IT NEEDS A FILE OF ITS OWN. `lost` counts baseline rows the run failed to
// put back (R21). On today's code no input can make it non-zero, because
// `repairSchedule` is TOTAL over the proposal it is handed on every return path:
// `clean` returns `[...proposal]` (repair.ts:287) and both `repaired` returns
// come off `proposal.map(...)` (repair.ts:1012), which is 1:1 by construction;
// the `timeout` and `infeasible` arms of `reflowExisting` hand `settle` the
// proposal itself. `proposal` is `[...args.placed, ...seed.assignments]`, so it
// contains every baseline row. Measured consequence: stubbing the counter to
// `lost: 0` survived every other reflow test in the suite.
//
// A guard that nothing can trip is indistinguishable from dead code, and the
// usual resolution — delete it — is the wrong one here. A repair that silently
// drops a card the organiser had already scheduled is precisely the harm the
// number exists to surface, and it is the kind of harm that arrives with a
// FUTURE repair path rather than with this one. So the counter stays and this
// test supplies the input today's engine cannot: a `repaired` result with one
// row removed. If a later repair path stops being total, `lost` reports it
// because this file established that it can.
//
// BOTH observables are asserted, and the second is the load-bearing one. A count
// nobody is shown is bookkeeping; the dropped fixture must also come back as a
// conflict, which is how the organiser learns a card left their board.
//
// The mock spreads the real module and calls the real `repairSchedule`, so
// everything up to the drop — the greedy seed, the pre-check, the z3 solve, the
// verifier `settle` runs over the result — is genuine, and the reads below hit a
// real Postgres.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/** What the real solver actually returned, and which row the mock removed from
 *  it. `statuses` is recorded so the test can assert it drove the branch it
 *  meant to drive rather than one that happens to agree. */
const repair = vi.hoisted(() => ({
  statuses: [] as string[],
  droppedId: null as string | null,
}));

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    repairSchedule: async (input: Parameters<typeof actual.repairSchedule>[0]) => {
      const result = await actual.repairSchedule(input);
      repair.statuses.push(result.status);
      // Only the `repaired` arm is intercepted. `clean`, `timeout` and
      // `infeasible` all make `reflowExisting` settle the PROPOSAL rather than
      // the solver's rows, so editing them here would change nothing and the
      // test would pass without ever exercising the counter.
      if (result.status !== "repaired") return result;
      const [dropped, ...kept] = result.assignments;
      repair.droppedId = dropped!.fixtureId;
      return { ...result, assignments: kept };
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
    // #376: an end date is mandatory on a competition insert.
    ends_on: "2030-12-31",
    name: "Lost " + suffix,
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

describe.skipIf(!HAS_DB)("REFLOW reports a card the repair solver dropped", () => {
  it("counts it in `lost` AND surfaces it as a conflict", async () => {
    const { auth, stageId } = await seedStage();

    // A legal board first, applied for real: `lost`'s baseline is where the
    // movable cards sit RIGHT NOW, so without an incumbent board there is
    // nothing for the run to lose and the assertion below would be vacuous.
    const built = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    await applySchedule(auth, stageId, {
      assignments: built.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });

    // Now break it, so the repair solver has something to repair and returns
    // `repaired` rather than `clean`. Written straight to the table rather than
    // through `applySchedule`: the apply gate exists to refuse a board like
    // this, and the point is to hand the SOLVER an illegal board, not to test
    // whether the gate can be talked into accepting one.
    const placed = await sql<{ id: string; scheduled_at: Date; court_label: string }[]>`
      select id, scheduled_at, court_label from fixtures
      where stage_id = ${stageId} and scheduled_at is not null and court_label is not null
      order by scheduled_at, court_label`;
    expect(placed.length).toBeGreaterThanOrEqual(2);
    await sql`
      update fixtures
      set scheduled_at = ${placed[0]!.scheduled_at}, court_label = ${placed[0]!.court_label}
      where id = ${placed[1]!.id}`;

    const out = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "reflow" });

    // The branch really was driven. `repaired` is the only status whose rows
    // reach `settle`; on any other one the drop above is a no-op and everything
    // below would be asserting against an untouched board.
    expect(repair.statuses).toEqual(["repaired"]);
    expect(repair.droppedId).not.toBeNull();

    // Observable 1: the count.
    expect(out.solver.lost).toBe(1);

    // Observable 2: the organiser is TOLD. This row comes from `settle`'s
    // absence loop, not from the verifier — `validateAssignments` answers for
    // the rows it is handed and cannot report a card that is not among them, so
    // without that loop a dropped card would come back on a clean-looking board.
    // `warn.no_slot` is `REASON_CODE.no_slot`, the wire spelling of the engine's
    // `reason: "no_slot"`.
    const absences = out.conflicts.filter((c) => c.code === "warn.no_slot");
    expect(absences.map((c) => c.fixture_id)).toEqual([repair.droppedId]);

    // …and it is genuinely off the board, not merely reported off it.
    expect(out.assignments.map((a) => a.fixture_id)).not.toContain(repair.droppedId);
  }, 180_000);
});
