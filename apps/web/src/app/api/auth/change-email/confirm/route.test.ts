// The email-change confirm redirect must land on the tabbed settings account
// view (/settings?tab=account), not the removed standalone /settings/account
// page. Regression for the settings/account de-duplication.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  // No matching token row → route takes the "invalid" branch without touching
  // sql.begin, so a plain empty-result stub is enough.
  sql: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/lib/auth", () => ({ invalidateUser: vi.fn() }));

import { GET } from "./route";

describe("change-email confirm redirect", () => {
  it("redirects to the tabbed settings account view, not /settings/account", async () => {
    const res = await GET(
      new Request("https://app.test/api/auth/change-email/confirm?token=nope"),
    );
    const loc = res.headers.get("location")!;
    const url = new URL(loc);
    expect(url.pathname).toBe("/settings");
    expect(url.searchParams.get("tab")).toBe("account");
    expect(url.searchParams.get("email_change")).toBe("invalid");
    expect(loc).not.toContain("/settings/account");
  });
});
