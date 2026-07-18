import { test, expect } from "@playwright/test";

// Core navigation smoke: the authed shell + the Jul3 pages render.
test.describe("navigation shell", () => {
  test("dashboard loads with nav", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    // Header CTA is always present and — since the empty-state hero now uses a
    // distinct label ("Create your first competition") — resolves to exactly one
    // element in every board state (strict mode would throw on a collision).
    await expect(page.getByRole("link", { name: "+ New Competition" })).toBeVisible();
  });

  test("unified Directory renders People + Clubs tabs (Jul3/01)", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("heading", { name: "Directory", exact: true })).toBeVisible();
    // Nav collapses People + Clubs into a single Directory item.
    await expect(page.getByRole("link", { name: "Directory" })).toBeVisible();
    // Clubs tab still exposes the Add club affordance.
    await page.getByRole("link", { name: "Clubs", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add club" })).toBeVisible();
  });

  test("import participants (Jul3/01) renders with a file input", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Import participants" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });
});

// Settings de-duplication: the standalone /settings/account page was removed and
// folded into the tabbed settings; Plan & billing keeps its own route.
test.describe("settings shell", () => {
  test("sidebar keeps Platform API and links billing to its own route", async ({ page }) => {
    await page.goto("/settings?tab=account");
    // Regression: the Platform API nav item once vanished during the dedup.
    await expect(page.getByRole("link", { name: "Platform API" })).toBeVisible();
    // Plan & billing owns Stripe reconciliation, so it links out, not a ?tab=.
    // PROMPT-30: billing is org-scoped — /o/[slug]/settings/billing.
    await expect(page.getByRole("link", { name: "Plan & billing" })).toHaveAttribute(
      "href",
      /\/o\/[^/]+\/settings\/billing$/,
    );
  });

  test("account tab carries the Privacy & cookies section (merged from old page)", async ({ page }) => {
    await page.goto("/settings?tab=account");
    await expect(page.getByRole("heading", { name: "Privacy & cookies" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cookie settings" })).toBeVisible();
  });

  test("old standalone /settings/account route is gone (404)", async ({ page }) => {
    const res = await page.goto("/settings/account");
    expect(res?.status()).toBe(404);
  });
});
