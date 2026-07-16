import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveWall } from "../live-wall";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";

const dict = {
  "live.wall.aria": "Live matches",
  "live.wall.emptyTitle": "EMPTY-XX",
  "live.wall.emptyBody": "BODY-XX",
  "live.wall.emptyDiscover": "DISCOVER-XX",
  "live.wall.emptyStart": "START-XX",
  "live.wall.count.one": "{count} EN DIRECT",
  "live.wall.count.other": "{count} EN DIRECT",
  "live.wall.watch": "WATCH-XX",
  "discovery.inPlay": "EN JEU",
};

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
  it("renders every fixture as a scorebug card with its live link + localized chrome", () => {
    const html = renderToStaticMarkup(
      <LiveWall fixtures={[fx(1), fx(2), fx(3)]} dict={dict} lang="fr" />,
    );
    expect(html).toContain("3 EN DIRECT");
    expect(html).toContain("WATCH-XX");
    expect(html).toContain("/shared/harbor/cup-2/a/fixtures/f2");
    expect(html).toContain("141/3 (12.4)");
    expect(html).toContain("Harbor Cup 3");
  });

  it("falls back to the localized 'In play' headline when a fixture has none", () => {
    const html = renderToStaticMarkup(
      <LiveWall fixtures={[{ ...fx(1), headline: null }]} dict={dict} lang="fr" />,
    );
    expect(html).toContain("EN JEU");
  });

  it("empty state is honest — localized, no filler fixtures, locale-prefixed CTAs", () => {
    const html = renderToStaticMarkup(<LiveWall fixtures={[]} dict={dict} lang="fr" />);
    expect(html).toContain("EMPTY-XX");
    expect(html).toContain('href="/fr/discover"');
    expect(html).toContain('href="/fr/start"');
    expect(html).not.toContain("/shared/");
  });
});
