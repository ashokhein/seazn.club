import { test, expect } from "@playwright/test";

// v17 SPEC-6 A1: the Pro Plus card is now a full fourth card in the tier ladder
// (the old progressive-disclosure reveal was promoted to a "Popular" hero card),
// while the comparison table still renders all 4 plan columns regardless.
// Anonymous visitor, no login: the default project storageState is signed-in
// (pro.json), so every test here opens its own fresh, unauthenticated context.

test.describe("pricing page — Pro Plus card", () => {
  test("Pro Plus is a full card shown by default, badged Popular with its price", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto("/en/pricing");

      // No reveal step any more — the fourth card is present on load.
      const plusCard = page.locator("[data-plus-card]");
      await expect(plusCard).toBeVisible();
      await expect(plusCard).toContainText("Pro Plus");
      await expect(plusCard).toContainText("$39");
      await expect(plusCard).toContainText("Popular");
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
      // Both Event Pass rungs are their own column since v17 #294.
      for (const col of ["Community", "Event Pass M", "Event Pass L", "Pro"]) {
        await expect(matrix.locator("thead")).toContainText(col);
      }
    } finally {
      await ctx.close();
    }
  });
});
