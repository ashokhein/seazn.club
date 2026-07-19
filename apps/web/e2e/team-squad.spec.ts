import { test, expect } from "@playwright/test";
import { TAG, apiJson } from "./helpers";

// Add a team under a club on its /clubs/[id] hub (Teams tab) and manage the
// persistent squad — no spreadsheet import. Names are namespaced so this spec
// never collides with others sharing the per-run org.
test("add a team to a club and manage its squad", async ({ page }) => {
  const clubName = `Harbour ${TAG}`;
  const teamName = `Squad ${TAG}`;
  const playerName = `Squaddie ${TAG}`;

  const club = (await apiJson<{ id: string }>(page.request, "/api/v1/clubs", "POST", {
    name: clubName,
  })).data!;
  await apiJson(page.request, "/api/v1/persons", "POST", {
    full_name: playerName,
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  });

  // Club hub → Teams tab: add a team directly under the club.
  await page.goto(`/clubs/${club.id}?tab=teams`);
  await page.getByPlaceholder("Riverside U12").fill(teamName);
  await page.getByRole("button", { name: "Add team" }).click();
  const teamToggle = page.getByRole("button", { name: new RegExp(teamName) });
  await expect(teamToggle).toBeVisible();
  // Collapsed by default; the leading-chevron accordion drives aria-expanded.
  await expect(teamToggle).toHaveAttribute("aria-expanded", "false");

  // Expand its squad, add the player, save. The picker shows only the first few
  // matches, so filter to our player first (the shared CI DB holds many).
  await teamToggle.click();
  await expect(teamToggle).toHaveAttribute("aria-expanded", "true");
  await page.getByPlaceholder("Find player…").fill(playerName);
  await page.getByRole("button", { name: `+ ${playerName}` }).click();
  await page.getByRole("button", { name: /Save squad/ }).click();

  // Persisted: reopening the panel (fresh load) still shows the player.
  await page.reload();
  await page.getByRole("button", { name: new RegExp(teamName) }).click();
  await expect(page.getByText(playerName)).toBeVisible();
});
