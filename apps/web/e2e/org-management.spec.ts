import { test, expect } from "@playwright/test";
import { TAG, activeOrg, type OrgInfo } from "./helpers";

// Org administration: rename the active org, create a second org from the
// switcher, and switch between orgs. Runs on the Pro account (community owns
// at most 1 org — orgs.max_owned). The active org lives in the `seazn_org`
// cookie, and every test starts from the storageState snapshot — so activation
// never leaks between tests; only the rename (a DB write) persists.
test.describe.serial("org management", () => {
  let original: OrgInfo;
  let secondOrgName: string;

  test("rename the active org from settings", async ({ page }) => {
    original = await activeOrg(page);
    const newName = `Renamed ${TAG}`;

    await page.goto("/settings");
    // The settings page has other Save buttons — scope to the rename row.
    const renameRow = page.locator("label", { hasText: "Organization name" });
    await renameRow.getByRole("textbox").fill(newName);
    await renameRow.getByRole("button", { name: "Save" }).click();
    // PROMPT-30: renaming regenerates the slug and lands on the new URL —
    // wait for the NEW slug (the old settings URL matches the pattern too).
    await page.waitForURL(
      (u) => u.pathname.endsWith("/settings") && !u.pathname.includes(`/o/${original.slug}`),
      { timeout: 20_000 },
    );

    // Persisted, not just optimistic UI.
    await page.reload();
    await expect(page.getByLabel("Organization name")).toHaveValue(newName, { timeout: 20_000 });
    original = { ...original, name: newName };
  });

  test("create a second org from the switcher", async ({ page }) => {
    secondOrgName = `Second Org ${TAG}`;

    await page.goto("/settings");
    await page.getByRole("button", { name: "Switch organization" }).click();
    await page.getByRole("button", { name: "+ New organization" }).click();
    await page.waitForURL(/\/orgs\/new/, { timeout: 20_000 });

    await page.getByPlaceholder("My Sports Club").fill(secondOrgName);
    await page.getByRole("button", { name: "Create organization" }).click();

    // Creation activates the new org (POST /api/orgs calls setActiveOrgId).
    await expect
      .poll(async () => (await activeOrg(page)).name, { timeout: 20_000 })
      .toBe(secondOrgName);
  });

  test("switch to the second org and back", async ({ page }) => {
    // Fresh context → the setup org is active again (cookie from storageState).
    expect((await activeOrg(page)).id).toBe(original.id);

    // Over to the second org…
    await page.goto("/settings");
    await page.getByRole("button", { name: "Switch organization" }).click();
    await page.getByRole("button", { name: new RegExp(secondOrgName) }).click();
    await expect
      .poll(async () => (await activeOrg(page)).name, { timeout: 20_000 })
      .toBe(secondOrgName);
    // Re-enter through the legacy cookie-following entry point (PROMPT-30:
    // the /o URL owns the page; reloading the old org's URL would show it).
    await page.goto("/settings");
    await expect(page.getByLabel("Organization name")).toHaveValue(secondOrgName, {
      timeout: 20_000,
    });

    // …and back to the original.
    await page.getByRole("button", { name: "Switch organization" }).click();
    await page.getByRole("button", { name: new RegExp(original.name) }).click();
    await expect
      .poll(async () => (await activeOrg(page)).id, { timeout: 20_000 })
      .toBe(original.id);
    await page.goto("/settings");
    await expect(page.getByLabel("Organization name")).toHaveValue(original.name, {
      timeout: 20_000,
    });
  });
});
