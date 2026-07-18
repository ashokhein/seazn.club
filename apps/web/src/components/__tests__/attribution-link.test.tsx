import { describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({
  EVENTS: { ATTRIBUTION_CLICKED: "attribution_clicked" },
  track,
}));

import { AttributionLink } from "../attribution-link";

// No jsdom/@testing-library/react in this workspace (vitest.config.ts runs
// environment: "node" — see console-link.test.tsx for the established
// pattern): call the component function directly and inspect the returned
// element's props instead of rendering to a DOM.
describe("AttributionLink", () => {
  it("links to /start with surface UTM and fires the event on click", () => {
    const el = AttributionLink({ surface: "badge" });
    expect(el.props.children).toMatch(/run your own free/i);
    expect(el.props.href).toContain("seazn.club/start");
    expect(el.props.href).toContain("utm_source=badge");
    el.props.onClick();
    expect(track).toHaveBeenCalledWith("attribution_clicked", { surface: "badge" });
  });
});
