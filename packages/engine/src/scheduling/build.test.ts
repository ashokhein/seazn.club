// The build solver's control loop.
//
// Two of these tests carry the whole design, and both were written against
// MEASURED greedy behaviour rather than assumed behaviour, because two of the
// obvious premises turn out to be false:
//
//   * `slotFixtures` does NOT respect `config.window` — it scans forward for a
//     year (`horizonMinutes`, default 365 days) and will happily place a card
//     outside the competition's own calendar window without a single conflict.
//     So "greedy cannot fit these in the window" is not a way to make greedy
//     report `no_slot`; only `sessionWindows`, `blackouts` and the typed rules
//     bound it. Every corner case below is built out of those.
//   * "the solver never returns a board worse than greedy" is NOT
//     `placed >= placed && makespan <= makespan`. D3 is LEXICOGRAPHIC with
//     `placed` on top, so a board that places one more card at a longer
//     makespan is strictly better and that conjunction would refuse it. The
//     contract is `isStrictlyBetter(greedy, built) === false`, and that is what
//     is asserted.
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildSchedule, type BuildInput } from "./build.ts";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import {
  slotFixtures,
  validateAssignments,
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

const seedOf = (input: BuildInput) =>
  slotFixtures({ fixtures: input.fixtures, config: input.config, existing: input.existing });

describe("buildSchedule", () => {
  afterAll(async () => {
    await resetZ3();
  });

  it("never returns a board the greedy seed beats", async () => {
    // The floor property, and the SOLE reason design D6 ships with no escape
    // hatch back to greedy. Asserted with `isStrictlyBetter` rather than a
    // hand-written conjunction so the test and the solver's own accept
    // condition are the same function — a test that re-derived D3's ordering
    // could disagree with the code it is guarding.
    const cases: BuildInput[] = [
      { fixtures: cornerFixtures, config: cornerConfig },
      { fixtures: overSubscribedFixtures, config: overSubscribedConfig },
      { fixtures: [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")], config: cfg({ courts: ["C1", "C2"] }) },
      {
        fixtures: [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")],
        config: cfg({ courts: ["C1", "C2"], perEntrantMinRest: 45 }),
      },
    ];
    for (const input of cases) {
      const seed = seedOf(input);
      const g = boardMetrics(seed.assignments, input.config.courts, input.fixtures.length);
      const built = await buildSchedule(input);
      expect(isStrictlyBetter(g, built.metrics)).toBe(false);
      expect(built.metrics.placed).toBeGreaterThanOrEqual(g.placed);
    }
  }, 180_000);

  it("places a card greedy declared unplaceable", async () => {
    const seed = seedOf({ fixtures: cornerFixtures, config: cornerConfig });
    // The premise, asserted rather than assumed: without it the rest of this
    // test would pass against a solver that did nothing at all.
    expect(seed.assignments).toHaveLength(1);
    expect(seed.conflicts.map((c) => `${c.fixtureId}:${c.reason}`)).toEqual(["b:start_window"]);

    const built = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(built.metrics.placed).toBe(2);
    expect(built.engine).toBe("z3");
    expect(built.status).toBe("ok");
    expect(built.tiersCompleted).toBe(1);
    expect(built.budgetExpired).toBe(false);
    // Non-vacuous only because `buildSchedule` synthesises a `no_slot` row for
    // every fixture it did not place: `validateAssignments` alone never emits
    // one, so this assertion would hold on a board with zero cards on it.
    expect(built.conflicts.filter((c) => c.reason === "no_slot")).toHaveLength(0);
    expect(validateAssignments(built.assignments, cornerConfig)).toEqual([]);
  }, 180_000);

  it("returns a board the verifier accepts", async () => {
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 45 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")];
    const built = await buildSchedule({ fixtures, config });
    expect(validateAssignments(built.assignments, config)).toEqual([]);
    expect(built.status).toBe("ok");
    expect(built.metrics.placed).toBe(3);
  }, 180_000);

  it("reports every unplaced card, and PROVES the count is the ceiling", async () => {
    const input = { fixtures: overSubscribedFixtures, config: overSubscribedConfig };
    const seed = seedOf(input);
    expect(seed.assignments).toHaveLength(2);

    const built = await buildSchedule(input);
    expect(built.metrics.placed).toBe(2);
    // Greedy GUESSED that a third card would not fit; T0 walked `placed >= 3`
    // and came back unsat, which is a proof. That difference is the whole
    // reason the tier exists, and `already_optimal` is where it surfaces.
    expect(built.status).toBe("already_optimal");
    expect(built.tiersCompleted).toBe(1);
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
    // the fixtures, and T0 would happily "improve" the board onto them. A
    // lattice the encoder cannot tell apart from a legal one is worse than
    // none — the same judgement `buildGrid` makes about `MAX_SLOTS`.
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

  it("does not mistake `unknown` for a proof of infeasibility", async () => {
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
    // "Never hand back nothing": the organiser still gets greedy's board, with
    // the court clash reported on it.
    expect(built.assignments).toHaveLength(2);
    expect(built.conflicts.some((c) => c.reason === "court")).toBe(true);
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

  it("hands back the greedy seed, LOUDLY, when the verifier rejects the board", async () => {
    // A pinned card outside the competition window. `buildGrid` admits the pin
    // unconditionally and `encodeBuild` states no clause about `config.window`,
    // so the model is happy and `validateAssignments` is not — a blocking
    // `window` conflict. This is the encoder/verifier fork this whole design
    // exists to prevent, so the gate must be neither an exception (the
    // organiser still needs a board) nor silent (nobody reads a status field
    // in an incident).
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const config = cfg({ courts: ["C1"], window: { from: T0, to: T0 + 60 * MIN } });
      const fixtures = [
        fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 + 120 * MIN } }),
        fx("b", "E3", "E4"),
      ];
      const seed = slotFixtures({ fixtures, config });
      const built = await buildSchedule({ fixtures, config });
      expect(built.status).toBe("verifier_rejected");
      expect(built.engine).toBe("greedy");
      expect(built.assignments).toEqual(seed.assignments);
      expect(built.conflicts.some((c) => c.reason === "window")).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("verifier");
    } finally {
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
