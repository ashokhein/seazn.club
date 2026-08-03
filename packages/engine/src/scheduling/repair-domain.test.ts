import { describe, expect, it } from "vitest";
import {
  pairRestMinutes,
  pairRestMinutesFor,
  type Assignment,
  type VerifyConfig,
} from "./calendar.ts";
import { buildDomains, candidatePairs, dayBuckets } from "./repair-domain.ts";
import { assign, at, BADMINTON, BASE_CONFIG, SOLO } from "./payload-fixtures.ts";

const H = 3_600_000;
const MIN = 60_000;

describe("dayBuckets", () => {
  it("walks calendar days in the org zone, not by adding 86_400_000", () => {
    // 2026-10-25 is the European DST fall-back: that London day is 25 hours.
    const buckets = dayBuckets({
      tz: "Europe/London",
      window: { from: at("2026-10-24T00:00:00+01:00"), to: at("2026-10-27T00:00:00Z") },
    });
    expect(buckets.map((b) => b.ymd)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    const dst = buckets.find((b) => b.ymd === "2026-10-25")!;
    expect(dst.to - dst.from).toBe(25 * H);
  });

  it("prefers explicit session windows, which are absolute instants", () => {
    const from = at("2026-08-10T09:00:00Z");
    const buckets = dayBuckets({
      tz: "Europe/London",
      sessionWindows: [{ from, to: from + 8 * H }],
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.from).toBe(from);
  });
});

describe("buildDomains", () => {
  const courts = ["C1", "C2"];
  const window = { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-17T08:00:00Z") };
  const proposal = assign(BADMINTON, SOLO, [
    ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
    ["wb-r0-i2", "2026-08-10T09:00:00Z", "C1"],
  ]);

  it("bounds the START so the whole occupancy fits the window", () => {
    const [d] = buildDomains({ proposal, config: { ...BASE_CONFIG, tz: "UTC", window, courts } });
    const last = d!.byFamily.window!.at(-1)!;
    expect(last.to).toBe(window.to - d!.durationMs);
  });

  it("a fixture_on_date rule collapses the domain to that one day", () => {
    const domains = buildDomains({
      proposal,
      config: {
        ...BASE_CONFIG,
        tz: "UTC",
        window,
        courts,
        ruleFixtures: [{ id: "wb-r0-i1", extKey: "wb-r0-i1", winnerTo: "wb-r1-i1" }],
        hard: [
          {
            type: "fixture_on_date",
            date: "2026-08-12",
            selector: { kind: "id", fixtureId: "wb-r0-i1" },
            scope: { kind: "competition" },
          },
        ],
      },
    });
    const inst = domains[0]!.byFamily.instruction!;
    expect(inst).toHaveLength(1);
    expect(new Date(inst[0]!.from).toISOString().slice(0, 10)).toBe("2026-08-12");
    // The fixture the rule does not name is left unconstrained by that family.
    expect(domains[1]!.byFamily.instruction).toBeUndefined();
  });

  it("not_before clips every day, in the org zone", () => {
    const domains = buildDomains({
      proposal,
      config: {
        ...BASE_CONFIG,
        tz: "America/New_York",
        window,
        courts,
        hard: [{ type: "not_before", time: "10:00", scope: { kind: "competition" } }],
      },
    });
    const intervals = domains[0]!.byFamily.instruction!;
    expect(intervals.length).toBeGreaterThan(1);
    for (const iv of intervals) {
      expect(new Date(iv.from).toISOString()).toMatch(/T14:00:00/); // 10:00 EDT
    }
  });

  it("a court blackout narrows the courts, not the times", () => {
    const domains = buildDomains({
      proposal,
      config: {
        ...BASE_CONFIG,
        tz: "UTC",
        window,
        courts,
        blackouts: [{ court: "C2", from: window.from, to: window.to }],
      },
    });
    expect(domains[0]!.courtsByFamily.blackout).toEqual(["C1"]);
    expect(domains[0]!.courtIntervals.C2).toEqual([]);
    expect(domains[0]!.courtIntervals.C1!.length).toBeGreaterThan(0);
  });

  it("reports an empty domain by family rather than handing z3 an unsat it cannot explain", () => {
    const domains = buildDomains({
      proposal,
      config: {
        ...BASE_CONFIG,
        tz: "UTC",
        courts,
        window: { from: window.from, to: window.from + 10 * MIN }, // shorter than a match
      },
    });
    expect(domains[0]!.empty).toContain("window");
  });

  it("sorts by fixtureId, because determinism starts before z3 sees anything", () => {
    const reversed = [...proposal].reverse();
    const domains = buildDomains({
      proposal: reversed,
      config: { ...BASE_CONFIG, tz: "UTC", window, courts },
    });
    expect(domains.map((d) => d.fixtureId)).toEqual(["wb-r0-i1", "wb-r0-i2"]);
  });
});

describe("candidatePairs", () => {
  it("prunes pairs whose domains cannot intersect", () => {
    const window = { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-17T08:00:00Z") };
    const proposal = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
      ["wb-r0-i2", "2026-08-11T09:00:00Z", "C1"],
    ]);
    const domains = buildDomains({
      proposal,
      config: {
        ...BASE_CONFIG,
        tz: "UTC",
        window,
        courts: ["C1"],
        ruleFixtures: [
          { id: "wb-r0-i1", extKey: "wb-r0-i1", winnerTo: "x" },
          { id: "wb-r0-i2", extKey: "wb-r0-i2", winnerTo: "y" },
        ],
        hard: [
          {
            type: "fixture_on_date",
            date: "2026-08-10",
            selector: { kind: "id", fixtureId: "wb-r0-i1" },
            scope: { kind: "competition" },
          },
          {
            type: "fixture_on_date",
            date: "2026-08-12",
            selector: { kind: "id", fixtureId: "wb-r0-i2" },
            scope: { kind: "competition" },
          },
        ],
      },
    });
    expect(candidatePairs(domains)).toEqual([]); // pinned to different days
  });

  it("keeps a pair that can still collide", () => {
    const window = { from: at("2026-08-10T08:00:00Z"), to: at("2026-08-11T08:00:00Z") };
    const proposal = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
      ["wb-r0-i2", "2026-08-10T09:00:00Z", "C1"],
    ]);
    const domains = buildDomains({
      proposal,
      config: { ...BASE_CONFIG, tz: "UTC", window, courts: ["C1"] },
    });
    expect(candidatePairs(domains)).toEqual([[0, 1]]);
  });
});

// Lives beside the domain builder rather than in `calendar.test.ts` because it
// exists FOR the solver: the encoder must not call `pairRestMinutes` inside its
// O(n²) pair loop (the wrapper re-derives `effectiveHard` and the ruleFixtures
// index per call — 47 ms → 5242 ms on a 500-fixture board), and the hoisted
// factory is only safe if it answers identically.
describe("pairRestMinutesFor", () => {
  const start = at("2026-08-10T09:00:00Z");
  const card = (
    fixtureId: string,
    entrant: string,
    poolId: string | undefined,
    divisionId: string,
  ): Assignment => ({
    fixtureId,
    court: "C1",
    startAt: start,
    endAt: start + 40 * MIN,
    entrants: [entrant],
    people: ["p-shared"],
    poolId,
    divisionId,
  });

  const a1 = card("f1", "e1", "pool-a", "d1");
  const a2 = card("f2", "e2", "pool-b", "d2");
  const a3 = card("f3", "e3", undefined, "d3");

  const config: VerifyConfig = {
    perEntrantMinRest: 10,
    gapMinutes: 0,
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restByGroup: { "pool-a": 30, d2: 55 },
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
    },
    restByDivision: { d1: 20, d2: 45 },
    ruleFixtures: [
      { id: "f1", extKey: "f1", divisionId: "d1", poolId: "pool-a", winnerTo: "x" },
      { id: "f2", extKey: "f2", divisionId: "d2", poolId: "pool-b", winnerTo: null },
      { id: "f3", extKey: "f3", divisionId: "d3", winnerTo: null },
    ],
    hard: [
      {
        type: "min_rest_minutes",
        minutes: 40,
        rest_scope: "per_person",
        scope: { kind: "pool", divisionId: "d1", pool: "pool-a" },
      },
    ],
  };

  it("agrees with the plain wrapper across restByGroup, a scoped rule and restByDivision", () => {
    const pairRest = pairRestMinutesFor(config);
    for (const [a, other] of [
      [a1, a2],
      [a2, a1],
      [a1, a3],
      [a3, a1],
      [a2, a3],
      [a3, a2],
    ] as const) {
      expect(pairRest(a, other)).toBe(pairRestMinutes(config, a, other));
    }
  });

  it("pins each source, and stays asymmetric", () => {
    const pairRest = pairRestMinutesFor(config);
    expect(pairRest(a1, a2)).toBe(45); // restByDivision[d2]
    expect(pairRest(a2, a1)).toBe(55); // restByGroup[d2] via a2's own division
    expect(pairRest(a1, a3)).toBe(40); // the pool-scoped min_rest_minutes rule
    expect(pairRest(a3, a2)).toBe(45); // restByDivision[d2], a3 contributes nothing
  });
});
