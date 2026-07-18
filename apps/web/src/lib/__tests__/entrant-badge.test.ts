// PROMPT-60 — one badge resolver for every surface: an entrant's own
// badge_url (external URL or assets-bucket path) wins, then the linked team's
// logo path, then null (callers fall back to the initials monogram).
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://cdn.example");

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let resolveEntrantBadge: typeof import("../entrant-badge").resolveEntrantBadge;
beforeAll(async () => {
  ({ resolveEntrantBadge } = await import("../entrant-badge"));
});

describe("resolveEntrantBadge", () => {
  it("returns an http(s) badge_url verbatim", () => {
    expect(resolveEntrantBadge({ badge_url: "https://flags.example/mex.png" })).toBe(
      "https://flags.example/mex.png",
    );
  });

  it("resolves a storage-path badge_url through the public assets bucket", () => {
    expect(resolveEntrantBadge({ badge_url: "entrant-badges/abc.png" })).toBe(
      "https://cdn.example/storage/v1/object/public/assets/entrant-badges/abc.png",
    );
  });

  it("falls back to the team logo path when badge_url is empty", () => {
    expect(
      resolveEntrantBadge({ badge_url: "  ", team_logo_path: "team-logos/riverside.png" }),
    ).toBe("https://cdn.example/storage/v1/object/public/assets/team-logos/riverside.png");
    expect(resolveEntrantBadge({ badge_url: null, team_logo_path: "team-logos/r.png" })).toContain(
      "team-logos/r.png",
    );
  });

  it("returns null when neither is set (monogram fallback)", () => {
    expect(resolveEntrantBadge({})).toBeNull();
    expect(resolveEntrantBadge({ badge_url: null, team_logo_path: null })).toBeNull();
  });
});
