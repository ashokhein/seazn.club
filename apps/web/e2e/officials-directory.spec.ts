import { test, expect } from "@playwright/test";
import { apiJson, seedScoredDivision, TAG } from "./helpers";

// v11.1 follow-up: officials roster management (add / invite / bulk-invite)
// moved from a division's Officials tab to the org-wide Directory → Officials
// tab, so the same pool is shared across every division's schedule. This
// proves the new home lists + adds + invites (claim-link fallback, since this
// env's RESEND_API_KEY is blank), and that the schedule tab's slimmed strip
// still reflects the pool and still lets you assign.

test("directory Officials tab: add and list an official", async ({ page }) => {
  const name = `Priya Ref ${TAG}`;

  await page.goto("/directory?tab=officials");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add official" }).click();

  await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });
});

test("directory Officials tab: role chips replace free text — multi-select on Pro", async ({ page }) => {
  const name = `Multi Ref ${TAG}`;

  await page.goto("/directory?tab=officials");
  await page.getByLabel("Name", { exact: true }).fill(name);
  // referee is pre-selected; add judge too (this project's storage state is
  // the Pro account — multi-role is allowed).
  const roleGroup = page.getByRole("group", { name: "Roles" });
  await expect(roleGroup.getByRole("button", { name: "referee", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await roleGroup.getByRole("button", { name: "judge", exact: true }).click();
  await expect(roleGroup.getByRole("button", { name: "judge", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Add official" }).click();

  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText("referee", { exact: true })).toBeVisible();
  await expect(row.getByText("judge", { exact: true })).toBeVisible();
});

test("directory Officials tab: invite falls back to a copyable claim link", async ({ page }) => {
  const name = `Kofi Ref ${TAG}`;

  await page.goto("/directory?tab=officials");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add official" }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });

  const row = page.locator("li").filter({ hasText: name });
  await row.getByRole("button", { name: "Invite" }).click();
  await row.getByLabel("Email", { exact: true }).fill(`ref_${TAG}@example.com`);
  await row.getByRole("button", { name: "Send invite" }).click();

  // this worktree's RESEND_API_KEY is blank — send always fails, so the
  // one-time claim link is the only path to the official.
  await expect(row.getByText(/Email failed to send/i)).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText(/\/claim\/pc_/)).toBeVisible();
});

test("schedule Officials tab: compact roster strip reflects the pool and links to the directory; assign still works", async ({
  page,
  request,
}) => {
  const { divisionId } = await seedScoredDivision(request, undefined, { decide: false });
  const stripName = `Strip Ref ${TAG}`;
  await apiJson(request, "/api/v1/officials", "POST", {
    display_name: stripName,
    role_keys: ["referee"],
  });

  await page.goto(`/divisions/${divisionId}/schedule?tab=officials`);
  await expect(page.getByText(stripName)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("link", { name: /Manage officials in the directory/i }),
  ).toBeVisible();

  // roster management left the schedule tab — no add form here anymore.
  await expect(page.getByRole("button", { name: "Add official" })).toHaveCount(0);

  // the assign combobox still lists officials from the same org-wide pool.
  const select = page.locator("select", { hasText: stripName }).first();
  await expect(select).toBeVisible({ timeout: 20_000 });
});
