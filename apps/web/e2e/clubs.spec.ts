import { test, expect } from "@playwright/test";
import { TAG } from "./helpers";

// W1 clubs: the thin Clubs & Teams list creates a club through an in-app inline
// form (no native prompt) and lands on the new club's hub, where badges,
// contacts and teams are managed.
test("create a club and land on its hub", async ({ page }) => {
  const clubName = `Acme United ${TAG}`;
  await page.goto("/directory?tab=clubs");

  await page.getByRole("button", { name: "New club" }).click();
  await page.getByLabel("Club name").fill(clubName);
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page).toHaveURL(/\/clubs\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: clubName })).toBeVisible();
});
