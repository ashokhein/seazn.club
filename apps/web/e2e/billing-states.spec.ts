import { test, expect, type Page } from "@playwright/test";
import { TAG, apiJson, setOrgSubscriptionSql } from "./helpers";

// Subscription lifecycle states Stripe normally owns (trialing, past_due) —
// forced via SQL so the app-wide billing banner and CTAs can be asserted
// without a live Stripe subscription.
//
// ORG BUDGET: pro caps owned orgs at 5 (orgs.max_owned) and the whole run
// shares one Pro user — setup(1) + billing.spec(2) + this file(1) +
// org-management(1) = 5, exactly at the cap. Reuse the single org here; do
// not add per-test orgs without retiring one elsewhere.
test.describe.serial("billing lifecycle states", () => {
  let orgId: string;

  async function activate(page: Page): Promise<void> {
    // Each test starts from the storageState snapshot (setup org active) —
    // re-point the context at this suite's org.
    const res = await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgId });
    expect(res.status).toBeLessThan(300);
  }

  test("trialing org sees the trial countdown and add-card CTA", async ({ page }) => {
    const org = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `BillState ${TAG}`,
    });
    expect(org.status).toBeLessThan(300);
    orgId = org.data!.id; // POST /api/orgs already activated it
    const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    await setOrgSubscriptionSql(orgId, { plan_key: "pro", status: "trialing", trial_end: trialEnd });

    await page.goto("/dashboard");
    await expect(page.getByText(/day(s)? left (on|in) your Pro trial/)).toBeVisible({
      timeout: 20_000,
    });
    // ≤7 days shows "Add a payment method →", >7 days "Add a card to keep Pro →".
    await expect(
      page.getByRole("link", { name: /add a (payment method|card to keep pro)/i }),
    ).toBeVisible();

    // The billing page mirrors the state.
    await page.goto("/settings/billing");
    await expect(page.getByText("trialing")).toBeVisible({ timeout: 20_000 });
  });

  test("past-due org sees the payment-failed banner", async ({ page }) => {
    await activate(page);
    await setOrgSubscriptionSql(orgId, { plan_key: "pro", status: "past_due" });

    await page.goto("/dashboard");
    await expect(page.getByText(/payment failed — your subscription is past due/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("link", { name: /update payment/i })).toBeVisible();

    await page.goto("/settings/billing");
    await expect(page.getByText(/past.due/i).first()).toBeVisible({ timeout: 20_000 });
  });
});
