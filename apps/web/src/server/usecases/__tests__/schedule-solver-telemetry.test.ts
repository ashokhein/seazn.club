// Task 9 — `autoSchedule`'s three-way dispatch, and the telemetry it puts on the
// wire.
//
// Task 8 shipped the SCHEMA for `metrics` and `solver`; nothing filled it. These
// specs are the other half: that each mode reaches the solver it is supposed to,
// that the numbers coming back are the board's own and not placeholders, and
// that the two facts a caller cannot derive for itself — the tier ladder's
// length and the pins an `infeasible` is about — ride along.
//
// The two corners that are NOT obvious, and that a looser spec would miss:
//
//   * REFLOW's regression is only visible on a board greedy would NOT reproduce.
//     A legal board that happens to be greedy's own board comes back identical
//     from `slotFixtures` too, so asserting "unchanged" on one proves nothing.
//     The card parked at 19:00 below is the corner: re-placing pulls it to
//     14:30, repairing leaves it alone, and the BUILD half of that test is there
//     to prove the corner is real rather than assumed.
//   * `TIERS_TOTAL` is asserted against the ENGINE, not against 4. `TIER_COUNT`
//     is module-private in build.ts, but `already_optimal` is returned only when
//     `tiersCompleted` reached it — so a run that comes back `already_optimal`
//     states the engine's number out loud and this file compares.
//
// Real Postgres required for the dispatch specs; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  buildSchedule,
  resetZ3,
  slotFixtures,
  z3LoadCount,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import {
  applySchedule,
  autoSchedule,
  boundSolverWindow,
  putScheduleSettings,
  AUTO_SOLVER_WALL_MS,
  TIERS_TOTAL,
} from "../schedule";
import { patchFixture } from "../fixtures";
import { AutoScheduleResult, ScheduleSolverInfo } from "@/server/api-v1/schemas";

const HAS_DB = !!process.env.DATABASE_URL;

const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<AuthCtx> {
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
  for (const feature of ["scheduling.constraints", "scheduling.board", "scheduling.multi_division"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A league division with `entrants` players and NO end date — the ordinary
 *  organiser config, and the one whose `applyWindow` is half-infinite. */
async function seedStage(
  auth: AuthCtx,
  entrants: number,
  config: Partial<Parameters<typeof putScheduleSettings>[2]["config"]> = {},
): Promise<{ divisionId: string; stageId: string; created: number }> {
  const competition = await createCompetition(auth, {
    name: "Solver " + randomUUID().slice(0, 6),
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
    Array.from({ length: entrants }, (_, i) => ({
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
      perEntrantMinRest: 30,
      blackouts: [],
      sessionWindows: [],
      ...config,
    },
    tz: "UTC",
  });
  const generated = await generateStageFixtures(auth, stage.id);
  return { divisionId: division.id, stageId: stage.id, created: generated.created };
}

const applyAll = (
  auth: AuthCtx,
  stageId: string,
  assignments: { fixture_id: string; scheduled_at: string; court_label: string }[],
) =>
  applySchedule(auth, stageId, {
    assignments: assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_label: a.court_label,
    })),
    source: "auto",
  });

// ---------------------------------------------------------------------------
// The tier ladder's length. Pure — no DB, but it does boot the WASM.
// ---------------------------------------------------------------------------

describe("TIERS_TOTAL is the engine's ladder, not a constant that agrees with it", () => {
  const cfg: SlotConfig & VerifyConfig & { courts: string[] } = {
    startAt: Date.parse(T0),
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["C1", "C2"],
    perEntrantMinRest: 0,
    tz: "UTC",
    window: { from: Date.parse(T0), to: Date.parse(T0) + 8 * 60 * MIN },
  };

  /** `buildSchedule` returns `already_optimal` only from
   *  `tiersCompleted === TIER_COUNT && !improved` — so this run is the engine
   *  reporting its own ladder length. Add or remove a tier there and the two
   *  numbers stop matching HERE, which is the drift the wire's `tiers_total`
   *  exists to stop the UI from having to guess about. */
  it("equals the tiersCompleted of a run the engine itself calls already_optimal", async () => {
    const built = await buildSchedule({
      fixtures: [{ id: "a", home: "E1", away: "E2", people: [] }],
      config: cfg,
      wallMs: AUTO_SOLVER_WALL_MS,
    });
    expect(built.status).toBe("already_optimal");
    expect(built.tiersCompleted).toBe(TIERS_TOTAL);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The finite-window clamp. Pure.
// ---------------------------------------------------------------------------

describe("boundSolverWindow", () => {
  const base: SlotConfig & VerifyConfig & { courts: string[] } = {
    startAt: Date.parse(T0),
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["C1"],
    perEntrantMinRest: 0,
    tz: "UTC",
  };
  const fixtures: SchedulableFixture[] = [
    { id: "a", home: "E1", away: "E2", people: [] },
    { id: "b", home: "E3", away: "E4", people: [] },
  ];

  /** The whole reason this exists: `dayKeyInTz(Infinity)` throws, so an
   *  open-ended competition takes the auto pass down before it reaches z3. */
  it("closes an open end at the work the greedy board actually needs, plus a day", () => {
    const open = { ...base, window: { from: Date.parse(T0), to: Infinity } };
    const bounded = boundSolverWindow(open, fixtures, []);
    const seed = slotFixtures({ fixtures, config: open, existing: [] });
    const lastEnd = Math.max(...seed.assignments.map((a) => a.endAt));
    // MEASURED against the greedy board, not restated from the implementation:
    // two 30-minute matches on one court end 60 minutes after T0.
    expect(lastEnd).toBe(Date.parse(T0) + 60 * MIN);
    expect(bounded.window).toEqual({ from: Date.parse(T0), to: lastEnd + DAY });
  });

  /** A year-wide lattice is not a harmless over-approximation: `buildGrid` caps
   *  at MAX_SLOTS = 20_000 and answers an overflow with NOTHING, which drops
   *  `buildSchedule` back onto the greedy board it was asked to improve. */
  it("keeps the clamped span far under the lattice cap", () => {
    const open = { ...base, window: { from: Date.parse(T0), to: Infinity } };
    const { window } = boundSolverWindow(open, fixtures, []);
    expect(window!.to - window!.from).toBeLessThanOrEqual(2 * DAY);
  });

  /** The clamp closes in front of the work, and REFLOW's proposal is the board
   *  as it stands — so a card the organiser parked days out has to widen it.
   *  `validateAssignments` bounds `assignments` and not `existing`, so a window
   *  that shut in front of that card would report a BLOCKING `window` conflict
   *  on a card nobody asked to move. */
  it("widens an open end around cards the proposal already contains", () => {
    const open = { ...base, window: { from: Date.parse(T0), to: Infinity } };
    const parkedFarOut = {
      fixtureId: "a",
      court: "C1",
      startAt: Date.parse(T0) + 3 * DAY,
      endAt: Date.parse(T0) + 3 * DAY + 30 * MIN,
      entrants: [],
      people: [],
    };
    const narrow = boundSolverWindow(open, fixtures, []);
    const widened = boundSolverWindow(open, fixtures, [], [parkedFarOut]);
    // The corner is real: without it the card falls OUTSIDE the clamp.
    expect(narrow.window!.to).toBeLessThan(parkedFarOut.endAt);
    expect(widened.window!.to).toBeGreaterThanOrEqual(parkedFarOut.endAt);
  });

  it("closes an open START at the earliest thing the run must contain", () => {
    const open = { ...base, window: { from: -Infinity, to: Date.parse(T0) + 4 * 60 * MIN } };
    const pinnedEarly: SchedulableFixture[] = [
      { id: "a", home: "E1", away: "E2", people: [], locked: { court: "C1", startAt: Date.parse(T0) - 90 * MIN } },
    ];
    const bounded = boundSolverWindow(open, pinnedEarly, []);
    // The pin is admitted to the lattice unconditionally, so a window that
    // excluded it would report a `window` conflict on a card nobody may move.
    expect(bounded.window!.from).toBe(Date.parse(T0) - 90 * MIN);
    expect(bounded.window!.to).toBe(Date.parse(T0) + 4 * 60 * MIN);
  });

  /** The competition's own dates are the answer whenever it has them — the
   *  clamp must not quietly widen or narrow a window an organiser set. */
  it("returns a two-bounded window untouched, identically", () => {
    const w = { from: Date.parse(T0), to: Date.parse(T0) + 4 * 60 * MIN };
    const closed = { ...base, window: w };
    expect(boundSolverWindow(closed, fixtures, []).window).toBe(w);
  });
});

// ---------------------------------------------------------------------------
// The three modes.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("autoSchedule dispatch (Task 9)", () => {
  it("build mode fills the metrics and solver blocks Task 8 declared", async () => {
    const auth = await seedOrg();
    const { stageId, created } = await seedStage(auth, 6);
    expect(created).toBe(15);

    const out = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

    // The whole envelope, round-tripped: a field left off, misspelled, or typed
    // wrong fails here, and `toEqual` catches an EXTRA key the schema strips —
    // which a field-by-field check cannot see.
    expect(AutoScheduleResult.parse(out)).toEqual(out);

    // The counts are the stage's own. `total` is the fixtures this run was
    // ASKED to place, which is why it is taken from `schedulable` and not from
    // whatever the solver managed.
    expect(out.metrics.total).toBe(created);
    expect(out.metrics.placed).toBe(out.assignments.length);
    expect(out.metrics.placed).toBe(created);
    // 15 matches over 2 courts at 30 minutes each cannot be compressed below
    // 8 slots' worth of wall time, and every entrant owes 30 minutes' rest.
    expect(out.metrics.makespan_minutes).toBeGreaterThanOrEqual(8 * 30);

    expect(out.solver.tiers_total).toBe(TIERS_TOTAL);
    expect(out.solver.tiers_completed).toBeLessThanOrEqual(out.solver.tiers_total);
    expect(out.solver.elapsed_ms).toBeGreaterThan(0);
    // The wall is the web's, not the engine's 30-second default: this response
    // is one an organiser is sitting and watching.
    expect(out.solver.elapsed_ms).toBeLessThan(AUTO_SOLVER_WALL_MS * 2);
    // Absent unless the engine PROVED an infeasibility about the pins. Never
    // synthesised from `total - placed`.
    expect(out.solver.contradictory_pins).toBe(undefined);
  }, 120_000);

  /** Without this, `metrics.total` and `metrics.placed` are the same number on
   *  every board in this file and a mapping that returned one for the other
   *  would pass everything above. */
  it("reports placed BELOW total when the board cannot hold every fixture", async () => {
    const auth = await seedOrg();
    const { stageId, created } = await seedStage(auth, 6, {
      courts: ["C1"],
      // Two hours on one court is four 30-minute slots for fifteen fixtures.
      sessionWindows: [{ from: T0, to: at(120) }],
    });
    const out = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

    expect(out.metrics.total).toBe(created);
    expect(out.metrics.placed).toBeLessThan(out.metrics.total);
    expect(out.metrics.placed).toBe(out.assignments.length);
    // An absence is a conflict. `validateAssignments` iterates the rows it is
    // handed and cannot report a fixture that is not on the board at all, so a
    // solver that placed four of fifteen must say so out of band.
    const missing = created - out.metrics.placed;
    expect(out.conflicts.length).toBeGreaterThanOrEqual(missing);
  }, 120_000);

  /**
   * REGRESSION, defect 3: `slotFixtures` re-places every unlocked card even when
   * nothing is wrong. Under `repairSchedule` k = 0 is representable, so a legal
   * board comes back untouched.
   *
   * The corner is a card the organiser has deliberately parked LATE. A board
   * that is merely legal is not enough — greedy's own board is legal and greedy
   * reproduces it — so the assertion would hold in both worlds and prove
   * nothing. The BUILD half at the end is what shows the corner is real.
   */
  it("reflow leaves an already-legal board untouched, including a card parked late", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, 6);

    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    await applyAll(auth, stageId, first.assignments);

    // Park the last card ten hours out. Still legal — nothing else is near it.
    const rows = await sql<{ id: string; scheduled_at: Date; court_label: string }[]>`
      select id, scheduled_at, court_label from fixtures
      where stage_id = ${stageId} order by scheduled_at, court_label, id`;
    const parked = rows[rows.length - 1]!;
    await applySchedule(auth, stageId, {
      assignments: [{ fixture_id: parked.id, scheduled_at: at(600), court_label: "C1" }],
      source: "manual",
    });

    const reflow = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(reflow.solver.moved).toBe(0);
    expect(reflow.assignments.find((a) => a.fixture_id === parked.id)?.scheduled_at).toBe(at(600));

    // …and the rest of the board is where the organiser left it too, not merely
    // the parked card.
    const onBoard = await sql<{ id: string; scheduled_at: Date; court_label: string }[]>`
      select id, scheduled_at, court_label from fixtures
      where stage_id = ${stageId} order by id`;
    const proposed = new Map(reflow.assignments.map((a) => [a.fixture_id, a]));
    expect(proposed.size).toBe(onBoard.length);
    for (const row of onBoard) {
      expect(proposed.get(row.id)?.scheduled_at).toBe(row.scheduled_at.toISOString());
      expect(proposed.get(row.id)?.court_label).toBe(row.court_label);
    }

    // The corner, proved rather than assumed: a re-place does NOT leave it
    // there. This is the behaviour REFLOW replaces, and if it ever stopped
    // being true the assertions above would be vacuous.
    const rebuilt = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "build" });
    expect(rebuilt.assignments.find((a) => a.fixture_id === parked.id)?.scheduled_at).not.toBe(at(600));

    // …and `only_unlocked: false` means a FULL pass: a pin is not a pin on this
    // branch, which is the whole difference between the two flags. Locking the
    // parked card and asking for a fresh board must still move it — a pin
    // predicate that ignored `only_unlocked` would leave it at 19:00 and every
    // other spec in this file would still pass.
    await patchFixture(auth, parked.id, { schedule_locked: true });
    const full = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(full.assignments.find((a) => a.fixture_id === parked.id)?.scheduled_at).not.toBe(at(600));
  }, 180_000);

  /** REFLOW is also the DEFAULT mode (an absent `only_unlocked` derives it), and
   *  the stages panel fires it from the UNSCHEDULED section. A repair solver
   *  moves cards and cannot conjure one onto a board it is not on, so without a
   *  greedy seed this is the click that silently does nothing. */
  it("reflow still places a stage where nothing is scheduled yet", async () => {
    const auth = await seedOrg();
    const { stageId, created } = await seedStage(auth, 4);

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(out.assignments).toHaveLength(created);
    expect(out.metrics.placed).toBe(created);
    expect(out.conflicts.filter((c) => c.blocking)).toHaveLength(0);
    // A greedy seed IS a move. Counting only the repair solver's own moves made
    // this run — which just scheduled the entire stage — report `moved: 0`, and
    // the result strip renders that as "nothing moved": the plainest possible
    // contradiction of what the organiser watched happen.
    expect(out.solver.moved).toBe(created);
  }, 120_000);

  /**
   * BUILD honouring a `locked` anchor, on a board that is SOLVABLE.
   *
   * This is the coverage the reflow conversion took away. `schedule.test.ts`
   * used to prove it through `slotFixtures`, but its pin assertions became
   * tautological once that call became a REFLOW: `reflowExisting`'s `settle`
   * copies the pinned cards back verbatim from the DB row, so
   * `scheduled_at === pinned.scheduled_at` cannot fail there whatever the solver
   * does. Nothing else covered it — the only other build + `only_unlocked: true`
   * case in this file asserts `infeasible`, which proves the pins were READ but
   * not that a board was built around them.
   */
  it("build honours a locked anchor and schedules the rest around it", async () => {
    const auth = await seedOrg();
    const { stageId, created } = await seedStage(auth, 4);
    expect(created).toBe(6);

    const rows = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} order by id`;
    const pinned = rows[0]!;

    // Ten hours out, on the second court: nowhere a compacting placer would put
    // a card of a six-fixture board, so "it stayed" cannot be an accident of
    // greedy happening to agree with the pin.
    await applySchedule(auth, stageId, {
      assignments: [{ fixture_id: pinned.id, scheduled_at: at(600), court_label: "C2" }],
      source: "manual",
    });
    await patchFixture(auth, pinned.id, { schedule_locked: true });

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "build" });

    // Solvable: every card placed, nothing blocking. Without this the pin
    // assertion below would pass just as well on a board the solver gave up on.
    expect(out.metrics.placed).toBe(created);
    expect(out.conflicts.filter((c) => c.blocking)).toHaveLength(0);

    const proposed = out.assignments.find((a) => a.fixture_id === pinned.id);
    expect(proposed?.scheduled_at).toBe(at(600));
    expect(proposed?.court_label).toBe("C2");
    // …and the solver worked AROUND the anchor rather than freezing onto it.
    // Keyed on fixture id, not on the timestamp: another card may legitimately
    // sit at 19:00 on the OTHER court, and an assertion that counted timestamps
    // would call that a failure.
    const others = out.assignments.filter((a) => a.fixture_id !== pinned.id);
    expect(others).toHaveLength(created - 1);
    // Nothing double-booked onto the anchor's own slot.
    expect(others.some((a) => a.scheduled_at === at(600) && a.court_label === "C2")).toBe(false);
    // The board is spread over time rather than collapsed onto the pin.
    expect(new Set(others.map((a) => a.scheduled_at)).size).toBeGreaterThan(1);
  }, 180_000);

  it("polish never moves a locked card", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, 6);

    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    await applyAll(auth, stageId, first.assignments);

    const rows = await sql<{ id: string; scheduled_at: Date; court_label: string }[]>`
      select id, scheduled_at, court_label from fixtures
      where stage_id = ${stageId} order by scheduled_at, court_label, id`;
    const locked = [rows[0]!, rows[3]!];
    for (const f of locked) await patchFixture(auth, f.id, { schedule_locked: true });

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "polish" });

    // Polish hands back the WHOLE stage, pinned cards included — the caller
    // applies the set it is given, and a mode that dropped its frozen cards
    // would unschedule them.
    expect(out.assignments).toHaveLength(rows.length);
    for (const f of locked) {
      const proposed = out.assignments.find((a) => a.fixture_id === f.id);
      expect(proposed?.scheduled_at).toBe(f.scheduled_at.toISOString());
      expect(proposed?.court_label).toBe(f.court_label);
    }
    expect(out.solver.tiers_total).toBe(TIERS_TOTAL);
    // POLISH goes to the TIER solver, not the repair solver. `reflowExisting`
    // hard-codes `tiersCompleted: 0` because a repair walks no ladder, so this
    // is what separates the two arms of the dispatch — every other assertion
    // above is satisfied by either.
    expect(out.solver.tiers_completed).toBeGreaterThan(0);
  }, 120_000);

  /**
   * `contradictory_pins` POPULATED, end to end — every other spec here only ever
   * sees it absent, and "absent" is also what a field that is declared and never
   * written looks like.
   *
   * Two cards that share an entrant, pinned 30 minutes apart under a 30-minute
   * rest rule: keeping both is impossible, and z3's feasibility probe proves it
   * about the PINS rather than about the board. Rest is warn-only at the write
   * gate, which is what lets the board reach this state at all.
   */
  it("forwards the pinned set an infeasible proof is about, when the engine names one", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, 4, { courts: ["C1", "C2"] });

    const rows = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId} order by id`;
    const first = rows[0]!;
    const sharing = rows.find(
      (r) =>
        r.id !== first.id &&
        [r.home_entrant_id, r.away_entrant_id].some((e) =>
          [first.home_entrant_id, first.away_entrant_id].includes(e),
        ),
    )!;

    // 30 minutes apart, on different courts, with 30 minutes' rest owed: legal
    // to WRITE (rest is a warning) and impossible to KEEP.
    await applySchedule(auth, stageId, {
      assignments: [
        { fixture_id: first.id, scheduled_at: at(0), court_label: "C1" },
        { fixture_id: sharing.id, scheduled_at: at(30), court_label: "C2" },
      ],
      source: "manual",
    });
    for (const f of [first, sharing]) await patchFixture(auth, f.id, { schedule_locked: true });

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "build" });
    expect(out.solver.status).toBe("infeasible");
    // The identity, not just a count: this is the whole reason the field exists.
    expect(out.solver.contradictory_pins).toEqual([first.id, sharing.id].sort());
    // …and the rest of the sentence still rides along, so the strip can say
    // "N of M scheduled" beside it.
    expect(out.metrics.total).toBe(rows.length);
  }, 120_000);

  /**
   * The WASM heap is shared by every solve in the process and only grows —
   * nothing frees a finished `Solver`. Without a teardown, six solves in one
   * process abort node with `Cannot enlarge memory arrays … (OOM)`; that is not
   * a hypothetical, it is what the first run of this very file did.
   *
   * `z3LoadCount()` reads "loads since the last reset", so a zero after a run
   * that demonstrably booted the WASM is the teardown having happened. The
   * `toBeGreaterThan(0)` on the way in is what stops this passing on a run that
   * never loaded z3 at all.
   */
  it("hands the WASM heap back after a solve, rather than growing it until node dies", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, 5);
    await resetZ3();

    await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(z3LoadCount()).toBe(0);

    // Prove the run above really did boot the WASM, so the 0 is a teardown and
    // not an absence: the same solve without the teardown leaves the count at 1.
    await buildSchedule({
      fixtures: [{ id: "a", home: "E1", away: "E2", people: [] }],
      config: {
        startAt: Date.parse(T0),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["C1"],
        perEntrantMinRest: 0,
        tz: "UTC",
        window: { from: Date.parse(T0), to: Date.parse(T0) + 4 * 60 * MIN },
      },
      wallMs: AUTO_SOLVER_WALL_MS,
    });
    expect(z3LoadCount()).toBeGreaterThan(0);
    await resetZ3();
  }, 120_000);

  /** The two blocks are REQUIRED on the wire (Task 8), so every mode has to
   *  produce a parseable one — including the repair path, which builds its
   *  `BuildResult` by hand rather than getting one from `buildSchedule`. */
  it("gives every mode a solver block the response schema accepts", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, 4);
    for (const mode of ["build", "reflow", "polish"] as const) {
      const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode });
      expect(ScheduleSolverInfo.parse(out.solver)).toEqual(out.solver);
      expect(out.solver.tiers_total).toBe(TIERS_TOTAL);
      expect(out.metrics.total).toBeGreaterThan(0);
    }
  }, 180_000);
});
