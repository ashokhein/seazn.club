// Source contract for design/fix-ui audit finding (04-account-public-embed.md,
// "TV slideshow/noticeboard view also shows the floating help FAB, obscuring
// the slide counter"): /slideshow/* is an unattended kiosk display, so the
// dev-mode route indicator must be suppressed entirely there, not just
// repositioned like everywhere else (next.config.js devIndicators.position).
//
// This repo's vitest config runs under `environment: "node"` (no jsdom/
// document), so a real-DOM behavioural test isn't available here — this
// follows the same source-contract pattern as
// analytics-bootstrap-contract.test.ts: it fails if the guard component
// stops removing the indicator, or stops being mounted on the slideshow
// route, either of which would silently bring the bug back.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GUARD = join(__dirname, "..", "..", "components/kiosk-dev-indicator-guard.tsx");
const LAYOUT = join(__dirname, "..", "..", "app/slideshow/layout.tsx");

// Same limited comment-stripping used by analytics-bootstrap-contract.test.ts
// — good enough for these small, string-light source files, and needed here
// because the guard's own docstring legitimately discusses "display: none"
// (explaining why it does real removal instead).
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("kiosk dev-indicator guard (design/fix-ui: slideshow FAB suppression)", () => {
  it("is a client component that removes <nextjs-portal> (the dev indicator's root element)", () => {
    const raw = readFileSync(GUARD, "utf8");
    const source = stripComments(raw);
    expect(raw).toMatch(/^"use client";/m);
    expect(source).toMatch(/nextjs-portal/);
    expect(source).toMatch(/\.remove\(\)/);
    // Real removal, not a hide — a display:none rule would leave the
    // element rendered, which the requirement explicitly rules out.
    expect(source).not.toMatch(/display:\s*none/);
    // Async re-mounts (route changes within /slideshow) must also be caught.
    expect(source).toMatch(/MutationObserver/);
  });

  it("is mounted on the /slideshow/* route tree", () => {
    const source = readFileSync(LAYOUT, "utf8");
    expect(source).toMatch(/KioskDevIndicatorGuard/);
    expect(source).toMatch(/<KioskDevIndicatorGuard\s*\/>/);
  });
});
