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

// Timezone preference: pick a zone, it persists; a bogus zone is rejected by
// the API. No email budget touched.
test("timezone preference persists and the API rejects a bogus zone", async ({ page }) => {
  await page.goto("/settings?tab=account");

  const select = page.getByRole("combobox", { name: "Your timezone" });
  await expect(select).toBeVisible();

  // Preferences form has its own Save; scope to the innermost div holding BOTH
  // the timezone select and its Save button (the select now sits in its own
  // min-w-0 wrapper, so filtering on the select alone lands too narrow).
  const tzForm = page
    .locator("div")
    .filter({ has: select })
    .filter({ has: page.getByRole("button", { name: /^Sav/ }) })
    .last();
  await select.selectOption("Asia/Kolkata");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/users/me") && r.request().method() === "PATCH" && r.ok(),
    ),
    tzForm.getByRole("button", { name: /^Sav/ }).click(),
  ]);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Your timezone" })).toHaveValue(
    "Asia/Kolkata",
    { timeout: 20_000 },
  );

  // The venue-vs-your-time helper copy is present.
  await expect(page.getByText(/venue/i).first()).toBeVisible();

  // API guards the column: a non-IANA zone is a 4xx, not stored.
  const bad = await page.request.patch("/api/users/me", {
    headers: { "Content-Type": "application/json" },
    data: { timezone: "Mars/Phobos" },
  });
  expect(bad.status()).toBeGreaterThanOrEqual(400);
  expect(bad.status()).toBeLessThan(500);

  // Restore to "follow my browser" so reruns start clean.
  await page.request.patch("/api/users/me", {
    headers: { "Content-Type": "application/json" },
    data: { timezone: null },
  });
});
