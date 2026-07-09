import { test, expect } from "@playwright/test";

// Sign-out clears the session: the nav action logs out and protected pages
// bounce to /login afterwards. Cookie changes stay inside this test's context,
// so the shared storage state is untouched for later specs.
test("sign out ends the session and protects organiser pages", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("navigation")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/dashboard"), { timeout: 20_000 });

  // The session cookie is gone — organiser pages now redirect to login.
  await page.goto("/dashboard");
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await expect(page.getByText(/sign.?in/i).first()).toBeVisible();
});
