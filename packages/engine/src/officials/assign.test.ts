// Goldens + rule units for assignOfficials (Jul3/02 §3, PROMPT-22 acceptance).
import { describe, expect, it } from "vitest";
import { assignOfficials } from "./assign.ts";
import { resolveOfficialSourcing } from "./source.ts";
import { AssignPolicy, type OfficialFixture, type OfficialSpec } from "./types.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 4, 9, 0, 0);

function fixture(
  id: string,
  slot: number,
  court: string,
  entrants: string[] = [],
  extra: Partial<OfficialFixture> = {},
): OfficialFixture {
  return {
    id,
    startAt: T0 + slot * 30 * MIN,
    endAt: T0 + (slot + 1) * 30 * MIN,
    court,
    entrants,
    ...extra,
  };
}

function official(id: string, extra: Partial<OfficialSpec> = {}): OfficialSpec {
  return { id, roleKeys: ["referee"], ...extra };
}

const POLICY = AssignPolicy.parse({ roles: ["referee"] });

describe("assignOfficials golden (Jul3/02 §3)", () => {
  it("24 fixtures, 2 courts, 6 officials, block-stay: one court per official, spread ≤ 1", () => {
    const fixtures: OfficialFixture[] = [];
    for (let slot = 0; slot < 12; slot++) {
      fixtures.push(fixture(`c1-${String(slot).padStart(2, "0")}`, slot, "Court 1"));
      fixtures.push(fixture(`c2-${String(slot).padStart(2, "0")}`, slot, "Court 2"));
    }
    const officials = ["o1", "o2", "o3", "o4", "o5", "o6"].map((id) => official(id));
    const { assignments, conflicts } = assignOfficials({
      fixtures,
      officials,
      locked: [],
      policy: AssignPolicy.parse({ roles: ["referee"], blockStay: true }),
      rngSeed: "golden-24",
      tz: "UTC",
    });
    expect(assignments).toHaveLength(24);
    expect(conflicts).toEqual([]); // full coverage, spread ≤ 1 → no warns

    const byOfficial = new Map<string, string[]>();
    for (const a of assignments) {
      const court = a.fixtureId.startsWith("c1") ? "Court 1" : "Court 2";
      const list = byOfficial.get(a.officialId) ?? [];
      list.push(court);
      byOfficial.set(a.officialId, list);
    }
    // fairness: 24 / 6 = 4 each
    for (const courts of byOfficial.values()) expect(courts).toHaveLength(4);
    // block-stay: within the single contiguous block each official stays put
    for (const courts of byOfficial.values()) {
      expect(new Set(courts).size).toBe(1);
    }
  });

  it("phased sourcing: Phase-2 officials resolve only after Phase-1 decided (17 Jun)", () => {
    const sources = [
      { kind: "rank" as const, fromStage: "s1", take: [{ poolId: "pG", rank: 4 }] },
      { kind: "result" as const, fromFixture: "f9", side: "winner" as const },
    ];
    const before = resolveOfficialSourcing(sources, {
      standings: [{ stageId: "s1", poolId: "pG", rows: [], decided: false }],
      fixtures: [{ id: "f9", decided: false }],
    });
    expect(before.resolved).toEqual([]);
    expect(before.pending).toHaveLength(2);

    const after = resolveOfficialSourcing(sources, {
      standings: [
        {
          stageId: "s1",
          poolId: "pG",
          decided: true,
          rows: [
            { entrantId: "e1", rank: 1 },
            { entrantId: "e2", rank: 2 },
            { entrantId: "e3", rank: 3 },
            { entrantId: "e4", rank: 4 },
          ],
        },
      ],
      fixtures: [{ id: "f9", decided: true, winnerId: "e7", loserId: "e8" }],
    });
    expect(after.pending).toEqual([]);
    expect(after.resolved.map((r) => r.entrantId)).toEqual(["e4", "e7"]);
  });

  it("withdrawn entrants drop from the sourcing pool (Jul3/02 §6)", () => {
    const result = resolveOfficialSourcing(
      [{ kind: "result", fromFixture: "f1", side: "loser" }],
      {
        standings: [],
        fixtures: [{ id: "f1", decided: true, winnerId: "e1", loserId: "e2" }],
        withdrawnEntrantIds: ["e2"],
      },
    );
    expect(result.resolved).toEqual([]);
    expect(result.pending).toEqual([
      expect.objectContaining({ reason: "entrant withdrawn" }),
    ]);
  });
});

describe("assignOfficials rules", () => {
  it("team-as-referee never officiates its own fixture", () => {
    const { assignments, conflicts } = assignOfficials({
      fixtures: [fixture("f1", 0, "C", ["eA", "eB"])],
      officials: [official("refA", { entrantIds: ["eA"] })],
      locked: [],
      policy: POLICY,
      rngSeed: "s",
      tz: "UTC",
    });
    expect(assignments).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "role_unfilled", severity: "block", fixtureId: "f1" }),
    ]);
  });

  it("an official never refs while their team plays in parallel", () => {
    const { assignments } = assignOfficials({
      fixtures: [
        fixture("plays", 0, "C1", ["eA", "eB"]),
        fixture("refs?", 0, "C2", ["eC", "eD"]),
      ],
      officials: [official("refA", { entrantIds: ["eA"] })],
      locked: [],
      policy: POLICY,
      rngSeed: "s",
      tz: "UTC",
    });
    expect(assignments).toEqual([]); // parallel slot → busy playing
  });

  it("poolLock keeps officials in their home pool; unlocked pool officials float", () => {
    const fixtures = [
      fixture("g1", 0, "C1", [], { poolId: "poolA" }),
      fixture("g2", 0, "C2", [], { poolId: "poolB" }),
    ];
    const { assignments, conflicts } = assignOfficials({
      fixtures,
      officials: [
        official("homerA", { homePoolId: "poolA" }),
        official("floater"),
      ],
      locked: [],
      policy: AssignPolicy.parse({ roles: ["referee"], poolLock: true }),
      rngSeed: "s",
      tz: "UTC",
    });
    expect(conflicts).toEqual([]);
    const byFixture = new Map(assignments.map((a) => [a.fixtureId, a.officialId]));
    expect(byFixture.get("g1")).toBe("homerA");
    expect(byFixture.get("g2")).toBe("floater");
  });

  it("locked assignments are obstacles: overlap with a lock is refused", () => {
    const fixtures = [fixture("f1", 0, "C1"), fixture("f2", 0, "C2")];
    const { assignments, conflicts } = assignOfficials({
      fixtures,
      officials: [official("only")],
      locked: [{ fixtureId: "f1", officialId: "only", roleKey: "referee", locked: true }],
      policy: POLICY,
      rngSeed: "s",
      tz: "UTC",
    });
    expect(assignments).toEqual([
      { fixtureId: "f1", officialId: "only", roleKey: "referee", locked: true },
    ]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "role_unfilled", fixtureId: "f2" }),
    ]);
  });

  it("maxPerDay caps a single official's load", () => {
    const fixtures = [0, 1, 2].map((slot) => fixture(`f${slot}`, slot, "C"));
    const { assignments, conflicts } = assignOfficials({
      fixtures,
      officials: [official("capped", { maxPerDay: 2 })],
      locked: [],
      policy: POLICY,
      rngSeed: "s",
      tz: "UTC",
    });
    expect(assignments).toHaveLength(2);
    expect(conflicts).toContainEqual(
      expect.objectContaining({ kind: "role_unfilled", fixtureId: "f2" }),
    );
  });

  it("multi-role coverage: judge + referee both filled per fixture (25 Dec)", () => {
    const { assignments } = assignOfficials({
      fixtures: [fixture("f1", 0, "C")],
      officials: [
        official("ref", { roleKeys: ["referee"] }),
        official("judge", { roleKeys: ["judge"] }),
      ],
      locked: [],
      policy: AssignPolicy.parse({ roles: ["referee", "judge"] }),
      rngSeed: "s",
      tz: "UTC",
    });
    expect(assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ officialId: "ref", roleKey: "referee" }),
        expect.objectContaining({ officialId: "judge", roleKey: "judge" }),
      ]),
    );
  });

  it("maxPerDay counts the ORG calendar day, not the UTC day (#448)", () => {
    // One local Saturday in America/Los_Angeles (PDT, UTC-7). The evening pair
    // is already Sunday in UTC, which is exactly what used to double the cap.
    const at = (hhmm: string): number => Date.parse(`2026-07-04T${hhmm}:00-07:00`);
    const fixtures: OfficialFixture[] = ["10:00", "12:00", "18:00", "20:00"].map((t, i) => ({
      id: `sat-${t}`,
      startAt: at(t),
      endAt: at(t) + 30 * MIN,
      court: "C1",
      entrants: [`e${i}a`, `e${i}b`],
    }));
    // Guard the guard: the last two really are a different UTC day, so a UTC
    // bucket sees 2 + 2 and this test cannot pass by accident.
    expect(fixtures.map((f) => new Date(f.startAt).toISOString().slice(0, 10))).toEqual([
      "2026-07-04",
      "2026-07-04",
      "2026-07-05",
      "2026-07-05",
    ]);

    const { assignments, conflicts } = assignOfficials({
      fixtures,
      officials: [official("capped", { maxPerDay: 2 })],
      locked: [],
      policy: POLICY,
      rngSeed: "s",
      tz: "America/Los_Angeles",
    });

    expect(assignments).toHaveLength(2);
    expect(assignments.map((a) => a.fixtureId)).toEqual(["sat-10:00", "sat-12:00"]);
    for (const id of ["sat-18:00", "sat-20:00"]) {
      expect(conflicts).toContainEqual(
        expect.objectContaining({ kind: "role_unfilled", severity: "block", fixtureId: id }),
      );
    }
  });

  it("per_day fairness buckets on the ORG calendar day (#448)", () => {
    // Four fixtures on ONE local Saturday straddling UTC midnight. o2 plays in
    // both evening fixtures, so o1 must take them: the load ends 3/1 and the
    // spread warning names the basis it was measured in. Bucketing on UTC
    // splits that into two bases and reports the spread against 07-05.
    const at = (hhmm: string): number => Date.parse(`2026-07-04T${hhmm}:00-07:00`);
    const mk = (t: string, entrants: string[]): OfficialFixture => ({
      id: `sat-${t}`,
      startAt: at(t),
      endAt: at(t) + 30 * MIN,
      court: "C1",
      entrants,
    });
    const fixtures = [
      mk("10:00", ["eX", "eY"]),
      mk("12:00", ["eX", "eY"]),
      mk("18:00", ["ePlay", "eY"]),
      mk("20:00", ["ePlay", "eY"]),
    ];
    const { assignments, conflicts } = assignOfficials({
      fixtures,
      officials: [official("o1"), official("o2", { entrantIds: ["ePlay"] })],
      locked: [],
      policy: AssignPolicy.parse({ roles: ["referee"], fairness: "per_day" }),
      rngSeed: "s",
      tz: "America/Los_Angeles",
    });
    expect(assignments).toHaveLength(4);
    const perOfficial = new Map<string, number>();
    for (const a of assignments) {
      perOfficial.set(a.officialId, (perOfficial.get(a.officialId) ?? 0) + 1);
    }
    expect(perOfficial.get("o1")).toBe(3);
    expect(perOfficial.get("o2")).toBe(1);
    // ONE basis for the whole local day, and it is the LOCAL date — under a UTC
    // bucket this is two bases and the warning would name 2026-07-05.
    expect(conflicts.filter((c) => c.kind === "fairness")).toEqual([
      expect.objectContaining({
        kind: "fairness",
        severity: "warn",
        detail: "assignment spread 2 within basis 2026-07-04",
      }),
    ]);
  });

  it("teamRefKeepDivision: same-division team-ref preferred; leaving warns", () => {
    const fixtures = [
      fixture("own", 0, "C1", [], { divisionId: "d1" }),
      fixture("far", 1, "C1", [], { divisionId: "d2" }),
    ];
    const { assignments, conflicts } = assignOfficials({
      fixtures,
      officials: [official("teamref", { homeDivisionId: "d1" })],
      locked: [],
      policy: AssignPolicy.parse({ roles: ["referee"], teamRefKeepDivision: true }),
      rngSeed: "s",
      tz: "UTC",
    });
    expect(assignments).toHaveLength(2);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "travel", severity: "warn", fixtureId: "far" }),
    ]);
  });
});
