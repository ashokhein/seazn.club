// The wall has to bound the RUN, and the caller has to be able to ask whether
// the run is worth starting (rulings R23 and R22).
//
// Both come out of the same Task 13 measurement. At 200 fixtures on a 216-slot
// lattice the solver returned at **15_368 ms against an 8_000 ms wall** — 92 %
// over — because the only wall tests were at the top of the search loops and
// everything expensive happens outside them: `encodeBuild` (3_706 ms) and the
// first `solver.push()` over the encoded model (9_837 ms). Neither reads the
// clock, so a run whose budget was already gone still paid both in full.
//
// R23 puts the tests where the cost is. R22 exports the gate so the web layer
// can decline the call rather than pay it — and so the threshold lives in one
// place, because a second copy of it is a placer/verifier fork wearing a
// different hat, which is the defect shape this subsystem has hit three times.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MAX_SOLVE_ENCODING, canSolveWithin } from "./build.ts";
import { buildGrid } from "./build-grid.ts";
import { resetZ3 } from "./z3-load.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 7, 8, 0);
const COURTS = ["C1", "C2", "C3", "C4"];
const MATCH_MIN = 40;

/**
 * `gridStepMinutes` is the gcd over every interval that can DISPLACE a start,
 * floored at 5 — here `gcd(40, 0, 20) = 20`, because the 20-minute rest counts:
 * greedy chains an entrant's next start on `lastEnd + rest`, and a 40-minute
 * lattice cannot hold `+60`.
 *
 * So a court's day holds `2 x slotsPerCourtDay - 1` STARTS rather than
 * `slotsPerCourtDay` of them: the step is half a match, and the last start is
 * the latest one whose match still ends inside the session. Every fixture-slot
 * product below is that arithmetic rather than a guess, and each is asserted.
 */
function board(opts: { n: number; days: number; slotsPerCourtDay: number }): {
  fixtures: SchedulableFixture[];
  config: SlotConfig & { courts: string[] };
} {
  const sessionMs = opts.slotsPerCourtDay * MATCH_MIN * MIN;
  const config: SlotConfig & { courts: string[] } = {
    startAt: T0,
    matchMinutes: MATCH_MIN,
    gapMinutes: 0,
    courts: [...COURTS],
    perEntrantMinRest: 20,
    sessionWindows: Array.from({ length: opts.days }, (_, d) => ({
      from: T0 + d * DAY,
      to: T0 + d * DAY + sessionMs,
    })),
    window: { from: T0, to: T0 + (opts.days - 1) * DAY + sessionMs },
    tz: "UTC",
  };
  const pool = 2 * opts.n;
  const fixtures: SchedulableFixture[] = Array.from(
    { length: opts.n },
    (_, f) => {
      const home = `e${(2 * f) % pool}`;
      const away = `e${(2 * f + 1) % pool}`;
      return {
        id: `f${String(f).padStart(4, "0")}`,
        roundNo: 1,
        home,
        away,
        people: [`p-${home}`, `p-${away}`],
      };
    },
  );
  return { fixtures, config };
}

describe("R23 — the wall bounds the encode path, not just the search loops", () => {
  // A SMALL board, and the size is the point.
  //
  // The first two drafts of this test proved the guard with a STOPWATCH: run
  // the board through `buildSchedule` with the wall already gone, then price
  // one `encodeBuild` of the same board directly, and assert the whole run cost
  // less than the encode. That needs a board big enough for the encode to
  // dominate, and it cost this suite two separate outages:
  //
  //   * at 200 x 432 fixture-slots the encode poisoned the whole run. The
  //     engine's vitest config is `isolate: false` on a thread pool and z3's
  //     WASM heap only ever GROWS, so one encode that large killed 17 tests in
  //     UNRELATED files — officials/assign.property, testkit/golden,
  //     testkit/simulation — with bare `STACK_TRACE_ERROR`s. `resetZ3()` cannot
  //     hand the memory back.
  //   * at 200 x 216 the ratio itself broke, in BOTH directions. The guarded
  //     arm is `boot + greedy + lattice`, and z3's boot is a fixed ~700 ms that
  //     does not shrink with the board; the encode does. Under a loaded machine
  //     the guarded arm drifted up; under an idle one the encode dropped to
  //     1_287 ms and the assertion failed as `expected 796 to be less than 643`.
  //     There is no board size that fixes both ends, because the two arms scale
  //     differently.
  //
  // So the timing is gone. The claim was never "the run is fast" — it is "the
  // run did not encode", and that is directly observable: mock `encodeBuild`
  // and count the calls. Deterministic, machine-independent, strictly stronger
  // than any threshold, and it frees the board to be small enough that this
  // file stops being the heaviest z3 test in the suite.
  const small = board({ n: 20, days: 1, slotsPerCourtDay: 12 });

  beforeAll(async () => {
    // `isolate: false` on a thread pool means this file shares one z3 instance
    // with its neighbours, and the WASM heap only ever grows. Reset both ends.
    await resetZ3();
  });
  afterEach(() => {
    vi.doUnmock("./build-encode.ts");
    vi.resetModules();
  });
  afterAll(async () => {
    await resetZ3();
  });

  /** Loads `build.ts` with `encodeBuild` counted. The real implementation still
   *  runs — this records that the step happened, it does not replace it. */
  const withEncodeSpy = async (): Promise<{
    calls: { n: number };
    mod: typeof import("./build.ts");
  }> => {
    const calls = { n: 0 };
    // BEFORE the mock, and this line is load-bearing. This file imports
    // `./build.ts` STATICALLY at the top for `MAX_SOLVE_ENCODING`, so by the
    // time any test runs, `build.ts` is already in the module cache holding a
    // direct reference to the REAL `encodeBuild`. Without this reset the
    // `await import("./build.ts")` below hands back that cached copy, the spy
    // is wired to nothing, and `calls.n` is 0 whatever the solver does —
    // which is precisely the assertion the first test makes. MEASURED: with
    // the R23 guard deleted from `build.ts`, the file still passed 5/5.
    //
    // The second test escaped it only by accident, because `afterEach` had
    // already reset the modules by the time it ran — which is why it read as
    // a working spy and hid the fact that the first one was inert.
    vi.resetModules();
    vi.doMock("./build-encode.ts", async () => {
      const actual =
        await vi.importActual<typeof import("./build-encode.ts")>(
          "./build-encode.ts",
        );
      return {
        ...actual,
        encodeBuild: (input: Parameters<typeof actual.encodeBuild>[0]) => {
          calls.n += 1;
          return actual.encodeBuild(input);
        },
      };
    });
    return { calls, mod: await import("./build.ts") };
  };

  it("returns the greedy seed without encoding when the wall is already gone", async () => {
    const grid = buildGrid({ config: small.config });
    // 4 courts x 23 starts = 92 slots, so 20 x 92 = 1_840 fixture-slots. Pinned
    // so a lattice change cannot quietly turn this into a board with nothing to
    // encode.
    expect({ slots: grid.slots.length, overCap: grid.overCap }).toEqual({
      slots: 92,
      overCap: false,
    });

    const { calls, mod } = await withEncodeSpy();
    const out = await mod.buildSchedule({
      fixtures: small.fixtures,
      config: small.config,
      wallMs: 1,
    });

    // THE ASSERTION. The guard at `build.ts:1043` sits between the WASM boot
    // and `encodeBuild`; if it is removed, the run still returns a greedy board
    // from the guard at `:1059` — same `engine`, same `placed`, same
    // `budgetExpired` — just slower. The call count is the ONLY observable that
    // separates the two.
    expect(calls.n).toBe(0);

    // It bails rather than throwing, and it bails to the SEED — D6 ("never
    // worse than greedy") has to survive an encode-time bail, and the greedy
    // board is what every other expired path returns too.
    //
    // `not_searched`, NOT `ok`. This exit runs no `check()` at all — the
    // assertion below pins `rlimitSpent: 0` — so the board it hands back has
    // never been looked at by a solver, and `ok` is documented as "a board was
    // produced and the gate accepted it". `budgetExpired` alone does not carry
    // that: it is set on every partially-searched run too, so it says the run
    // was cut short and nothing about whether a search happened at all.
    expect({
      engine: out.engine,
      status: out.status,
      budgetExpired: out.budgetExpired,
      tiers: out.tiersCompleted,
      placed: out.metrics.placed,
    }).toEqual({
      engine: "greedy",
      status: "not_searched",
      budgetExpired: true,
      tiers: 0,
      placed: 20,
    });

    // z3's own counter never moved, so no `check()` ran either.
    expect(out.rlimitSpent).toBe(0);
  }, 120_000);

  it("still encodes when the wall is intact — the guard is a skip, not a removal", async () => {
    // THE POSITIVE WITNESS, and without it the test above is satisfied by a
    // solver that never encodes anything at all. `rlimit: 1` starves every
    // check the moment the model exists, so this pays for the encode and
    // nothing after it — the encode is what is being witnessed, not the search.
    const { calls, mod } = await withEncodeSpy();
    const out = await mod.buildSchedule({
      fixtures: small.fixtures,
      config: small.config,
      wallMs: 30_000,
      rlimit: 1,
    });

    expect(calls.n).toBe(1);
    // And the run is still held to the greedy floor on the way out.
    expect(out.metrics.placed).toBe(20);
  }, 120_000);
});

describe("R22 — canSolveWithin is the one place the size gate lives", () => {
  // 90 x 140 = 12_600 fixture-slots, inside the measured knee.
  //
  // ONE DAY, not the two it used to be. Folding the rest into the lattice step
  // (`gcd(40, 0, 20) = 20`) doubled every board's slot count, and 90 x 280 sits
  // OUTSIDE the gate — which is not a test artefact but the real consequence:
  // the same competition now costs twice the encoding, so `canSolveWithin`
  // genuinely admits fewer boards at a given wall. `MAX_SOLVE_ENCODING` is
  // stated in fixture-slots for exactly that reason, and Task 13's bench is
  // what re-measures where the knee now sits.
  const inside = board({ n: 90, days: 1, slotsPerCourtDay: 18 });
  // 200 x 420 = 84_000, well outside it.
  const outside = board({ n: 200, days: 3, slotsPerCourtDay: 18 });

  it("admits a board inside the knee and refuses one outside it", () => {
    // Both products asserted, not assumed: the verdicts below mean nothing if
    // the two boards do not actually straddle MAX_SOLVE_ENCODING.
    const inProduct =
      inside.fixtures.length *
      buildGrid({ config: inside.config }).slots.length;
    const outProduct =
      outside.fixtures.length *
      buildGrid({ config: outside.config }).slots.length;
    expect({ inProduct, outProduct, gate: MAX_SOLVE_ENCODING }).toEqual({
      inProduct: 12_600,
      outProduct: 84_000,
      gate: 20_000,
    });

    expect(canSolveWithin(inside.fixtures, inside.config, 8_000)).toBe(true);
    expect(canSolveWithin(outside.fixtures, outside.config, 8_000)).toBe(false);
  });

  it("scales the gate with the wall the caller will actually pass", () => {
    // The 20_000 figure was measured against an 8_000 ms wall, so it is a
    // cost-to-budget RATIO and not a fixed board size. The same board that is
    // refused at 8 s is admitted at 40 s, because 84_000 <= 20_000 x 5.
    //
    // This is the assertion that kills a gate which ignores `wallMs` and
    // compares against the bare constant: that mutant answers `false` here.
    expect(canSolveWithin(outside.fixtures, outside.config, 8_000)).toBe(false);
    expect(canSolveWithin(outside.fixtures, outside.config, 40_000)).toBe(true);
  });

  it("refuses a board with nothing to place, and one whose lattice is over cap", () => {
    expect(canSolveWithin([], inside.config, 8_000)).toBe(false);

    // A 400-day horizon with no session windows: 4 courts x 36 slots a day x
    // 400 days is far past `MAX_SLOTS`, so `buildGrid` returns an EMPTY slot
    // list with `overCap: true`. Without the over-cap arm the product is
    // `n x 0 = 0`, which slips under any threshold and reports `true` for a
    // board `buildSchedule` refuses to solve at all — the gate would then send
    // every caller into a run that returns greedy without searching.
    const wide: SlotConfig & { courts: string[] } = {
      ...inside.config,
      sessionWindows: undefined,
      window: { from: T0, to: T0 + 400 * DAY },
    };
    const grid = buildGrid({ config: wide });
    expect(grid.overCap).toBe(true);
    expect(grid.slots.length).toBe(0);
    expect(canSolveWithin(inside.fixtures, wide, 8_000)).toBe(false);
  });
});
