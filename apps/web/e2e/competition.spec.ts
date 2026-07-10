import { test, expect } from "@playwright/test";
import { TAG, apiJson } from "./helpers";

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

// Settings are organised into tabs (General / Branding / Archived); one form
// spans them, so an unsaved edit must survive a tab switch and save from any
// tab. Showcase stays inline on General (under visibility, which gates it);
// Archived only appears once something is archived.
test("competition settings tabs share one form", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Tabs ${TAG}`,
    visibility: "public",
  });
  await page.goto(`/competitions/${comp.data!.id}/settings`);

  const tablist = page.getByRole("tablist", { name: "Competition settings" });
  await expect(tablist.getByRole("tab", { name: "General" })).toBeVisible({ timeout: 20_000 });
  // Pro org (default storageState) → Branding tab present; nothing archived → no Archived tab.
  await expect(tablist.getByRole("tab", { name: "Branding" })).toBeVisible();
  await expect(tablist.getByRole("tab", { name: /Archived/ })).toHaveCount(0);
  // Showcase sits inline on General, right under visibility.
  await expect(page.getByText("Showcase on seazn.club")).toBeVisible();

  // Edit on General, switch to Branding, save from there.
  const renamed = `Tabs renamed ${TAG}`;
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(renamed);
  await tablist.getByRole("tab", { name: "Branding" }).click();
  await expect(page.getByText("Brand color")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /save settings/i }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // The General edit rode along.
  await page.reload();
  await expect(page.getByRole("heading", { name: new RegExp(renamed) })).toBeVisible();
});
