// ResultsMatrix (G2) — crosstable markup: rank-ordered axes, home-perspective
// scoreline cells linked to the fixture, shaded diagonal, dot placeholders.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ResultsMatrix } from "../results-matrix";

const FX = (id: string, home: string, away: string, status: string, headline?: string) => ({
  id, division_id: "d", stage_id: "s", pool_id: null, round_no: 1, seq_in_round: 1,
  home_entrant_id: home, away_entrant_id: away, scheduled_at: null, venue: null,
  court_label: null, status, outcome: null,
  summary: headline ? { headline } : null,
});

const names = { a: "Ants United", b: "Bees", c: "Cats" };
const href = (id: string) => `/f/${id}`;

describe("ResultsMatrix", () => {
  it("puts the home-vs-away scoreline in the right cell, linked", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsMatrix, {
        entrantIds: ["a", "b", "c"],
        entrantNames: names,
        fixtures: [FX("f1", "a", "b", "decided", "3–1"), FX("f2", "c", "a", "in_play")] as never,
        fixtureHref: href,
      }),
    );
    expect(html).toContain("data-results-matrix");
    expect(html).toContain(">3–1</a>");
    expect(html).toContain('href="/f/f1"');
    // Live pairing renders the pulse dot, not a score.
    expect(html).toContain("animate-live-pulse");
    // Column headers fall back to initials with the full name as title.
    expect(html).toContain('title="Ants United"');
    expect(html).toContain(">AU<");
    // 3 diagonal cells.
    expect(html.match(/—/g)?.length).toBe(3);
  });

  it("returns nothing for fewer than two entrants", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsMatrix, {
        entrantIds: ["a"],
        entrantNames: names,
        fixtures: [] as never,
        fixtureHref: href,
      }),
    );
    expect(html).toBe("");
  });
});
