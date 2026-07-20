import { test, expect, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  setOrgPlanBySql,
  setOrgSubscriptionSql,
} from "./helpers";

// Billing lifecycle. Runs on the Pro account but against FRESH orgs (new orgs
// start on community), so nothing here disturbs the setup org's Pro plan and
// no extra magic links are spent.
//
// Two sharp edges this file navigates:
//  - The active org lives in the `seazn_org` cookie. Every Playwright test gets
//    a fresh context from the storageState file, so activation does NOT carry
//    across tests; and the `request` fixture is a SEPARATE cookie jar from the
//    page. All org mutations therefore go through `page.request` (shares the
//    page's jar) and each test re-activates the org it needs.
//  - Owned orgs are a SHARED, run-wide budget (orgs.max_owned). The cap and
//    the reasoning live in ONE place — e2e/auth.setup.ts, "ORG BUDGET". This
//    file mints three fresh orgs; reuse before adding a fourth.
//
// Stripe-dependent tests probe the checkout endpoint and skip cleanly when
// Stripe isn't configured (same spirit as scripts/smoke.ts).
test.describe.serial("billing", () => {
  let orgA: string; // stays community (checkout-facing tests)

  async function createFreshOrg(page: Page): Promise<string> {
    const org = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `Billing ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    });
    expect(org.status).toBeLessThan(300);
    return org.data!.id; // POST /api/orgs also activates the new org
  }

  async function activate(page: Page, orgId: string): Promise<void> {
    const res = await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgId });
    expect(res.status).toBeLessThan(300);
  }

  test("a fresh org lands on Community with the trial CTA", async ({ page }) => {
    orgA = await createFreshOrg(page);
    await page.goto("/settings/billing");
    await expect(page.getByText("community", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /start free trial/i })).toBeVisible();
    // Usage card reflects plan limits ("✓ 2 active competitions" also exists
    // in the plan-comparison card — exact match dodges it).
    await expect(page.getByText("Active competitions", { exact: true })).toBeVisible();
  });

  test("upgrade click mounts the embedded Stripe checkout", async ({ page }) => {
    await activate(page, orgA);

    // Probe: the server tells us whether Stripe is usable (500 = no key,
    // 503 = prices not synced). Skip instead of failing half-configured envs.
    const probe = await apiJson<{ client_secret?: string }>(
      page.request,
      "/api/billing/checkout",
      "POST",
      { plan_key: "pro", interval: "monthly" },
    );
    test.skip(probe.status >= 500, "Stripe not configured — skipping");
    expect(probe.status).toBe(200);
    expect(probe.data?.client_secret).toBeTruthy();

    await page.goto("/settings/billing");
    await page.getByRole("button", { name: /start free trial/i }).click();
    // Embedded checkout mounts an iframe once the client_secret resolves.
    await expect(page.locator('iframe[src*="stripe.com"]').first()).toBeVisible({
      timeout: 30_000,
    });
    // Unmount so the page is left clean — checkout lives in a Modal (Task 8);
    // its close control is the "×" button carrying aria-label="Close", same
    // as the "opens checkout in a modal" test below.
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  });

  test("full checkout via the Stripe test flow", async ({ page }) => {
    test.skip(process.env.E2E_STRIPE_FULL !== "1", "set E2E_STRIPE_FULL=1 to run full checkout");
    test.setTimeout(180_000);
    await activate(page, orgA);

    await page.goto("/settings/billing");
    await page.getByRole("button", { name: /start free trial/i }).click();
    const frame = page.frameLocator('iframe[src*="stripe.com"]').first();

    // 14-day no-card trial (payment_method_collection: if_required) — Stripe
    // usually only asks for an email before "Start trial". Fill what's shown.
    const email = frame.getByLabel(/email/i).first();
    if (await email.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await email.fill(`e2e-checkout-${TAG}@example.com`);
    }
    const card = frame.getByPlaceholder(/1234 1234/).first();
    if (await card.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await card.fill("4242424242424242");
      await frame.getByPlaceholder(/MM \/ YY/i).fill("12/34");
      await frame.getByPlaceholder(/CVC/i).fill("123");
      const name = frame.getByLabel(/name/i).first();
      if (await name.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await name.fill("E2E Test");
      }
    }
    await frame.getByRole("button", { name: /start trial|subscribe|pay/i }).click();

    // The return URL lands back on the billing page, which reconciles the
    // session server-side (reconcileCheckout) even without webhooks.
    await page.waitForURL(/settings\/billing\?checkout=success/, { timeout: 120_000 });
    await expect(page.getByText("pro", { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test("comped Pro downgrade freezes over-quota competitions", async ({ page }) => {
    const orgB = await createFreshOrg(page);
    // Comp the org straight away — before any entitlement read warms the cache
    // with community values. No stripe_subscription_id → DowngradeButton shows.
    await setOrgPlanBySql({ orgId: orgB }, "pro");

    // Three active competitions — one over the community ceiling of 2. Each
    // gets a division so the freeze has a write surface to block.
    const divisionIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
        name: `Freeze ${i + 1} ${TAG}`,
        visibility: "private",
      });
      expect(comp.status).toBe(201);
      const div = await apiJson<{ id: string }>(
        page.request,
        `/api/v1/competitions/${comp.data!.id}/divisions`,
        "POST",
        {
          name: "Open",
          sport_key: "generic",
          variant_key: "score",
          config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
        },
      );
      divisionIds.push(div.data!.id);
    }

    // Billing page shows the comped Pro plan with the in-app downgrade button
    // (no Stripe subscription on file).
    await page.goto("/settings/billing");
    await expect(page.getByText("pro", { exact: true })).toBeVisible({ timeout: 20_000 });

    // PROMPT-32 moved this to the in-app ConfirmDialog (native confirm is
    // lint-banned) — confirm through the dialog.
    await page.getByRole("button", { name: "Downgrade to Community" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Downgrade" }).click();
    await expect(page.getByText("community", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /start free trial/i })).toBeVisible();

    // The least-recently-active competition (the first created) freezes:
    // writes 402 with the same feature key the paywall shows.
    const frozen = await apiJson(
      page.request,
      `/api/v1/divisions/${divisionIds[0]!}/entrants`,
      "POST",
      { kind: "individual", display_name: "Frozen Out" },
    );
    expect(frozen.status).toBe(402);
    expect(frozen.error?.code).toBe("PAYMENT_REQUIRED");

    // The in-quota competitions stay writable.
    const alive = await addEntrantsViaApi(page.request, divisionIds[2]!, ["Still Alive"]);
    expect(alive.status).toBeLessThan(300);
  });

  // The reported bug, at the surface the user actually saw: an org that had
  // already had Pro (downgraded, then came back) was still shown the 14-day
  // trial CTA — and checkout then 409'd, or worse, handed out a second trial.
  // trial_used_at is the only input that moves here, so the CTA is asserted
  // both ways around a single column flip.
  test("an org that has already had Pro is not offered the trial again", async ({ page }) => {
    const orgC = await createFreshOrg(page);
    // Explicit null: a fresh org has never had Pro, so the trial is on offer.
    await setOrgSubscriptionSql(orgC, {
      plan_key: "community",
      status: "active",
      trial_used_at: null,
    });
    await page.goto("/settings/billing");

    // Anchored: the Pro Plus CTA is literally "Go Pro Plus — …", so an
    // unanchored /Go Pro/ matches the wrong button, and the default
    // getByRole name matcher is a case-insensitive SUBSTRING match.
    const trialCta = page.getByRole("button", { name: /^Start free trial — / });
    const goProCta = page.getByRole("button", { name: /^Go Pro — / });
    await expect(trialCta).toBeVisible({ timeout: 20_000 });
    // Page-wide negative, deliberately NOT the anchored locator above: on a
    // single UpgradeButton the anchored count is fully determined by the
    // assertion before it. Sweep every "Go Pro" button on the page (minus the
    // Pro Plus CTA, which is always there) so any other component offering
    // paid-now-no-trial would red here.
    await expect(
      page.getByRole("button", { name: /go pro/i }).filter({ hasNotText: /pro plus/i }),
    ).toHaveCount(0);
    await expect(page.getByText(/14-day free trial/)).toBeVisible();

    // Burn the trial — the one column that decides this.
    await setOrgSubscriptionSql(orgC, {
      plan_key: "community",
      status: "active",
      trial_used_at: new Date().toISOString(),
    });
    await page.reload();

    await expect(goProCta).toBeVisible({ timeout: 20_000 });
    // Negative on the whole page, not on the anchored locator: no button
    // anywhere may still promise a trial this org cannot have.
    await expect(page.getByRole("button", { name: /start free trial/i })).toHaveCount(0);
    await expect(page.getByText(/your free trial has already been used/)).toBeVisible();
  });

  test("upgrade opens checkout in a modal that survives a dismiss", async ({ page }) => {
    // Storage-state's default active org is the Pro setup org (no CTA to
    // click), and activation doesn't carry across tests' fresh contexts — so
    // reactivate orgA (still community, trial unused from earlier in this
    // serial suite) the same way the "mounts the embedded Stripe checkout"
    // test above does.
    await activate(page, orgA);

    // Same probe-and-skip pattern as "upgrade click mounts the embedded
    // Stripe checkout" above — this exercises the ANNUAL Pro price, since
    // that's the only button whose label matches "Start free trial".
    const probe = await apiJson<{ client_secret?: string }>(
      page.request,
      "/api/billing/checkout",
      "POST",
      { plan_key: "pro", interval: "annual" },
    );
    test.skip(probe.status >= 500, "Stripe not configured — skipping");
    // A healthy-looking skip previously CONCEALED a real regression on this
    // branch — pin the non-skip path to a real 200 so this can't quietly
    // start skipping every run without anyone noticing.
    expect(probe.status).toBe(200);

    // NOTE: "/settings?tab=billing" redirects through routes.orgSettings() to
    // the tabbed org-profile page, NOT the billing page — that's a different
    // component with no UpgradeButton. The legacy "/settings/billing" redirect
    // (routes.billing()) is what every other test in this file uses to reach
    // the actual billing surface; matching that here.
    await page.goto("/settings/billing");
    await page.waitForURL(/\/o\/[^/]+\/settings\/billing/, { timeout: 20_000 });

    await page.getByRole("button", { name: /Start free trial|Go Pro/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("iframe")).toBeVisible({ timeout: 30_000 });

    // Dismiss and reopen: the provider must remount cleanly with a fresh secret,
    // not a dead iframe from the previous session.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /Start free trial|Go Pro/ }).first().click();
    await expect(page.getByRole("dialog").locator("iframe")).toBeVisible({ timeout: 30_000 });
  });
});
