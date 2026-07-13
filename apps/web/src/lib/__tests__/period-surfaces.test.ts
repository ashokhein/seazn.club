// Public-surface extractors for the period/nested kernels (v6/00 §5):
// goals-by-period, strength chip, discipline list, serving side. Each fails
// without its extractor — the scorebug and /live wall read these.
import { describe, expect, it } from "vitest";
import {
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
} from "../public-site";

const periodSummary = {
  headline: "2 — 1 · P3",
  perSide: [],
  detail: {
    periods: [
      { phase: "P1", home: 1, away: 0 },
      { phase: "P2", home: 0, away: 1 },
      { phase: "P3", home: 1, away: 0 },
    ],
    strength: "5v4",
    discipline: [
      { side: "away", classKey: "minor", person: "p9" },
      { side: "home", classKey: "yellow" },
    ],
  },
};

describe("period-kernel public surfaces", () => {
  it("extracts goals by period", () => {
    expect(periodBreakdown(periodSummary)).toEqual([
      { phase: "P1", home: 1, away: 0 },
      { phase: "P2", home: 0, away: 1 },
      { phase: "P3", home: 1, away: 0 },
    ]);
    expect(periodBreakdown({ detail: {} })).toBeNull();
    expect(periodBreakdown(null)).toBeNull();
  });

  it("extracts the strength chip only when present", () => {
    expect(matchStrength(periodSummary)).toBe("5v4");
    expect(matchStrength({ detail: { strength: null } })).toBeNull();
    expect(matchStrength({ detail: {} })).toBeNull();
  });

  it("extracts the discipline list with labels", () => {
    const list = disciplineList(periodSummary);
    expect(list).toEqual([
      { side: "away", classKey: "minor", person: "p9" },
      { side: "home", classKey: "yellow" },
    ]);
    expect(disciplineLabel("double_minor")).toBe("Double minor");
  });
});

describe("nested-kernel public surfaces", () => {
  const tennisSummary = {
    headline: "1 — 0 · 7–6(5) · 3–2 (40–15)",
    perSide: [{ entrantId: "h" }, { entrantId: "a" }],
    detail: {
      sets: [
        { home: 7, away: 6, tb: { home: 7, away: 5 }, closed: true },
        { home: 3, away: 2, closed: false },
      ],
      serving: "away",
    },
  };

  it("tennis sets ride the shared set breakdown (closed + live)", () => {
    const breakdown = setBreakdown(tennisSummary, "tennis");
    expect(breakdown?.sets).toEqual([
      { home: 7, away: 6, closed: true },
      { home: 3, away: 2, closed: false },
    ]);
    expect(breakdown?.unit).toBe("Set");
  });

  it("exposes the serving side for the serve dot", () => {
    expect(servingSide(tennisSummary)).toBe("away");
    expect(servingSide(periodSummary)).toBeNull();
  });
});
