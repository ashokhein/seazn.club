import { describe, expect, it } from "vitest";
import { computeParticipants, stripByes, type ParticipantFixture } from "./participants";

// ---------------------------------------------------------------------------
// The badminton double-elimination payload, frozen. 13 fixtures, 7 entrants;
// 10 of the 13 have at least one null slot filled by whoever advances.
// `BYE-1` is a feeder that is NOT in the movable set — a bye.
// ---------------------------------------------------------------------------
const fx = (
  id: string,
  home: string | null,
  away: string | null,
  after: string[],
): ParticipantFixture => ({ id, ext_key: id, home, away, feeds: { after } });

const BADMINTON: ParticipantFixture[] = [
  fx("wb-r0-i1", "e", "d", []),
  fx("wb-r0-i2", "c", "f", []),
  fx("wb-r0-i3", "g", "b", []),
  fx("wb-r1-i0", "a", null, ["wb-r0-i1", "BYE-1"]),
  fx("wb-r1-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("wb-r2-i0", null, null, ["wb-r1-i1", "wb-r1-i0"]),
  fx("lb-r0-i0", null, null, ["wb-r0-i1", "BYE-1"]),
  fx("lb-r0-i1", null, null, ["wb-r0-i2", "wb-r0-i3"]),
  fx("lb-r1-i0", null, null, ["wb-r1-i0", "lb-r0-i0"]),
  fx("lb-r1-i1", null, null, ["lb-r0-i1", "wb-r1-i1"]),
  fx("lb-r2-i0", null, null, ["lb-r1-i1", "lb-r1-i0"]),
  fx("lb-r3-i0", null, null, ["wb-r2-i0", "lb-r2-i0"]),
  fx("gf", null, null, ["wb-r2-i0", "lb-r3-i0"]),
];

/** One person per entrant, named after the entrant — the individual case. */
const SOLO = new Map<string, string[]>(
  ["a", "b", "c", "d", "e", "f", "g"].map((e) => [e, [`p-${e}`]]),
);

describe("stripByes", () => {
  it("strips a feeder that is not in the movable set and records an assumption", () => {
    const out = stripByes(BADMINTON);
    expect(out.fixtures.every((f) => f.feeds.after.every((id) => id !== "BYE-1"))).toBe(true);
    expect(out.assumptions).toEqual([
      "feeder BYE-1 of lb-r0-i0 is not in the movable set — treated as completed (bye or finished round)",
      "feeder BYE-1 of wb-r1-i0 is not in the movable set — treated as completed (bye or finished round)",
    ]);
  });

  it("returns the same fixture objects when nothing dangles", () => {
    const clean = stripByes(BADMINTON).fixtures;
    const again = stripByes(clean);
    expect(again.assumptions).toEqual([]);
    expect(again.fixtures[0]).toBe(clean[0]);
  });
});

describe("computeParticipants", () => {
  const P = () => computeParticipants(stripByes(BADMINTON).fixtures, SOLO);

  it("participants(gf) = all 7 entrants (full advancer recursion)", () => {
    expect(P()["gf"]).toEqual(["p-a", "p-b", "p-c", "p-d", "p-e", "p-f", "p-g"]);
  });

  it("participants(lb-r0-i0) = exactly {d, e} — only wb-r0-i1's possible losers", () => {
    expect(P()["lb-r0-i0"]).toEqual(["p-d", "p-e"]);
  });

  it("a fixture with both slots named does not recurse into its feeders", () => {
    expect(P()["wb-r0-i1"]).toEqual(["p-d", "p-e"]);
  });

  it("a half-named fixture keeps its named side and recurses for the null side", () => {
    // wb-r1-i0: home 'a' named, away fed by wb-r0-i1 (BYE-1 stripped).
    expect(P()["wb-r1-i0"]).toEqual(["p-a", "p-d", "p-e"]);
  });

  it("a team entrant with N roster members contributes all N person ids", () => {
    const roster = new Map<string, string[]>([
      ["home-team", ["p1", "p2", "p3", "p4"]],
      ["away-team", ["p5"]],
    ]);
    const fixtures = [
      fx("semi", "home-team", "away-team", []),
      fx("final", null, null, ["semi"]),
    ];
    const out = computeParticipants(fixtures, roster);
    expect(out["semi"]).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(out["final"]).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("deduplicates a person rostered into both entrants of one fixture", () => {
    const shared = new Map<string, string[]>([["x", ["p1", "p2"]], ["y", ["p2", "p3"]]]);
    expect(computeParticipants([fx("m", "x", "y", [])], shared)["m"]).toEqual(["p1", "p2", "p3"]);
  });

  it("a cycle in the feed graph does not hang or stack-overflow", () => {
    const cyc = [
      fx("A", null, null, ["B"]),
      fx("B", null, null, ["C"]),
      fx("C", "z", null, ["A"]),
    ];
    const out = computeParticipants(cyc, new Map([["z", ["p-z"]]]));
    expect(out["A"]).toEqual(["p-z"]);
    expect(out["C"]).toEqual(["p-z"]);
  });

  it("orders each list by the supplied sortKey, not by the raw id", () => {
    const persons = new Map<string, string[]>([["x", ["zzz", "aaa"]]]);
    const names = new Map([["zzz", "Anna"], ["aaa", "Zoe"]]);
    const out = computeParticipants([fx("m", "x", null, [])], persons, {
      sortKey: (p) => `${names.get(p)}|${p}`,
    });
    expect(out["m"]).toEqual(["zzz", "aaa"]); // Anna before Zoe
  });

  it("emits an entry for every fixture, empty when nobody is known", () => {
    const out = computeParticipants([fx("orphan", null, null, [])], new Map());
    expect(out).toEqual({ orphan: [] });
  });
});
