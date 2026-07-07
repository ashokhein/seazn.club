import { test, expect } from "@playwright/test";
import { TAG } from "./helpers";

// PROMPT-21 bulk import: upload a CSV, see the dry-run preview (the plan), then
// commit. The preview IS the plan — no writes until commit.
test("import wizard: upload CSV → preview → commit", async ({ page }) => {
  const csv = [
    "Club,Team,Player",
    `Riverside ${TAG},Riverside U12 ${TAG},Ada Lovelace ${TAG}`,
    `Riverside ${TAG},Riverside U12 ${TAG},Grace Hopper ${TAG}`,
  ].join("\n");

  await page.goto("/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "participants.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });

  // Dry-run preview appears (grouped by club).
  await expect(page.getByText(`Riverside U12 ${TAG}`)).toBeVisible({ timeout: 20_000 });

  const commit = page.getByRole("button", { name: /commit import/i });
  await expect(commit).toBeEnabled();
  await commit.click();

  // Committed → the wizard shows the effect summary (2 players imported).
  await expect(page.getByRole("heading", { name: "Import committed" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/2 players/)).toBeVisible();
});
