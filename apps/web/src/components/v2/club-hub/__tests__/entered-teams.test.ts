import { describe, expect, it } from "vitest";
import { enteredTeams } from "../entries-tab";

describe("enteredTeams", () => {
  const first = {
    id: "t1",
    name: "First XI",
    entries: [{ division_id: "d1", division_name: "Premier" }],
  };
  const reserves = { id: "t2", name: "Reserves", entries: [] };

  it("keeps only teams entered in at least one division", () => {
    // Reserves has no entries — it must not appear on the read-only grid.
    expect(enteredTeams([first, reserves])).toEqual([first]);
  });

  it("returns [] when no team is entered — this drives the empty state", () => {
    expect(enteredTeams([reserves])).toEqual([]);
    expect(enteredTeams([])).toEqual([]);
  });

  it("preserves input order (getClub already orders teams by name)", () => {
    const a = { id: "a", name: "A", entries: [{ division_id: "d", division_name: "D" }] };
    const b = { id: "b", name: "B", entries: [{ division_id: "e", division_name: "E" }] };
    expect(enteredTeams([b, a])).toEqual([b, a]);
  });

  it("keeps a team that carries multiple division entries intact", () => {
    const multi = {
      id: "t3",
      name: "Colts",
      entries: [
        { division_id: "d1", division_name: "U18 North" },
        { division_id: "d2", division_name: "U18 Cup" },
      ],
    };
    expect(enteredTeams([multi])).toEqual([multi]);
  });
});
