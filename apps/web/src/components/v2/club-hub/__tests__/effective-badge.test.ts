import { describe, expect, it } from "vitest";
import { effectiveBadge } from "../teams-tab";

// The hub row must mirror team_display_v's fallback: a team wears its own
// badge when set, else the club crest, else nothing — and the UI labels the
// inherited case so "Override club crest" vs the Overview crest control never
// read as the same thing.
describe("effectiveBadge", () => {
  it("prefers the team's own badge and does not mark it inherited", () => {
    expect(effectiveBadge("orgs/o/teams/t.png", "orgs/o/clubs/c.png")).toEqual({
      path: "orgs/o/teams/t.png",
      inherited: false,
    });
  });

  it("falls back to the club crest and marks it inherited", () => {
    expect(effectiveBadge(null, "orgs/o/clubs/c.png")).toEqual({
      path: "orgs/o/clubs/c.png",
      inherited: true,
    });
  });

  it("returns no badge when neither is set", () => {
    expect(effectiveBadge(null, null)).toEqual({ path: null, inherited: false });
  });
});
