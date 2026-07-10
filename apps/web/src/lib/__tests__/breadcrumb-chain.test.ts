// Breadcrumb chain derivation (v3/01 §3): trail from pathname + name maps,
// each level linked, names fall back to humanized slugs, fixture crumbs
// send the division link back to the fixtures tab.
import { describe, expect, it } from "vitest";
import { buildCrumbs } from "@/lib/breadcrumb-chain";

const names = {
  comps: { "summer-smash": "Summer Smash 2026" },
  divs: { "summer-smash/u16-boys": "U16 Boys" },
};
const base = { orgName: "Acme Sports", names };

describe("buildCrumbs", () => {
  it("derives the full org › comp › div › page chain", () => {
    expect(
      buildCrumbs({ ...base, pathname: "/o/acme/c/summer-smash/d/u16-boys/schedule" }),
    ).toEqual([
      { label: "Acme Sports", href: "/o/acme" },
      { label: "Summer Smash 2026", href: "/o/acme/c/summer-smash" },
      { label: "U16 Boys", href: "/o/acme/c/summer-smash/d/u16-boys" },
      { label: "Schedule", href: "/o/acme/c/summer-smash/d/u16-boys/schedule" },
    ]);
  });

  it("labels fixtures as Match {no} and points the division back at fixtures", () => {
    const crumbs = buildCrumbs({
      ...base,
      pathname: "/o/acme/c/summer-smash/d/u16-boys/f/14",
    });
    expect(crumbs[2]).toEqual({
      label: "U16 Boys",
      href: "/o/acme/c/summer-smash/d/u16-boys?tab=fixtures",
    });
    expect(crumbs[3]).toEqual({
      label: "Match 14",
      href: "/o/acme/c/summer-smash/d/u16-boys/f/14",
    });
  });

  it("humanizes slugs missing from the name maps", () => {
    const crumbs = buildCrumbs({ ...base, pathname: "/o/acme/c/spring-open" });
    expect(crumbs[1]!.label).toBe("Spring open");
  });

  it("covers settings, billing and create pages", () => {
    expect(buildCrumbs({ ...base, pathname: "/o/acme/settings/billing" }).map((c) => c.label))
      .toEqual(["Acme Sports", "Settings", "Plan & billing"]);
    expect(buildCrumbs({ ...base, pathname: "/o/acme/c/new" }).map((c) => c.label))
      .toEqual(["Acme Sports", "New competition"]);
    expect(
      buildCrumbs({ ...base, pathname: "/o/acme/c/summer-smash/d/new" }).map((c) => c.label),
    ).toEqual(["Acme Sports", "Summer Smash 2026", "New division"]);
  });

  it("returns only the org crumb on org home and [] off-console", () => {
    expect(buildCrumbs({ ...base, pathname: "/o/acme" })).toHaveLength(1);
    expect(buildCrumbs({ ...base, pathname: "/pricing" })).toEqual([]);
  });
});
