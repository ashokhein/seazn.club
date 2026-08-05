import { describe, expect, it } from "vitest";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import type { Assignment } from "./calendar.ts";

const T0 = Date.UTC(2026, 7, 8, 9, 0);
const MIN = 60_000;

const card = (id: string, court: string, startMin: number, durMin = 30, entrants: string[] = [], people: string[] = []): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + startMin * MIN,
  endAt: T0 + (startMin + durMin) * MIN,
  entrants,
  people,
});

describe("boardMetrics", () => {
  it("reports zero for an empty board", () => {
    expect(boardMetrics([], ["C1"], 0)).toEqual({
      makespanMinutes: 0, worstIdleGapMinutes: 0, courtImbalanceMinutes: 0, placed: 0, total: 0,
    });
  });

  it("makespan spans earliest start to latest end", () => {
    const m = boardMetrics([card("a", "C1", 0), card("b", "C1", 60)], ["C1"], 2);
    expect(m.makespanMinutes).toBe(90);
  });

  it("worst idle gap is measured per entrant, between consecutive matches", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 120, 30, ["E1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(90); // 30 -> 120
  });

  it("counts a person's gap as well as an entrant's", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, [], ["p1"]), card("b", "C2", 200, 30, [], ["p1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(170);
  });

  it("never merges an entrant with a person that shares its id string", () => {
    // `entrants` is EntrantId[] and `people` is string[], but both are plain
    // strings at runtime, so the `e:` / `p:` key prefixes inside boardMetrics
    // are load-bearing. Drop them and these two cards collapse into ONE
    // participant chain that reports a fabricated 470-minute wait.
    const m = boardMetrics(
      [card("a", "C1", 0, 30, ["X1"]), card("b", "C2", 500, 30, [], ["X1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(0);
  });

  it("is zero when nobody plays twice", () => {
    const m = boardMetrics([card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 500, 30, ["E2"])], ["C1", "C2"], 2);
    expect(m.worstIdleGapMinutes).toBe(0);
  });

  it("court imbalance counts an unused configured court as zero minutes", () => {
    const m = boardMetrics([card("a", "C1", 0, 30), card("b", "C1", 60, 30)], ["C1", "C2"], 2);
    expect(m.courtImbalanceMinutes).toBe(60);
  });

  it("counts a court the board uses but the config omits", () => {
    // Two courts must reach `mins` for this to constrain anything: the
    // configured-but-unused C1 at 0, and the unconfigured-but-used CX at 30.
    // A version that only ever measured the configured courts would see
    // [0] and report 0; one that only measured used courts would see [30]
    // and also report 0. Only counting BOTH gives 30.
    const m = boardMetrics([card("a", "CX", 0, 30)], ["C1"], 1);
    expect(m.courtImbalanceMinutes).toBe(30);
  });
});

describe("isStrictlyBetter", () => {
  const base = { makespanMinutes: 100, worstIdleGapMinutes: 50, courtImbalanceMinutes: 20, placed: 10, total: 10 };

  it("prefers more placed above everything", () => {
    expect(isStrictlyBetter({ ...base, placed: 11, makespanMinutes: 999 }, base)).toBe(true);
  });

  it("prefers a shorter makespan over a fairer board", () => {
    expect(isStrictlyBetter({ ...base, makespanMinutes: 90, worstIdleGapMinutes: 999 }, base)).toBe(true);
    expect(isStrictlyBetter({ ...base, makespanMinutes: 110, worstIdleGapMinutes: 0 }, base)).toBe(false);
  });

  it("prefers a fairer board over a balanced one", () => {
    expect(isStrictlyBetter({ ...base, worstIdleGapMinutes: 40, courtImbalanceMinutes: 999 }, base)).toBe(true);
  });

  it("is false for an identical board", () => {
    expect(isStrictlyBetter(base, base)).toBe(false);
  });
});
