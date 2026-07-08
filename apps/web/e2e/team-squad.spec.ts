import { test, expect } from "@playwright/test";
import { TAG, apiJson } from "./helpers";

// Add a team directly under a club and manage its persistent squad, all in the
// Directory → Clubs detail (no spreadsheet import). Names are namespaced so this
// spec never collides with others sharing the per-run org.
test("add a team to a club and manage its squad", async ({ page }) => {
  const clubName = `Harbour ${TAG}`;
  const teamName = `Squad ${TAG}`;
  const playerName = `Squaddie ${TAG}`;

  const club = (await apiJson<{ id: string }>(page.request, "/api/v1/clubs", "POST", {
    name: clubName,
  })).data!;
  void club;
  await apiJson(page.request, "/api/v1/persons", "POST", {
    full_name: playerName,
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  });

  await page.goto("/directory?tab=clubs");
  // Per-row badge control is present for each club in the table.
  await expect(page.getByLabel(`Badge for ${clubName}`)).toBeAttached();
  await page.getByRole("button", { name: clubName }).first().click();

  // Add a team under the club.
  await page.getByPlaceholder("Riverside U12").fill(teamName);
  await page.getByRole("button", { name: "Add team" }).click();
  const teamToggle = page.getByRole("button", { name: new RegExp(teamName) });
  await expect(teamToggle).toBeVisible();
  // Collapsed by default; the leading-chevron accordion drives aria-expanded.
  await expect(teamToggle).toHaveAttribute("aria-expanded", "false");

  // Expand its squad, add a player, save.
  await teamToggle.click();
  await expect(teamToggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: `+ ${playerName}` }).click();
  await page.getByRole("button", { name: /Save squad/ }).click();

  // Persisted: reopening the panel still shows the player in the squad.
  await page.reload();
  await page.getByRole("button", { name: clubName }).first().click();
  await page.getByRole("button", { name: new RegExp(teamName) }).click();
  await expect(page.getByText(playerName)).toBeVisible();
});
