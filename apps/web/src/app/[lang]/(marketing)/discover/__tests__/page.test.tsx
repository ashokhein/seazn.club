import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiscoveryEntry } from "@/server/usecases/public";

// PLG task 6: /discover must funnel fans → organisers via /start (not /login)
// and surface a live "N clubs live now" counter when entries exist. Keep the
// shell to a no-op passthrough (its nav/footer are their own async server
// components and would otherwise thenable-leak into renderToStaticMarkup).
vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/server/public-site/discovery", () => ({
  getDiscoveryDirectory: vi.fn(),
  listDiscoverySports: vi.fn(async () => []),
}));

import { getDiscoveryDirectory } from "@/server/public-site/discovery";
import DiscoverPage from "../page";

const ENTRY: DiscoveryEntry = {
  id: "comp-1",
  name: "Riverside Cup",
  slug: "riverside-cup",
  starts_on: null,
  ends_on: null,
  status: "live",
  city: null,
  country: null,
  tagline: null,
  hero_image_path: null,
  featured: false,
  org_name: "Riverside CC",
  org_slug: "riverside",
  sports: ["cricket"],
  entrant_count: 8,
  in_play_count: 1,
  next_fixture_at: null,
};

async function renderDiscover(lang: "en" | "fr") {
  const el = await DiscoverPage({
    params: Promise.resolve({ lang }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(el);
}

describe("/discover — PLG organiser funnel", () => {
  it("empty state: CTA links to /start (not /login), no counter shown", async () => {
    vi.mocked(getDiscoveryDirectory).mockResolvedValue([]);
    const html = await renderDiscover("en");
    expect(html).not.toContain("/login");
    expect(html).toContain("/en/start?utm_source=discover&amp;utm_medium=directory&amp;utm_campaign=plg");
  });

  it("non-empty state: shows the live club count and a /start CTA", async () => {
    vi.mocked(getDiscoveryDirectory).mockResolvedValue([ENTRY]);
    const html = await renderDiscover("en");
    expect(html).not.toContain("/login");
    expect(html).toContain("/en/start?utm_source=discover&amp;utm_medium=directory&amp;utm_campaign=plg");
    // 1 entry -> singular form of the count string, real number not hardcoded.
    expect(html).toContain("1 club live right now");
  });

  it("non-empty state (fr): uses the localized plural count string", async () => {
    vi.mocked(getDiscoveryDirectory).mockResolvedValue([ENTRY, { ...ENTRY, id: "comp-2" }]);
    const html = await renderDiscover("fr");
    expect(html).toContain("/fr/start?utm_source=discover&amp;utm_medium=directory&amp;utm_campaign=plg");
    expect(html).toContain("2 clubs en direct actuellement");
  });
});
