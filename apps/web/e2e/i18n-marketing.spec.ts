// Marketing [lang] routing (v5 i18n §5), proven on /start. Verified manually
// via SSR fetch during T8; this is the CI regression guard.
import { test, expect } from "@playwright/test";

test("localized /fr/start resolves and sets html lang after hydration", async ({ page }) => {
  const res = await page.goto("/fr/start");
  expect(res?.status()).toBe(200);
  // Root layout SSRs lang=en (kept static for ISR); HtmlLang corrects it client-side.
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test("unprefixed /start serves en via rewrite (no redirect)", async ({ page }) => {
  const res = await page.goto("/start");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/start$/); // rewrite, not a redirect to /en/start
});

test("hreflang alternates present for all four locales + x-default", async ({ page }) => {
  await page.goto("/en/start");
  for (const l of ["en", "fr", "es", "nl", "x-default"]) {
    await expect(page.locator(`link[rel="alternate"][hreflang="${l}"]`)).toHaveCount(1);
  }
});

test("unsupported locale 404s", async ({ page }) => {
  const res = await page.goto("/de/start");
  expect(res?.status()).toBe(404);
});
