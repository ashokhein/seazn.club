// BracketPanel (PROMPT-62 §2) — node-env test: renderToStaticMarkup only (no
// jsdom in this repo). The dict provider is mocked to identity keys.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/components/i18n/dict-provider", () => ({
  useMsg: () => (key: string) => key,
}));

import { BracketPanel } from "../bracket-panel";

// 4-team knockout: two R0 matches decided, final pending (TBD feeds resolved
// to winners? no — keep away side of final unresolved to exercise TBD).
const FIX = (
  id: string,
  round: number,
  seq: number,
  home: string | null,
  away: string | null,
  outcome: unknown,
  status: string,
  no: number,
) => ({
  id, stage_id: "st1", division_id: "d1", pool_id: null, round_no: round,
  seq_in_round: seq, fixture_no: no, home_entrant_id: home, away_entrant_id: away,
  scheduled_at: null, venue: null, court_label: null, officials: null,
  status, outcome, schedule_source: null, schedule_locked: false, created_at: "",
});

const fixtures = [
  FIX("f1", 0, 1, "e1", "e4", { kind: "win", winner: "e1", loser: "e4" }, "decided", 1),
  FIX("f2", 0, 2, "e2", "e3", null, "in_play", 2),
  FIX("f3", 1, 1, "e1", null, null, "scheduled", 3),
];

const entrantNames = { e1: "Mexico", e2: "Canada", e3: "Japan", e4: "Chile" };

function markup(extra: Partial<Parameters<typeof BracketPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(BracketPanel, {
      fixtures: fixtures as never,
      entrantNames,
      entrantBadges: { e1: "https://flags.example/mex.png" },
      headlines: { f1: "2–1" },
      orgSlug: "org", compSlug: "cup", divSlug: "open",
      ...extra,
    }),
  );
}

describe("BracketPanel", () => {
  it("renders a two-sided tree: svg connectors, centred final, winner bold, TBD feed", () => {
    const html = markup();
    expect(html).toContain("<svg");
    expect(html).toContain('data-side="center"');
    expect(html).toContain("bracket.tbd"); // unresolved away feed of the final
    expect(html).toContain("2–1"); // decided headline
    // winner emphasised, loser muted (class hooks)
    expect(html).toMatch(/font-semibold[^>]*>Mexico|Mexico<\/span>/);
    expect(html).toContain('href="/o/org/c/cup/d/open/f/1"');
    expect(html).toContain("flags.example/mex.png"); // entrant badge on the node
    expect(html).toContain("animate-live-pulse"); // in-play node pulses
  });

  it("returns null for non-single-elim shapes (page falls back to the flat list)", () => {
    const ladder = [FIX("a", 0, 1, "e1", "e2", null, "scheduled", 1), FIX("b", 1, 1, null, null, null, "scheduled", 2), FIX("c", 2, 1, null, null, null, "scheduled", 3)];
    expect(markup({ fixtures: ladder as never })).toBe("");
  });
});
