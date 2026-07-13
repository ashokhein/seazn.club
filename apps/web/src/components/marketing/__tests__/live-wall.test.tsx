import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveWall } from "../live-wall";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";

const fx = (n: number): DiscoveryLiveFixture => ({
  id: `f${n}`,
  sport_key: "cricket",
  headline: `14${n}/3 (12.4)`,
  strength: null,
  competition_name: `Harbor Cup ${n}`,
  org_slug: "harbor",
  comp_slug: `cup-${n}`,
  division_slug: "a",
});

describe("LiveWall (/live)", () => {
  it("renders every fixture as a scorebug card with its live link", () => {
    const html = renderToStaticMarkup(<LiveWall fixtures={[fx(1), fx(2), fx(3)]} />);
    expect(html).toContain("3 live now");
    expect(html).toContain("/shared/harbor/cup-2/a/fixtures/f2");
    expect(html).toContain("141/3 (12.4)");
    expect(html).toContain("Harbor Cup 3");
  });

  it("empty state is honest — no filler fixtures, routes to discover/start", () => {
    const html = renderToStaticMarkup(<LiveWall fixtures={[]} />);
    expect(html).toContain("No one");
    expect(html).toContain('href="/discover"');
    expect(html).toContain('href="/start"');
    expect(html).not.toContain("/shared/");
  });
});
