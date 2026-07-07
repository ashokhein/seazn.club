import { test, expect } from "@playwright/test";
import { TAG } from "./helpers";

// PROMPT-21 clubs: create a club through the UI and see it listed.
test("create a club and see it in the directory", async ({ page }) => {
  const clubName = `Acme United ${TAG}`;
  // Clubs now live in the unified Directory (People + Clubs tabs).
  await page.goto("/directory?tab=clubs");

  await page.getByRole("textbox").first().fill(clubName);
  await page.getByRole("button", { name: "Add club" }).click();

  await expect(page.getByText(clubName)).toBeVisible();
});
