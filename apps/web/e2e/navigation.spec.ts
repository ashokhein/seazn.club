import { test, expect } from "@playwright/test";

// Core navigation smoke: the authed shell + the Jul3 pages render.
test.describe("navigation shell", () => {
  test("dashboard loads with nav", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation")).toBeVisible();
    await expect(page.getByRole("link", { name: "+ New Competition" })).toBeVisible();
  });

  test("unified Directory renders People + Clubs tabs (Jul3/01)", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("heading", { name: "Directory", exact: true })).toBeVisible();
    // Nav collapses People + Clubs into a single Directory item.
    await expect(page.getByRole("link", { name: "Directory" })).toBeVisible();
    // Clubs tab still exposes the Add club affordance.
    await page.getByRole("link", { name: "clubs", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add club" })).toBeVisible();
  });

  test("import participants (Jul3/01) renders with a file input", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Import participants" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });
});
