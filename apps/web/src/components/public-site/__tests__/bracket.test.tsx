// Public bracket (PROMPT-62 §3) — two-sided connected tree for single-elim
// shapes, existing column/ladder rendering as the fallback branch.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Bracket } from "../bracket";

const F = (
  id: string, round: number, seq: number,
  home: string | null, away: string | null,
  outcome: { kind?: string; winner?: string } | null,
  status = "scheduled",
) => ({
  id, division_id: "d", stage_id: "s", pool_id: null, round_no: round,
  seq_in_round: seq, home_entrant_id: home, away_entrant_id: away,
  scheduled_at: null, venue: null, court_label: null, status, outcome,
  summary: outcome ? { headline: "2–0" } : null,
});

const names = { a: "Ants", b: "Bees", c: "Cats", d: "Dogs" };
const href = (id: string) => `/f/${id}`;

describe("public Bracket", () => {
  it("renders the two-sided tree for a knockout: svg connectors + centred final", () => {
    const fixtures = [
      F("f1", 0, 1, "a", "d", { kind: "win", winner: "a" }, "decided"),
      F("f2", 0, 2, "b", "c", null, "in_play"),
      F("f3", 1, 1, "a", null, null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain('data-bracket="two-sided"');
    expect(html).toContain('data-side="center"');
    expect(html).toContain("2–0");
    expect(html).toContain('href="/f/f1"');
  });

  it("keeps the column/ladder branch for stepladder shapes", () => {
    const fixtures = [
      F("f1", 1, 1, "a", "b", null),
      F("f2", 2, 1, null, "c", null),
      F("f3", 3, 1, null, "d", null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "stepladder", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
    );
    expect(html).not.toContain('data-bracket="two-sided"');
    expect(html).toContain("Rung 1");
  });

  it("falls back to columns when a knockout's shape isn't single-elim (partial data)", () => {
    const fixtures = [F("f1", 0, 1, "a", "b", null), F("f2", 0, 2, "c", "d", null), F("f3", 0, 3, "a", "c", null)];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
    );
    expect(html).not.toContain('data-bracket="two-sided"');
  });

  it("renders badge chips in nodes when entrantLogos provides them (F4)", () => {
    const fixtures = [
      F("f1", 0, 1, "a", "d", null),
      F("f2", 0, 2, "b", "c", null),
      F("f3", 1, 1, null, null, null),
    ];
    const logos = { a: "https://flags.example/a.png", b: null };
    const html = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "knockout", fixtures: fixtures as never, entrantNames: names,
        entrantLogos: logos, fixtureHref: href,
      }),
    );
    expect(html).toContain('src="https://flags.example/a.png"');
    // b has no badge and d has no entry — exactly one img chip.
    expect(html.match(/<img/g)?.length).toBe(1);
    const without = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
    );
    expect(without).not.toContain("<img");
  });
});
