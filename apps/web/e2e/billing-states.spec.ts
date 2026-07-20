import { test, expect, type Page } from "@playwright/test";
import { TAG, apiJson, setOrgSubscriptionSql, setOwnerStaffSql } from "./helpers";

// Subscription lifecycle states Stripe normally owns (trialing, past_due) —
// forced via SQL so the app-wide billing banner and CTAs can be asserted
// without a live Stripe subscription.
//
// ORG BUDGET: owned orgs are a SHARED, run-wide budget. The cap and the
// reasoning live in ONE place — e2e/auth.setup.ts, "ORG BUDGET". This file
// mints two fresh orgs; reuse before adding a third.
test.describe.serial("billing lifecycle states", () => {
  let orgId: string;

  // Superadmin is granted on the SHARED Pro user, so a leak would silently
  // change every later spec in the run. An in-test `finally` is not enough:
  // if an assertion inside the try pushes the test past its timeout,
  // Playwright kills the worker and the finally never runs. afterEach is
  // honoured on timeout, so the flag is revoked either way. Keyed by org id
  // (the flag is written through the org's owner membership).
  const staffOrgIds = new Set<string>();
  async function grantStaff(id: string): Promise<void> {
    staffOrgIds.add(id);
    await setOwnerStaffSql(id, true);
  }
  test.afterEach(async () => {
    for (const id of staffOrgIds) await setOwnerStaffSql(id, false);
    staffOrgIds.clear();
  });

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

  // The dead state: the staff "Extend trial" grant used to write status
  // 'trialing' and a trial_end and nothing else — entitlements resolve on
  // plan_key, so the org sat there labelled trialing with Community's limits.
  // Asserted on an entitlement, not on a badge: the badge was never the bug.
  test("a staff trial grant conveys real Pro, not just a trialing badge", async ({ page }) => {
    const org = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `GrantState ${TAG}`,
    });
    expect(org.status).toBeLessThan(300);
    const grantOrgId = org.data!.id; // POST /api/orgs already activated it

    const newCompetition = (n: string) =>
      apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
        name: `${n} ${TAG}`,
        visibility: "private",
      });

    // Fill Community's active-competition quota until it BITES — the ceiling
    // is plan data (1 today) so it is discovered, not hardcoded. Observing the
    // 402 is what stops the post-grant 201 from proving nothing.
    let blockedAt = 0;
    for (let i = 1; i <= 6 && blockedAt === 0; i++) {
      const res = await newCompetition(`Grant ${i}`);
      if (res.status === 402) {
        expect(res.error?.code).toBe("PAYMENT_REQUIRED");
        blockedAt = i;
      } else {
        expect(res.status).toBe(201);
      }
    }
    expect(blockedAt, "community never hit its competition ceiling").toBeGreaterThan(0);

    await grantStaff(grantOrgId);
    try {
      await page.goto(`/admin/orgs/${grantOrgId}`);
      // Two "Reason (required)" inputs live on this page (comp + trial), so
      // scope to the Extend-trial card: .last() is the innermost div holding
      // the heading, i.e. the card itself rather than a page-level wrapper.
      const trialCard = page
        .locator("div")
        .filter({ has: page.getByRole("heading", { name: "Extend trial", exact: true }) })
        .last();
      await trialCard.getByRole("button", { name: "+14d", exact: true }).click();
      await trialCard.getByPlaceholder("Reason (required)").fill("e2e: grant must convey Pro");
      await trialCard.getByRole("button", { name: "Extend trial", exact: true }).click();
      // router.refresh() lands the grant in the panel — comped_until is what
      // the entitlement resolver honours, so it is the visible receipt.
      await expect(page.getByText(/comped until/i)).toBeVisible({ timeout: 20_000 });
    } finally {
      // Idempotent alongside the hook — revokes immediately so the assertion
      // below runs as a plain owner, not as staff.
      await setOwnerStaffSql(grantOrgId, false);
      staffOrgIds.delete(grantOrgId);
    }

    // The point of the whole task: the very call that was refused above is
    // now allowed, because the grant lifted plan_key.
    const granted = await newCompetition(`Grant ${blockedAt}`);
    expect(granted.status).toBe(201);
  });

  // The admin panel's downgrade preview reads `GET /downgrade`, which — like
  // every other admin route — goes through handler() and comes back wrapped
  // as { ok, data }. The panel used to read `.frozen` off that whole envelope
  // instead of `.data.frozen`, so the click threw inside the async handler
  // and the confirm dialog silently never opened (nothing visibly happens).
  test("staff Preview & downgrade unwraps the freeze-preview envelope and opens the confirm dialog", async ({
    page,
  }) => {
    const org = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `PreviewDowngrade ${TAG}`,
    });
    expect(org.status).toBeLessThan(300);
    const previewOrgId = org.data!.id;

    await grantStaff(previewOrgId);
    try {
      await page.goto(`/admin/orgs/${previewOrgId}`);
      const downgradeCard = page
        .locator("div")
        .filter({ has: page.getByRole("heading", { name: "Downgrade to Free", exact: true }) })
        .last();
      await downgradeCard
        .getByPlaceholder("Reason (required)")
        .fill("e2e: preview must not throw");
      await downgradeCard
        .getByRole("button", { name: "Preview & downgrade", exact: true })
        .click();

      // A fresh org has zero competitions, so the honest preview is the
      // "nothing will freeze" branch — asserting its exact copy proves the
      // envelope was actually unwrapped (frozen: []), not just that some
      // dialog happened to appear.
      const dialog = page.getByRole("alertdialog", { name: "Downgrade to Free — immediately?" });
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await expect(
        dialog.getByText(/within Free limits — nothing will freeze/i),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await setOwnerStaffSql(previewOrgId, false);
      staffOrgIds.delete(previewOrgId);
    }
  });
});
