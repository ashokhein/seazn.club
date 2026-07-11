import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TheDraw } from "../the-draw";
import { DrawRenderer } from "../draw-renderer";
import type { PreviewPhase } from "@/server/usecases/stages";

const groupsPhases: PreviewPhase[] = [
  { title: "Group stage", sections: [{ title: "Pool A", matches: [{ home: "A", away: "B" }] }] },
  { title: "Knockout", sections: [{ title: "Semi-finals", matches: [{ home: "Seed 1", away: "Seed 4" }] }] },
];

// Node-env render contract for the SSR state; format switching / fetch /
// shuffle interactions are covered by e2e (marketing-home.spec.ts).
describe("TheDraw", () => {
  it("renders the SSR draw with controls and default state", () => {
    const html = renderToStaticMarkup(<TheDraw initialPhases={groupsPhases} />);
    expect(html).toContain("Pool A");
    expect(html).toContain("Group stage");
    // Default entrants shown on the stepper:
    expect(html).toContain("8 teams");
    // All four formats offered:
    for (const label of ["League", "Groups + KO", "Knockout", "Double elim"]) {
      expect(html).toContain(label);
    }
  });

  it("CTA carries format and entrants into /start", () => {
    const html = renderToStaticMarkup(<TheDraw initialPhases={groupsPhases} />);
    expect(html).toContain('data-testid="make-it-real"');
    expect(html).toContain("/start?sport=Badminton&amp;entrants=8&amp;format=groups-knockout");
  });
});

describe("DrawRenderer", () => {
  it("maps single-letter engine labels to club names, leaves seeds alone", () => {
    const html = renderToStaticMarkup(
      <DrawRenderer phases={groupsPhases} names={["Riverside Falcons", "Oakwood Comets"]} />,
    );
    expect(html).toContain("Riverside Falcons");
    expect(html).toContain("Oakwood Comets");
    expect(html).not.toMatch(/>A</);
    expect(html).toContain("Seed 1");
  });
});
