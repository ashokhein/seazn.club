import { test, expect, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  expectNoHorizontalScroll,
  joinOrgToGroupSql,
  orgGroupIdSql,
  setEntitlementOverrideSql,
  setGroupSeatsPaidSql,
  setOrgPlanBySql,
  setOrgStatusSql,
  setOrgSubscriptionSql,
  splitOrgIntoOwnGroupSql,
} from "./helpers";

// The billing-group panel (spec 2026-07-21 billing-groups §Operations) — what
// a payer actually SEES on a bill that covers several organisations.
//
// SCOPE, deliberately narrow. Attach, detach and transfer all price the move,
// which on a live group means a real Stripe call, and e2e must never make one.
// Those paths are covered where Stripe is mocked
// (src/server/usecases/__tests__/billing-group-move.test.ts, 59 cases) and the
// decisions behind the panel are covered as pure functions
// (src/lib/__tests__/billing-group-view.test.ts, 38 cases). Neither of those
// can prove the panel renders at all, that the two counts survive as two
// numbers, or that the sentence shown immediately before an irreversible click
// is the right one. That is this file's job, and only this file's.
//
// So the groups here are built in SQL and left non-live: no
// stripe_subscription_id, therefore `has_live_subscription: false`. Where a
// case needs the live variant of a message it forces the id directly.
//
// ORG BUDGET: owned orgs are a SHARED, run-wide budget — the cap and the
// reasoning live in e2e/auth.setup.ts, "ORG BUDGET". This file mints THREE and
// reuses them across every case rather than one per test.
test.describe.serial("billing groups", () => {
  let orgA = "";
  let orgB = "";
  let orgC = "";
  let groupA = "";

  const panelOf = (page: Page) => page.getByTestId("billing-group-panel");

  async function activate(page: Page, orgId: string): Promise<void> {
    const res = await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgId });
    expect(res.status).toBeLessThan(300);
  }

  async function makeOrg(page: Page, label: string): Promise<string> {
    const res = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `Group ${label} ${TAG}`,
    });
    expect(res.status).toBeLessThan(300);
    return res.data!.id;
  }

  /** Put the group back to A+B on a paid Pro plan, seats matching orgs. The
   *  cases below each bend one thing off this baseline. */
  async function baseline(): Promise<void> {
    await joinOrgToGroupSql(orgB, groupA);
    await setOrgPlanBySql({ orgId: orgA }, "pro");
    await setGroupSeatsPaidSql(groupA, 2);
  }

  test("a solo Community organisation is not told it has a bill", async ({ page, browser }) => {
    orgA = await makeOrg(page, "A");
    orgB = await makeOrg(page, "B");
    orgC = await makeOrg(page, "C");
    // V309: a new org joins its creator's EXISTING group (lib/auth.ts
    // createOrgForUser). Minted as-is, A, B and C are already on ONE bill
    // together with the setup org — `onBill` reads 4, not 2, and neither the
    // joins below nor the "move C in" cases mean anything, because C is never
    // in a group of its own to be moved FROM. Break all three apart first; the
    // cases then build the groups they describe.
    await splitOrgIntoOwnGroupSql(orgA);
    await splitOrgIntoOwnGroupSql(orgB);
    await splitOrgIntoOwnGroupSql(orgC);

    // The control CANNOT be one of these three. `hidden` in
    // lib/billing-group-view.ts also clears the moment the payer owns any org
    // in another group ("candidates"), and this file's payer is the shared Pro
    // account, which owns the setup org plus A, B and C by construction — so C
    // would render the panel however solo its own group is, and the assertion
    // below would be about the fixture rather than the product.
    //
    // A genuinely solo Community payer is the Community storageState:
    // one org, its own group, nothing paid ahead, nothing else to move in.
    const solo = await browser.newContext({ storageState: "e2e/.auth/community.json" });
    const soloPage = await solo.newPage();
    try {
      await soloPage.goto("/settings/billing");
      // The page heading, not a bare getByText("Billing") — that matched the
      // breadcrumb, the h1 AND a sentence inside the panel, so it was a strict-
      // mode violation rather than a wait.
      await expect(soloPage.getByRole("heading", { name: "Plan & Billing" })).toBeVisible({
        timeout: 20_000,
      });
      // The panel mounts, then fetches, then decides. `toHaveCount(0)` against
      // a page that has not finished those fetches passes for the wrong reason,
      // so settle the network before asserting absence.
      await soloPage.waitForLoadState("networkidle");
      await expect(panelOf(soloPage)).toHaveCount(0);
    } finally {
      await solo.close();
    }
  });

  test("two organisations on one bill are both listed", async ({ page }) => {
    await setOrgPlanBySql({ orgId: orgA }, "pro");
    groupA = await orgGroupIdSql(orgA);
    await baseline();

    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(`Group A ${TAG}`)).toBeVisible();
    await expect(panel.getByText(`Group B ${TAG}`)).toBeVisible();
  });

  test("the two counts stay two numbers when a paid slot is free", async ({ page }) => {
    // THE case this panel exists for. Four seats paid, two organisations on
    // the bill: a single "2 of 4" would price the next move as a purchase when
    // it is in fact free, which is the opposite of what the customer was sold.
    await baseline();
    await setGroupSeatsPaidSql(groupA, 4);

    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText("On this bill: 2 · Seats paid for: 4")).toBeVisible();
    // And the freed slots are named, with their number, not merely implied.
    await expect(panel.getByText(/Paid slots free until renewal: 2\b/)).toBeVisible();
    await expect(panel.getByText(/costs nothing/)).toBeVisible();
  });

  test("no freed-slot line when every paid seat is in use", async ({ page }) => {
    await baseline();
    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText("On this bill: 2 · Seats paid for: 2")).toBeVisible();
    await expect(panel.getByText(/Paid slots free until renewal/)).toHaveCount(0);
  });

  test("a suspended organisation stays on the bill, and says so", async ({ page }) => {
    // Suspension is moderation, not billing: the slot is still paid for. If the
    // row vanished, the payer would be charged for something they cannot see,
    // so the row stays and carries the reason.
    await baseline();
    await setOrgStatusSql(orgB, "suspended");
    try {
      await activate(page, orgA);
      await page.goto("/settings/billing");
      const panel = panelOf(page);
      await expect(panel).toBeVisible({ timeout: 20_000 });

      const suspended = panel.locator("li").filter({ hasText: `Group B ${TAG}` });
      await expect(suspended).toHaveCount(1);
      await expect(suspended.getByText("suspended")).toBeVisible();
      // Scoped to the row, not the panel: the badge has to be attached to the
      // organisation it describes, and a panel-wide assertion would pass with
      // it rendered against the wrong one.
      const healthy = panel.locator("li").filter({ hasText: `Group A ${TAG}` });
      await expect(healthy.getByText("suspended")).toHaveCount(0);
    } finally {
      await setOrgStatusSql(orgB, "active");
    }
  });

  test("removing an organisation warns about the refund and the slot", async ({ page }) => {
    await baseline();
    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });

    const row = panel.locator("li").filter({ hasText: `Group B ${TAG}` });
    await row.getByRole("button", { name: "Remove from this bill" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    // Both surprises stated before the click, not discovered on the invoice.
    await expect(dialog).toContainText("There is no refund");
    await expect(dialog).toContainText("the slot stays yours until the subscription renews");

    // Cancelling must be inert: the organisation is still on the bill.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByText(`Group B ${TAG}`)).toBeVisible();
  });

  test("moving an organisation in states the price first", async ({ page }) => {
    // C sits in its own group, so it is a candidate for A's bill. Seats are
    // full, so this move costs money and the dialog has to say so.
    await baseline();
    await setGroupSeatsPaidSql(groupA, 2);
    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });

    await panel.getByRole("button", { name: `Group C ${TAG}` }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("your bill goes up by half your plan's rate");
    await expect(dialog).toContainText("charged now");
    await page.keyboard.press("Escape");
  });

  test("moving into a slot already paid for says it is free", async ({ page }) => {
    await baseline();
    await setGroupSeatsPaidSql(groupA, 4);
    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });

    await panel.getByRole("button", { name: `Group C ${TAG}` }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("there is nothing to pay now");
    // The two attach bodies must never be confusable — this is the pair the
    // customer reads immediately before spending money.
    await expect(dialog).not.toContainText("charged now");
    await page.keyboard.press("Escape");
  });

  test("a full plan says so instead of offering a move it would refuse", async ({ page }) => {
    // groupOrgLimit resolves through the OLDEST org in the group, so the
    // override goes on A.
    await baseline();
    await setEntitlementOverrideSql(orgA, "orgs.max_owned", 2);
    try {
      await activate(page, orgA);
      await page.goto("/settings/billing");
      const panel = panelOf(page);
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(panel.getByText(/This plan covers 2 organisations, and they are all in use/))
        .toBeVisible();
      await expect(panel.getByRole("button", { name: `Group C ${TAG}` })).toHaveCount(0);
    } finally {
      await setEntitlementOverrideSql(orgA, "orgs.max_owned", 50);
    }
  });

  test("a payer who owns everything is told how to reach someone else", async ({ page }) => {
    // Every org on this bill is owned by the payer, so there is nobody to hand
    // it to — and a dead picker would be worse than a sentence explaining the
    // two steps that would create a recipient.
    await baseline();
    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(/You can only hand this bill to someone who owns one/))
      .toBeVisible();
  });

  test("with nothing to bill, the handover explainer does not promise a card step", async ({
    page,
  }) => {
    // The pair that has already been wrong once: a group with no live
    // subscription hands over on the spot, so "your card stays on the bill
    // until theirs is confirmed" would be a plain lie. Forced through the
    // no-recipients branch is not enough — the explainer only renders when a
    // recipient exists, so this asserts the live variant is absent from the
    // panel entirely rather than that the immediate one is present.
    await baseline();
    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(/Your card stays on the bill until theirs is confirmed/))
      .toHaveCount(0);
  });

  test("the panel fits a phone without scrolling sideways", async ({ page }) => {
    await baseline();
    await setGroupSeatsPaidSql(groupA, 4);
    await page.setViewportSize({ width: 390, height: 844 });
    await activate(page, orgA);
    await page.goto("/settings/billing");
    await expect(panelOf(page)).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalScroll(page);
  });

  test("a trialing group still shows its organisations", async ({ page }) => {
    // Trial is the state most groups are created in, and the panel reads
    // `quantity_paid`, which a trial has never written. It must not blank.
    await baseline();
    await setOrgSubscriptionSql(orgA, {
      plan_key: "pro",
      status: "trialing",
      trial_end: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    await setGroupSeatsPaidSql(groupA, 0);

    await activate(page, orgA);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText("On this bill: 2 · Seats paid for: 0")).toBeVisible();
    // Zero seats against two live orgs is a group Stripe has never confirmed —
    // it must not read as two free slots.
    await expect(panel.getByText(/Paid slots free until renewal/)).toHaveCount(0);
  });
});
