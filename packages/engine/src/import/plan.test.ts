// planImport goldens + rule units (Jul3/01 §3–§4, PROMPT-21 acceptance).
import { describe, expect, it } from "vitest";
import { planImport } from "./plan.ts";
import { ImportConfig, type ImportRow, type ImportSnapshot } from "./types.ts";

const CONFIG = ImportConfig.parse({});

const EMPTY: ImportSnapshot = { clubs: [], teams: [], persons: [], divisions: [], entrants: [] };

const DIVISIONS: ImportSnapshot["divisions"] = [
  { id: "div-u12", name: "Under 12s", slug: "u12", sportKey: "football", positionKeys: ["gk", "def", "mid", "fwd"] },
];

function row(partial: Partial<ImportRow> & { rowNo: number }): ImportRow {
  return partial as ImportRow;
}

// The golden fixture: 3 clubs × 4 teams × 11 players placed into one division
// (players spread over the teams; sparse club/team columns repeat per row).
function goldenRows(): ImportRow[] {
  const rows: ImportRow[] = [];
  let rowNo = 1;
  const clubs = ["Acme SC", "Borough FC", "City Rovers"];
  const teams = ["U12", "U14", "U16", "U18"];
  for (const club of clubs) {
    for (const team of teams) {
      const teamName = `${club} ${team}`;
      rows.push(
        row({
          rowNo: rowNo++,
          clubName: club,
          teamName,
          divisionSlug: "u12",
        }),
      );
    }
  }
  // 11 players on the first club's first team
  for (let i = 1; i <= 11; i++) {
    rows.push(
      row({
        rowNo: rowNo++,
        clubName: "Acme SC",
        teamName: "Acme SC U12",
        playerFullName: `Player ${String(i).padStart(2, "0")}`,
        dob: `2014-01-${String(i).padStart(2, "0")}`,
        squadNumber: i,
        position: i === 1 ? "gk" : "mid",
        isCaptain: i === 1,
        divisionSlug: "u12",
      }),
    );
  }
  return rows;
}

describe("planImport golden (Jul3/01 §3)", () => {
  it("3 clubs × 4 teams × 11 players → expected plan stats + op kinds", () => {
    const plan = planImport(goldenRows(), { ...EMPTY, divisions: DIVISIONS }, CONFIG);
    expect(plan.issues).toEqual([]);
    expect(plan.stats).toEqual({ clubs: 3, teams: 12, persons: 11, entrants: 12, rosters: 11 });
    const kinds = plan.ops.map((o) => o.kind);
    expect(kinds.filter((k) => k === "club.create")).toHaveLength(3);
    expect(kinds.filter((k) => k === "team.create")).toHaveLength(12);
    expect(kinds.filter((k) => k === "person.create")).toHaveLength(11);
    expect(kinds.filter((k) => k === "entrant.create")).toHaveLength(12);
    expect(kinds.filter((k) => k === "roster.add")).toHaveLength(11);
    // ref-dependency bucket order (Jul3/01 §9)
    const order = ["club.create", "club.update", "team.create", "team.link",
      "person.create", "entrant.create", "roster.add"];
    const seen = kinds.map((k) => order.indexOf(k));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("committing then re-planning the same file is a no-op (idempotence, Jul3/01 §4)", () => {
    const rows = goldenRows();
    const plan = planImport(rows, { ...EMPTY, divisions: DIVISIONS }, CONFIG);
    const after = applyPlanToSnapshot(plan, { ...EMPTY, divisions: DIVISIONS });
    const replan = planImport(rows, after, CONFIG);
    expect(replan.ops).toEqual([]);
    expect(replan.stats).toEqual({ clubs: 0, teams: 0, persons: 0, entrants: 0, rosters: 0 });
  });
});

describe("planImport rules (Jul3/01 §4)", () => {
  it("club matches by external_ref before folded name", () => {
    const snapshot: ImportSnapshot = {
      ...EMPTY,
      clubs: [{ id: "c1", name: "Old Name", shortName: null, externalRef: "FA-1" }],
    };
    const plan = planImport(
      [row({ rowNo: 1, clubName: "New Name", clubExternalRef: "FA-1" })],
      snapshot,
      CONFIG,
    );
    expect(plan.ops).toEqual([]); // matched, nothing supplied to update
  });

  it("existing club with differing short_name gets club.update; blanks never overwrite", () => {
    const snapshot: ImportSnapshot = {
      ...EMPTY,
      clubs: [{ id: "c1", name: "Acme SC", shortName: "ACM", externalRef: null }],
    };
    const updated = planImport(
      [row({ rowNo: 1, clubName: "acme sc", clubShortName: "ACME" })],
      snapshot,
      CONFIG,
    );
    expect(updated.ops).toEqual([
      expect.objectContaining({ kind: "club.update", clubId: "c1", after: { shortName: "ACME" } }),
    ]);
    const blankShort = planImport([row({ rowNo: 1, clubName: "Acme SC" })], snapshot, CONFIG);
    expect(blankShort.ops).toEqual([]);
  });

  it("existing clubless team + club supplied ⇒ team.link, not team.create", () => {
    const snapshot: ImportSnapshot = {
      ...EMPTY,
      clubs: [{ id: "c1", name: "Acme SC", shortName: null, externalRef: null }],
      teams: [{ id: "t1", name: "U12", clubId: null }],
    };
    const plan = planImport([row({ rowNo: 1, clubName: "Acme SC", teamName: "U12" })], snapshot, CONFIG);
    expect(plan.ops).toEqual([
      expect.objectContaining({ kind: "team.link", teamId: "t1", club: { id: "c1" } }),
    ]);
  });

  it("ambiguous person: lenient warns + matches deterministically, strict errors + no op", () => {
    const snapshot: ImportSnapshot = {
      ...EMPTY,
      persons: [
        { id: "p1", fullName: "Sam Kerr", dob: null, externalRef: null },
        { id: "p2", fullName: "Sam Kerr", dob: null, externalRef: null },
      ],
    };
    const lenient = planImport([row({ rowNo: 3, playerFullName: "Sam Kerr" })], snapshot, CONFIG);
    expect(lenient.issues).toEqual([
      expect.objectContaining({ severity: "warn", code: "AMBIGUOUS_PERSON", rowNo: 3 }),
    ]);
    expect(lenient.ops).toEqual([]); // matched the first dob-less candidate

    const strict = planImport(
      [row({ rowNo: 3, playerFullName: "Sam Kerr" })],
      snapshot,
      ImportConfig.parse({ personMatch: "strict" }),
    );
    expect(strict.issues).toEqual([
      expect.objectContaining({ severity: "error", code: "AMBIGUOUS_PERSON" }),
    ]);
    expect(strict.ops).toEqual([]);
  });

  it("ambiguous name where all candidates have other dobs: lenient creates a distinguishable person", () => {
    const snapshot: ImportSnapshot = {
      ...EMPTY,
      persons: [
        { id: "p1", fullName: "Sam Kerr", dob: "2010-01-01", externalRef: null },
        { id: "p2", fullName: "Sam Kerr", dob: "2011-01-01", externalRef: null },
      ],
    };
    const plan = planImport([row({ rowNo: 3, playerFullName: "Sam Kerr" })], snapshot, CONFIG);
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "warn", code: "AMBIGUOUS_PERSON" }),
    ]);
    expect(plan.ops).toEqual([expect.objectContaining({ kind: "person.create" })]);
  });

  it("dob disambiguates a name collision", () => {
    const snapshot: ImportSnapshot = {
      ...EMPTY,
      persons: [
        { id: "p1", fullName: "Sam Kerr", dob: "2010-01-01", externalRef: null },
        { id: "p2", fullName: "Sam Kerr", dob: "2012-05-05", externalRef: null },
      ],
    };
    const plan = planImport(
      [row({ rowNo: 1, playerFullName: "Sam Kerr", dob: "2012-05-05" })],
      snapshot,
      CONFIG,
    );
    expect(plan.ops).toEqual([]); // matched p2; no roster requested
  });

  it("unknown division ⇒ error DIVISION_NOT_FOUND, never an entrant/roster op", () => {
    const plan = planImport(
      [row({ rowNo: 5, teamName: "U12", playerFullName: "A B", divisionSlug: "nope" })],
      { ...EMPTY, divisions: DIVISIONS },
      CONFIG,
    );
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "error", code: "DIVISION_NOT_FOUND", rowNo: 5 }),
    ]);
    expect(plan.ops.filter((o) => o.kind === "entrant.create" || o.kind === "roster.add")).toEqual([]);
  });

  it("division column matches the display name (case-insensitive), not just the slug", () => {
    // Regression: the Division column instructions show users the display
    // name ("Under 12s"), never the slug ("u12") — a name match must resolve
    // the same division as a slug match, and must not raise DIVISION_NOT_FOUND.
    const plan = planImport(
      [row({ rowNo: 5, teamName: "U12", playerFullName: "A B", divisionSlug: "UNDER 12S" })],
      { ...EMPTY, divisions: DIVISIONS },
      CONFIG,
    );
    expect(plan.issues.filter((i) => i.code === "DIVISION_NOT_FOUND")).toEqual([]);
    expect(plan.ops.some((o) => o.kind === "entrant.create")).toBe(true);
  });

  it("bad position ⇒ error BAD_POSITION and no roster op; valid position normalises to catalog key", () => {
    const bad = planImport(
      [row({ rowNo: 2, teamName: "T", playerFullName: "A B", position: "striker", divisionSlug: "u12" })],
      { ...EMPTY, divisions: DIVISIONS },
      CONFIG,
    );
    expect(bad.issues).toEqual([
      expect.objectContaining({ severity: "error", code: "BAD_POSITION", column: "position" }),
    ]);
    expect(bad.ops.filter((o) => o.kind === "roster.add")).toEqual([]);

    const good = planImport(
      [row({ rowNo: 2, teamName: "T", playerFullName: "A B", position: "GK", divisionSlug: "u12" })],
      { ...EMPTY, divisions: DIVISIONS },
      CONFIG,
    );
    const roster = good.ops.find((o) => o.kind === "roster.add");
    expect(roster).toMatchObject({ after: { positionKey: "gk" } });
  });

  it("empty-spot teams (no players) import fine (Jul3/01 §9)", () => {
    const plan = planImport(
      [row({ rowNo: 1, teamName: "Ghosts", divisionSlug: "u12" })],
      { ...EMPTY, divisions: DIVISIONS },
      CONFIG,
    );
    expect(plan.issues).toEqual([]);
    expect(plan.stats).toMatchObject({ teams: 1, entrants: 1, persons: 0, rosters: 0 });
  });

  it("duplicate player across two teams: one person, two roster rows", () => {
    const plan = planImport(
      [
        row({ rowNo: 1, teamName: "A", playerFullName: "Dana Roe", dob: "2010-02-02", divisionSlug: "u12" }),
        row({ rowNo: 2, teamName: "B", playerFullName: "Dana Roe", dob: "2010-02-02", divisionSlug: "u12" }),
      ],
      { ...EMPTY, divisions: DIVISIONS },
      CONFIG,
    );
    expect(plan.stats).toMatchObject({ persons: 1, rosters: 2, teams: 2 });
  });
});

// Test-local snapshot applier: replays a plan onto a snapshot the way the app
// layer would, minting deterministic ids for created refs.
export function applyPlanToSnapshot(
  plan: ReturnType<typeof planImport>,
  snapshot: ImportSnapshot,
): ImportSnapshot {
  const next: ImportSnapshot = JSON.parse(JSON.stringify(snapshot));
  const ids = new Map<string, string>();
  const resolve = (t: { id: string } | { ref: string }): string =>
    "id" in t ? t.id : ids.get(t.ref)!;
  for (const op of plan.ops) {
    switch (op.kind) {
      case "club.create": {
        const id = `club#${ids.size}`;
        ids.set(op.ref, id);
        next.clubs.push({
          id,
          name: op.after.name,
          shortName: op.after.shortName ?? null,
          externalRef: op.after.externalRef ?? null,
        });
        break;
      }
      case "club.update": {
        const club = next.clubs.find((c) => c.id === op.clubId)!;
        club.shortName = op.after.shortName;
        break;
      }
      case "team.create": {
        const id = `team#${ids.size}`;
        ids.set(op.ref, id);
        next.teams.push({
          id,
          name: op.after.name,
          clubId: op.after.club ? resolve(op.after.club) : null,
        });
        break;
      }
      case "team.link": {
        const team = next.teams.find((t) => t.id === op.teamId)!;
        team.clubId = resolve(op.club);
        break;
      }
      case "person.create": {
        const id = `person#${ids.size}`;
        ids.set(op.ref, id);
        next.persons.push({
          id,
          fullName: op.after.fullName,
          dob: op.after.dob ?? null,
          externalRef: null,
        });
        break;
      }
      case "entrant.create": {
        const id = `entrant#${ids.size}`;
        ids.set(op.ref, id);
        next.entrants.push({
          id,
          divisionId: op.divisionId,
          teamId: resolve(op.after.team),
          memberPersonIds: [],
        });
        break;
      }
      case "roster.add": {
        const entrant = next.entrants.find((e) => e.id === resolve(op.entrant))!;
        entrant.memberPersonIds.push(resolve(op.person));
        break;
      }
    }
  }
  return next;
}
