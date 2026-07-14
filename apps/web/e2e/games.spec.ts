import { test, expect } from "@playwright/test";

// Seazn Games surface: listing, player hub, deterministic play-through, 404s,
// subdomain rewrite. No fixtures needed — the registry is static data.

test("games listing renders the Chess Quest card as playable", async ({ page }) => {
  await page.goto("/games");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Chess Quest/ })).toBeVisible();
  await expect(page.getByText("Play →")).toBeVisible();
});

test("chess quest hub lists the mini-games", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await expect(page.getByRole("link", { name: "← Games" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chess Quest" })).toBeVisible();
  // A few of the eight game cards.
  await expect(page.getByRole("heading", { name: "Mate in 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pawn Wars" })).toBeVisible();
});

test("Mate in 1 can be solved end to end", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.getByRole("button", { name: /Mate in 1/ }).click();
  // Puzzle 1 "Sneak down the hallway": Re1–e8 is mate.
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="e8"]').click();
  await expect(page.getByText(/Checkmate/)).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Chess Quest" })).toBeVisible();
  await ctx.close();
});
