import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// At 390px the schedule tab strip needed 447px inside a 358px box, and an
// ancestor sets `overflow-x: clip` — so it did not scroll, it truncated. The
// last tab (History) was simply unreachable on a phone.
//
// The division page already had the right treatment; the schedule and
// directory pages never got it. Asserted as source text because these are
// server components whose nav is plain markup — there is no jsdom here to
// measure with, and the failure mode is a missing class rather than a
// computed width.
const ROOT = join(process.cwd(), "src/app");
const PAGES_WITH_TAB_STRIPS = [
  "o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx",
  "o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx",
  "directory/page.tsx",
];

describe("console tab strips survive a narrow viewport", () => {
  for (const rel of PAGES_WITH_TAB_STRIPS) {
    it(`${rel} scrolls its tabs rather than clipping them`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const nav = src.match(/<nav className="([^"]*)"/)?.[1];
      expect(nav, "no <nav> found — did the tab strip move?").toBeDefined();
      // scroll-x is the repo's overflow-x-auto helper; without it the strip
      // inherits the page's overflow-x: clip and loses its last tab.
      expect(nav).toContain("scroll-x");
      // Tabs must not wrap into a second row instead of scrolling.
      expect(nav).toContain("whitespace-nowrap");
    });
  }
});
