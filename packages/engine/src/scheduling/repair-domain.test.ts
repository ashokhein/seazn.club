import { describe, expect, it } from "vitest";
import {
  pairRestMinutes,
  pairRestMinutesFor,
  type Assignment,
  type VerifyConfig,
} from "./calendar.ts";
import {
  buildDomains,
  calendarDaysCovering,
  candidatePairs,
  dayBuckets,
  maxSeparationMinutes,
  type FixtureDomain,
} from "./repair-domain.ts";
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

  it("splits a session that crosses local midnight at the org zone's midnight", () => {
    // 22:00 Monday → 02:00 Tuesday, London. Labelled whole, the four hours after
    // midnight wear Monday's date and every day-shaped instruction reads them as
    // Monday's — which the verifier, which asks `dayKeyInTz(startAt)`, does not.
    const buckets = dayBuckets({
      tz: "Europe/London",
      sessionWindows: [{ from: at("2026-08-10T21:00:00Z"), to: at("2026-08-11T01:00:00Z") }],
    });
    expect(buckets.map((b) => b.ymd)).toEqual(["2026-08-10", "2026-08-11"]);
    expect(buckets[0]!.from).toBe(at("2026-08-10T21:00:00Z"));
    expect(buckets[0]!.to).toBe(at("2026-08-10T23:00:00Z")); // local midnight
    expect(buckets[1]!.from).toBe(at("2026-08-10T23:00:00Z"));
    expect(buckets[1]!.to).toBe(at("2026-08-11T01:00:00Z"));
  });

  it("keeps the split on the org's midnight across the DST fall-back", () => {
    // 2026-10-25 is the European fall-back: that London day is 25 hours, and the
    // session runs from the evening before into it. A fixed 86_400_000 step would
    // put the boundary an hour early.
    const buckets = dayBuckets({
      tz: "Europe/London",
      sessionWindows: [
        { from: at("2026-10-24T21:00:00+01:00"), to: at("2026-10-26T00:00:00Z") },
      ],
    });
    expect(buckets.map((b) => b.ymd)).toEqual(["2026-10-24", "2026-10-25"]);
    expect(buckets[0]!.to).toBe(at("2026-10-24T23:00:00Z")); // 00:00 BST
    expect(buckets[1]!.to - buckets[1]!.from).toBe(25 * H); // the fall-back day
  });

  it("leaves a session unsplit when there is no zone to split it by", () => {
    const from = at("2026-08-10T21:00:00Z");
    const buckets = dayBuckets({ sessionWindows: [{ from, to: from + 4 * H }] });
    expect(buckets).toEqual([{ ymd: "", from, to: from + 4 * H }]);
  });
});

describe("calendarDaysCovering", () => {
  it("returns WHOLE days that tile the range with no clipping and no gap", () => {
    // Mid-morning both ends — precisely what `dayBuckets` would have clipped, and
    // what let a start in the cut-off remainder be counted by no day literal.
    const range = { from: at("2026-08-10T09:00:00Z"), to: at("2026-08-12T15:30:00Z") };
    const days = calendarDaysCovering(range, "UTC");
    // One day of padding at each end, because the solver's bound on a start is
    // applied in whole MINUTES and can sit just outside the range.
    expect(days.map((d) => d.ymd)).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
    ]);
    expect(days[0]!.from).toBe(at("2026-08-09T00:00:00Z"));
    expect(days.at(-1)!.to).toBe(at("2026-08-14T00:00:00Z"));
    for (let i = 1; i < days.length; i++) expect(days[i]!.from).toBe(days[i - 1]!.to);
    // Covering means covering: nothing in the range falls between two days.
    expect(days[0]!.from).toBeLessThanOrEqual(range.from);
    expect(days.at(-1)!.to).toBeGreaterThan(range.to);
  });

  it("keeps the org zone's midnights, so the DST fall-back day is 25 hours", () => {
    const days = calendarDaysCovering(
      { from: at("2026-10-25T05:00:00Z"), to: at("2026-10-25T06:00:00Z") },
      "Europe/London",
    );
    const dst = days.find((d) => d.ymd === "2026-10-25")!;
    expect(dst.to - dst.from).toBe(25 * H);
    expect(dst.from).toBe(at("2026-10-24T23:00:00Z"));
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
  // Hand-built rather than round-tripped through `buildDomains`, because the
  // thing under test is the pruning predicate and the spans it reads. A domain
  // built from a config would have to manufacture the geometry through a rule,
  // and the only families that can legally narrow a span are the blocking ones.
  const day = at("2026-08-10T09:00:00Z");
  const domain = (fixtureId: string, from: number, to: number): FixtureDomain => ({
    fixtureId,
    durationMs: 40 * MIN,
    origStartAt: from,
    origCourt: "C1",
    byFamily: {},
    courtsByFamily: {},
    courtIntervals: {},
    empty: [],
    span: { from, to },
  });

  it("prunes a pair that can neither overlap nor crowd the other", () => {
    // a occupies [09:00, 09:40]; b cannot start before 10:00. No separation is
    // owed, so nothing connects them.
    const domains = [domain("a", day, day), domain("b", day + 60 * MIN, day + 60 * MIN)];
    expect(candidatePairs(domains)).toEqual([]);
  });

  it("keeps a pair that can still collide", () => {
    const domains = [domain("a", day, day + 4 * H), domain("b", day, day + 4 * H)];
    expect(candidatePairs(domains)).toEqual([[0, 1]]);
  });

  // The pruner tested OCCUPANCY overlap only, while the constraint it prunes
  // away is separation: a pair 20 minutes apart that owes 45 minutes of rest
  // does not overlap and was dropped, so the encoder never bounded it and the
  // verifier then rejected the "repaired" board.
  it("keeps a pair that owes more separation than the gap between their domains", () => {
    const domains = [domain("a", day, day), domain("b", day + 60 * MIN, day + 60 * MIN)];
    expect(candidatePairs(domains, 0)).toEqual([]);
    expect(candidatePairs(domains, 45 * MIN)).toEqual([[0, 1]]);
  });

  // A relaxable family emptying a domain is the C1 regression at unit level:
  // `instruction` is dropped whole on the fallback path, so a `null` span is a
  // reason to encode the pair, never to drop it.
  it("keeps every pair a null-span fixture is party to", () => {
    const domains = [
      { ...domain("a", day, day), span: null },
      domain("b", day + 60 * MIN, day + 60 * MIN),
    ];
    expect(candidatePairs(domains)).toEqual([[0, 1]]);
  });

  // Same regression from the other end: the span must not narrow when a
  // relaxable family does. Two fixtures pinned to different days by an
  // instruction still owe each other a court, because the instruction is exactly
  // what the fallback path drops.
  it("does not let an instruction-pinned pair be pruned", () => {
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
    // The instruction still narrows the DOMAIN — it just no longer narrows the
    // span the pruner reads.
    expect(domains[0]!.byFamily.instruction).toHaveLength(1);
    expect(candidatePairs(domains)).toEqual([[0, 1]]);
  });
});

describe("maxSeparationMinutes", () => {
  it("takes the strictest of every source a pair can draw on", () => {
    expect(
      maxSeparationMinutes({
        ...BASE_CONFIG,
        gapMinutes: 5,
        perEntrantMinRest: 10,
        constraints: {
          restMin: 20,
          restByGroup: { "pool-a": 35, d2: 15 },
          noBackToBack: false,
          startWindows: [],
          fieldFairness: "off",
          parallelism: "mixed",
          crossPersonClash: "warn",
        },
        restByDivision: { d1: 50 },
        hard: [
          {
            type: "min_rest_minutes",
            minutes: 75,
            rest_scope: "per_person",
            scope: { kind: "competition" },
          },
        ],
      }),
    ).toBe(75);
  });

  it("counts noBackToBack, which is a whole fixture plus the turnaround", () => {
    expect(
      maxSeparationMinutes({
        ...BASE_CONFIG,
        matchMinutes: 40,
        gapMinutes: 5,
        constraints: {
          noBackToBack: true,
          startWindows: [],
          fieldFairness: "off",
          parallelism: "mixed",
          crossPersonClash: "warn",
        },
      }),
    ).toBe(45);
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
