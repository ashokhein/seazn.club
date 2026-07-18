import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ EVENTS: { SHARE_FIRED: "share_fired" }, track }));

import { shareLinks, ShareBar } from "../share-bar";

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

describe("ShareBar hydration safety", () => {
  const origNav = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: origNav,
      configurable: true,
      writable: true,
    });
  });

  it("omits the native-share button on first render even when navigator.share is present (avoids hydration mismatch)", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { share: () => {} },
      configurable: true,
      writable: true,
    });

    const html = renderToStaticMarkup(<ShareBar path="/x" title="Y" />);

    expect(html).not.toContain('data-testid="native-share"');
    expect(html).toContain("WhatsApp");
  });
});
