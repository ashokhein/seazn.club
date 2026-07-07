import { test, expect } from "@playwright/test";

// Core navigation smoke: the authed shell + the Jul3 pages render.
test.describe("navigation shell", () => {
  test("dashboard loads with nav", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation")).toBeVisible();
    await expect(page.getByRole("link", { name: "+ New Competition" })).toBeVisible();
  });

  test("clubs directory (Jul3/01) renders", async ({ page }) => {
    await page.goto("/clubs");
    await expect(page.getByRole("heading", { name: "Clubs", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add club" })).toBeVisible();
  });

  test("import participants (Jul3/01) renders with a file input", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Import participants" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });
});
