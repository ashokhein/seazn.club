// DocModel goldens (Jul3/06, PROMPT-26 acceptance): stable JSON, not pixels.
import { describe, expect, it } from "vitest";
import { buildParticipants, buildRoster, buildStandings, buildTimetable } from "./build.ts";
import { DocModel, type ExportFixture } from "./types.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";

const OPTS = { printedAt: "2026-07-20T09:00:00.000Z" };

const FIXTURES: ExportFixture[] = [
  { id: "f1", at: "2026-07-20T09:00:00Z", court: "Court 1", stageName: "Preliminary", round: 1, home: "A", away: "B" },
  { id: "f2", at: "2026-07-20T09:30:00Z", court: "Court 2", stageName: "Preliminary", round: 1, home: "C", away: "D" },
  { id: "f3", at: null, court: "Court 1", stageName: "Knockout", round: 2, home: "Winner of SF1", away: "Winner of SF2" },
];

describe("buildDocModel goldens (Jul3/06 §2)", () => {
  it("timetable: prelim/KO headings, TBD feeds render labels, footer date input", () => {
    const model = buildTimetable("Summer Cup — Open", FIXTURES, {
      ...OPTS,
      footerNote: "printed 2026-07-20",
    });
    expect(DocModel.parse(model)).toBeTruthy();
    expect(model.meta.printedAt).toBe(OPTS.printedAt); // input, never Date.now()
    expect(model.sections.map((s) => s.subheading)).toEqual(["Preliminary", "Knockout"]);
    const ko = model.sections[1]!.table!.rows[0]!;
    expect(ko).toContain("Winner of SF1"); // unfinished tournament (§7)
    expect(ko[0]).toBe("TBD");
  });

  it("timetable pageBreaks=per_pitch: each court starts a new page", () => {
    const model = buildTimetable("Cup", FIXTURES, { ...OPTS, pageBreaks: "per_pitch" });
    const headings = model.sections.filter((s) => s.heading !== undefined).map((s) => s.heading);
    expect(headings).toEqual(["Court 1", "Court 2"]);
    expect(model.sections.some((s) => s.pageBreakBefore === true)).toBe(true);
  });

  it("landscape standings with metric columns", () => {
    const model = buildStandings(
      "Open — Standings",
      [
        { name: "A", played: 2, won: 2, drawn: 0, lost: 0, points: 6, metrics: { diff: 4, for: 5 } },
        { name: "B", played: 2, won: 0, drawn: 0, lost: 2, points: 0, metrics: { diff: -4, for: 1 } },
      ],
      { ...OPTS, landscape: true, metricColumns: ["for", "diff"] },
    );
    expect(model.sections[0]!.table).toEqual({
      columns: ["#", "Team", "P", "W", "D", "L", "for", "diff", "Pts"],
      rows: [
        [1, "A", 2, 2, 0, 0, 5, 4, 6],
        [2, "B", 2, 0, 0, 2, 1, -4, 0],
      ],
      landscape: true,
    });
  });

  it("roster form: sign-at-start table + signature blocks (13 May)", () => {
    const model = buildRoster(
      "Open — Rosters",
      [{ teamName: "U12", clubName: "Acme SC", players: [{ name: "Ada", dob: "2014-01-01", number: 7 }] }],
      OPTS,
    );
    expect(model.sections[0]).toMatchObject({
      heading: "Acme SC — U12",
      signatures: ["Team captain", "Official"],
    });
    expect(model.sections[0]!.table!.rows[0]).toEqual([7, "Ada", "2014-01-01", ""]);
  });

  it("participants keep Empty-Spot labels (30 Jan)", () => {
    const model = buildParticipants(
      "Participants",
      [{ club: "", team: "", division: "Open", entrant: "Empty Spot 3", player: "", number: null, position: "" }],
      OPTS,
    );
    expect(model.sections[0]!.table!.rows[0]).toContain("Empty Spot 3");
  });

  it("volleyball scoresheet: per-set point columns, signatures, two-per-page (12 Jun)", () => {
    const sections = volleyball.exportTemplates!.scoresheet!(
      { home: "A", away: "B", court: "Court 1", homeColor: "#ff0000" },
      { bestOf: 5, setTo: 25, finalSetTo: 15 } as never,
    );
    const model = DocModel.parse({
      kind: "scoresheet",
      title: "Scoresheets",
      meta: { printedAt: OPTS.printedAt },
      sections,
      pageBreaks: "auto",
    });
    const s = model.sections[0]!;
    expect(s.columnsHint).toBe(2);
    expect(s.signatures).toContain("1st referee");
    expect(s.table!.rows).toHaveLength(10); // 5 sets × 2 teams
    expect(s.table!.rows[0]![2]).toContain("25");
    expect(s.table!.rows[8]![2]).not.toContain("16"); // final set to 15
    expect(s.swatches).toEqual([{ label: "A", color: "#ff0000" }]);
  });
});
