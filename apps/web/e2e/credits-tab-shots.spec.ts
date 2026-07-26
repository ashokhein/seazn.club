import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { loginUi, activeOrg, apiJson } from "./helpers";

// Screenshot + axe evidence for moving AI Credits to its own Settings tab
// (fix/ai-credits-tab). Own empty storageState + loginUi (auto-provisions an
// org, which gets a bootstrap credit grant) so it runs with --no-deps.
test.use({ storageState: { cookies: [], origins: [] } });

const SHOTS =
  process.env.CREDITS_SHOTS_DIR ??
  resolve(process.cwd(), "../../.superpowers/sdd/shots/credits-tab");

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

test("AI Credits tab: nav entry, desktop + mobile, axe", async ({ page }) => {
  const email = `credits-${Date.now()}@example.com`;
  await loginUi(page, email, "/");
  // Create + activate a fresh org (bootstrap credit grant fires on creation),
  // so the wallet shows a real balance.
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `Credits Demo ${Date.now()}`,
  });
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  const org = await activeOrg(page);

  // Nav showing the new "AI Credits" tab (desktop settings sidebar).
  await page.goto(`/o/${org.slug}/settings?tab=organization`, { waitUntil: "load" });
  await expect(page.getByRole("link", { name: "AI Credits" })).toBeVisible();
  await shot(page, "settings-nav-desktop");

  // The new page, desktop.
  await page.goto(`/o/${org.slug}/settings/credits`, { waitUntil: "load" });
  await expect(page.getByRole("heading", { level: 1, name: "AI Credits" })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "credits-desktop");

  // axe on /settings/credits (serious/critical only).
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
    "axe serious/critical on /settings/credits",
  ).toEqual([]);

  // Mobile 375px — no horizontal page scroll.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow, "no horizontal page scroll at 375px").toBe(false);
  await shot(page, "credits-mobile-375");
});
