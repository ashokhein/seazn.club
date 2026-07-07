import { test, expect } from "@playwright/test";
import { TAG } from "./helpers";

// Core organiser journey: create a competition through the wizard.
test("create a competition via the wizard", async ({ page }) => {
  const name = `Autumn Cup ${TAG}`;
  await page.goto("/competitions/new");
  await expect(page.getByRole("heading", { name: "New competition" })).toBeVisible();

  await page.getByPlaceholder("Summer Championship 2026").fill(name);
  await page.getByRole("button", { name: /create/i }).click();

  // Lands on the competition page (add-division CTA present).
  await expect(page.getByRole("link", { name: /add division/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(name)).toBeVisible();
});
