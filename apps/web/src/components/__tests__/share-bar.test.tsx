import { describe, expect, it, beforeEach, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ EVENTS: { SHARE_FIRED: "share_fired" }, track }));

import { shareLinks } from "../share-bar";

describe("shareLinks (ShareBar pure helper)", () => {
  beforeEach(() => {
    track.mockClear();
  });

  it("builds an absolute url and a wa.me link with the encoded title + url", () => {
    const { url, wa } = shareLinks(
      "https://seazn.club",
      "/shared/riverside/spring-cup",
      "Spring Cup",
    );
    expect(url).toBe("https://seazn.club/shared/riverside/spring-cup");
    expect(wa).toBe(
      `https://wa.me/?text=${encodeURIComponent("Spring Cup — https://seazn.club/shared/riverside/spring-cup")}`,
    );
  });
});
