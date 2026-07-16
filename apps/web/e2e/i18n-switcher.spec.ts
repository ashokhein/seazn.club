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

// The unprefixed home ("/") carries no locale segment, so the proxy rewrites it
// to the cookie's locale and the switcher refreshes in place. Regression for
// two bugs: (1) the proxy hardcoded /en and ignored the cookie, so the page
// stayed English; (2) the picker re-initialized from the path on the refresh
// remount and snapped back to English while the page was already French.
//
// Runs anonymously: signed-in visitors are redirected off "/" to the console,
// so only logged-out visitors ever see the marketing home + its switcher.
test.describe("unprefixed marketing home", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("switching French localizes in place and keeps the picker in sync", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Any sport");
    await page.getByTestId("locale-switcher").selectOption("fr");
    await expect(page).toHaveURL(/\/$/); // no visible redirect — stays on "/"
    await expect(page.locator("h1")).toContainText("N'importe quel sport");
    await expect(page.getByTestId("locale-switcher")).toHaveValue("fr");
    const cookie = (await context.cookies()).find((c) => c.name === "seazn_locale");
    expect(cookie?.value).toBe("fr");
  });

  test("renders the cookie's locale on load, picker included", async ({ page, context }) => {
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    await context.addCookies([{ name: "seazn_locale", value: "es", url: origin }]);
    await page.reload();
    await expect(page.locator("h1")).toContainText("Cualquier deporte");
    await expect(page.getByTestId("locale-switcher")).toHaveValue("es");
  });
});
