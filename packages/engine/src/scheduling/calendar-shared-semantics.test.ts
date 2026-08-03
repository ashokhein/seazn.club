// The solver may not hold an opinion of its own about what a rule means (#401).
// These tests pin the exported semantics to what `validateAssignments` actually
// enforces, so a future divergence fails here instead of silently producing a
// "repaired" board the verifier rejects.
import { describe, expect, it } from "vitest";
import {
  effectiveHard,
  intervalsOverlap,
  pairRestMinutes,
  startWindowFor,
  validateAssignments,
  type Assignment,
  type VerifyConfig,
} from "./calendar.ts";
import { assign, at, BADMINTON, BASE_CONFIG, SOLO } from "./payload-fixtures.ts";

const MIN = 60_000;

describe("exported rule semantics", () => {
  it("effectiveHard merges both homes, compiled first", () => {
    const compiled = [{ type: "not_before", time: "09:00", scope: { kind: "competition" } }] as const;
    const stored = [{ type: "not_after", time: "21:00", scope: { kind: "competition" } }] as const;
    expect(effectiveHard({ hard: compiled, constraints: undefined })).toEqual(compiled);
    expect(effectiveHard({ hard: undefined, constraints: { hard: stored } as never })).toEqual(stored);
    expect(effectiveHard({ hard: compiled, constraints: { hard: stored } as never })).toEqual([
      ...compiled,
      ...stored,
    ]);
  });

  it("pairRestMinutes is the number validateAssignments enforces", () => {
    const config: VerifyConfig = { ...BASE_CONFIG, perEntrantMinRest: 45 };
    const [a, b] = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-10T09:00:00Z", "C1"],
      ["wb-r1-i0", "2026-08-10T09:40:00Z", "C2"],
    ]);
    const rest = pairRestMinutes(config, a!, b!);
    expect(rest).toBe(45);
    // One minute short of the exported number must be a `rest` conflict; the
    // number itself must be clean. Anything else means two definitions exist.
    const short = [a!, { ...b!, startAt: a!.endAt + (rest - 1) * MIN, endAt: a!.endAt + (rest + 39) * MIN }];
    const exact = [a!, { ...b!, startAt: a!.endAt + rest * MIN, endAt: a!.endAt + (rest + 40) * MIN }];
    expect(validateAssignments(short, config).some((c) => c.reason === "rest")).toBe(true);
    expect(validateAssignments(exact, config).some((c) => c.reason === "rest")).toBe(false);
  });

  it("startWindowFor returns the bounds the verifier compares against", () => {
    const notBefore = at("2026-08-10T10:00:00Z");
    const config: VerifyConfig = {
      ...BASE_CONFIG,
      constraints: {
        startWindows: [{ target: { kind: "division", id: "d1" }, notBefore }],
        noBackToBack: false,
        fieldFairness: "off",
        parallelism: "mixed",
      } as never,
    };
    const a: Assignment = {
      fixtureId: "f1",
      court: "C1",
      startAt: notBefore - MIN,
      endAt: notBefore + 39 * MIN,
      entrants: [],
      people: [],
      divisionId: "d1",
    };
    expect(startWindowFor(config, a).notBefore).toBe(notBefore);
    expect(validateAssignments([a], config).some((c) => c.reason === "start_window")).toBe(true);
  });

  it("intervalsOverlap is half-open — touching is not overlapping", () => {
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 11, 10, 20)).toBe(true);
  });
});
