import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg, failOnNativeDialog } from "./helpers";

// PROMPT-32 acceptance: match-day cards navigate, ConfirmDialog replaced
// window.confirm everywhere, and the visibility picker surfaces the share
// URL with unchanged noindex behaviour.

test("card grid: competition card renders match-day anatomy and navigates", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Card Nav ${TAG}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);

  await page.goto("/dashboard");
  const card = page
    .locator("article")
    .filter({ hasText: `Card Nav ${TAG}` })
    .first();
  await expect(card).toBeVisible();
  // Status chip vocabulary (v3/03 §1): a fresh competition reads "Draft".
  await expect(card.getByText("Draft", { exact: true })).toBeVisible();
  // Whole card is the click target (stretched link).
  await card.getByRole("link", { name: `Card Nav ${TAG}` }).click();
  // PROMPT-30: cards navigate to the slug URL.
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/?]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: `Card Nav ${TAG}` })).toBeVisible();
});

test("destructive action uses ConfirmDialog — a native confirm() fails the test", async ({
  page,
  request,
}) => {
  // Clubs delete is a canonical destructive flow reachable on every plan.
  const club = await apiJson<{ id: string; name: string }>(request, "/api/v1/clubs", "POST", {
    name: `Doomed Club ${TAG}`,
  });
  expect(club.status).toBeLessThan(300);

  failOnNativeDialog(page); // any window.confirm/alert = instant failure
  // Delete moved to the club hub's danger zone (the directory list is read/create only).
  await page.goto(`/clubs/${club.data!.id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  // The app-owned dialog, not the browser's.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/its teams stay/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Delete club" }).click();

  // Confirming lands back on the directory, with the club gone from the list.
  await page.waitForURL(/\/directory\?tab=clubs/);
  await expect(page.getByRole("link", { name: new RegExp(`Doomed Club ${TAG}`) })).toHaveCount(0);
});

test("visibility picker: Link only surfaces a copyable URL; public page stays noindex", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Vis Flip ${TAG}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);
  const orgSlug = (await activeOrg(page)).slug;

  await page.goto(`/competitions/${comp.data!.id}/settings`);
  // Radio cards speak plain language (v3/03 §7).
  await expect(page.getByText("Only your team can see it.")).toBeVisible();
  await page.getByRole("radio", { name: /link only/i }).check();
  // The consequence is immediate: share URL + copy affordance appear.
  await expect(page.getByText(`/shared/${orgSlug}/${comp.data!.slug}`).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /copy link/i })).toBeVisible();
  await page.getByRole("button", { name: /save settings/i }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();

  // Keys/noindex behaviour unchanged: unlisted pages serve a robots noindex.
  const res = await page.request.get(`/shared/${orgSlug}/${comp.data!.slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/noindex/);
});
