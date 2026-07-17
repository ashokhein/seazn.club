import { describe, expect, it } from "vitest";
import { meEmptyState } from "../page";

describe("meEmptyState", () => {
  it("shows the unrostered message when the user has no teams, fixtures, or results", () => {
    expect(meEmptyState(0, 0, 0)).toBe("unrostered");
  });

  it("shows the rostered message once the user has a team but no fixtures yet", () => {
    expect(meEmptyState(0, 0, 1)).toBe("rostered");
  });

  it("shows nothing once fixtures exist, even with no results", () => {
    expect(meEmptyState(1, 0, 1)).toBeNull();
  });

  it("shows nothing once results exist, even with no upcoming fixtures", () => {
    expect(meEmptyState(0, 1, 0)).toBeNull();
  });
});
