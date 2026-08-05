// The typed instruction rules, inside the boolean model (#463's convergence,
// carried into BUILD).
//
// `slotFixtures` has placed around `max_fixtures_per_day`, `not_before`,
// `not_after`, `fixture_on_date` and `fixture_on_weekday` since #463, and
// `repair.ts`'s `assertDayCap` encodes the cap for the repair solver. Without
// them here BUILD would be the only path ignoring rules the greedy it replaces
// and the solver beside it both honour — `validateInstructionRules` would report
// breaches on a board the model had just called optimal, and re-running auto
// could not fix it.
//
// THE GATE, in every case below: the model accepts a placement IFF
// `validateAssignments` reports nothing about it, and `validateAssignments`
// includes `validateInstructionRules`. Each case enumerates EVERY placement its
// lattice can express, so nothing here is a spot check. Two anti-vacuity
// assertions guard the harness itself: both answers must be reachable, and at
// least one placement must breach an INSTRUCTION rule specifically — otherwise a
// case whose sat/unsat split came entirely from the court rule would read as
// covering a rule the encoder never stated.
import { describe, expect, it } from "vitest";
import { buildGrid, type BuildGrid } from "./build-grid.ts";
import { encodeBuild } from "./build-encode.ts";
import { loadZ3, resetZ3, withZ3Lock } from "./z3-load.ts";
import {
  validateAssignments,
  validateInstructionRules,
  type Assignment,
  type RuleFixture,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "./calendar.ts";
import { HardConstraint } from "./constraints.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** 09:00 Europe/London on SATURDAY 2026-08-08. August is BST (UTC+1), and no
 *  transition falls inside this window, so `+ DAY` genuinely stays on 09:00
 *  local — the one thing `+ 86_400_000` may not be assumed to do. */
const D1 = Date.UTC(2026, 7, 8, 8, 0);
/** SUNDAY 2026-08-09, 09:00 local. */
const D2 = D1 + DAY;

type Cfg = SlotConfig & { courts: string[] };

const config = (over: Partial<SlotConfig> = {}): Cfg => ({
  startAt: D1,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 60,
  tz: "Europe/London",
  window: { from: D1 - 12 * 60 * MIN, to: D2 + 12 * 60 * MIN },
  ...over,
});

/** Two 40-minute sessions on two calendar days — 09:00 and 09:10 local on
 *  Saturday and on Sunday, across two courts. Eight slots. */
const twoDay = (): Cfg =>
  config({
    sessionWindows: [
      { from: D1, to: D1 + 40 * MIN },
      { from: D2, to: D2 + 40 * MIN },
    ],
  });

/** Two 40-minute sessions on ONE day, morning and afternoon — 09:00/09:10 and
 *  14:00/14:10 local, across two courts. Eight slots, four wall-clock times. */
const twoSession = (): Cfg =>
  config({
    sessionWindows: [
      { from: D1, to: D1 + 40 * MIN },
      { from: D1 + 300 * MIN, to: D1 + 340 * MIN },
    ],
  });

/** One 30-minute session per day: exactly one start per (court, day). Four
 *  slots, and the court rule can never bind two fixtures — so a sat/unsat split
 *  here is the day cap's and nothing else's. */
const oneStartPerDay = (): Cfg =>
  config({
    sessionWindows: [
      { from: D1, to: D1 + 30 * MIN },
      { from: D2, to: D2 + 30 * MIN },
    ],
  });

const fx = (
  id: string,
  home: string,
  away: string,
  over: Partial<SchedulableFixture> = {},
): SchedulableFixture => ({ id, home, away, people: [], ...over });

/** A movable fixture's rule metadata. Built through the real shape so a missing
 *  field is a type error rather than a rule that silently binds nothing. */
const rf = (id: string, over: Partial<RuleFixture> = {}): RuleFixture => ({
  id,
  extKey: null,
  winnerTo: null,
  ...over,
});

/** Rule literals go through the zod schema on purpose: `max_fixtures_per_day`
 *  carries `count` (not `max`), the date/weekday rules carry a REQUIRED
 *  `selector`, and `weekday` is a code string. A brief has got each of those
 *  wrong; `parse` throws where a bare literal would bind nothing and pass. */
const rule = (x: unknown): HardConstraint => HardConstraint.parse(x);

/** Every placement the lattice can express, one fixture per slot, no repeats. */
function* placements(n: number, slotCount: number): Generator<number[]> {
  const pick: number[] = [];
  function* go(i: number): Generator<number[]> {
    if (i === n) {
      yield [...pick];
      return;
    }
    for (let s = 0; s < slotCount; s++) {
      if (pick.includes(s)) continue;
      pick.push(s);
      yield* go(i + 1);
      pick.pop();
    }
  }
  yield* go(0);
}

const slotAt = (grid: BuildGrid, court: string, startAt: number): number => {
  const s = grid.slots.findIndex((sl) => sl.court === court && sl.startAt === startAt);
  if (s < 0) throw new Error(`no slot ${court}@${new Date(startAt).toISOString()}`);
  return s;
};

interface RuleCase {
  cfg: Cfg;
  verify: VerifyConfig;
  fixtures: readonly SchedulableFixture[];
  existing?: readonly Assignment[];
  /** Slot count the lattice is expected to produce — pinned so a config edit
   *  that silently empties or explodes the lattice fails loudly rather than
   *  quietly enumerating a different (or vacuous) space. */
  slots: number;
}

/**
 * Force every placement in turn and require the model's verdict to equal the
 * verifier's, plus the instruction-rule gate on top.
 *
 * Returns the tally so a caller can pin the split when it is load-bearing.
 */
async function assertRuleParity(input: RuleCase): Promise<{ checked: number; sats: number }> {
  const { cfg, verify, fixtures } = input;
  const existing = input.existing ?? [];
  const grid = buildGrid({ config: cfg, existing });
  expect(grid.overCap).toBe(false);
  expect(grid.slots.length).toBe(input.slots);

  const { Z3 } = await loadZ3();
  let checked = 0;
  let sats = 0;
  let instructionBreaches = 0;
  await withZ3Lock(async () => {
    for (const pick of placements(fixtures.length, grid.slots.length)) {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...verify, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
        existing,
      });
      pick.forEach((s, i) => solver.add(model.place[i]![s]!));
      const sat = (await solver.check()) === "sat";
      const board = model.assignmentsFrom(pick);
      const instruction = validateInstructionRules(board, verify, existing);
      const clean = validateAssignments(board, verify, existing).length === 0;
      expect({ pick, sat }).toEqual({ pick, sat: clean });
      // THE ACCEPTANCE CRITERION, stated separately from the parity equality
      // above so it cannot be satisfied by a rule the verifier happens not to
      // reach: nothing the model accepts may carry an instruction conflict.
      if (sat) expect({ pick, instruction }).toEqual({ pick, instruction: [] });
      if (instruction.length > 0) instructionBreaches++;
      checked++;
      if (sat) sats++;
    }
  });
  await resetZ3();
  // Both answers reachable, or a model that refused (or accepted) everything
  // would satisfy the equality vacuously.
  expect(sats).toBeGreaterThan(0);
  expect(sats).toBeLessThan(checked);
  // And the split must actually involve the rule under test — without this a
  // case whose unsat half came entirely from the court rule would read as
  // covering an instruction rule the encoder never stated.
  expect(instructionBreaches).toBeGreaterThan(0);
  return { checked, sats };
}

describe("encodeBuild — not_before / not_after", () => {
  it("refuses every slot whose wall clock is before not_before", async () => {
    const cfg = twoSession();
    const hard = [rule({ type: "not_before", time: "10:00", scope: { kind: "competition" } })];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard },
      fixtures: [fx("f1", "E1", "E2")],
      slots: 8,
    });
  }, 180_000);

  it("refuses every slot whose wall clock is after not_after", async () => {
    const cfg = twoSession();
    const hard = [rule({ type: "not_after", time: "10:00", scope: { kind: "competition" } })];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard },
      fixtures: [fx("f1", "E1", "E2")],
      slots: 8,
    });
  }, 180_000);

  it("binds EVERY fixture the scope covers, not only the one it probed", async () => {
    // The wall-clock verdict is resolved ONCE per (rule, slot) — it depends on
    // the slot and on scope, never on which scoped row is asked — and is then
    // applied to the whole scoped set. This is the case that makes that second
    // half load-bearing: with two scoped fixtures, an encoder that bound only
    // the row it probed leaves the other free to take a morning slot.
    const cfg = twoSession();
    const hard = [rule({ type: "not_before", time: "10:00", scope: { kind: "competition" } })];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard },
      fixtures: [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")],
      slots: 8,
    });
  }, 300_000);

  it("binds only the fixtures the rule's SCOPE covers", async () => {
    // f1 is in division DA and bound; f2 is in DB and free to take a morning
    // slot. A filter that ignored `scopeCoversFixture` and bound the whole board
    // would make the DB placements unsat, and the parity equality would catch it
    // placement by placement.
    const cfg = { ...twoSession(), courts: ["C1"] };
    const hard = [
      rule({ type: "not_before", time: "10:00", scope: { kind: "division", divisionId: "DA" } }),
    ];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard },
      fixtures: [fx("f1", "E1", "E2", { divisionId: "DA" }), fx("f2", "E3", "E4", { divisionId: "DB" })],
      slots: 4,
    });
  }, 300_000);

  it("reads the rule from the STORED stream too, not only `hard`", async () => {
    // `effectiveHard` merges `constraints.hard` with `hard`. An encoder reading
    // `config.hard` alone enforces a rule authored through the API on the board
    // and not in the solver — the fork this whole file exists to avoid.
    const cfg = twoSession();
    const verify: VerifyConfig = {
      ...cfg,
      constraints: {
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "off",
        parallelism: "mixed",
        crossPersonClash: "warn",
        hard: [rule({ type: "not_before", time: "10:00", scope: { kind: "competition" } })],
      },
    };
    await assertRuleParity({ cfg, verify, fixtures: [fx("f1", "E1", "E2")], slots: 8 });
  }, 180_000);

  it("is INERT without an org zone, exactly as the verifier is", async () => {
    // A wall-clock bound is meaningless without a zone, and bucketing in UTC
    // would report a violation the organiser never expressed (#448). The
    // verifier skips the whole block; so must the encoder, or the model refuses
    // boards the gate passes.
    const base = twoSession();
    const cfg: Cfg = { ...base, tz: undefined };
    const hard = [rule({ type: "not_before", time: "23:00", scope: { kind: "competition" } })];
    const verify: VerifyConfig = { ...cfg, hard };
    const grid = buildGrid({ config: cfg });
    const fixtures = [fx("f1", "E1", "E2")];

    const { Z3 } = await loadZ3();
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...verify, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
      });
      solver.add(model.place[0]![0]!);
      expect(await solver.check()).toBe("sat");
      expect(validateInstructionRules(model.assignmentsFrom([0]), verify, [])).toEqual([]);
    });
    await resetZ3();
  }, 120_000);
});

describe("encodeBuild — fixture_on_date / fixture_on_weekday", () => {
  it("refuses every slot outside the required DATE", async () => {
    const cfg = twoDay();
    const hard = [
      rule({
        type: "fixture_on_date",
        date: "2026-08-09",
        selector: { kind: "id", fixtureId: "f1" },
        scope: { kind: "competition" },
      }),
    ];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard, ruleFixtures: [rf("f1")] },
      fixtures: [fx("f1", "E1", "E2")],
      slots: 8,
    });
  }, 180_000);

  it("refuses every slot outside the required WEEKDAY", async () => {
    // 2026-08-08 is a Saturday and 2026-08-09 a Sunday, so a SUN rule splits
    // this lattice exactly in half.
    const cfg = twoDay();
    const hard = [
      rule({
        type: "fixture_on_weekday",
        weekday: "SUN",
        selector: { kind: "id", fixtureId: "f1" },
        scope: { kind: "competition" },
      }),
    ];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard, ruleFixtures: [rf("f1")] },
      fixtures: [fx("f1", "E1", "E2")],
      slots: 8,
    });
  }, 180_000);

  it("binds EVERY fixture the selector names, not only the first", async () => {
    // A `terminal` selector under a competition scope covers every division's
    // final — two fixtures here. An encoder that stopped at the first would
    // leave the second free of a rule the referee still enforces on it.
    const cfg = twoDay();
    const hard = [
      rule({
        type: "fixture_on_date",
        date: "2026-08-09",
        selector: { kind: "terminal" },
        scope: { kind: "competition" },
      }),
    ];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard, ruleFixtures: [rf("f1"), rf("f2")] },
      fixtures: [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")],
      slots: 8,
    });
  }, 300_000);

  it("binds only the fixtures the SELECTOR names", async () => {
    // The selector names f1 by id; f2 is a fixture of the same competition and
    // must stay free of the date rule. An encoder that applied the rule to every
    // scoped fixture rather than to `resolveSelector`'s answer would refuse
    // every Saturday placement of f2.
    const cfg = { ...twoDay(), courts: ["C1"] };
    const hard = [
      rule({
        type: "fixture_on_date",
        date: "2026-08-09",
        selector: { kind: "id", fixtureId: "f1" },
        scope: { kind: "competition" },
      }),
    ];
    await assertRuleParity({
      cfg,
      verify: { ...cfg, hard, ruleFixtures: [rf("f1"), rf("f2")] },
      fixtures: [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")],
      slots: 4,
    });
  }, 300_000);
});

describe("encodeBuild — max_fixtures_per_day", () => {
  it("caps the fixtures a calendar day may hold", async () => {
    // One start per (court, day), so the court rule cannot bind two fixtures at
    // all: every unsat verdict below is the cap's.
    const cfg = oneStartPerDay();
    const hard = [rule({ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } })];
    const out = await assertRuleParity({
      cfg,
      verify: { ...cfg, hard, ruleFixtures: [rf("f1"), rf("f2")] },
      fixtures: [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")],
      slots: 4,
    });
    // 4 slots, 2 fixtures: 12 ordered placements, of which the 8 that split
    // across the two days are legal.
    expect(out).toEqual({ checked: 12, sats: 8 });
  }, 300_000);

  it("counts only the fixtures the rule's SCOPE covers", async () => {
    // A DA-scoped 1/day cap says nothing about f2, so both may share Saturday.
    // Counting the whole board here would make that placement unsat.
    const cfg = oneStartPerDay();
    const hard = [
      rule({
        type: "max_fixtures_per_day",
        count: 1,
        scope: { kind: "division", divisionId: "DA" },
      }),
    ];
    const fixtures = [
      fx("f1", "E1", "E2", { divisionId: "DA" }),
      fx("f2", "E3", "E4", { divisionId: "DB" }),
    ];
    const verify: VerifyConfig = {
      ...cfg,
      hard,
      ruleFixtures: [rf("f1", { divisionId: "DA" }), rf("f2", { divisionId: "DB" })],
    };
    const { Z3 } = await loadZ3();
    const grid = buildGrid({ config: cfg });
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...verify, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
      });
      const pick = [slotAt(grid, "C1", D1), slotAt(grid, "C2", D1)];
      pick.forEach((s, i) => solver.add(model.place[i]![s]!));
      expect(await solver.check()).toBe("sat");
      expect(validateInstructionRules(model.assignmentsFrom(pick), verify, [])).toEqual([]);
    });
    await resetZ3();
  }, 120_000);

  it("seeds the cap from the IMMOVABLE fixtures already on that day", async () => {
    // A cap is a statement about how busy a day is, and a day is exactly as busy
    // as everything already on it. `sib` is a known fixture on Saturday, so a
    // 1/day cap leaves Saturday full and the only legal slots are Sunday's.
    const cfg = oneStartPerDay();
    const existing: Assignment[] = [
      {
        fixtureId: "sib",
        court: "C2",
        startAt: D1,
        endAt: D1 + 30 * MIN,
        entrants: ["E9"],
        people: [],
      },
    ];
    const hard = [rule({ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } })];
    const out = await assertRuleParity({
      cfg,
      verify: { ...cfg, hard, ruleFixtures: [rf("f1"), rf("sib")] },
      fixtures: [fx("f1", "E1", "E2")],
      existing,
      slots: 3,
    });
    // The sibling's court time removes C2/Saturday from the lattice; of the
    // three that remain only the two Sunday slots survive the cap.
    expect(out).toEqual({ checked: 3, sats: 2 });
  }, 180_000);

  it("does NOT count an immovable row that is not a known fixture", async () => {
    // Identical board, except `sib` is absent from `ruleFixtures` — an outside
    // booking or a closed court, not a fixture. Counting one would invent a cap
    // breach out of a blackout and refuse a Saturday the organiser never closed.
    const cfg = oneStartPerDay();
    const existing: Assignment[] = [
      {
        fixtureId: "sib",
        court: "C2",
        startAt: D1,
        endAt: D1 + 30 * MIN,
        entrants: ["E9"],
        people: [],
      },
    ];
    const hard = [rule({ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } })];
    const verify: VerifyConfig = { ...cfg, hard, ruleFixtures: [rf("f1")] };
    const grid = buildGrid({ config: cfg, existing });
    expect(grid.slots.length).toBe(3);
    const fixtures = [fx("f1", "E1", "E2")];

    const { Z3 } = await loadZ3();
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...verify, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
        existing,
      });
      const s = slotAt(grid, "C1", D1);
      solver.add(model.place[0]![s]!);
      expect(await solver.check()).toBe("sat");
      expect(validateInstructionRules(model.assignmentsFrom([s]), verify, existing)).toEqual([]);
    });
    await resetZ3();
  }, 120_000);

  it("is INERT without an org zone, exactly as the verifier is", async () => {
    const base = oneStartPerDay();
    const cfg: Cfg = { ...base, tz: undefined };
    const hard = [rule({ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } })];
    const verify: VerifyConfig = { ...cfg, hard, ruleFixtures: [rf("f1"), rf("f2")] };
    const grid = buildGrid({ config: cfg });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E3", "E4")];

    const { Z3 } = await loadZ3();
    await withZ3Lock(async () => {
      const solver = new Z3.Solver();
      const model = encodeBuild({
        Z3,
        solver,
        fixtures,
        grid,
        config: { ...verify, matchMinutes: cfg.matchMinutes, courts: cfg.courts },
      });
      // Both on the same calendar day, which a zoned 1/day cap would refuse.
      const pick = [slotAt(grid, "C1", D1), slotAt(grid, "C2", D1)];
      pick.forEach((s, i) => solver.add(model.place[i]![s]!));
      expect(await solver.check()).toBe("sat");
      expect(validateInstructionRules(model.assignmentsFrom(pick), verify, [])).toEqual([]);
    });
    await resetZ3();
  }, 120_000);
});
