import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureOfficialsStrip } from "@/components/v2/fixture-officials-strip";

// Task 8 (design v11 §D2): compact assigned-officials strip on the fixture
// console — organiser-only cue. A red "Declined" badge (+ reason tooltip) is
// the signal to re-pick; accepted/pending stay quiet lime/amber chips, same
// grammar as the /me officiating-lane response rail.
describe("FixtureOfficialsStrip (static render)", () => {
  it("shows a red Declined badge with the reason, and does not badge an accepted official as declined", () => {
    const html = renderToStaticMarkup(
      <FixtureOfficialsStrip
        officials={[
          { official_id: "1", name: "Ada", role: "umpire", response: "declined", decline_reason: "away" },
          { official_id: "2", name: "Ben", role: "referee", response: "accepted" },
        ]}
      />,
    );
    expect(html).toContain("Ada");
    expect(html).toMatch(/Declined/);
    expect(html).toContain("away");
    // The accepted official's chip must not itself read "Declined".
    const benChipMatch = html.match(/Ben<\/span>[\s\S]*?<span[^>]*>([^<]*)<\/span>/);
    expect(benChipMatch).not.toBeNull();
    expect(benChipMatch![1]).not.toMatch(/Declined/);
  });

  it("renders nothing when there are no officials", () => {
    const html = renderToStaticMarkup(<FixtureOfficialsStrip officials={[]} />);
    expect(html).toBe("");
  });
});
