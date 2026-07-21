import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  TAG,
  apiJson,
  setEntitlementOverrideSql,
  setGroupSeatsPaidSql,
  splitOrgIntoOwnGroupSql,
} from "./helpers";

// The multi-org billing workflow, walked end to end and photographed at every
// step (spec 2026-07-21 billing-groups).
//
// This file does the REAL moves — attach, detach, re-attach, hand over — through
// the UI, not through SQL. That is possible because every Stripe call in the
// model sits behind `hasLiveSubscription(...)`:
//   syncGroupQuantity returns before its first Stripe touch when the group is
//   not live; offerGroupTransfer's card handover is behind
//   `hasLiveSubscription(group) && group.stripe_customer_id` and its else branch
//   completes locally; cancelBillingGroup guards the same way.
// So a group with no `stripe_subscription_id` exercises the whole flow with no
// Stripe API call at all. What genuinely needs Stripe — an attach that CHARGES,
// the SetupIntent card handover, and seat arithmetic against a live
// subscription — stays in the mocked usecase suite.
//
// The screenshots are the deliverable as much as the assertions: each `shot`
// is taken immediately after the assertion that proves the state is real, so
// the walkthrough cannot show a screen the product does not actually produce.
//
// ORG BUDGET: owned orgs are a SHARED, run-wide budget — cap and reasoning in
// e2e/auth.setup.ts, "ORG BUDGET". This file mints TWO and reuses them.
const SHOTS = resolve(process.cwd(), "e2e/__shots__/billing-groups");

test.describe.serial("billing groups — visual workflow", () => {
  let payerOrg = "";
  let otherOrg = "";
  let groupId = "";
  let payerUserId = "";
  let step = 0;

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
  });

  /**
   * A local SQL client rather than a helpers.ts export, deliberately and
   * temporarily: e2e/helpers.ts is being edited concurrently, and reaching into
   * it for two queries would mean two sessions writing one file. Fold these into
   * helpers once that settles.
   */
  async function db<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL required");
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : "require",
      max: 1,
    });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  /**
   * Numbered so the artifact can order them without a manifest. NOT wrapped in
   * `.catch(() => undefined)` like the AI-architect helper: a missing shot here
   * is a missing step in the walkthrough, and swallowing it would publish a
   * workflow with a silent hole in it.
   */
  async function shot(target: Page | Locator, name: string): Promise<void> {
    step += 1;
    const file = resolve(SHOTS, `${String(step).padStart(2, "0")}-${name}.png`);
    await target.screenshot({ path: file });
  }

  const panelOf = (page: Page) => page.getByTestId("billing-group-panel");
  const dialogOf = (page: Page) => page.getByRole("alertdialog");

  async function activate(page: Page, orgId: string): Promise<void> {
    const res = await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgId });
    expect(res.status).toBeLessThan(300);
  }

  async function openBilling(page: Page, orgId: string): Promise<Locator> {
    await activate(page, orgId);
    await page.goto("/settings/billing");
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    return panel;
  }

  /** Confirm the open dialog and wait for the panel to reload behind it. */
  async function confirmDialog(page: Page, action: string): Promise<void> {
    await dialogOf(page).getByRole("button", { name: action }).click();
    await expect(dialogOf(page)).toHaveCount(0);
    // Every mutation is followed by `load()`, so the panel is briefly stale.
    await page.waitForLoadState("networkidle");
  }

  test("01 — a bill with one organisation, and others that could join it", async ({ page }) => {
    const a = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `Riverside ${TAG}`,
    });
    expect(a.status).toBeLessThan(300);
    payerOrg = a.data!.id;

    const b = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `Northside ${TAG}`,
    });
    expect(b.status).toBeLessThan(300);
    otherOrg = b.data!.id;

    // A new org JOINS its creator's existing group (lib/auth.ts
    // createOrgForUser, `ownedGroups.length === 1`). So these two arrive on ONE
    // bill together with the shared fixture's own org, and the walkthrough
    // would open on a group of three with nothing to move in — no candidate
    // button, no attach, no story. Break them apart so the journey starts where
    // a real customer starts: separate organisations, separate bills.
    await splitOrgIntoOwnGroupSql(payerOrg);
    await splitOrgIntoOwnGroupSql(otherOrg);

    // The payer's group goes Pro by SQL — buying a plan is checkout's job and
    // that DOES need Stripe. Everything after this point is the real product.
    const row = await db(async (sql) => {
      const [org] = await sql<{ subscription_id: string }[]>`
        select subscription_id from organizations where id = ${payerOrg}`;
      await sql`update subscriptions set plan_key = 'pro', status = 'active', quantity_paid = 1
                 where id = ${org.subscription_id}`;
      const [g] = await sql<{ owner_user_id: string }[]>`
        select owner_user_id from subscriptions where id = ${org.subscription_id}`;
      return { groupId: org.subscription_id, ownerId: g.owner_user_id };
    });
    groupId = row.groupId;
    payerUserId = row.ownerId;

    const panel = await openBilling(page, payerOrg);
    await expect(panel.getByText("On this bill: 1 · Seats paid for: 1")).toBeVisible();
    await expect(panel.getByRole("button", { name: `Northside ${TAG}` })).toBeVisible();
    await shot(panel, "one-org-on-the-bill");
  });

  test("02 — moving an organisation in states the price before the click", async ({ page }) => {
    const panel = await openBilling(page, payerOrg);
    await panel.getByRole("button", { name: `Northside ${TAG}` }).click();

    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    // Seats are full, so this move costs money and the dialog has to say so.
    await expect(dialog).toContainText("your bill goes up by half your plan's rate");
    await shot(dialog, "attach-confirm-charged");
  });

  test("03 — the attach actually happens", async ({ page }) => {
    const panel = await openBilling(page, payerOrg);
    await panel.getByRole("button", { name: `Northside ${TAG}` }).click();
    await confirmDialog(page, "Move it onto this bill");

    const after = panelOf(page);
    await expect(after.getByText(`Riverside ${TAG}`)).toBeVisible();
    await expect(after.getByText(`Northside ${TAG}`)).toBeVisible();
    // quantity_paid does NOT move on a non-live group — nothing was billed, so
    // nothing may claim to have been paid for.
    await expect(after.getByText("On this bill: 2 · Seats paid for: 1")).toBeVisible();
    await shot(after, "two-orgs-on-one-bill");
  });

  test("04 — the joined organisation inherits the plan on its own page", async ({ page }) => {
    // The point of the whole model: Northside did not buy anything, and is Pro.
    await activate(page, otherOrg);
    await page.goto("/settings/billing");
    await expect(page.getByRole("heading", { name: "Plan & Billing" })).toBeVisible({
      timeout: 20_000,
    });
    const sub = await apiJson<{ plan_key: string; status: string }>(
      page.request,
      `/api/orgs/${otherOrg}/subscription`,
    );
    expect(sub.data?.plan_key).toBe("pro");
    await shot(page, "joined-org-is-pro");
  });

  test("05 — removing an organisation says what it costs and what it does not", async ({
    page,
  }) => {
    const panel = await openBilling(page, payerOrg);
    const row = panel.locator("li").filter({ hasText: `Northside ${TAG}` });
    await row.getByRole("button", { name: "Remove from this bill" }).click();

    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("There is no refund");
    await expect(dialog).toContainText("the slot stays yours until the subscription renews");
    await shot(dialog, "detach-confirm");
  });

  test("06 — the detach happens, and the organisation lands on its own plan", async ({ page }) => {
    const panel = await openBilling(page, payerOrg);
    const row = panel.locator("li").filter({ hasText: `Northside ${TAG}` });
    await row.getByRole("button", { name: "Remove from this bill" }).click();
    await confirmDialog(page, "Take it off this bill");

    const after = panelOf(page);
    // Scoped to the BILL ROWS, not the panel. The panel is where candidates
    // live too, and a detached org lands in a group of its own — which makes it
    // immediately re-addable, so its name is still on screen, now as an "add"
    // button. Asserting its absence from the whole panel failed for exactly
    // that reason, and would have been the wrong thing to demand anyway.
    const rows = after.locator("li").filter({ has: page.getByRole("button", { name: "Remove from this bill" }) });
    await expect(rows.filter({ hasText: `Northside ${TAG}` })).toHaveCount(0);
    await expect(rows.filter({ hasText: `Riverside ${TAG}` })).toHaveCount(1);
    // Positive proof the detach did what it claims: it is offerable again,
    // which only happens once it is in a group of its own.
    await expect(after.getByRole("button", { name: `Northside ${TAG}` })).toBeVisible();
    await shot(after, "back-to-one-org");

    // It kept the plan it was paid up for, on a group of its own — not a
    // silent downgrade the moment the payer let go.
    const moved = await db((sql) =>
      sql<{ subscription_id: string }[]>`
        select subscription_id from organizations where id = ${otherOrg}`,
    );
    expect(moved[0].subscription_id).not.toBe(groupId);
  });

  test("07 — an organisation that already pays for itself cannot just join", async ({ page }) => {
    // attachOrgToGroup refuses this with a 409: Stripe cannot move credit
    // between customers, and refunding an annual plan mid-term could be $130+.
    // The panel used to offer it anyway, so the payer agreed to a charge and
    // THEN got the error. Now the rule is on screen instead of the button.
    await db((sql) =>
      sql`update subscriptions
             set status = 'active', plan_key = 'pro',
                 stripe_subscription_id = ${"sub_e2e_paying"}
           where id = (select subscription_id from organizations where id = ${otherOrg})`,
    );
    try {
      const panel = await openBilling(page, payerOrg);
      await expect(panel.getByText(/pays for its own subscription/)).toBeVisible();
      // And it is not offerable: no button, so no dialog promising a charge.
      await expect(panel.getByRole("button", { name: `Northside ${TAG}` })).toHaveCount(0);
      await shot(panel, "already-paying-cannot-join");
    } finally {
      await db((sql) =>
        sql`update subscriptions
               set stripe_subscription_id = null, plan_key = 'community'
             where id = (select subscription_id from organizations where id = ${otherOrg})`,
      );
    }
  });

  test("08 — a paid slot that has been freed is stated, with its number", async ({ page }) => {
    // Three seats were paid for at renewal; two organisations left the bill.
    // This is the state that makes the next move free, and the reason the panel
    // never merges the two counts into "1 of 3".
    await setGroupSeatsPaidSql(groupId, 3);
    const panel = await openBilling(page, payerOrg);
    await expect(panel.getByText("On this bill: 1 · Seats paid for: 3")).toBeVisible();
    await expect(panel.getByText(/Paid slots free until renewal: 2\b/)).toBeVisible();
    await shot(panel, "freed-slots");
  });

  test("09 — moving into a slot already paid for is offered as free", async ({ page }) => {
    const panel = await openBilling(page, payerOrg);
    await panel.getByRole("button", { name: `Northside ${TAG}` }).click();

    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("there is nothing to pay now");
    await expect(dialog).not.toContainText("charged now");
    await shot(dialog, "attach-confirm-free");

    await confirmDialog(page, "Move it onto this bill");
    const after = panelOf(page);
    await expect(after.getByText("On this bill: 2 · Seats paid for: 3")).toBeVisible();
    await shot(after, "re-attached-into-a-freed-slot");
  });

  test("10 — a full plan says so instead of offering a move it would refuse", async ({ page }) => {
    // groupOrgLimit resolves through the OLDEST org in the group.
    await setEntitlementOverrideSql(payerOrg, "orgs.max_owned", 2);
    try {
      const panel = await openBilling(page, payerOrg);
      await expect(
        panel.getByText(/This plan covers 2 organisations, and they are all in use/),
      ).toBeVisible();
      await shot(panel, "plan-is-full");
    } finally {
      await setEntitlementOverrideSql(payerOrg, "orgs.max_owned", 50);
    }
  });

  test("11 — with nobody else owning an org here, the handover explains itself", async ({
    page,
  }) => {
    const panel = await openBilling(page, payerOrg);
    await expect(
      panel.getByText(/You can only hand this bill to someone who owns one/),
    ).toBeVisible();
    await shot(panel, "handover-no-recipients");
  });

  test("12 — handing the whole bill to someone else", async ({ page }) => {
    // Give Northside a different owner, which is what makes them a candidate.
    // Ownership of an ORG is separate from who pays, and it is the only consent
    // in the no-card handover path.
    const heir = await db(async (sql) => {
      const email = `e2e-heir-${TAG}@example.com`;
      await sql`insert into users (email, display_name, email_verified)
                values (${email}, ${"Sam Heir"}, true) on conflict (email) do nothing`;
      const [u] = await sql<{ id: string }[]>`select id from users where email = ${email}`;
      await sql`delete from org_members where org_id = ${otherOrg} and role = 'owner'`;
      await sql`insert into org_members (org_id, user_id, role)
                values (${otherOrg}, ${u.id}, 'owner')`;
      return u.id;
    });

    try {
      const panel = await openBilling(page, payerOrg);
      // No live subscription, so the handover is immediate and the explainer
      // must NOT promise a card step — the pair that has been wrong once.
      await expect(panel.getByText(/There is nothing to bill on this plan/)).toBeVisible();
      await expect(
        panel.getByText(/Your card stays on the bill until theirs is confirmed/),
      ).toHaveCount(0);
      await shot(panel, "handover-picker");

      await panel.getByRole("button", { name: /Sam Heir/ }).click();
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("hands the bill to Sam Heir straight away");
      await shot(dialog, "handover-confirm");

      await confirmDialog(page, "Offer the bill");

      // The bill really changed hands: the former payer is no longer the payer,
      // so the panel is not theirs to see.
      const owner = await db((sql) =>
        sql<{ owner_user_id: string }[]>`
          select owner_user_id from subscriptions where id = ${groupId}`,
      );
      expect(owner[0].owner_user_id).toBe(heir);
      await page.goto("/settings/billing");
      await page.waitForLoadState("networkidle");
      await expect(panelOf(page)).toHaveCount(0);
      await shot(page, "handed-over-panel-gone");
    } finally {
      // Give the bill and the org back: this file runs on the SHARED Pro user
      // and every serial spec after it assumes that user still pays for its own
      // organisations.
      await db(async (sql) => {
        await sql`update subscriptions set owner_user_id = ${payerUserId} where id = ${groupId}`;
        await sql`delete from org_members where org_id = ${otherOrg} and role = 'owner'`;
        await sql`insert into org_members (org_id, user_id, role)
                  values (${otherOrg}, ${payerUserId}, 'owner')`;
      });
    }
  });

  test("13 — the panel on a phone", async ({ page }) => {
    await setGroupSeatsPaidSql(groupId, 3);
    await page.setViewportSize({ width: 390, height: 844 });
    const panel = await openBilling(page, payerOrg);
    await shot(panel, "mobile-panel");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("14 — what the pricing page promises about it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/pricing");
    const row = page.getByText("Organisations on one bill").first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.scrollIntoViewIfNeeded();
    await shot(page, "pricing-row");
  });

  test("15 — the help page a customer lands on", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/help/billing/groups");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "help-page");
  });
});
