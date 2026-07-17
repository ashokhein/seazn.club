import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentsMenu } from "@/components/v2/board/documents-menu";

// Regression (v12 task 15): the schedule board used to link straight to the
// timetable PDF only. The Documents menu must surface all four matchday
// documents — order of play, match sheets, officials rota (each PDF+XLSX),
// and admit tickets (PDF only, competition-scoped) — each pointing at its
// real export route. <details> content is present in the static markup
// regardless of open/closed state, so no interaction is needed to assert on
// the rows (see stages-panel-*.test.tsx for the same renderToStaticMarkup
// pattern).
describe("DocumentsMenu", () => {
  const html = renderToStaticMarkup(
    <DocumentsMenu divisionId="d1" competitionId="c1" />,
  );

  it("renders the four document rows", () => {
    expect(html).toContain("Order of play");
    expect(html).toContain("Match sheets");
    expect(html).toContain("Officials rota");
    expect(html).toContain("Admit tickets");
  });

  it("links order of play to the timetable export (PDF + XLSX)", () => {
    expect(html).toContain('href="/api/v1/divisions/d1/exports/timetable?format=pdf"');
    expect(html).toContain('href="/api/v1/divisions/d1/exports/timetable?format=xlsx"');
  });

  it("links match sheets to the scoresheet export (PDF + XLSX)", () => {
    expect(html).toContain('href="/api/v1/divisions/d1/exports/scoresheet?format=pdf"');
    expect(html).toContain('href="/api/v1/divisions/d1/exports/scoresheet?format=xlsx"');
  });

  it("links officials rota to the officials_rota export (PDF + XLSX)", () => {
    expect(html).toContain('href="/api/v1/divisions/d1/exports/officials_rota?format=pdf"');
    expect(html).toContain('href="/api/v1/divisions/d1/exports/officials_rota?format=xlsx"');
  });

  it("links admit tickets to the competition-scoped tickets export, PDF only", () => {
    expect(html).toContain('href="/api/v1/competitions/c1/exports/tickets?format=pdf"');
    expect(html).not.toContain('href="/api/v1/competitions/c1/exports/tickets?format=xlsx"');
  });
});
