import { describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({
  EVENTS: { PLAYER_STARTED_OWN_ORG: "player_started_own_org" },
  track,
}));

import { RunYourOwnCta } from "../run-your-own-cta";

// No jsdom/@testing-library/react in this workspace (vitest.config.ts runs
// environment: "node" — see attribution-link.test.tsx for the established
// pattern): call the component function directly and inspect the returned
// element's props instead of rendering to a DOM.
describe("RunYourOwnCta", () => {
  it("links to /start and fires the loop event on click", () => {
    const el = RunYourOwnCta({ label: "Run your own tournament — free.", cta: "Start free →" });
    const link = el.props.children[1];
    expect(link.props.children).toBe("Start free →");
    expect(link.props.href).toContain("/start");
    link.props.onClick();
    expect(track).toHaveBeenCalledWith("player_started_own_org", { from: "me" });
  });
});
