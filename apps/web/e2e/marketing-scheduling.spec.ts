import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("/scheduling attract-mode board (design/v3/12 §5)", () => {
  test("replay hands over; tap-place works; clash fires; publish flips to player view", async ({
    browser,
  }) => {
    // Reduced motion skips the replay — deterministic start state for e2e.
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/scheduling");

    const chips = page.getByTestId("board-chip");
    await expect(chips).toHaveCount(3);

    // Clash: two fixtures on court 1
    await chips.first().click();
    await page.getByTestId("board-court-0").click();
    await chips.first().click();
    await page.getByTestId("board-court-0").click();
    await expect(page.getByTestId("board-status")).toContainText("Clash!");

    // No publish while clashed; reload and place clean
    await expect(page.getByTestId("board-publish")).toHaveCount(0);
    await page.reload();
    for (const court of [0, 1, 2]) {
      await page.getByTestId("board-chip").first().click();
      await page.getByTestId(`board-court-${court}`).click();
    }
    await page.getByTestId("board-publish").click();
    await expect(page.getByTestId("board-player-view")).toBeVisible();
    await expect(page.getByTestId("board-player-view").getByText("Court 1")).toBeVisible();
    await ctx.close();
  });

  test("replay renders in attract mode with animations enabled", async ({ page }) => {
    await page.goto("/scheduling");
    await expect(page.getByText(/TOUCH TO TAKE OVER/)).toBeVisible();
    // Hands over automatically ≤ ~3.4s
    await expect(page.getByTestId("board-chip").first()).toBeVisible({ timeout: 6000 });
  });

  test("axe: no serious/critical violations on /scheduling", async ({ page }) => {
    await page.goto("/scheduling", { waitUntil: "load" });
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
