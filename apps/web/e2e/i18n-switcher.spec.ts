// Locale switcher (v5 i18n §9). On a marketing [lang] route the footer picker
// swaps the segment and writes the seazn_locale cookie.
import { test, expect } from "@playwright/test";

test("switching to French navigates and sets the cookie", async ({ page, context }) => {
  await page.goto("/en/start");
  await page.getByTestId("locale-switcher").selectOption("fr");
  await expect(page).toHaveURL(/\/fr(\/|$)/);
  const cookie = (await context.cookies()).find((c) => c.name === "seazn_locale");
  expect(cookie?.value).toBe("fr");
});
