import { describe, expect, it } from "vitest";
import { inviteProblem, inviteProblemCode, type InviteRow } from "@/lib/invites";

const base: InviteRow = {
  id: "i1",
  org_id: "o1",
  org_name: "Riverside",
  role: "viewer",
  default_scope: null,
  email: null,
  expires_at: null,
  max_uses: 0,
  used_count: 0,
  revoked: false,
};

describe("inviteProblemCode", () => {
  it("returns null for a valid invite", () => {
    expect(inviteProblemCode(base)).toBeNull();
    expect(inviteProblem(base)).toBeNull();
  });

  it("returns a stable code (not a prose string) per reason", () => {
    expect(inviteProblemCode({ ...base, revoked: true })).toBe("revoked");
    expect(inviteProblemCode({ ...base, expires_at: "2000-01-01T00:00:00Z" })).toBe("expired");
    expect(inviteProblemCode({ ...base, max_uses: 1, used_count: 1 })).toBe("used");
  });

  it("revoked takes precedence over expiry/uses", () => {
    expect(
      inviteProblemCode({ ...base, revoked: true, expires_at: "2000-01-01T00:00:00Z" }),
    ).toBe("revoked");
  });

  it("inviteProblem maps the code to its English string for API responses", () => {
    expect(inviteProblem({ ...base, revoked: true })).toBe("This invite has been revoked");
    expect(inviteProblem({ ...base, max_uses: 1, used_count: 2 })).toBe(
      "This invite has already been used",
    );
  });
});
