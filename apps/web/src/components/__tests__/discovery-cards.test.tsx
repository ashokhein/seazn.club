import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscoveryCard, ThisWeekSection } from "../discovery-cards";
import type { DiscoveryEntry } from "@/server/public-site/discovery";

const dict = {
  "discovery.thisWeek": "THISWEEK-XX",
  "discovery.exploreAll": "EXPLORE-XX",
  "discovery.badge.live": "LIVE-XX",
  "discovery.badge.featured": "FEATURED-XX",
  "discovery.by": "PAR {org}",
};

const entry = (over: Partial<DiscoveryEntry> = {}): DiscoveryEntry => ({
  id: "e1",
  name: "Harbor Cup",
  slug: "harbor-cup",
  starts_on: "2026-08-01",
  ends_on: "2026-08-03",
  status: "published",
  city: "Leeds",
  country: "UK",
  tagline: null,
  hero_image_path: null,
  featured: true,
  org_name: "Riverside",
  org_slug: "riverside",
  sports: ["cricket"],
  entrant_count: 12,
  in_play_count: 2,
  next_fixture_at: null,
  ...over,
});

describe("DiscoveryCard / ThisWeekSection i18n", () => {
  it("reads section chrome + badges from the dict and prefixes the explore link with the locale", () => {
    const html = renderToStaticMarkup(
      <ThisWeekSection entries={[entry()]} dict={dict} lang="fr" />,
    );
    expect(html).toContain("THISWEEK-XX");
    expect(html).toContain("EXPLORE-XX");
    expect(html).toContain('href="/fr/discover"');
    expect(html).toContain("LIVE-XX");
    expect(html).toContain("FEATURED-XX");
    // "by {org}" interpolation, and no leftover hardcoded English chrome.
    expect(html).toContain("PAR Riverside");
    expect(html).not.toContain("Happening this week");
    expect(html).not.toContain(">by ");
  });

  it("badges only render when the entry warrants them", () => {
    const html = renderToStaticMarkup(
      <DiscoveryCard entry={entry({ featured: false, in_play_count: 0 })} dict={dict} lang="fr" />,
    );
    expect(html).not.toContain("LIVE-XX");
    expect(html).not.toContain("FEATURED-XX");
  });
});
