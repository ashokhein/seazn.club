import { test, expect } from "@playwright/test";

// Seazn Games surface (Phase A): listing, player page, 404s, subdomain
// rewrite. No fixtures needed — the registry is static data.

test("games listing renders registry cards", async ({ page }) => {
  await page.goto("/games");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await expect(page.getByText("Chess Quest")).toBeVisible();
  await expect(page.getByText("Coming soon")).toBeVisible();
});

test("coming-soon game shows teaser, not a dead page", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await expect(page.getByText("Chess Quest is coming soon")).toBeVisible();
  await expect(page.getByRole("link", { name: "← Games" })).toBeVisible();
});

test("unknown game slug 404s", async ({ page }) => {
  const res = await page.goto("/games/not-a-game");
  expect(res?.status()).toBe(404);
});

test("games.* host serves the games tree", async ({ browser }) => {
  // The proxy prefers x-forwarded-host, which is what Fly sets in production.
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-host": "games.seazn.club" },
  });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await page.goto("/chess-quest");
  await expect(page.getByText("Chess Quest is coming soon")).toBeVisible();
  await ctx.close();
});
