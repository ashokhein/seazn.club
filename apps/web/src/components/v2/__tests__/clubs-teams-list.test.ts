import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  partitionDirectory,
  type ClubListItem,
  type TeamListItem,
} from "../clubs-teams-list";

const clubs: ClubListItem[] = [
  { id: "c1", name: "Riverside FC", short_name: "RIV", logo_path: null, slug: "riverside-fc", team_count: 3, primary_contact: "Sam Lee" },
  { id: "c2", name: "Northside United", short_name: null, logo_path: null, slug: "northside-united", team_count: 0, primary_contact: null },
];
const teams: TeamListItem[] = [
  { id: "t1", name: "Riverside U12", club_id: "c1", logo_path: null }, // club-attached → hidden (lives on its club hub)
  { id: "t2", name: "Sunday Casuals", club_id: null, logo_path: null }, // standalone → shown
  { id: "t3", name: "Riverside Vets", club_id: null, logo_path: null }, // standalone → shown
];

describe("partitionDirectory", () => {
  it("lists all clubs and only standalone teams when the query is empty", () => {
    const { clubs: c, standalone } = partitionDirectory(clubs, teams, "");
    expect(c.map((x) => x.id)).toEqual(["c1", "c2"]);
    // club-attached team t1 must NOT appear — it lives on its /clubs/[id] hub
    expect(standalone.map((x) => x.id)).toEqual(["t2", "t3"]);
  });

  it("matches clubs by name, case-insensitively", () => {
    expect(partitionDirectory(clubs, teams, "RIVER").clubs.map((x) => x.id)).toEqual(["c1"]);
  });

  it("matches clubs by short name", () => {
    expect(partitionDirectory(clubs, teams, "riv").clubs.map((x) => x.id)).toEqual(["c1"]);
  });

  it("filters standalone teams by name and never resurfaces club-attached teams", () => {
    // "Riverside U12" (t1) matches the query but is club-attached → excluded
    expect(partitionDirectory(clubs, teams, "riverside").standalone.map((x) => x.id)).toEqual(["t3"]);
  });

  it("trims surrounding whitespace on the query so a padded search still matches", () => {
    expect(partitionDirectory(clubs, teams, "  north  ").clubs.map((x) => x.id)).toEqual(["c2"]);
  });
});

// Regression guard (binding constraint + precedent in
// fixture-console-no-native-prompt.test.ts): the create flow must be an in-app
// inline form, never a native window.prompt/alert. No jsdom setup exists here to
// drive the click-through, so a source-level guard is the honest test available.
const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../clubs-teams-list.tsx"),
  "utf8",
);
describe("clubs-teams-list: no native browser dialogs", () => {
  it("never calls window.prompt/confirm or bare alert", () => {
    expect(source).not.toMatch(/window\.(prompt|confirm|alert)\(/);
    expect(source).not.toMatch(/(?<![.\w])prompt\(/);
    expect(source).not.toMatch(/(?<![.\w])alert\(/);
  });
  it("creates clubs and teams through an inline form submit", () => {
    expect(source).toContain("onSubmit={submitCreate}");
  });
});
