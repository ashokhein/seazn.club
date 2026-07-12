import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TheDraw } from "../the-draw";
import { DrawMindmap } from "../draw-mindmap";
import { marketingPreview } from "@/lib/marketing/format-preview";
import { clubNames } from "@/lib/marketing/club-names";

const names = clubNames(8, 1);
const groupsPhases = marketingPreview("groups-knockout", 8);

// Node-env render contract for the SSR state; format switching / fetch /
// shuffle interactions are covered by e2e (marketing-home.spec.ts).
describe("TheDraw", () => {
  it("renders the SSR mind-map with controls and default state", () => {
    const html = renderToStaticMarkup(<TheDraw initialPhases={groupsPhases} />);
    expect(html).toContain("<svg");
    expect(html).toContain("GROUP STAGE");
    expect(html).toContain("8 teams");
    for (const label of ["League", "Groups + KO", "Knockout", "Double elim"]) {
      expect(html).toContain(label);
    }
  });

  it("CTA carries format and entrants into /start", () => {
    const html = renderToStaticMarkup(<TheDraw initialPhases={groupsPhases} />);
    expect(html).toContain('data-testid="make-it-real"');
    expect(html).toContain("/start?sport=Football&amp;entrants=8&amp;format=groups-knockout");
  });
});

describe("DrawMindmap", () => {
  it("draws pools with club names and a bracket with a trophy", () => {
    const html = renderToStaticMarkup(<DrawMindmap phases={groupsPhases} names={names} />);
    expect(html).toContain(names[0]!.slice(0, 12)); // club name text (maybe truncated)
    expect(html).toContain("🏆");
    expect(html).toContain("QUALIFIERS ADVANCE");
    expect(html).toContain("mk-map-edge");
  });

  it("league renders the radial hub", () => {
    const html = renderToStaticMarkup(
      <DrawMindmap phases={marketingPreview("league", 8)} names={names} />,
    );
    expect(html).toContain("Everyone plays everyone");
    expect(html).toContain("7 rounds · 28 matches");
  });
});
