import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveTicker } from "../live-ticker";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";

const fx = (n: number): DiscoveryLiveFixture => ({
  id: `f${n}`,
  sport_key: "badminton",
  headline: `Falcons 2${n} — Comets 1${n}`,
  strength: null,
  competition_name: `Summer Open ${n}`,
  org_slug: "riverside",
  comp_slug: `summer-${n}`,
  division_slug: "a",
});

describe("LiveTicker", () => {
  it("collapses to nothing when no live fixtures", () => {
    expect(renderToStaticMarkup(<LiveTicker fixtures={[]} />)).toBe("");
  });
  it("links each fixture to its live page (same target as LiveNowStrip)", () => {
    const html = renderToStaticMarkup(<LiveTicker fixtures={[fx(1), fx(2)]} />);
    expect(html).toContain("/shared/riverside/summer-1/a/fixtures/f1");
    expect(html).toContain("Falcons 21 — Comets 11");
    expect(html).toContain("Summer Open 2");
  });
  it("duplicated marquee row is aria-hidden and untabbable", () => {
    const html = renderToStaticMarkup(<LiveTicker fixtures={[fx(1)]} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
  });
  it("tails into /live so a busy day never floods the home strip", () => {
    const html = renderToStaticMarkup(<LiveTicker fixtures={[fx(1)]} />);
    expect(html).toContain('href="/live"');
    expect(html).toContain("All live");
  });
});
