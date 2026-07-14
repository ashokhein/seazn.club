// Pseudolocale audit (v5 i18n §8). Runs only in the dedicated `pseudo`
// Playwright project, which starts the app with SEAZN_PSEUDO=1 (every extracted
// string renders as ⟦…⟧). Any visible text WITHOUT ⟦ markers is a hardcoded
// (un-extracted) string — the test fails and names it. Surfaces are added as
// they're extracted (T8 marketing, T9 public league).
import { test, expect } from "@playwright/test";

const PSEUDO = process.env.SEAZN_PSEUDO === "1";

// Extend as surfaces get extracted. Kept minimal until T8/T9 land their strings.
const SURFACES = ["/", "/pricing"];

test.describe("pseudolocale audit", () => {
  test.skip(!PSEUDO, "runs only in the SEAZN_PSEUDO project");

  for (const path of SURFACES) {
    test(`no hardcoded strings on ${path}`, async ({ page }) => {
      await page.goto(path);
      const hardcoded = await page.locator("main").evaluate((root) => {
        const bad: string[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const txt = (n.textContent ?? "").trim();
          if (!txt) continue;
          // Ignore pure punctuation/digits/symbols; flag any real word text
          // that isn't wrapped in the pseudolocale markers.
          if (/^[\d\s\p{P}\p{S}]+$/u.test(txt)) continue;
          if (!txt.includes("⟦")) bad.push(txt);
        }
        return bad;
      });
      expect(
        hardcoded,
        `hardcoded (un-pseudo'd) text: ${JSON.stringify(hardcoded.slice(0, 8))}`,
      ).toHaveLength(0);
    });
  }
});
