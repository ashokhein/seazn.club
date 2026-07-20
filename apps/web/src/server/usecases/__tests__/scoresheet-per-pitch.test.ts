import { describe, expect, it } from "vitest";
import { groupByCourt } from "@/server/usecases/exports";

// `pageBreaks=per_pitch` on scoresheets is meant to give an organiser one
// printed stack per court, to hand to each court's official.
//
// It never did. exportFixtures orders by stage/round, which interleaves courts
// on purpose — that is what parallel courts are for — and the old code broke a
// page "whenever the court changed" against that order. On a two-court day
// that is a break at almost every sheet, and no grouping at all.
//
// It also indexed `undecided[i]` by SECTION index while sections were built
// with `push(...fragment())`, so the moment a sport emitted two sections for a
// fixture the arrays desynchronised and courts were read off the wrong
// fixture. Only volleyball ships a bespoke sheet today and it emits one, so
// that one was latent rather than live.
const f = (id: string, court: string | null) => ({ id, court_label: court });

describe("groupByCourt", () => {
  it("gathers each court's fixtures together out of round order", () => {
    // How a two-court round robin actually comes back: R1 on both courts,
    // then R2 on both courts.
    const rounds = [f("r1c1", "Court 1"), f("r1c2", "Court 2"), f("r2c1", "Court 1"), f("r2c2", "Court 2")];
    expect(groupByCourt(rounds).map((p) => p.fixture.id)).toEqual([
      "r1c1", "r2c1", "r1c2", "r2c2",
    ]);
  });

  it("flags exactly one boundary per court, never the first fixture", () => {
    const rounds = [f("r1c1", "Court 1"), f("r1c2", "Court 2"), f("r2c1", "Court 1"), f("r2c2", "Court 2")];
    const plan = groupByCourt(rounds);
    expect(plan.map((p) => p.startsNewCourt)).toEqual([false, false, true, false]);
    // One break for two courts — the old code produced three here.
    expect(plan.filter((p) => p.startsNewCourt)).toHaveLength(1);
  });

  it("keeps play order within a court", () => {
    // The sort is stable, so a court's sheets stay in the order they are played.
    const rounds = [f("a", "Court 1"), f("b", "Court 1"), f("c", "Court 1")];
    expect(groupByCourt(rounds).map((p) => p.fixture.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts courts naturally, so Court 10 does not land between 1 and 2", () => {
    const rounds = [f("ten", "Court 10"), f("two", "Court 2"), f("one", "Court 1")];
    expect(groupByCourt(rounds).map((p) => p.fixture.id)).toEqual(["one", "two", "ten"]);
  });

  it("puts unassigned fixtures last — nobody can hand those to a court", () => {
    const rounds = [f("none", null), f("c2", "Court 2"), f("c1", "Court 1")];
    const plan = groupByCourt(rounds);
    expect(plan.map((p) => p.fixture.id)).toEqual(["c1", "c2", "none"]);
    expect(plan[2]!.startsNewCourt).toBe(true);
  });

  it("treats a single-court division as one uninterrupted stack", () => {
    const plan = groupByCourt([f("a", "Court 1"), f("b", "Court 1")]);
    expect(plan.some((p) => p.startsNewCourt)).toBe(false);
  });

  it("handles an empty division", () => {
    expect(groupByCourt([])).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const rounds = [f("r1c2", "Court 2"), f("r1c1", "Court 1")];
    groupByCourt(rounds);
    expect(rounds.map((x) => x.id)).toEqual(["r1c2", "r1c1"]);
  });
});
