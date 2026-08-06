// The build solver's control loop.
//
// The tests here were written against MEASURED greedy behaviour, because
// several of the obvious premises turn out to be false:
//
//   * `slotFixtures` does NOT respect `config.window` — it scans forward for
//     `horizonMinutes` (default 365 days) and will happily place a card outside
//     the competition's own calendar window without a single conflict, while
//     `repairUniverse` bounds z3's lattice to that same window. So "greedy
//     cannot fit these in the window" is not a way to make greedy report
//     `no_slot`; only `sessionWindows`, `blackouts` and the typed rules bound
//     it. Every corner case below is built out of those.
//   * "the solver never returns a board worse than greedy" is NOT
//     `placed >= placed && makespan <= makespan`. D3 is LEXICOGRAPHIC with
//     `placed` on top, so a board that places one more card at a longer
//     makespan is strictly better and that conjunction would refuse it. The
//     contract is `isStrictlyBetter(floor, built) === false`, and that is what
//     is asserted.
//   * the floor is not greedy's board, it is greedy's LEGAL board. Counting a
//     card that carries a blocking conflict as "placed" is what let an illegal
//     greedy board outrank every legal one D3 could reach.
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildSchedule, rejectedBlockingConflicts, type BuildInput } from "./build.ts";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import { buildGrid } from "./build-grid.ts";
import {
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  validateInstructionRules,
  type Assignment,
  type Conflict,
  type RuleFixture,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";
import type { SchedulingConstraints } from "./constraints.ts";
import { resetZ3 } from "./z3-load.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

type Cfg = SlotConfig & { courts: string[] };

const cfg = (over: Partial<SlotConfig> & { courts?: string[] } = {}): Cfg => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  tz: "Europe/London",
  // A window on EVERY case, deliberately. `buildGrid` takes its universe from
  // `repairUniverse`, which with no window, no session windows and no existing
  // board falls back to the first day of the unix epoch — a lattice 56 years
  // away from the fixtures. `buildSchedule` refuses to solve over one (see
  // "declines to solve a lattice that cannot reach the fixtures"), so a case
  // that forgot its window would silently test greedy and read as covered.
  window: { from: T0, to: T0 + 180 * MIN },
  ...over,
});

/** `SchedulingConstraints` defaults five fields and a zod default is REQUIRED in
 *  the inferred type, so the bare literal every reader wants to write does not
 *  typecheck. Same helper as the parity suite. */
const cons = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});

const fx = (
  id: string,
  home: string,
  away: string,
  over: Partial<SchedulableFixture> = {},
): SchedulableFixture => ({ id, home, away, roundNo: 1, ...over });

/**
 * THE corner case: two slots, two fixtures, and a start window that only one
 * fixture can use.
 *
 * `b`'s entrant E3 may not start after T0, so `b` fits the 09:00 slot and
 * nothing else. Greedy walks fixtures in (roundNo, id) order, takes 09:00 for
 * `a` because nothing stops it, and then has no legal slot left for `b` — it
 * reports `start_window` and hands back a one-card board. The assignment is a
 * two-slot bipartite matching whose only perfect matching is the one greedy's
 * ordering excludes, so a solver that looks at both cards at once places both.
 * Measured, not assumed: greedy gives `[a@C1+0]`, z3 gives `[b@C1+0, a@C1+30]`.
 */
const cornerConfig = cfg({
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
});
const cornerFixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];

/** Two slots, three fixtures. Nobody can place all three; the point of the case
 *  is that z3 PROVES it where greedy only ran out of ideas. */
const overSubscribedConfig = cfg({ sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
const overSubscribedFixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E4", "E5")];

/** A competition that overruns its own window: three 30-minute matches, a
 *  60-minute window, one court. Greedy places all three because it never reads
 *  `config.window`; the third sits entirely outside it and the verifier calls
 *  that BLOCKING. z3's lattice stops at the window, so it can only ever place
 *  two — and under a naive `placed`-first comparison greedy's illegal board
 *  wins forever. */
const overrunConfig = cfg({ window: { from: T0, to: T0 + 60 * MIN } });
const overrunFixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")];

const rawSeedOf = (input: BuildInput) =>
  slotFixtures({ fixtures: input.fixtures, config: input.config, existing: input.existing });

/** Greedy's LEGAL board — the floor the solver is actually held to. A row
 *  carrying a blocking conflict was never legally placed, so counting it would
 *  hold the solver to a board nobody may publish. */
const legalSeedOf = (input: BuildInput): Assignment[] => {
  const raw = rawSeedOf(input);
  const bad = new Set(
    validateAssignments(raw.assignments, input.config, input.existing)
      .filter(isBlockingConflict)
      .map((c) => c.fixtureId),
  );
  return raw.assignments.filter((a) => !bad.has(a.fixtureId));
};

describe("buildSchedule", () => {
  afterAll(async () => {
    await resetZ3();
  });

  it("never returns a board the greedy floor beats", async () => {
    // The floor property, and the SOLE reason design D6 ships with no escape
    // hatch back to greedy. Asserted with `isStrictlyBetter` rather than a
    // hand-written conjunction so the test and the solver's own accept
    // condition are the same function — a test that re-derived D3's ordering
    // could disagree with the code it is guarding.
    const cases: BuildInput[] = [
      { fixtures: cornerFixtures, config: cornerConfig },
      { fixtures: overSubscribedFixtures, config: overSubscribedConfig },
      { fixtures: overrunFixtures, config: overrunConfig },
      {
        fixtures: [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")],
        config: cfg({ courts: ["C1", "C2"] }),
      },
      {
        fixtures: [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")],
        config: cfg({ courts: ["C1", "C2"], perEntrantMinRest: 45 }),
      },
    ];
    for (const input of cases) {
      const floor = boardMetrics(legalSeedOf(input), input.config.courts, input.fixtures.length);
      const built = await buildSchedule(input);
      expect(isStrictlyBetter(floor, built.metrics)).toBe(false);
      expect(built.metrics.placed).toBeGreaterThanOrEqual(floor.placed);
    }
  }, 180_000);

  it("drops a card greedy placed OUTSIDE the window, and keeps the legal board", async () => {
    // R2. Greedy places all three; the third overruns the competition window,
    // which `isBlockingConflict` calls physically impossible. Counting it as
    // `placed` is what made the illegal board outrank every legal one, so the
    // seed is legalised before it is measured. The board handed back is then
    // one the verifier accepts outright, and the dropped card is reported with
    // the conflict that ACTUALLY disqualified it — not a fabricated `no_slot`.
    const raw = rawSeedOf({ fixtures: overrunFixtures, config: overrunConfig });
    expect(raw.assignments).toHaveLength(3);
    expect(raw.conflicts).toEqual([]);

    const built = await buildSchedule({ fixtures: overrunFixtures, config: overrunConfig });
    expect(validateAssignments(built.assignments, overrunConfig)).toEqual([]);
    expect(built.metrics.placed).toBe(2);
    expect(built.status).toBe("already_optimal");
    const dropped = built.conflicts.filter((c) => c.fixtureId === "c");
    expect(dropped.map((c) => c.reason)).toEqual(["window"]);
  }, 180_000);

  it("places a card greedy declared unplaceable", async () => {
    const seed = rawSeedOf({ fixtures: cornerFixtures, config: cornerConfig });
    // The premise, asserted rather than assumed: without it the rest of this
    // test would pass against a solver that did nothing at all.
    expect(seed.assignments).toHaveLength(1);
    expect(seed.conflicts.map((c) => `${c.fixtureId}:${c.reason}`)).toEqual(["b:start_window"]);

    const built = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(built.metrics.placed).toBe(2);
    expect(built.engine).toBe("z3");
    expect(built.status).toBe("ok");
    expect(built.tiersCompleted).toBe(4);
    expect(built.budgetExpired).toBe(false);
    // Non-vacuous only because `buildSchedule` synthesises a row for every
    // fixture it did not place: `validateAssignments` alone never emits a
    // `no_slot`, so this assertion would hold on a board with zero cards on it.
    expect(built.conflicts.filter((c) => c.reason === "no_slot")).toHaveLength(0);
    expect(validateAssignments(built.assignments, cornerConfig)).toEqual([]);
  }, 180_000);

  it("returns a board the verifier accepts", async () => {
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 45 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")];
    const built = await buildSchedule({ fixtures, config });
    expect(validateAssignments(built.assignments, config)).toEqual([]);
    // `already_optimal`, not `ok`: greedy's 45-minute rest pushes two of these
    // three cards OFF the 30-minute lattice (09:00 / 10:15 / 11:30), so no
    // three-card board exists on the grid at all and every tier bound comes
    // back unsat. That is a proof about the lattice, and reporting it as "we
    // stopped looking" would understate what actually happened.
    expect(built.status).toBe("already_optimal");
    expect(built.metrics.placed).toBe(3);
  }, 180_000);

  it("reports every unplaced card, and PROVES the count is the ceiling", async () => {
    const input = { fixtures: overSubscribedFixtures, config: overSubscribedConfig };
    const seed = rawSeedOf(input);
    expect(seed.assignments).toHaveLength(2);

    const built = await buildSchedule(input);
    expect(built.metrics.placed).toBe(2);
    // Greedy GUESSED that a third card would not fit; T0 walked `placed >= 3`
    // and came back unsat, which is a proof. That difference is the whole
    // reason the tier exists, and `already_optimal` is where it surfaces.
    expect(built.status).toBe("already_optimal");
    expect(built.tiersCompleted).toBe(4);
    const unplaced = built.conflicts.filter((c) => c.reason === "no_slot");
    expect(unplaced.map((c) => c.fixtureId)).toEqual(["c"]);
    expect(unplaced[0]?.rule).toBe("CAP");
  }, 180_000);

  it("falls back to greedy, and says so, when the lattice is over the cap", async () => {
    const config = cfg({
      window: { from: T0, to: T0 + 400 * 86_400_000 },
      courts: ["C1", "C2", "C3", "C4"],
    });
    const built = await buildSchedule({ fixtures: [fx("a", "E1", "E2")], config });
    expect(built.engine).toBe("greedy");
    expect(built.assignments).toHaveLength(1);
    expect(built.tiersCompleted).toBe(0);
  }, 180_000);

  it("declines to solve a lattice that cannot reach the fixtures", async () => {
    // `buildGrid` takes its universe from `repairUniverse`, which with no
    // window, no session windows and no existing board returns the FIRST DAY OF
    // THE UNIX EPOCH. Every slot in the lattice would then be 56 years before
    // the fixtures, and T0 would happily "improve" the board onto them.
    //
    // The corner case is reused WITHOUT its session windows on purpose: greedy
    // leaves a card unplaced, so T0 has a reason to run, and every 1970 slot
    // satisfies `b`'s "not after 09:00 on 8 Aug 2026" start window trivially.
    // Drop the guard and this returns a perfectly verifier-clean two-card board
    // dated 1 January 1970 — `validateAssignments` has no window to object to
    // either, so the gate cannot catch it. The date assertion is the only thing
    // between that board and an organiser.
    const config = cfg({
      constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
    });
    delete config.window;
    const built = await buildSchedule({ fixtures: cornerFixtures, config });
    expect(built.assignments.every((a) => a.startAt >= T0)).toBe(true);
    expect(built.engine).toBe("greedy");
    expect(built.tiersCompleted).toBe(0);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  it("does not mistake the WALK's `unknown` for a proof of infeasibility", async () => {
    // `rlimit: 1` exhausts z3's deterministic resource counter before it can
    // decide anything, so `check()` returns `unknown` — measured, not assumed.
    // `unknown` is the ABSENCE of a proof and the incumbent must simply stand;
    // mapping it onto `infeasible` would report an impossibility nobody
    // established, which is the one thing this tier must never do.
    const built = await buildSchedule({
      fixtures: cornerFixtures,
      config: cornerConfig,
      rlimit: 1,
    });
    expect(built.status).toBe("ok");
    expect(built.budgetExpired).toBe(true);
    expect(built.tiersCompleted).toBe(0);
    expect(built.engine).toBe("greedy");
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  it("does not mistake the PROBE's `unknown` for a proof of infeasibility", async () => {
    // The second site that can see an `unknown`, and it had no test of its own.
    // A pin is what makes the bare feasibility probe run at all, so this needs
    // both a locked card and an rlimit too small to decide anything.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 } }),
      fx("b", "E3", "E4"),
    ];
    const built = await buildSchedule({ fixtures, config, rlimit: 1 });
    expect(built.status).not.toBe("infeasible");
    expect(built.status).toBe("ok");
    expect(built.budgetExpired).toBe(true);
    expect(built.metrics.placed).toBe(2);
  }, 180_000);

  it("does not report infeasible from a probe it never got to run", async () => {
    // The same contradictory pins as below, but no budget. `unsat` would be a
    // proof; not asking is not one. Without the wall-clock guard the probe runs
    // anyway and this comes back `infeasible` off a question nobody asked.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 } }),
      fx("b", "E3", "E4", { locked: { court: "C1", startAt: T0 } }),
    ];
    const built = await buildSchedule({ fixtures, config, wallMs: 0 });
    expect(built.status).not.toBe("infeasible");
    expect(built.budgetExpired).toBe(true);
  }, 180_000);

  it("stops on the outer wall cap without inventing a verdict", async () => {
    const built = await buildSchedule({
      fixtures: cornerFixtures,
      config: cornerConfig,
      wallMs: 0,
    });
    expect(built.budgetExpired).toBe(true);
    expect(built.status).toBe("ok");
    expect(built.assignments).toHaveLength(1);
  }, 180_000);

  it("proves infeasible only when the pins really do contradict", async () => {
    // Two cards pinned onto ONE slot. `buildGrid` admits a pinned placement
    // unconditionally and `encodeBuild` asserts it as a unit clause, so this
    // makes the WHOLE model unsat rather than leaving one card unplaced — and
    // an unsat that arrives that way is a fact about the pins, not about the
    // board. `infeasible` here is a real proof: with no locked card the empty
    // board satisfies every clause the encoder writes, so the model can only
    // be globally unsat because of a pin.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 } }),
      fx("b", "E3", "E4", { locked: { court: "C1", startAt: T0 } }),
    ];
    const built = await buildSchedule({ fixtures, config });
    expect(built.status).toBe("infeasible");
    expect(built.engine).toBe("greedy");
    // Both cards are double-booked, so NEITHER is legally placed and the seed
    // legalisation drops both. The organiser is not left guessing: every card
    // is reported, with the court clash that actually disqualified it.
    expect(built.assignments).toHaveLength(0);
    expect(
      built.conflicts
        .filter((c) => c.reason === "court")
        .map((c) => c.fixtureId)
        .sort(),
    ).toEqual(["a", "b"]);
    // R4. The proof is about the PINS, and on a bigger board — 38 of 40 placed
    // and two locked cards fighting over one slot — "infeasible" on its own
    // reads to an organiser as "no schedule is possible", which is false. The
    // result names the cards the proof is about so the caller can say which.
    expect(built.contradictoryPins).toEqual(["a", "b"]);
  }, 180_000);

  it("names no pins when the proof is about the BOARD, not the pins", async () => {
    // The other `infeasible` source, and the reason the field is optional
    // rather than always present: nothing is pinned here at all. One slot, one
    // fixture, and a start window that excludes it, so T0 walks `placed >= 1`
    // and comes back unsat — a proof about the lattice. Reporting a pin here
    // would name cards that had nothing to do with it.
    const config = cfg({
      courts: ["C1"],
      sessionWindows: [{ from: T0, to: T0 + 30 * MIN }],
      constraints: cons({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notAfter: T0 - MIN }],
      }),
    });
    const built = await buildSchedule({ fixtures: [fx("a", "E1", "E2")], config });
    expect(built.status).toBe("infeasible");
    expect(built.metrics.placed).toBe(0);
    expect(built.contradictoryPins).toBeUndefined();
    // Every tier ran to a verdict on the empty board — each is already at its
    // own floor — which is what makes the status a proof rather than a stop.
    expect(built.tiersCompleted).toBe(4);
  }, 180_000);

  it("does not cry infeasible over a pin that is merely legal", async () => {
    // The other side of the probe above: a locked card that fits must not be
    // read as a contradiction, and its slot must survive into the answer.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 90 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 + 60 * MIN } }),
      fx("b", "E3", "E4"),
    ];
    const built = await buildSchedule({ fixtures, config });
    expect(built.status).not.toBe("infeasible");
    expect(built.metrics.placed).toBe(2);
    expect(built.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 60 * MIN);
  }, 180_000);

  it("holds a frozen card to its slot even when moving it would place one more", async () => {
    // POLISH. Without the freeze the solver swaps `a` onto the later slot and
    // fits `b` — a strictly better board by D3. `frozen` is the caller saying
    // an entrant has already been told when they play, and a better board is
    // not worth breaking that promise. The unfrozen run is asserted first so
    // this cannot pass against a solver that never had the option.
    const free = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(free.metrics.placed).toBe(2);
    expect(free.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 30 * MIN);

    const built = await buildSchedule({
      fixtures: cornerFixtures,
      config: cornerConfig,
      frozen: ["a"],
    });
    expect(built.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  it("holds a frozen card whose published slot is OFF the lattice", async () => {
    // A card the organiser dragged, or one greedy parked against the edge of an
    // existing booking: its start is not a multiple of the grid step, so it is
    // not a slot `buildGrid` generates. Looking it up with `findIndex` gets -1,
    // and silently dropping the freeze there let POLISH move a card it had
    // promised not to while still reporting `ok`. Every frozen anchor is now
    // PINNED into the lattice the way a `locked` placement is.
    // `a`'s entrant may not start before 09:07, so greedy starts it at exactly
    // 09:07 — the lattice only generates 09:00 / 09:30 / 10:00. `b`'s entrant
    // may not start after 09:00, and `a` sitting at 09:07 covers 09:00's slot
    // on the only court, so greedy leaves `b` unplaced. Move `a` to 09:30 and
    // both fit, which gives the solver a real reason to move the card the
    // caller froze. Measured: greedy `[a@C1+7]`, `b:start_window`; slots are
    // `C1+0, C1+30, C1+60`.
    const config = cfg({
      sessionWindows: [{ from: T0, to: T0 + 90 * MIN }],
      constraints: cons({
        startWindows: [
          { target: { kind: "entrant", id: "E1" }, notBefore: T0 + 7 * MIN },
          { target: { kind: "entrant", id: "E3" }, notAfter: T0 },
        ],
      }),
    });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    const seed = rawSeedOf({ fixtures, config });
    expect(seed.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 7 * MIN);
    expect(seed.conflicts.map((c) => c.reason)).toEqual(["start_window"]);

    // Unfrozen, the solver takes the better board and `a` moves onto the grid.
    const free = await buildSchedule({ fixtures, config });
    expect(free.metrics.placed).toBe(2);
    expect(free.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 30 * MIN);

    // Frozen, 09:07 has to survive — and 09:07 is not a slot the lattice
    // generates, so it survives only because the anchor was pinned into it.
    const built = await buildSchedule({ fixtures, config, frozen: ["a"] });
    expect(built.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 7 * MIN);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  it("does NOT reject a board over a blocking breach greedy already had", async () => {
    // R1: the gate is a DELTA. This card is pinned outside the competition
    // window — `buildGrid` admits a pin unconditionally, `encodeBuild` states no
    // clause about `config.window`, and `validateAssignments` calls it a
    // blocking `window` breach. An ABSOLUTE gate refuses the solver's answer
    // here, and would go on refusing it on every board carrying a legacy
    // `person_overlap` too, which is the population `deltaConflicts` exists to
    // keep editable. The breach is greedy's, so it is not laid at the solver's
    // door — it is reported, and the better board still ships.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const config = cfg({ courts: ["C1"], window: { from: T0, to: T0 + 60 * MIN } });
      const fixtures = [
        fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 + 120 * MIN } }),
        fx("b", "E3", "E4"),
      ];
      const built = await buildSchedule({ fixtures, config });
      expect(built.status).toBe("ok");
      expect(built.metrics.placed).toBe(2);
      expect(built.conflicts.some((c) => c.fixtureId === "a" && c.reason === "window")).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 180_000);

  it("hands back the greedy seed, LOUDLY, over a breach the solver INTRODUCED", async () => {
    // The rejection branch itself. A genuine encoder/verifier disagreement is
    // not constructible here — `build-encode-parity.test.ts` proves the two
    // agree over every placement two lattices can express, which is the design
    // working — so the disagreement is INJECTED: `validateAssignments` reports
    // a blocking `person_overlap` on the solver's two-card board and nothing on
    // greedy's one-card board. That is exactly the shape a future encoder
    // regression would take, and it is the only way to exercise the fallback
    // and the log without waiting for one.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();
    vi.doMock("./calendar.ts", async () => {
      const actual = await vi.importActual<typeof import("./calendar.ts")>("./calendar.ts");
      return {
        ...actual,
        validateAssignments: (
          assignments: readonly Assignment[],
          ...rest: unknown[]
        ): Conflict[] => [
          ...(actual.validateAssignments as (...a: unknown[]) => Conflict[])(assignments, ...rest),
          ...(assignments.length === 2
            ? [{ fixtureId: "b", reason: "person_overlap" as const, detail: "injected fork" }]
            : []),
        ],
      };
    });
    try {
      const mod = await import("./build.ts");
      const built = await mod.buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
      expect(built.status).toBe("verifier_rejected");
      expect(built.engine).toBe("greedy");
      // The greedy seed, not the solver's better board: the organiser still
      // gets a board, and it is the one nothing new is wrong with.
      expect(built.assignments).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("verifier rejected");
      expect(String(spy.mock.calls[0]?.[0])).toContain("b:person_overlap");
    } finally {
      const z3 = await import("./z3-load.ts");
      await z3.resetZ3();
      vi.doUnmock("./calendar.ts");
      vi.resetModules();
      spy.mockRestore();
    }
  }, 180_000);

  it("reports z3_unavailable rather than throwing when the solver will not boot", async () => {
    // Auto-schedule must always hand back a board. A WASM that will not boot is
    // a fallback, never an exception.
    vi.resetModules();
    vi.doMock("./z3-load.ts", async () => {
      const actual = await vi.importActual<typeof import("./z3-load.ts")>("./z3-load.ts");
      return { ...actual, loadZ3: () => Promise.reject(new Error("no wasm here")) };
    });
    try {
      const mod = await import("./build.ts");
      const built = await mod.buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
      expect(built.status).toBe("z3_unavailable");
      expect(built.engine).toBe("greedy");
      expect(built.assignments).toHaveLength(1);
    } finally {
      vi.doUnmock("./z3-load.ts");
      vi.resetModules();
    }
  }, 180_000);
});

describe("rejectedBlockingConflicts", () => {
  // The gate's decision, tested where it can actually be exercised. Inside
  // `buildSchedule` an encoder/verifier disagreement is not constructible —
  // `build-encode-parity.test.ts` proves the two agree over every placement two
  // lattices can express, and the one seam outside that envelope (a pin outside
  // `config.window`) is a breach greedy shares, so the delta cancels it. That
  // makes the gate a guard against a FUTURE encoder change, and a guard nothing
  // can trigger is a guard nothing can test end to end.
  const c = (over: Partial<Conflict> & Pick<Conflict, "fixtureId" | "reason">): Conflict => ({
    detail: "d",
    ...over,
  });

  it("passes a blocking conflict the board already carried", () => {
    const before = [c({ fixtureId: "a", reason: "window" })];
    const after = [c({ fixtureId: "a", reason: "window" })];
    expect(rejectedBlockingConflicts(before, after, new Set(["a"]))).toEqual([]);
  });

  it("rejects a blocking conflict the solver introduced", () => {
    const after = [c({ fixtureId: "a", reason: "person_overlap" })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual(after);
  });

  it("rejects a MEASURED blocking conflict that got worse", () => {
    // `conflictKey` excludes `shortfallMinutes` on purpose, so a worsening has
    // identical identity and is visible only through the size. A gate built on
    // a plain set difference would wave this through.
    const before = [c({ fixtureId: "a", reason: "order", direct: true, shortfallMinutes: 10 })];
    const after = [c({ fixtureId: "a", reason: "order", direct: true, shortfallMinutes: 30 })];
    expect(rejectedBlockingConflicts(before, after, new Set(["a"]))).toEqual(after);
  });

  it("ignores a blocking conflict on a card this run did not place", () => {
    // `validateAssignments` attributes an `order` conflict between two
    // `existing` rows to a fixture the solver never touched. Refusing our own
    // answer over one would be a lock-out with no fix, since nothing the solver
    // can do changes it.
    const after = [c({ fixtureId: "sibling", reason: "order", direct: true })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual([]);
  });

  it("filters BLOCKING before it takes the delta, so a warn-only twin cannot cancel it", () => {
    // The rationale the function's doc gives, exercised rather than asserted.
    // `conflictKey` is `fixtureId|reason|detail` and does NOT include `direct`,
    // so a warn-only `order` row and a blocking one are the same key. Take the
    // delta first and they cancel: the board goes from "the dependent is a bit
    // tight" to "the dependent starts before its feeder finishes" and the gate
    // sees nothing at all.
    const before = [c({ fixtureId: "a", reason: "order", direct: false })];
    const after = [c({ fixtureId: "a", reason: "order", direct: true })];
    expect(rejectedBlockingConflicts(before, after, new Set(["a"]))).toEqual(after);
  });

  it("ignores a NON-blocking conflict however new it is", () => {
    // Below-minimum rest is uncomfortable, not impossible, and organisers
    // override it. Rejecting the board over one would make the solver refuse
    // the very trade-offs it exists to make.
    const after = [c({ fixtureId: "a", reason: "rest" }), c({ fixtureId: "a", reason: "blackout" })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual([]);
  });
});

/**
 * Tiers 1-3.
 *
 * Every board below is MEASURED, not assumed: the premise assertion at the top
 * of each case pins what greedy actually does, because a tier test whose seed is
 * already optimal passes against a solver that ran no tiers at all. The brief's
 * own sketch for this suite had exactly that shape — four disjoint fixtures on
 * two courts, asserting `courtImbalanceMinutes === 0`, on a board greedy
 * already balances 2-2.
 */
describe("buildSchedule — lexicographic tiers", () => {
  afterAll(async () => {
    await resetZ3();
  });

  /** Four slots a side, two fixtures sharing E1. Greedy stacks both on C1 —
   *  it looks for the earliest legal TIME and takes the first court free at it,
   *  so the second card lands on C1 at 09:30 rather than beside the first. The
   *  makespan (60) and the worst idle gap (0) are the same on every board that
   *  places both, so T3 is the tier that decides, and an even split beats a
   *  stack. */
  const balanceConfig = cfg({ courts: ["C1", "C2"], window: { from: T0, to: T0 + 120 * MIN } });
  const balanceFixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3")];

  it("completes all four tiers, and balances the courts with the last of them", async () => {
    const seed = rawSeedOf({ fixtures: balanceFixtures, config: balanceConfig });
    expect(boardMetrics(seed.assignments, balanceConfig.courts, 2).courtImbalanceMinutes).toBe(60);

    const built = await buildSchedule({ fixtures: balanceFixtures, config: balanceConfig });
    expect(built.tiersCompleted).toBe(4);
    expect(built.budgetExpired).toBe(false);
    expect(built.metrics.placed).toBe(2);
    // T1 and T2 had nothing to give — both are already at their optimum on the
    // greedy board — so the only thing that moved is the court split.
    expect(built.metrics.makespanMinutes).toBe(60);
    expect(built.metrics.worstIdleGapMinutes).toBe(0);
    expect(built.metrics.courtImbalanceMinutes).toBe(0);
    expect(new Set(built.assignments.map((a) => a.court))).toEqual(new Set(["C1", "C2"]));
    expect(built.engine).toBe("z3");
  }, 180_000);

  it("shortens a makespan greedy left long", async () => {
    // `notBefore` is the one place greedy reliably loses a makespan: it starts
    // the constrained card at EXACTLY 09:45, which is not a lattice multiple,
    // and then packs the other two around it — 09:00, 09:45, 10:15, a 105-minute
    // board. The lattice only offers 09:00 / 09:30 / 10:00 / 10:30, so `a` must
    // take 10:00 or later, and the shortest board is the other two beneath it.
    const config = cfg({
      window: { from: T0, to: T0 + 120 * MIN },
      constraints: cons({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notBefore: T0 + 45 * MIN }],
      }),
    });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")];
    const seed = rawSeedOf({ fixtures, config });
    expect(boardMetrics(seed.assignments, config.courts, 3).makespanMinutes).toBe(105);

    const built = await buildSchedule({ fixtures, config });
    expect(built.metrics.placed).toBe(3);
    expect(built.metrics.makespanMinutes).toBe(90);
    // Forced, not incidental: 90 minutes over one court is three back-to-back
    // slots, and `a` may not start before 09:45, so `a` is the LAST of them.
    //
    // THE ABSOLUTE INSTANT IS NOT FORCED AND MUST NOT BE ASSERTED. Two boards
    // meet all four of D3's tiers here — 09:00/09:30/10:00 and
    // 09:30/10:00/10:30 — with the same `placed`, the same makespan, no idle
    // gap on either (six distinct entrants, one match each) and the same
    // imbalance (one court). Which one comes back is a tie z3 breaks in its own
    // internals, not a property of this design.
    //
    // This asserted 10:00 until R17, and passed only because the solves EARLIER
    // IN THIS FILE left the shared z3 context warm — the cold answer was always
    // 10:30 (measured directly). Now that `buildSchedule` tears the context down
    // itself, every solve is cold and the tie falls the other way. Asserting the
    // instant was pinning the solver's search state; asserting the shape pins
    // what the comment above actually argues.
    const starts = [...built.assignments].map((x) => x.startAt).sort((p, q) => p - q);
    expect(built.assignments.find((x) => x.fixtureId === "a")?.startAt).toBe(starts[2]);
    expect(built.tiersCompleted).toBe(4);
  }, 180_000);

  it("closes an idle gap greedy left open, without lengthening the board", async () => {
    // Three slots, three cards, so the makespan is 90 on every board that
    // places them all and T1 can do nothing. E1 plays `a` and `b`; greedy walks
    // fixtures in (roundNo, id) order, so `c` gets served before `b` and E1 is
    // left with a 30-minute wait in the middle. T2 swaps them.
    const config = cfg({ window: { from: T0, to: T0 + 90 * MIN } });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3", { roundNo: 2 }), fx("c", "E4", "E5")];
    const seed = rawSeedOf({ fixtures, config });
    const seedMetrics = boardMetrics(seed.assignments, config.courts, 3);
    expect(seedMetrics.worstIdleGapMinutes).toBe(30);
    expect(seedMetrics.makespanMinutes).toBe(90);

    const built = await buildSchedule({ fixtures, config });
    expect(built.metrics.placed).toBe(3);
    expect(built.metrics.worstIdleGapMinutes).toBe(0);
    expect(built.metrics.makespanMinutes).toBe(90);
    expect(built.tiersCompleted).toBe(4);
  }, 180_000);

  it("will not buy court balance with makespan", async () => {
    // THE ORDERING TEST, and the only one of these where a tier has something
    // strictly better in reach and may not take it.
    //
    // C1 is open 09:00-10:00 and C2 only from 10:30, so the lattice is
    // C1+09:00, C1+09:30, C2+10:30 and the two cards are disjoint. The shortest
    // board is both on C1 — 60 minutes, and a 60-minute court imbalance. Moving
    // either card to C2 balances the courts perfectly at 0, which T3 would take
    // in a heartbeat, and costs 30 or 60 minutes of makespan, which T1 has
    // already frozen. So the board that wins is the LOPSIDED one.
    //
    // T2's freeze cannot stand in for T1's here: the two fixtures share no
    // participant, so the idle gap is 0 on every board and its clause family is
    // empty. Only the makespan freeze forbids the balanced board.
    const config = cfg({
      courts: ["C1", "C2"],
      window: { from: T0, to: T0 + 120 * MIN },
      blackouts: [
        { court: "C2", from: T0, to: T0 + 90 * MIN },
        { court: "C1", from: T0 + 60 * MIN, to: T0 + 120 * MIN },
      ],
    });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    expect(buildGrid({ config }).slots.filter((s) => s.court === "C2")).toHaveLength(1);

    const built = await buildSchedule({ fixtures, config });
    expect(built.metrics.placed).toBe(2);
    expect(built.metrics.makespanMinutes).toBe(60);
    expect(built.metrics.courtImbalanceMinutes).toBe(60);
    // All four, and that is the assertion the freeze actually holds up: without
    // it T3 finds the balanced board, `isStrictlyBetter` refuses it because the
    // makespan regressed, and the tier ends without a verdict.
    expect(built.tiersCompleted).toBe(4);
    expect(built.status).toBe("already_optimal");
  }, 180_000);

  it("keeps the encoder and the verifier on ONE immovable board", async () => {
    // The caller contract `encodeBuild` documents and `build.ts` honours, tested
    // end to end for the first time now that both halves exist. The encoder
    // seeds its per-day tally from the `existing` array IT is handed; the
    // verifier tallies from the array IT is handed; hand either side a filtered
    // copy and the model believes a day has room the referee says it does not.
    //
    // Two days, one court, a 3/day cap and one immovable card already on day 1.
    // Day 1 therefore has room for two more and offers three slots, while day 2
    // offers only two — so no board can avoid splitting, and packing all three
    // onto day 1 would collapse the makespan from a day and a half to 90
    // minutes. That is exactly what T1 does the moment the cap stops binding,
    // and the cap only binds if the encoder counted the immovable card.
    const D1 = Date.UTC(2026, 7, 8, 8, 0); // 09:00 Europe/London
    const D2 = D1 + 24 * 60 * MIN;
    const ruleFixtures: RuleFixture[] = ["x", "a", "b", "c"].map((id) => ({
      id,
      extKey: null,
      winnerTo: null,
    }));
    const existing: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: D1, endAt: D1 + 30 * MIN, entrants: ["E9"], people: [] },
    ];
    const config = cfg({
      startAt: D1,
      window: { from: D1, to: D2 + 120 * MIN },
      sessionWindows: [
        { from: D1, to: D1 + 120 * MIN },
        { from: D2, to: D2 + 60 * MIN },
      ],
      constraints: cons({
        hard: [{ type: "max_fixtures_per_day", count: 3, scope: { kind: "competition" } }],
      }),
      ruleFixtures,
    });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")];

    // The premise, measured: day 1 offers three free slots, so the cap — not
    // the lattice — is the only thing stopping all three cards landing there.
    const grid = buildGrid({ config, existing });
    expect(grid.slots.filter((s) => s.startAt < D2)).toHaveLength(3);
    expect(grid.slots.filter((s) => s.startAt >= D2)).toHaveLength(2);
    const seed = rawSeedOf({ fixtures, config, existing });
    expect(seed.assignments).toHaveLength(3);
    expect(validateInstructionRules(seed.assignments, config, existing)).toEqual([]);

    const built = await buildSchedule({ fixtures, config, existing });
    expect(built.metrics.placed).toBe(3);
    // The load-bearing assertion. An encoder counting a day it thinks is empty
    // puts all three on day 1 and the referee reports the cap breach here.
    expect(validateInstructionRules(built.assignments, config, existing)).toEqual([]);
    expect(built.assignments.filter((a) => a.startAt < D2).length).toBeLessThanOrEqual(2);
    // Non-vacuous: the solver really did move the board, so this is not a test
    // of greedy wearing the solver's name — and 1410 is the shortest board the
    // cap allows, where 90 is the shortest board it would allow if the encoder
    // had not counted `x`.
    expect(built.engine).toBe("z3");
    expect(built.metrics.makespanMinutes).toBe(1410);
  }, 180_000);
});

describe("buildSchedule — the lattice is the configured courts", () => {
  afterAll(async () => {
    await resetZ3();
  });

  /** An immovable row parked on a court the organiser never configured. It is
   *  what drags "C2" into `repairCourts`, and therefore into the lattice. */
  const onC2: Assignment[] = [
    { fixtureId: "x", court: "C2", startAt: T0 + 60 * MIN, endAt: T0 + 90 * MIN, entrants: ["E9"], people: [] },
  ];

  it("places nothing on a court the organiser did not configure", async () => {
    // R3. One session-window slot on the configured court and two fixtures, so
    // the solver has an obvious use for the borrowed court and must decline it.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 30 * MIN }] });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    // The premise, and the whole reason this is not vacuous: the UNRESTRICTED
    // lattice does offer C2, and a solver allowed to use it places both cards.
    expect(buildGrid({ config, existing: onC2 }).slots.map((s) => s.court)).toEqual(["C1", "C2"]);

    const built = await buildSchedule({ fixtures, config, existing: onC2 });
    expect(built.assignments.map((a) => a.court)).toEqual(["C1"]);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  it("still honours a locked card parked on an unconfigured court", async () => {
    // The exemption, and it is load-bearing rather than defensive: `encodeBuild`
    // THROWS when a locked placement is missing from the lattice, so a filter
    // without it turns an odd-looking board into a crash.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C2", startAt: T0 } }),
      fx("b", "E3", "E4"),
    ];
    const built = await buildSchedule({ fixtures, config, existing: onC2 });
    expect(built.status).not.toBe("infeasible");
    expect(built.metrics.placed).toBe(2);
    expect(built.assignments.find((x) => x.fixtureId === "a")).toMatchObject({
      court: "C2",
      startAt: T0,
    });
    // The pin is an exemption for ONE slot, not an amnesty for the court: `b`
    // may not join it there even though C2 has free time.
    expect(built.assignments.filter((x) => x.court === "C2").map((x) => x.fixtureId)).toEqual(["a"]);
  }, 180_000);
});
