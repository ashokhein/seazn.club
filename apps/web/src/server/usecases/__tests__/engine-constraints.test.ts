// #458 — ONE builder for the engine's `constraints` block.
//
// Three call sites built this object as independent literals over the same
// shape — `verifyConfig` (schedule-ai.ts), `toSlotConfig` (schedule.ts) and
// `verifyConfigFor` (competition-schedule-ai.ts) — and they had already
// drifted: the board site mapped EVERY start window through, the joint site
// dropped any whose `target.kind` was outside the engine's enum, and the
// single-division AI site pinned `startWindows: []` outright, which is #458.
//
// The joint site's filter is the canonical behaviour and this file pins WHY:
// `PackStartWindow.target.kind` is a bare `string` (the pack is a wire shape),
// so casting an unrecognised kind through would let the engine silently never
// match it while hiding that a settings row has drifted from the enum.
import { describe, expect, it } from "vitest";
import type { HardConstraint } from "@seazn/engine/scheduling";
import {
  AI_VERIFY_POLICY,
  buildEngineConstraints,
  toEngineStartWindows,
} from "../engine-constraints";

const T0 = Date.parse("2026-08-10T09:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
const MIN = 60_000;

const BOARD_POLICY = {
  fieldFairness: "balance",
  parallelism: "block",
  crossPersonClash: "hard",
  hard: true,
} as const;

const RULE: HardConstraint = {
  type: "max_fixtures_per_day",
  count: 2,
  scope: { kind: "competition" },
};

describe("buildEngineConstraints", () => {
  it("converts notBefore/notAfter from ISO to epoch ms", () => {
    const out = buildEngineConstraints(
      {
        noBackToBack: false,
        startWindows: [
          {
            target: { kind: "pool", id: "p1" },
            notBefore: iso(T0),
            notAfter: iso(T0 + 90 * MIN),
          },
        ],
      },
      AI_VERIFY_POLICY,
    );
    expect(out.startWindows).toEqual([
      { target: { kind: "pool", id: "p1" }, notBefore: T0, notAfter: T0 + 90 * MIN },
    ]);
  });

  it("omits a bound the source did not set, rather than emitting undefined", () => {
    const out = buildEngineConstraints(
      {
        noBackToBack: false,
        startWindows: [{ target: { kind: "entrant", id: "e1" }, notAfter: iso(T0) }],
      },
      AI_VERIFY_POLICY,
    );
    expect(out.startWindows[0]).toEqual({ target: { kind: "entrant", id: "e1" }, notAfter: T0 });
    expect("notBefore" in out.startWindows[0]!).toBe(false);
  });

  it("DROPS a window whose target.kind is outside the engine's enum", () => {
    const out = buildEngineConstraints(
      {
        noBackToBack: false,
        startWindows: [
          { target: { kind: "nonsense", id: "x" }, notBefore: iso(T0) },
          { target: { kind: "division", id: "d1" }, notBefore: iso(T0) },
        ],
      },
      AI_VERIFY_POLICY,
    );
    // Dropped, not cast through: the engine would never match "nonsense" and a
    // cast would hide that a stored settings row drifted from the enum.
    expect(out.startWindows).toEqual([{ target: { kind: "division", id: "d1" }, notBefore: T0 }]);
  });

  it("carries all three recognised kinds", () => {
    const out = toEngineStartWindows([
      { target: { kind: "entrant", id: "e1" } },
      { target: { kind: "pool", id: "p1" } },
      { target: { kind: "division", id: "d1" } },
    ]);
    expect(out.map((w) => w.target.kind)).toEqual(["entrant", "pool", "division"]);
  });

  it("omits restMin/restByGroup the source did not set, and carries the ones it did", () => {
    const bare = buildEngineConstraints(
      { noBackToBack: true, startWindows: [] },
      AI_VERIFY_POLICY,
    );
    expect(bare).toEqual({
      noBackToBack: true,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
    });

    const full = buildEngineConstraints(
      { restMin: 45, restByGroup: { p1: 120 }, noBackToBack: false, startWindows: [] },
      AI_VERIFY_POLICY,
    );
    expect(full.restMin).toBe(45);
    expect(full.restByGroup).toEqual({ p1: 120 });
  });

  it("takes the policy fields from the caller, never from the source", () => {
    const out = buildEngineConstraints(
      { noBackToBack: false, startWindows: [], hard: [RULE] },
      BOARD_POLICY,
    );
    expect(out.fieldFairness).toBe("balance");
    expect(out.parallelism).toBe("block");
    expect(out.crossPersonClash).toBe("hard");
  });

  it("carries durable hard rules only when the policy asks for them", () => {
    // The AI paths merge the SAME rules into the top-level `hard` field, and
    // `effectiveHard` merges the two — carrying both would count every durable
    // rule twice.
    const board = buildEngineConstraints(
      { noBackToBack: false, startWindows: [], hard: [RULE] },
      BOARD_POLICY,
    );
    expect(board.hard).toEqual([RULE]);

    const ai = buildEngineConstraints(
      { noBackToBack: false, startWindows: [], hard: [RULE] },
      AI_VERIFY_POLICY,
    );
    expect("hard" in ai).toBe(false);
  });

  it("omits `hard` entirely when the source stored none", () => {
    // Never defaulted to []: a `hard: []` on a config that stored nothing is
    // indistinguishable downstream but differs from every literal the suite
    // compares `toSlotConfig` output against.
    const out = buildEngineConstraints({ noBackToBack: false, startWindows: [] }, BOARD_POLICY);
    expect("hard" in out).toBe(false);
  });
});
