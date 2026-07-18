import { test, expect } from "@playwright/test";

// Rename regression: the People directory is now "Players" (labels + routes),
// and both the club-badge and player-photo upload controls live inline in their
// respective add forms.
test("directory reads 'Players' and exposes inline image pickers", async ({ page }) => {
  // /people is a back-compat redirect onto the Players tab.
  await page.goto("/people");
  await expect(page).toHaveURL(/\/directory\?tab=players/);
  await expect(page.getByRole("link", { name: "Players" })).toBeVisible();

  // Add-player form carries a photo picker and a "Add player" button.
  await expect(page.getByRole("button", { name: "Add player" })).toBeVisible();
  await expect(page.getByLabel("Player photo")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "consents to public photo" })).toBeVisible();

  // /players resolves to the same tab.
  await page.goto("/players");
  await expect(page).toHaveURL(/\/directory\?tab=players/);

  // Clubs tab: the thin "Clubs & Teams" register exposes a search box and an
  // inline create control (badge/contact editing now lives on the club hub).
  await page.goto("/directory?tab=clubs");
  await expect(page.getByRole("link", { name: "Clubs & Teams" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New club" })).toBeVisible();
  await expect(page.getByPlaceholder("Search clubs and teams…")).toBeVisible();
});
