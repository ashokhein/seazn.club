import { test, expect, type Locator } from "@playwright/test";
import { TAG } from "./helpers";

// W1 clubs & teams: the thin Directory → Clubs & Teams list creates a club
// through an in-app inline form (never a native prompt) and lands on the club's
// /clubs/[id] hub, where profile, contacts, teams and squads are managed.
// Names are namespaced (TAG + timestamp) so parallel workers and retries — which
// share the per-run Pro org — never collide on the club-name unique constraint.
const stamp = () => `${TAG}-${Date.now().toString(36)}`;

test("club hub journey: create → profile → squad → entries", async ({ page }) => {
  const clubName = `E2E Hub FC ${stamp()}`;
  const teamName = `E2E Squad ${stamp()}`;
  const playerName = `E2E Nova ${stamp()}`;

  await page.goto("/directory?tab=clubs");

  // Create through the inline form (no window.prompt), land on the club hub.
  await page.getByRole("button", { name: "New club" }).click();
  const nameField = page.getByLabel("Club name");
  await expect(nameField).toBeVisible();
  await nameField.fill(clubName);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/clubs\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: clubName })).toBeVisible();

  // Overview: set the home ground, save (await the PATCH), reload, assert it
  // persisted — the round-trip proves patchClub, not just local state.
  await page.getByLabel("Home ground").fill("Meadow Lane");
  const [patchRes] = await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/v1\/clubs\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === "PATCH",
    ),
    page.getByRole("button", { name: "Save changes" }).click(),
  ]);
  expect(patchRes.status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel("Home ground")).toHaveValue("Meadow Lane");

  // Teams tab: add a team, expand its squad, quick-add a brand-new player, save.
  const tabNav = page.locator("nav", { hasText: "Overview" });
  await tabNav.getByRole("link", { name: "Teams", exact: true }).click();
  await page.getByPlaceholder("Riverside U12").fill(teamName);
  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/v1\/clubs\/[0-9a-f-]+\/teams$/.test(r.url()) && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Add team" }).click(),
  ]);
  const teamToggle = page.getByRole("button", { name: new RegExp(teamName) });
  await expect(teamToggle).toBeVisible();
  await teamToggle.click();

  // The unique name matches no existing person → the inline quick-add appears.
  await page.getByPlaceholder("Find player…").fill(playerName);
  await page.getByRole("button", { name: /as a new player/ }).click();
  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/v1\/teams\/[0-9a-f-]+\/squad$/.test(r.url()) && r.request().method() === "PUT",
    ),
    page.getByRole("button", { name: /Save squad/ }).click(),
  ]);
  await expect(page.getByText(playerName)).toBeVisible();

  // Entries tab: nothing enrolled yet → the read grid shows its empty state.
  await tabNav.getByRole("link", { name: "Entries", exact: true }).click();
  await expect(
    page.getByText(/None of this club's teams are entered in a division yet/i),
  ).toBeVisible();
});

// v3/02 §4 touch-target gate (deferred from Task 8 review to Task 12): the NEW
// interactive controls — the directory New club/New team form, the hub tab
// links, and the squad quick-add — must all clear a 44px tap height on a phone.
test("club controls clear the 44px touch target at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const clubName = `E2E Touch FC ${stamp()}`;
  const teamName = `E2E Touch Squad ${stamp()}`;

  const atLeast44 = async (loc: Locator, label: string) => {
    await expect(loc, `${label} not visible`).toBeVisible();
    const box = await loc.boundingBox();
    expect(box, `${label}: no bounding box`).not.toBeNull();
    expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44);
  };

  // Directory: New club / New team + the inline create form.
  await page.goto("/directory?tab=clubs");
  await atLeast44(page.getByRole("button", { name: "New club" }), "New club button");
  await atLeast44(page.getByRole("button", { name: "New team" }), "New team button");
  await page.getByRole("button", { name: "New club" }).click();
  await atLeast44(page.getByLabel("Club name"), "Club name input");
  await atLeast44(page.getByRole("button", { name: "Create" }), "Create button");
  await atLeast44(page.getByRole("button", { name: "Cancel" }), "Cancel button");

  // Create → hub, then the tab links.
  await page.getByLabel("Club name").fill(clubName);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/clubs\/[0-9a-f-]+/);
  const tabNav = page.locator("nav", { hasText: "Overview" });
  for (const tab of ["Overview", "Teams", "Entries"]) {
    await atLeast44(tabNav.getByRole("link", { name: tab, exact: true }), `${tab} tab link`);
  }

  // Teams tab → expand a team → the quick-add control.
  await tabNav.getByRole("link", { name: "Teams", exact: true }).click();
  await page.getByPlaceholder("Riverside U12").fill(teamName);
  await page.getByRole("button", { name: "Add team" }).click();
  const teamToggle = page.getByRole("button", { name: new RegExp(teamName) });
  await expect(teamToggle).toBeVisible();
  await teamToggle.click();
  await page.getByPlaceholder("Find player…").fill(`E2E NoMatch ${Date.now()}`);
  await atLeast44(page.getByRole("button", { name: /as a new player/ }), "Quick-add button");
});
