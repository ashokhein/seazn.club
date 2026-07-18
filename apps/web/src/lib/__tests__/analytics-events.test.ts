import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/analytics-events";

describe("PLG growth events", () => {
  it("exposes the loop event names", () => {
    expect(EVENTS.ATTRIBUTION_CLICKED).toBe("attribution_clicked");
    expect(EVENTS.SHARE_FIRED).toBe("share_fired");
    expect(EVENTS.PLAYER_STARTED_OWN_ORG).toBe("player_started_own_org");
    expect(EVENTS.COMPETITION_MADE_PUBLIC).toBe("competition_made_public");
    expect(EVENTS.EMBED_RENDERED).toBe("embed_rendered");
  });
});
