import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentsMenu } from "@/components/v2/board/documents-menu";

// The schedule page header carried its own row of five export buttons —
// Timetable PDF, Scoresheets, Rosters, Standings PDF, Participants XLSX —
// duplicating a Documents menu that already existed on the fixtures view.
// Removing that row is only safe if the three exports the menu lacked came
// across with it. These pin the whole set, and the two shapes the move
// introduced: an XLSX-only row (participants has no print edition) and a row
// carrying extra query (standings prints landscape).
//
// Rows are buttons, not links, so the URL is not in the markup — assert on the
// affordances per row instead. Note the sibling documents-menu.test.tsx checks
// hrefs with `not.toContain`, which passes vacuously for exactly that reason.
describe("DocumentsMenu — exports moved off the schedule page", () => {
  const html = renderToStaticMarkup(<DocumentsMenu divisionId="d1" competitionId="c1" />);

  /** The markup for one row, keyed by its visible label. */
  function row(label: string): string {
    const at = html.indexOf(`>${label}<`);
    if (at === -1) return "";
    const start = html.lastIndexOf('<div class="px-3 py-2', at);
    const next = html.indexOf('<div class="px-3 py-2', at);
    return html.slice(start, next === -1 ? undefined : next);
  }

  it("still offers everything the schedule page used to", () => {
    for (const label of [
      "Order of play",
      "Match sheets",
      "Team rosters",
      "Standings",
      "Participants",
    ]) {
      expect(html, `missing row: ${label}`).toContain(`>${label}<`);
    }
  });

  it("offers participants as a spreadsheet only — there is no print edition", () => {
    const participants = row("Participants");
    expect(participants).not.toBe("");
    expect(participants).toContain(">XLSX<");
    expect(participants).not.toContain(">PDF<");
  });

  it("offers rosters and standings as print only", () => {
    for (const label of ["Team rosters", "Standings"]) {
      const r = row(label);
      expect(r, `missing row: ${label}`).not.toBe("");
      expect(r).toContain(">PDF<");
      expect(r).not.toContain(">XLSX<");
    }
  });

  it("keeps both editions on the rows that always had them", () => {
    for (const label of ["Order of play", "Match sheets"]) {
      const r = row(label);
      expect(r).toContain(">PDF<");
      expect(r).toContain(">XLSX<");
    }
  });
});
