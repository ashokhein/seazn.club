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
    });
    expect(assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ officialId: "ref", roleKey: "referee" }),
        expect.objectContaining({ officialId: "judge", roleKey: "judge" }),
      ]),
    );
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
    });
    expect(assignments).toHaveLength(2);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "travel", severity: "warn", fixtureId: "far" }),
    ]);
  });
});
