// design/fix-ui audit (02-console-org.md, "cookie-consent banner stacks
// directly on a floating help/chat bubble"): on mobile the banner spans
// left-4..right-4 (nearly full viewport width), so even after moving the
// dev-mode route indicator to the opposite corner (next.config.js
// devIndicators.position: "bottom-right"), the banner's own right edge
// would still sit flush against that corner. This checks the banner
// reserves a right-side gutter on mobile instead of running edge-to-edge.
//
// CookieConsent's visible markup only appears after a client effect sets
// state (needsConsentPrompt), and this repo's vitest config runs under
// `environment: "node"` (no jsdom) — so, consistent with the source-contract
// tests elsewhere in this suite (e.g. analytics-bootstrap-contract.test.ts),
// this asserts against the component's source rather than a rendered DOM.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COOKIE_CONSENT = join(__dirname, "..", "cookie-consent.tsx");

describe("CookieConsent mobile positioning clears the dev-indicator corner", () => {
  it("does not run edge-to-edge (right-4) on mobile anymore", () => {
    const source = readFileSync(COOKIE_CONSENT, "utf8");
    const classNameMatch = source.match(/className="([^"]*fixed[^"]*)"/);
    expect(classNameMatch).not.toBeNull();
    const className = classNameMatch![1];
    expect(className).toMatch(/\bleft-4\b/);
    expect(className).not.toMatch(/\bright-4\b/);
    // Reserves a gutter clear of the bottom-right indicator on mobile.
    expect(className).toMatch(/\bright-(1[6-9]|[2-9]\d)\b/);
    // Desktop (sm+) keeps its own bottom-left, auto-width placement.
    expect(className).toMatch(/sm:left-6/);
    expect(className).toMatch(/sm:right-auto/);
  });
});
