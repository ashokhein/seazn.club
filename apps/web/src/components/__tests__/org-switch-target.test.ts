// Org switch lands on the SAME page under the new org (fix for "switching org
// redirects to dashboard"). orgSwitchTarget is the pure path computation; the
// component hard-navigates to it (window.location.assign) to avoid the
// router.push+refresh bounce.
import { describe, it, expect } from "vitest";
import { orgSwitchTarget } from "../org-switcher";

describe("orgSwitchTarget", () => {
  it("stays on the same settings sub-path (Settings → Billing)", () => {
    expect(orgSwitchTarget("/o/riverside/settings/billing", "riverside", "northside")).toBe(
      "/o/northside/settings/billing",
    );
  });

  it("stays on the settings root", () => {
    expect(orgSwitchTarget("/o/riverside/settings", "riverside", "northside")).toBe(
      "/o/northside/settings",
    );
  });

  it("stays on the org home", () => {
    expect(orgSwitchTarget("/o/riverside", "riverside", "northside")).toBe("/o/northside");
  });

  it("falls back to the new org home from a competition/entity path (can't transfer)", () => {
    expect(orgSwitchTarget("/o/riverside/c/spring-cup/d/mens", "riverside", "northside")).toBe(
      "/o/northside",
    );
  });

  it("falls back to the new org home when oldSlug is unknown or the path doesn't match", () => {
    expect(orgSwitchTarget("/somewhere", undefined, "northside")).toBe("/o/northside");
    expect(orgSwitchTarget("/o/other/settings", "riverside", "northside")).toBe("/o/northside");
  });

  it("does not treat a slug-prefix collision as a match (/o/riverside-two)", () => {
    expect(orgSwitchTarget("/o/riverside-two/settings", "riverside", "northside")).toBe(
      "/o/northside",
    );
  });

  it("does not transfer a non-settings path that merely starts with 'settings' (/settingsX)", () => {
    expect(orgSwitchTarget("/o/riverside/settingsX", "riverside", "northside")).toBe("/o/northside");
  });
});
