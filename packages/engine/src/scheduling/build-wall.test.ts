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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SOLVE_ENCODING, buildSchedule, canSolveWithin } from "./build.ts";
import { encodeBuild } from "./build-encode.ts";
import { buildGrid } from "./build-grid.ts";
import { loadZ3, resetZ3 } from "./z3-load.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 7, 8, 0);
const COURTS = ["C1", "C2", "C3", "C4"];
const MATCH_MIN = 40;

/**
 * `gapMinutes: 0` makes the lattice step the match length (`gridStepMinutes` is
 * `gcd(match, gap)` floored at 5, and `gcd(m, 0) === m`), so `slotsPerCourtDay`
 * means exactly what it says and the fixture-slot product below is arithmetic
 * rather than a guess.
 */
function board(opts: {
  n: number;
  days: number;
  slotsPerCourtDay: number;
}): { fixtures: SchedulableFixture[]; config: SlotConfig & { courts: string[] } } {
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
  const fixtures: SchedulableFixture[] = Array.from({ length: opts.n }, (_, f) => {
    const home = `e${(2 * f) % pool}`;
    const away = `e${(2 * f + 1) % pool}`;
    return {
      id: `f${String(f).padStart(4, "0")}`,
      roundNo: 1,
      home,
      away,
      people: [`p-${home}`, `p-${away}`],
    };
  });
  return { fixtures, config };
}

describe("R23 — the wall bounds the encode path, not just the search loops", () => {
  // A deliberately LARGE board — 200 fixtures on a 432-slot lattice, 86_400
  // fixture-slots. The size is chosen for SEPARATION, not realism: the guarded
  // path costs boot + greedy + lattice and does not move with the slot count,
  // while the unguarded path pays an `encodeBuild` that scales with
  // `fixtures x slots`. Widening the lattice therefore buys margin on the one
  // assertion that discriminates, at no cost to the committed run, which only
  // ever walks the fast arm. A 216-slot version of this board measured
  // 853 ms / 3_208 ms — a 7 % margin against the threshold below, thin enough
  // that a quiet machine could have slipped the mutant under it.
  const big = board({ n: 200, days: 6, slotsPerCourtDay: 18 });

  beforeAll(async () => {
    // `isolate: false` on a thread pool means this file shares one z3 instance
    // with its neighbours, and the WASM heap only ever grows. Reset both ends.
    await resetZ3();
  });
  afterAll(async () => {
    await resetZ3();
  });

  // An explicit timeout, because this test deliberately does the expensive
  // thing TWICE — once through `buildSchedule` (which must skip it) and once
  // directly (to price it). At 200 x 432 that is ~5 s on an idle machine and
  // more on a loaded one, against vitest's 5 s default; the overrun surfaces as
  // `Error: STACK_TRACE_ERROR`, which reads like the engine suite's load flakes
  // and is really just this test being slower than its budget.
  it("returns the greedy seed without encoding when the wall is already gone", { timeout: 120_000 }, async () => {
    const grid = buildGrid({ config: big.config });
    // Pin the shape the timing argument rests on. If a future change shrinks
    // this lattice, the encode stops being expensive and the assertion below
    // stops discriminating — silently. 200 x 216 = 43_200 fixture-slots.
    expect({ slots: grid.slots.length, overCap: grid.overCap }).toEqual({ slots: 432, overCap: false });

    const out = await buildSchedule({ fixtures: big.fixtures, config: big.config, wallMs: 1 });

    // It bails rather than throwing, and it bails to the SEED — D6 ("never
    // worse than greedy") has to survive an encode-time bail, and the greedy
    // board is what every other expired path returns too.
    expect({
      engine: out.engine,
      budgetExpired: out.budgetExpired,
      tiers: out.tiersCompleted,
      placed: out.metrics.placed,
    }).toEqual({ engine: "greedy", budgetExpired: true, tiers: 0, placed: 200 });

    // z3's own counter never moved, so no `check()` ran. This is the part that
    // is NOT a timing: a run that encoded and then searched would show a spend.
    expect(out.rlimitSpent).toBe(0);

    // THE DISCRIMINATING ASSERTION: the whole run must cost less than ONE
    // `encodeBuild` of the same board — which is only possible if it never
    // encoded.
    //
    // Measured on this machine, both arms back to back: 728 ms with the guard,
    // 4_493 ms without, against an encode of ~3_765 ms. An absolute threshold
    // between those two numbers is what I wrote first, and it FLAKED in a
    // full-suite run the same hour — the engine's suite shares one thread pool,
    // and under load the guarded arm alone drifted past 2_500 ms. A stopwatch
    // assertion measures the machine, not the code.
    //
    // Re-measuring the encode HERE, on the same box in the same second, makes
    // the comparison a ratio instead: both sides move together when the machine
    // is slow, so the inequality holds at any speed while still separating the
    // two behaviours by ~5x.
    const { Z3 } = await loadZ3();
    const solver = new Z3.Solver();
    const t = performance.now();
    encodeBuild({
      Z3,
      solver,
      fixtures: big.fixtures,
      grid,
      config: { ...big.config, matchMinutes: MATCH_MIN, courts: [...COURTS] },
    });
    const encodeMs = performance.now() - t;
    await resetZ3();

    // A positive witness that the reference is real: an encode this board can
    // do in under a tenth of a second would mean the lattice collapsed and the
    // comparison below proves nothing.
    expect(encodeMs).toBeGreaterThan(100);

    // HALF the encode, not all of it, and the halving is what makes the test
    // protective rather than merely correct. An unguarded run costs
    // `boot + greedy + encode`, so against the FULL encode it overshoots by only
    // the boot-and-greedy sliver — measured 5_804 ms against 5_376 ms, an 8 %
    // margin that a slightly faster boot would erase, letting the mutant pass.
    // Against half the encode the same two arms sit at 0.13x and 1.08x of the
    // bound: the guarded run has ~4x headroom and the unguarded one misses by
    // more than 2x. Both margins are ratios, so neither moves with the machine.
    expect(out.elapsedMs).toBeLessThan(encodeMs / 2);
  });
});

describe("R22 — canSolveWithin is the one place the size gate lives", () => {
  // 90 x 144 = 12_960 fixture-slots, inside the measured knee.
  const inside = board({ n: 90, days: 2, slotsPerCourtDay: 18 });
  // 200 x 216 = 43_200, well outside it.
  const outside = board({ n: 200, days: 3, slotsPerCourtDay: 18 });

  it("admits a board inside the knee and refuses one outside it", () => {
    // Both products asserted, not assumed: the verdicts below mean nothing if
    // the two boards do not actually straddle MAX_SOLVE_ENCODING.
    const inProduct = inside.fixtures.length * buildGrid({ config: inside.config }).slots.length;
    const outProduct = outside.fixtures.length * buildGrid({ config: outside.config }).slots.length;
    expect({ inProduct, outProduct, gate: MAX_SOLVE_ENCODING }).toEqual({
      inProduct: 12_960,
      outProduct: 43_200,
      gate: 20_000,
    });

    expect(canSolveWithin(inside.fixtures, inside.config, 8_000)).toBe(true);
    expect(canSolveWithin(outside.fixtures, outside.config, 8_000)).toBe(false);
  });

  it("scales the gate with the wall the caller will actually pass", () => {
    // The 20_000 figure was measured against an 8_000 ms wall, so it is a
    // cost-to-budget RATIO and not a fixed board size. The same board that is
    // refused at 8 s is admitted at 32 s, because 43_200 <= 20_000 x 4.
    //
    // This is the assertion that kills a gate which ignores `wallMs` and
    // compares against the bare constant: that mutant answers `false` here.
    expect(canSolveWithin(outside.fixtures, outside.config, 8_000)).toBe(false);
    expect(canSolveWithin(outside.fixtures, outside.config, 32_000)).toBe(true);
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
