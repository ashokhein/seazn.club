import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The home page redirects signed-in users to /dashboard — run signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("marketing home (design/v3/12)", () => {
  test("default draw renders without any interaction", async ({ page }) => {
    await page.goto("/");
    const draw = page.locator("#the-draw");
    await expect(draw.locator("svg[role=img]")).toBeVisible();
    await expect(draw.getByText("GROUP STAGE")).toBeVisible();
    await expect(draw.getByText("QUALIFIERS ADVANCE ↓")).toBeVisible();
    await expect(draw.getByText("🏆")).toBeVisible();
  });

  test("format switch redraws via the public API", async ({ page }) => {
    await page.goto("/");
    const api = page.waitForResponse("**/api/public/format-preview");
    await page.getByRole("radio", { name: "League", exact: true }).click();
    expect((await api).status()).toBe(200);
    await expect(page.locator("#the-draw").getByText("Everyone plays everyone")).toBeVisible();
  });

  test("Make it real carries choices into /start", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("make-it-real").click();
    await expect(page).toHaveURL(/\/start\?sport=Football&entrants=8&format=groups-knockout/);
  });

  test("hero funnel still routes to /start with sport + entrants", async ({ page }) => {
    await page.goto("/");
    await page.locator("form[data-start-funnel] button[type=submit]").click();
    await expect(page).toHaveURL(/\/start\?sport=/);
  });

  test("nav flips from night to solid after the hero", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-mk-nav]")).toHaveClass(/mk-nav-night/);
    await page.locator("#the-draw").scrollIntoViewIfNeeded();
    await expect(page.locator("[data-mk-nav]")).toHaveClass(/mk-nav-solid/);
  });

  test("reveal system fires on scroll (mk-in lands once)", async ({ page }) => {
    await page.goto("/");
    await page.locator("#the-draw").scrollIntoViewIfNeeded();
    await expect(page.locator("#the-draw .mk-reveal.mk-in").first()).toBeVisible();
  });

  test("reduced motion renders end states", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("scorebug")).toBeVisible();
    await expect(page.locator("#the-draw").getByText("GROUP STAGE")).toBeVisible();
    await ctx.close();
  });

  test("floodlit finale renders the three ticket stubs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Pick your season" })).toBeVisible();
    for (const tier of ["Community", "Event Pass", "Pro"]) {
      await expect(page.getByText(tier, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Start your tournament →" })).toBeVisible();
  });

  test("axe: no serious/critical violations on / (v3/11 gap 11)", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
