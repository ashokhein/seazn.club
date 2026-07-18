import { test, expect } from "@playwright/test";

// pro-plus-tier Task 11: the Pro Plus card is progressively disclosed on the
// marketing pricing page (spec §4) — hidden by default, revealed on click —
// while the comparison table always renders all 4 plan columns regardless.
// Anonymous visitor, no login: the default project storageState is signed-in
// (pro.json), so every test here opens its own fresh, unauthenticated context.

test.describe("pricing page — Pro Plus reveal", () => {
  test("Pro Plus card is hidden until the teaser button is clicked", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto("/en/pricing");

      // Hidden by default: no revealed wrapper, but the teaser + reveal CTA are up.
      await expect(page.locator("[data-plus-revealed]")).toHaveCount(0);
      const teaserCta = page.locator("[data-plus-reveal-cta]");
      await expect(teaserCta).toBeVisible();
      await expect(teaserCta).toHaveText("Show Pro Plus");

      await teaserCta.click();

      const revealed = page.locator("[data-plus-revealed]");
      await expect(revealed).toBeVisible();
      await expect(revealed).toContainText("Pro Plus");
      await expect(revealed).toContainText("$39");
    } finally {
      await ctx.close();
    }
  });

  test("comparison table always carries a Pro Plus column (no click needed)", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto("/en/pricing");

      // Never clicked the reveal button — the 4-column table is unconditional.
      const matrix = page.locator("[data-pricing-matrix]");
      await expect(matrix).toBeVisible();
      await expect(matrix.locator("thead")).toContainText("Pro Plus");
      for (const col of ["Community", "Event Pass", "Pro"]) {
        await expect(matrix.locator("thead")).toContainText(col);
      }
    } finally {
      await ctx.close();
    }
  });
});
