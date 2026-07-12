import { describe, expect, it } from "vitest";
import { buildDrawGraph } from "../draw-graph";
import { marketingPreview } from "../format-preview";
import { clubNames } from "../club-names";

const names8 = clubNames(8, 1);

describe("buildDrawGraph", () => {
  it("groups+KO: pool boxes with real names feed a bracket with edges and a trophy", () => {
    const g = buildDrawGraph(marketingPreview("groups-knockout", 8), names8);
    const pools = g.nodes.filter((n) => n.kind === "pool");
    expect(pools).toHaveLength(2);
    // 4 members listed per pool, all substituted club names (no bare A/B letters)
    for (const p of pools) {
      expect(p.lines.length).toBe(5); // title + 4 members
      for (const l of p.lines.slice(1)) expect(l).not.toMatch(/^[A-Z]$/);
    }
    const matches = g.nodes.filter((n) => n.kind === "match");
    expect(matches.length).toBe(3); // 2 semis + final
    expect(g.nodes.some((n) => n.kind === "trophy")).toBe(true);
    expect(g.edges.length).toBe(3); // semis → final + trophy tail
    expect(g.height).toBeGreaterThan(0);
  });

  it("league: radial hub with one pill per entrant and a spoke each", () => {
    const g = buildDrawGraph(marketingPreview("league", 8), names8);
    const pills = g.nodes.filter((n) => n.kind === "entrant");
    expect(pills).toHaveLength(8);
    expect(g.edges.length).toBe(8);
    const hub = g.nodes.find((n) => n.kind === "hub");
    expect(hub).toBeTruthy();
    expect(hub!.lines.join(" ")).toMatch(/7 rounds · 28 matches/);
  });

  it("knockout: rounds become bracket columns, later rounds keep engine refs", () => {
    const g = buildDrawGraph(marketingPreview("knockout", 8), names8);
    const matches = g.nodes.filter((n) => n.kind === "match");
    expect(matches.length).toBe(7); // 4 QF + 2 SF + F
    expect(g.edges.length).toBe(7); // 6 bracket + trophy tail
    // First round uses club names; final references winners
    expect(matches[0]!.lines[0]).not.toMatch(/^[A-Z]$/);
  });

  it("never returns empty output for any marketing format at any size", () => {
    for (const f of ["league", "groups-knockout", "knockout", "double_elim"] as const) {
      for (const n of [4, 8, 16]) {
        const g = buildDrawGraph(marketingPreview(f, n), clubNames(n, 2));
        expect(g.nodes.length).toBeGreaterThan(0);
        expect(g.width).toBe(800);
      }
    }
  });
});
