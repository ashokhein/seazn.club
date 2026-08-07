// The manual settings form previously had no way to set `max_fixtures_per_day`
// at all — the engine and API already enforce it end to end (build-encode.ts),
// but a human operator could only reach it through the AI/NLP parser. These
// helpers are the read/write halves of the new form field; tested standalone
// since the repo has no jsdom to drive the `<input>` itself.
import { describe, expect, it } from "vitest";
import { readMaxFixturesPerDay, withMaxFixturesPerDay } from "../constraints-panel";

const DIVISION = "div-1";
const OTHER_DIVISION = "div-2";

describe("readMaxFixturesPerDay", () => {
  it("returns undefined when no hard rules exist", () => {
    expect(readMaxFixturesPerDay(undefined, DIVISION)).toBeUndefined();
  });

  it("finds the whole-division max_fixtures_per_day rule among others", () => {
    const hard = [
      { type: "min_rest", scope: { kind: "division", divisionId: DIVISION } },
      { type: "max_fixtures_per_day", count: 6, scope: { kind: "division", divisionId: DIVISION } },
    ];
    expect(readMaxFixturesPerDay(hard, DIVISION)).toBe(6);
  });

  it("ignores a max_fixtures_per_day rule scoped to a different division", () => {
    const hard = [
      { type: "max_fixtures_per_day", count: 6, scope: { kind: "division", divisionId: OTHER_DIVISION } },
    ];
    expect(readMaxFixturesPerDay(hard, DIVISION)).toBeUndefined();
  });

  it("ignores a max_fixtures_per_day rule scoped to something other than the whole division", () => {
    const hard = [
      { type: "max_fixtures_per_day", count: 6, scope: { kind: "entrant", divisionId: DIVISION } },
    ];
    expect(readMaxFixturesPerDay(hard, DIVISION)).toBeUndefined();
  });
});

describe("withMaxFixturesPerDay", () => {
  it("appends the rule when none existed", () => {
    const out = withMaxFixturesPerDay(undefined, DIVISION, 5);
    expect(out).toEqual([{ type: "max_fixtures_per_day", count: 5, scope: { kind: "division", divisionId: DIVISION } }]);
  });

  it("replaces the existing rule rather than duplicating it", () => {
    const hard = [{ type: "max_fixtures_per_day", count: 5, scope: { kind: "division", divisionId: DIVISION } }];
    const out = withMaxFixturesPerDay(hard, DIVISION, 9);
    expect(out).toEqual([{ type: "max_fixtures_per_day", count: 9, scope: { kind: "division", divisionId: DIVISION } }]);
  });

  it("removes the rule when count is undefined, without touching other rules", () => {
    const hard = [
      { type: "min_rest", scope: { kind: "division", divisionId: DIVISION } },
      { type: "max_fixtures_per_day", count: 5, scope: { kind: "division", divisionId: DIVISION } },
    ];
    const out = withMaxFixturesPerDay(hard, DIVISION, undefined);
    expect(out).toEqual([{ type: "min_rest", scope: { kind: "division", divisionId: DIVISION } }]);
  });

  it("leaves an AI-authored rule for a different scope untouched when setting this one", () => {
    const hard = [
      { type: "max_fixtures_per_day", count: 3, scope: { kind: "entrant", divisionId: DIVISION } },
    ];
    const out = withMaxFixturesPerDay(hard, DIVISION, 7);
    expect(out).toEqual([
      { type: "max_fixtures_per_day", count: 3, scope: { kind: "entrant", divisionId: DIVISION } },
      { type: "max_fixtures_per_day", count: 7, scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });
});
