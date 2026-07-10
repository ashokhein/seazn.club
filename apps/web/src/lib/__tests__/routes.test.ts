// Route builders (PROMPT-30, v3/01 §2) — the single source of console hrefs.
// ESLint bans string-built console paths; if a URL shape changes, it changes
// here and nowhere else.
import { describe, expect, it } from "vitest";
import { routes } from "@/lib/routes";

describe("routes", () => {
  it("builds the /o hierarchy from slugs", () => {
    expect(routes.orgHome("acme")).toBe("/o/acme");
    expect(routes.orgSettings("acme")).toBe("/o/acme/settings");
    expect(routes.orgSettings("acme", "team")).toBe("/o/acme/settings?tab=team");
    expect(routes.billing("acme")).toBe("/o/acme/settings/billing");
    expect(routes.competitionNew("acme")).toBe("/o/acme/c/new");
    expect(routes.competition("acme", "summer-smash")).toBe("/o/acme/c/summer-smash");
    expect(routes.competitionSettings("acme", "summer-smash")).toBe(
      "/o/acme/c/summer-smash/settings",
    );
    expect(routes.competitionSchedule("acme", "summer-smash")).toBe(
      "/o/acme/c/summer-smash/schedule",
    );
    expect(routes.divisionNew("acme", "summer-smash")).toBe("/o/acme/c/summer-smash/d/new");
    expect(routes.division("acme", "summer-smash", "u16-boys")).toBe(
      "/o/acme/c/summer-smash/d/u16-boys",
    );
    expect(routes.division("acme", "summer-smash", "u16-boys", "fixtures")).toBe(
      "/o/acme/c/summer-smash/d/u16-boys?tab=fixtures",
    );
    expect(routes.divisionSchedule("acme", "summer-smash", "u16-boys")).toBe(
      "/o/acme/c/summer-smash/d/u16-boys/schedule",
    );
    expect(routes.divisionRegistrations("acme", "summer-smash", "u16-boys")).toBe(
      "/o/acme/c/summer-smash/d/u16-boys/registrations",
    );
    expect(routes.fixture("acme", "summer-smash", "u16-boys", 14)).toBe(
      "/o/acme/c/summer-smash/d/u16-boys/f/14",
    );
  });

  it("keeps id-based slideshow and slug-based public builders", () => {
    expect(routes.slideshowCompetition("abc-123")).toBe("/slideshow/competitions/abc-123");
    expect(routes.slideshowDivision("def-456")).toBe("/slideshow/divisions/def-456");
    expect(routes.shared("acme")).toBe("/shared/acme");
    expect(routes.shared("acme", "summer-smash", "u16-boys")).toBe(
      "/shared/acme/summer-smash/u16-boys",
    );
  });
});
