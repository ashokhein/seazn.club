import { describe, expect, it } from "vitest";
// next.config.js is wrapped in withSentryConfig for the default export; the
// pre-wrap object is re-exported by name (see image-config.test.ts for the
// same pattern) so this test doesn't depend on Sentry's wrapper shape.
import { nextConfig } from "../../../next.config.js";

describe("devIndicators position", () => {
  it("moves the dev-mode route indicator to bottom-right", () => {
    // design/fix-ui audit, cross-cutting finding #1: the default bottom-left
    // position overlapped primary content/CTAs on marketing, console, and
    // public pages, and stacked on top of the cookie-consent banner (which
    // is anchored bottom-left, see cookie-consent.test.tsx). Regression:
    // without this setting, the indicator reverts to Next's bottom-left
    // default and both bugs come back.
    const devIndicators = (
      nextConfig as { devIndicators?: false | { position?: string } }
    ).devIndicators;
    expect(devIndicators).not.toBe(false);
    expect((devIndicators as { position?: string } | undefined)?.position).toBe(
      "bottom-right",
    );
  });
});
