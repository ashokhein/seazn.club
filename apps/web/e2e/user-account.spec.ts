import { test, expect } from "@playwright/test";
import { TAG } from "./helpers";

// Account tab basics that don't consume the email rate budget: display-name
// edit (restored afterwards) and the data export. Change-email and account
// deletion are deliberately NOT covered end-to-end: the confirmation token is
// only delivered by email (no dev fallback), and each attempt spends the
// fail-closed 5/5min email budget CI needs for logins.
test("display name edits persist and the data export downloads", async ({ page }) => {
  await page.goto("/settings?tab=account");
  // The profile form: input placeholder "Your name" + Save.
  const input = page.getByPlaceholder("Your name");
  const originalName = await input.inputValue();

  await input.fill(`Renamed User ${TAG}`);
  // Scope to the profile form (the tab has other Save buttons) and wait for
  // the PATCH to land before reloading.
  const profileForm = page.locator("form").filter({ has: page.getByPlaceholder("Your name") });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/users/me") && r.request().method() === "PATCH"),
    profileForm.getByRole("button", { name: /^Sav/ }).click(),
  ]);
  await page.reload();
  await expect(page.getByPlaceholder("Your name")).toHaveValue(`Renamed User ${TAG}`, {
    timeout: 20_000,
  });

  // Restore so later runs/spec reruns see a stable profile.
  await page.request.patch("/api/users/me", {
    headers: { "Content-Type": "application/json" },
    data: { display_name: originalName || "E2e Pro" },
  });

  // Data export responds with the user's JSON bundle.
  const exported = await page.request.get("/api/users/me/export");
  expect(exported.status()).toBe(200);
  const body = (await exported.json()) as Record<string, unknown>;
  expect(Object.keys(body).length).toBeGreaterThan(0);
});
