import { test, expect } from "@playwright/test";

// The Scalar API reference (v3/08 §3) must render STYLED — the stylesheet is
// a separate package export and shipping without it produces a bare unstyled
// document that reads as "not loading" (bitten 2026-07-11). Asserting on the
// sidebar catches that: Scalar's sidebar only exists as a distinct visible
// column when its CSS is applied.
test("API reference renders the styled Scalar app with a sidebar", async ({ browser }) => {
  const ctx = await browser.newContext(); // public page — no auth
  const page = await ctx.newPage();
  try {
    await page.goto("/developers/reference");

    // Content loaded from /api/v1/openapi.json…
    await expect(page.getByRole("heading", { name: "seazn.club platform API" })).toBeVisible({
      timeout: 30_000,
    });

    // …and the CSS is live: the sidebar nav entry for a tag group exists and
    // occupies a real side column (a nonzero-width element left of the
    // content), which the unstyled fallback never produces.
    const sidebarLink = page
      .locator(".scalar-app aside, .scalar-app .sidebar, [class*=sidebar]")
      .getByText("competitions", { exact: true })
      .first();
    await expect(sidebarLink).toBeVisible();
    const box = await sidebarLink.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x).toBeLessThan(300); // pinned in the left column, not inline prose
  } finally {
    await ctx.close();
  }
});
