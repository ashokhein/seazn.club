// What a card that is NOT on the REFLOW answer is told about itself.
//
// `reflowExisting`'s `settle` carries the web layer's own copy of the engine's
// conflict-source rule: `validateAssignments` answers for the rows it is handed
// and cannot report an ABSENCE, so every movable fixture missing from the
// proposal needs a reason, and there are two sources — greedy's own diagnosis
// first, a bare `no_slot` only if greedy said nothing. The ORDER is right. The
// FILTER on the first source was not, and it is the same defect the engine
// fixed in a5b2c4d7.
//
// `seed.conflicts` is not "what greedy could not do". `slotFixtures` also files
// rows about cards it DID place — the `commit` person-overlap loop, and the
// clash it reports rather than fixes when a `locked` slot collides — and source
// 1 short-circuits the one below it. So a card greedy PLACED and something
// later removed was handed a placed card's conflict: an overlap describing the
// placement greedy had just made, rather than the fact that the card is now on
// nobody's timetable. `person_overlap` is BLOCKING, so the organiser is also
// shown a reason their board cannot be applied for a card that is not on it.
//
// WHY THIS FILE MOCKS. Two inputs are needed and today's code can produce
// neither on its own, which is the same argument `schedule-reflow-lost.test.ts`
// makes for its own mock:
//
//   * a greedy row about a card greedy placed. `reflowExisting` seeds only
//     `f.locked === undefined` fixtures, so the locked-clash row is out of
//     reach, and `personBlocked` is unconditional in the free-placement loop,
//     so the `commit` overlap row cannot fire either. The shape is reachable in
//     `buildSchedule` (which seeds pins) and is one lock-mode change away from
//     being reachable here.
//   * a card dropped between the seed and `settle`. `repairSchedule` is TOTAL
//     over the proposal on every return path, so only a mock can remove one —
//     measured and documented in `schedule-reflow-lost.test.ts`.
//
// Everything else is real: a real Postgres, a real greedy seed, a real z3
// repair, and the real `settle`.
//
// BOTH DIRECTIONS ARE ASSERTED. The narrowing must not turn a genuine greedy
// diagnosis into a bare `no_slot` — the binding constraint greedy names is the
// best answer anybody has for a card that was never placed — so the second
// fixture below is absent from the seed WITH a diagnosis, and must still be
// told it. That half passes before and after the fix, deliberately: it is the
// guard on the fix, not the proof of it.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/** The detail strings the two synthetic greedy rows carry. Distinct, and
 *  neither is a string anything else in this run can emit, so an assertion
 *  about one cannot be satisfied by the other or by a real verifier row. */
const PLACED_ROW_DETAIL = "person mock-person-1 also in some-other-card";
const UNPLACED_ROW_DETAIL = "no feasible slot before the start window's notAfter bound";

/**
 * What the two mocks did, recorded so the test can prove it drove the branch it
 * meant to drive rather than one that happens to agree.
 *
 * `placedThenDropped` is the card greedy placed, greedy filed a row about, and
 * the repair mock then removed. `neverPlaced` is the card the seed mock held
 * back WITH a diagnosis.
 */
const state = vi.hoisted(() => ({
  seedCalls: 0,
  placedThenDropped: null as string | null,
  neverPlaced: null as string | null,
  repairStatuses: [] as string[],
  droppedFromRepair: false,
}));

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    slotFixtures: (input: Parameters<typeof actual.slotFixtures>[0]) => {
      const real = actual.slotFixtures(input);
      // ONLY the REFLOW seed. `boundSolverWindow` runs its own `slotFixtures`
      // pass over the WHOLE movable set on every mode to size the window;
      // `reflowExisting` seeds just the cards with no slot, which is the two
      // this test unscheduled. Length is the discriminator, and `seedCalls`
      // below asserts it fired exactly once.
      if (input.fixtures.length !== 2 || real.assignments.length !== 2) return real;
      state.seedCalls += 1;
      const [a, b] = real.assignments;
      state.placedThenDropped = a!.fixtureId;
      state.neverPlaced = b!.fixtureId;
      return {
        // `b` is held back — greedy could not place it — while `a` stays on the
        // seed. Both get a conflict row, and the whole question is which of the
        // two rows `settle` is entitled to repeat.
        assignments: real.assignments.filter((x) => x.fixtureId !== b!.fixtureId),
        conflicts: [
          ...real.conflicts,
          {
            fixtureId: a!.fixtureId,
            reason: "person_overlap" as const,
            detail: PLACED_ROW_DETAIL,
            rule: actual.RULE_BY_REASON.person_overlap,
          },
          {
            fixtureId: b!.fixtureId,
            reason: "start_window" as const,
            detail: UNPLACED_ROW_DETAIL,
            rule: actual.RULE_BY_REASON.start_window,
          },
        ],
      };
    },
    repairSchedule: async (input: Parameters<typeof actual.repairSchedule>[0]) => {
      const result = await actual.repairSchedule(input);
      state.repairStatuses.push(result.status);
      // Only the `repaired` arm is intercepted: `clean`, `timeout` and
      // `infeasible` all make `reflowExisting` settle the PROPOSAL rather than
      // the solver's rows, so a drop here would be undone.
      if (result.status !== "repaired") return result;
      const kept = result.assignments.filter((a) => a.fixtureId !== state.placedThenDropped);
      if (kept.length !== result.assignments.length) state.droppedFromRepair = true;
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
    ends_on: "2030-12-31",
    name: "Dropped " + suffix,
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

describe.skipIf(!HAS_DB)("REFLOW answers for a card with no slot", () => {
  it("gives a dropped card its OWN reason, not the row greedy filed while placing it", async () => {
    const { auth, stageId } = await seedStage();

    // A legal board first, applied for real, so the reflow has an incumbent to
    // repair and cards to leave alone.
    const built = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    await applySchedule(auth, stageId, {
      assignments: built.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });

    const placed = await sql<{ id: string; scheduled_at: Date; court_label: string }[]>`
      select id, scheduled_at, court_label from fixtures
      where stage_id = ${stageId} and scheduled_at is not null and court_label is not null
      order by scheduled_at, court_label`;
    expect(placed.length).toBe(6);

    // Two cards taken off the timetable, so the reflow's greedy seed has
    // exactly two fixtures to place — the pass the mock above intercepts.
    await sql`
      update fixtures set scheduled_at = null, court_label = null
      where id in ${sql([placed[4]!.id, placed[5]!.id])}`;

    // …and one card moved on top of another, so the repair solver has something
    // to repair and comes back `repaired` rather than `clean`. Written straight
    // to the table: the apply gate exists to refuse a board like this, and the
    // point is to hand the SOLVER an illegal board.
    await sql`
      update fixtures
      set scheduled_at = ${placed[0]!.scheduled_at}, court_label = ${placed[0]!.court_label}
      where id = ${placed[1]!.id}`;

    const out = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "reflow" });

    // ---- the branch really was driven ----
    expect(state.seedCalls).toBe(1);
    expect(state.repairStatuses).toEqual(["repaired"]);
    expect(state.droppedFromRepair).toBe(true);
    const dropped = state.placedThenDropped!;
    const unplaced = state.neverPlaced!;
    expect(dropped).not.toBe(unplaced);
    // Genuinely off the board, not merely reported off it.
    const onBoard = out.assignments.map((a) => a.fixture_id);
    expect(onBoard).not.toContain(dropped);
    expect(onBoard).not.toContain(unplaced);

    // ---- THE FIX ----
    // Greedy placed this card, so greedy's row about it is a statement about
    // that placement. It says nothing about why the card has no slot NOW, and
    // it is `person_overlap` — blocking — so before the fix the organiser was
    // shown a reason their board could not be applied, about a card that is not
    // on their board.
    const forDropped = out.conflicts.filter((c) => c.fixture_id === dropped);
    expect(forDropped.map((c) => c.code)).toEqual(["warn.no_slot"]);
    expect(forDropped.map((c) => c.detail)).toEqual(["no legal slot in the lattice"]);
    expect(forDropped.some((c) => c.blocking)).toBe(false);
    expect(JSON.stringify(out.conflicts)).not.toContain(PLACED_ROW_DETAIL);

    // ---- THE GUARD (passes either way, and that is the point) ----
    // Greedy never placed this one and named the binding constraint. Narrowing
    // source 1 must not cost that: a bare `no_slot` here would drop the one
    // fact that tells the organiser what to change.
    const forUnplaced = out.conflicts.filter((c) => c.fixture_id === unplaced);
    expect(forUnplaced.map((c) => c.code)).toEqual(["conflict.start_window"]);
    expect(forUnplaced.map((c) => c.detail)).toEqual([UNPLACED_ROW_DETAIL]);
  }, 180_000);
});
