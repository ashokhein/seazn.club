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

  // Production `feeds.after` holds fixture UUIDs (schedule-ai.ts builds it from
  // `feedDependencies`), so ordering the strings by their own text sorts on a
  // per-seed random value and the pack's double-seed determinism test breaks.
  // Order must come from the OWNING fixture's stable label.
  it("orders assumptions by the owning fixture's stable label, never by the feeder UUID", () => {
    const u = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    const fixtures: ParticipantFixture[] = [
      { id: u("11"), ext_key: "z-late", home: null, away: null, feeds: { after: [u("aa")] } },
      { id: u("22"), ext_key: "a-early", home: null, away: null, feeds: { after: [u("bb")] } },
      // Two dangling feeders on ONE fixture: the tie must keep feeds.after order
      // (ff before cc), which is the opposite of the feeder ids' own order.
      {
        id: u("33"),
        ext_key: "m-mid",
        home: null,
        away: null,
        feeds: { after: [u("ff"), u("cc")] },
      },
    ];
    const tail = "is not in the movable set — treated as completed (bye or finished round)";
    expect(stripByes(fixtures).assumptions).toEqual([
      `feeder ${u("bb")} of a-early ${tail}`,
      `feeder ${u("ff")} of m-mid ${tail}`,
      `feeder ${u("cc")} of m-mid ${tail}`,
      `feeder ${u("aa")} of z-late ${tail}`,
    ]);
  });

  it("falls back to the full fixture id as the order key when there is no ext_key", () => {
    const fixtures: ParticipantFixture[] = [
      // Feeder ids sort b-fix-first; the owning ids sort a-fix-first.
      { id: "b-fix", ext_key: null, home: null, away: null, feeds: { after: ["gone-1"] } },
      { id: "a-fix", ext_key: null, home: null, away: null, feeds: { after: ["gone-2"] } },
    ];
    const out = stripByes(fixtures).assumptions;
    expect(out.map((a) => a.split(" of ")[1]?.split(" ")[0])).toEqual(["a-fix", "b-fix"]);
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

  // A cycle-truncated subtree must never be memoised: the node behind the cut
  // gets an empty set only because of where the walk happened to start, so a
  // cached one makes the answer depend on the order of the fixtures array — and
  // a person rule scoped to that node then silently passes. Nothing upstream
  // rejects a fixture-level cycle, so this guard is the only thing standing.
  it("a cycle in the feed graph terminates and gives the same answer in either array order", () => {
    // A keeps a named side; B sees A only through the cycle.
    const cyc = [fx("A", "x", null, ["B"]), fx("B", null, null, ["A"])];
    const persons = new Map<string, string[]>([["x", ["p-x"]]]);
    const forward = computeParticipants(cyc, persons);
    const reversed = computeParticipants([...cyc].reverse(), persons);
    expect(forward).toEqual(reversed);
    expect(forward["A"]).toEqual(["p-x"]);
    expect(forward["B"]).toEqual(["p-x"]); // the node behind the cut, not []
  });

  it("a longer cycle also terminates and is array-order independent", () => {
    const cyc = [
      fx("A", null, null, ["B"]),
      fx("B", null, null, ["C"]),
      fx("C", "z", null, ["A"]),
    ];
    const persons = new Map<string, string[]>([["z", ["p-z"]]]);
    const forward = computeParticipants(cyc, persons);
    expect(forward).toEqual(computeParticipants([...cyc].reverse(), persons));
    expect(forward).toEqual({ A: ["p-z"], B: ["p-z"], C: ["p-z"] });
  });

  // `home` absent (not null) is a different value from `home: null`. Guarding
  // with `!== null` lets undefined through and skips the advancer recursion.
  it("treats an absent home/away key as a null slot and still recurses", () => {
    const roster = new Map<string, string[]>([["e1", ["p-1"]], ["e2", ["p-2"]]]);
    const feeder = fx("feeder", "e1", "e1", []);
    const noHome = {
      id: "loose",
      ext_key: "loose",
      away: "e2",
      feeds: { after: ["feeder"] },
    } as unknown as ParticipantFixture;
    expect(computeParticipants([feeder, noHome], roster)["loose"]).toEqual(["p-1", "p-2"]);
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
