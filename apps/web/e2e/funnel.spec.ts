import { test, expect } from "@playwright/test";
import { PROD_TARGET, TAG } from "./helpers";

// The funnel flow hinges on the dev-exposed claim link ([data-claim-url]) —
// production targets (e.g. staging) email it instead, so skip there.
test.skip(PROD_TARGET, "dev claim-link exposure is disabled on production targets");

// PROMPT-36 (v3/07 §6): the /start funnel end-to-end — a fresh anonymous
// visitor configures a competition, receives the claim link (dev exposes it
// like the magic-link login_url), and one click lands them signed-in inside
// the created competition on the entrants tab. Fresh context per test: the
// funnel must never depend on an existing session.

test("wizard → claim link → inside the created competition", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const name = `Funnel E2E ${TAG}`;
  try {
    // Hero form params prefill step 1.
    await page.goto("/start?sport=Badminton&entrants=8");
    const wizard = page.locator("[data-start-wizard]");
    await expect(wizard).toBeVisible();
    // Scope to the wizard — the marketing footer carries a second <select>
    // (locale switcher), which trips strict mode on a bare page.locator.
    await expect(wizard.locator("select")).toHaveValue("Badminton");

    await page.getByLabel("Competition name").fill(name);
    await page.getByRole("button", { name: /recommend a format/i }).click();

    // Step 2: the live recommendation strip (pure recommendFormats) renders
    // ranked options; keep the best fit.
    await expect(page.getByText("Best fit")).toBeVisible();
    await page.getByRole("button", { name: /looks right/i }).click();

    // Step 3: email capture → draft + dev claim link.
    await page.getByLabel("Your email").fill(`e2e-funnel-${TAG}@example.com`);
    await page.getByRole("button", { name: /email me the link/i }).click();
    const claim = page.locator("[data-claim-url]");
    await expect(claim).toBeVisible({ timeout: 20_000 });
    const claimUrl = await claim.getAttribute("data-claim-url");
    expect(claimUrl).toBeTruthy();

    // The single link signs in AND creates org + competition + division.
    await page.goto(claimUrl!);
    await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/[^/?]+\?tab=entrants/, { timeout: 30_000 });
    await expect(page.locator("body")).toContainText(name);

    // Single-use: revisiting the link fails cleanly with a way forward.
    await page.goto(claimUrl!);
    await expect(page.locator("[data-funnel-claim]")).toContainText(/didn.t work/i, {
      timeout: 20_000,
    });
  } finally {
    await ctx.close();
  }
});
