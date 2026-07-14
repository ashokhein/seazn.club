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

// Every Track 3 opening must play its whole line to completion. Each step is
// the learner's move plus the SAN the trainer prompts for it — we wait for that
// prompt (which also covers the trainer's auto-reply, and the auto-1.e4 the
// Scandinavian plays before Black's first move) before making the move. Covers
// opponent-ending lines (Italian, Ruy Lopez — the regression), captures
// (Scotch), a learner-ending line (London), and a Black-learner line where the
// trainer moves first (Scandinavian).
const OPENING_WALKTHROUGHS: { day: number; title: string; steps: [string, string, string][] }[] = [
  {
    day: 97,
    title: "The Italian Game",
    steps: [
      ["e2", "e4", "e4"],
      ["g1", "f3", "Nf3"],
      ["f1", "c4", "Bc4"],
    ],
  },
  {
    day: 99,
    title: "The Ruy Lopez",
    steps: [
      ["e2", "e4", "e4"],
      ["g1", "f3", "Nf3"],
      ["f1", "b5", "Bb5"],
    ],
  },
  {
    day: 101,
    title: "The Scotch Game",
    steps: [
      ["e2", "e4", "e4"],
      ["g1", "f3", "Nf3"],
      ["d2", "d4", "d4"],
      ["f3", "d4", "Nxd4"],
    ],
  },
  {
    day: 103,
    title: "The London System",
    steps: [
      ["d2", "d4", "d4"],
      ["g1", "f3", "Nf3"],
      ["c1", "f4", "Bf4"],
    ],
  },
  {
    day: 105,
    title: "The Scandinavian Defense",
    steps: [
      ["d7", "d5", "d5"],
      ["d8", "d5", "Qxd5"],
      ["d5", "a5", "Qa5"],
    ],
  },
];

for (const opening of OPENING_WALKTHROUGHS) {
  test(`Opening Trainer plays ${opening.title} to completion`, async ({ page }) => {
    await page.goto("/games/chess-quest");
    await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
    await page.reload();
    // Launch the opening from its Track 3 lesson.
    await page.getByRole("button", { name: `Day ${opening.day}: ${opening.title}` }).click();
    await page.getByRole("button", { name: /Play the opening/ }).click();
    await expect(page.getByText(new RegExp(opening.title)).first()).toBeVisible();

    for (const [from, to, san] of opening.steps) {
      // Wait for this move to be prompted (covers the trainer's prior auto-move).
      await expect(page.getByText(san, { exact: true }).first()).toBeVisible();
      await page.locator(`[data-square="${from}"]`).click();
      await page.locator(`[data-square="${to}"]`).click();
    }
    await expect(page.getByText(/you played the whole line/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
  });
}

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
