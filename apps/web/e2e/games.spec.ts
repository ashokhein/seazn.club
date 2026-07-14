import { test, expect } from "@playwright/test";

// Seazn Games surface: listing, quest hub, lesson→game launch + persistence,
// free-play arcade, 404s, subdomain rewrite. No fixtures — static registry +
// localStorage.

test("games listing renders the Chess Quest card as playable", async ({ page }) => {
  await page.goto("/games");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Chess Quest/ })).toBeVisible();
  await expect(page.getByText("Play →")).toBeVisible();
});

test("quest hub shows the map and the Day 1 lesson", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await expect(page.getByText("First Steps")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Board Land" })).toBeVisible();
});

test("marking a day done persists across a reload", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await page.getByRole("button", { name: /Mark day done/ }).click();
  await expect(page.getByRole("button", { name: /Done — undo/ })).toBeVisible();
  await page.reload();
  // Day 1 stays done — its map stop shows a check.
  await expect(page.getByRole("button", { name: "Day 1: Board Land" })).toHaveText("✓");
});

test("a lesson launches its mini-game", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.getByRole("button", { name: /Play Square Race/ }).click();
  await expect(page.getByRole("button", { name: /Back to quest/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Square Race" })).toBeVisible();
});

test("free-play arcade lists the eight games and one solves", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.getByRole("button", { name: "Free play" }).click();
  await expect(page.getByRole("heading", { name: "Mate in 1" })).toBeVisible();
  await page.getByRole("button", { name: /Mate in 1/ }).click();
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="e8"]').click();
  await expect(page.getByText(/Checkmate/)).toBeVisible();
});

test("an Opening Trainer lesson launches and takes the first move", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await page.getByRole("button", { name: "Free play" }).click();
  await page.getByRole("button", { name: /Opening Trainer/ }).click();
  await expect(page.getByText(/The Italian Game/)).toBeVisible();
  // First learner move in the Italian: e2–e4.
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator('[data-square="e4"]')).toHaveAttribute("aria-label", /white pawn/);
});

test("unknown game slug 404s", async ({ page }) => {
  const res = await page.goto("/games/not-a-game");
  expect(res?.status()).toBe(404);
});

test("games.* host serves the games tree", async ({ browser }) => {
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-host": "games.seazn.club" },
  });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await page.goto("/chess-quest");
  await expect(page.getByRole("banner").getByRole("heading", { name: "Chess Quest" })).toBeVisible();
  await ctx.close();
});
