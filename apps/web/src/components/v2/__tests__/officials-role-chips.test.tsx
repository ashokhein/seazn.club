import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { nextOfficialRoles, RoleChipPicker } from "@/components/v2/officials-shared";
import { ALL_OFFICIAL_ROLES } from "@/lib/official-roles";

// v11.1 follow-up: the free-text "Roles (space-separated)" field is replaced
// by a chip toggle group. The transition rule (nextOfficialRoles) is the part
// that must match the server's assertRolesAllowed gate — free plan holds
// exactly one role, so a 2nd pick SWAPS rather than stacks. Pure function, no
// DOM needed to prove it.
describe("nextOfficialRoles (role chip picker transition)", () => {
  it("free plan: first pick selects, second pick SWAPS and reports blocked", () => {
    const first = nextOfficialRoles([], "referee", false);
    expect(first).toEqual({ roles: ["referee"], blocked: false });

    const second = nextOfficialRoles(first.roles, "chair_umpire", false);
    expect(second).toEqual({ roles: ["chair_umpire"], blocked: true });
    // never two roles on free — this is the exact shape the server would 422 on
    expect(second.roles).toHaveLength(1);
  });

  it("free plan: re-picking the already-selected role is a no-op removal guard (keeps >= 1)", () => {
    const out = nextOfficialRoles(["referee"], "referee", false);
    expect(out).toEqual({ roles: ["referee"], blocked: false });
  });

  it("pro plan: toggles add and remove freely, down to a minimum of one", () => {
    const added = nextOfficialRoles(["referee"], "judge", true);
    expect(added).toEqual({ roles: ["referee", "judge"], blocked: false });

    const removed = nextOfficialRoles(added.roles, "referee", true);
    expect(removed).toEqual({ roles: ["judge"], blocked: false });

    // can't drop the last role
    const floor = nextOfficialRoles(["judge"], "judge", true);
    expect(floor).toEqual({ roles: ["judge"], blocked: false });
  });
});

describe("RoleChipPicker (static render)", () => {
  it("renders every suggestion as a chip, with the current value pressed", () => {
    const html = renderToStaticMarkup(
      <RoleChipPicker value={["referee"]} onChange={() => {}} suggestions={ALL_OFFICIAL_ROLES} multiAllowed />,
    );
    for (const role of ALL_OFFICIAL_ROLES) {
      expect(html).toContain(role.replace(/_/g, " "));
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*>\s*referee\s*</);
  });

  it("includes judge and scorer among the suggestions (brief: 'referee, umpire, scorer, judge, etc.')", () => {
    expect(ALL_OFFICIAL_ROLES).toEqual(expect.arrayContaining(["referee", "umpire", "judge", "scorer"]));
  });
});
