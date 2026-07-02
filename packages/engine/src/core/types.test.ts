// Shared primitive schemas — spec 03 §3, spec 02 §2/§3/§5/§7.
import { describe, expect, it } from "vitest";
import {
  EntrantId,
  LineupPair,
  MatchOutcome,
  MetricSpec,
  ScoreSummary,
  StageCtx,
  StageKind,
  StandingsDelta,
} from "./types.ts";

describe("MatchOutcome", () => {
  // spec 03 §3 — all five kinds
  it.each([
    [{ kind: "win", winner: "H", loser: "A", method: "shootout" }],
    [{ kind: "win", winner: "H", loser: "A" }],
    [{ kind: "draw" }],
    [{ kind: "tie" }],
    [{ kind: "no_result" }],
    [{ kind: "award", winner: "A", score: { goals: [3, 0] } }],
    [{ kind: "award", winner: "A" }],
  ])("accepts %j", (outcome) => {
    expect(MatchOutcome.parse(outcome)).toEqual(outcome);
  });

  it("rejects unknown kinds and missing fields", () => {
    expect(MatchOutcome.safeParse({ kind: "loss" }).success).toBe(false);
    expect(MatchOutcome.safeParse({ kind: "win", winner: "H" }).success).toBe(false);
    expect(MatchOutcome.safeParse({ kind: "award" }).success).toBe(false);
  });
});

describe("StageKind / StageCtx", () => {
  it("accepts the six stage kinds of spec 02 §5", () => {
    for (const kind of ["league", "group", "swiss", "knockout", "double_elim", "stepladder"]) {
      expect(StageKind.parse(kind)).toBe(kind);
    }
    expect(StageKind.safeParse("round_robin").success).toBe(false);
  });

  it("StageCtx carries kind plus optional pool/round", () => {
    expect(StageCtx.parse({ kind: "group", poolId: "A", roundNo: 3 })).toEqual({
      kind: "group",
      poolId: "A",
      roundNo: 3,
    });
    expect(StageCtx.parse({ kind: "knockout" })).toEqual({ kind: "knockout" });
    expect(StageCtx.safeParse({ kind: "knockout", roundNo: 0 }).success).toBe(false);
  });
});

describe("ScoreSummary", () => {
  it("is render-agnostic: headline + per-side lines + opaque detail", () => {
    const summary = {
      headline: "252/8 (50) — 253/4 (48.2)",
      perSide: [
        { entrantId: "H", line: "252/8 (50)" },
        { entrantId: "A", line: "253/4 (48.2)" },
      ],
      detail: { innings: 2 },
    };
    expect(ScoreSummary.parse(summary)).toEqual(summary);
    expect(ScoreSummary.safeParse({ headline: "3–1" }).success).toBe(false);
  });
});

describe("StandingsDelta", () => {
  it("carries counts, points and a numeric sport-metric ledger (spec 02 §7)", () => {
    const delta = {
      entrantId: "H",
      played: 1,
      won: 1,
      drawn: 0,
      lost: 0,
      points: 3,
      metrics: { gf: 2, ga: 0, gd: 2 },
    };
    expect(StandingsDelta.parse(delta)).toEqual(delta);
    expect(StandingsDelta.safeParse({ ...delta, played: -1 }).success).toBe(false);
    expect(StandingsDelta.safeParse({ ...delta, metrics: { gd: "two" } }).success).toBe(false);
  });
});

describe("MetricSpec", () => {
  it("declares a sport ledger field with sort direction", () => {
    const spec = { key: "nrr", label: "Net run rate", direction: "desc", decimals: 3 };
    expect(MetricSpec.parse(spec)).toEqual(spec);
    expect(MetricSpec.safeParse({ ...spec, direction: "up" }).success).toBe(false);
  });
});

describe("LineupPair", () => {
  it("validates per-side lineups with ordered slots (spec 02 §3)", () => {
    const pair = {
      home: {
        entrantId: "H",
        slots: [
          { personId: "p1", positionKey: "GK", slot: "starting", orderNo: 1 },
          { personId: "p2", slot: "bench", orderNo: 2 },
        ],
      },
      away: { entrantId: "A", slots: [] },
    };
    expect(LineupPair.parse(pair)).toEqual(pair);
    expect(
      LineupPair.safeParse({
        ...pair,
        home: { entrantId: "H", slots: [{ personId: "", slot: "starting", orderNo: 1 }] },
      }).success,
    ).toBe(false);
  });

  it("EntrantId must be non-empty", () => {
    expect(EntrantId.safeParse("").success).toBe(false);
    expect(EntrantId.parse("H")).toBe("H");
  });
});
