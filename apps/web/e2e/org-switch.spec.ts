import { test, expect } from "@playwright/test";
import { loginUi, apiJson, TAG, setEntitlementOverrideSql } from "./helpers";

// Switching organisations must land on the SAME page under the new org, not
// bounce to the dashboard (`/o/<slug>`). The user has reported this 3× and it
// survived #274 — so this reproduces it end to end, against BOTH switch
// affordances: the settings-header `OrgSwitcher` (the one #274 touched) and
// the always-visible breadcrumb org dropdown (`OrgCrumb`), which is what a
// user reaches for on any page.
//
// The wait after each switch MUST name org B's slug. `/\/o\/[^/]+(\/|$)/`
// matches the PRE-CLICK url (`/o/<A>/settings`) too, so it resolves instantly
// and `networkidle` then settles on the OLD page while the switch navigation
// is still in flight — the settings switcher POSTs `/api/orgs/active` before
// `window.location.assign`, so its nav starts a round-trip late. Solo that
// races green; at 4 workers it read org A's url 12 times out of 16.
//
// Runs in its own context (own two-org user); no shared storageState.
test.use({ storageState: { cookies: [], origins: [] } });

async function seedTwoOrgUser(page: import("@playwright/test").Page) {
  const email = `e2e-switch-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await loginUi(page, email, "/dashboard");
  let orgsA = await apiJson<{ id: string; slug: string; name: string }[]>(page.request, "/api/orgs");
  if (!orgsA.data?.length) {
    const a = await apiJson<{ id: string; slug: string }>(page.request, "/api/orgs", "POST", {
      name: `Switch A ${TAG}`,
    });
    if (a.status >= 400) throw new Error(`create org A failed: ${a.status} ${a.error?.message}`);
    orgsA = await apiJson<{ id: string; slug: string; name: string }[]>(page.request, "/api/orgs");
  }
  const orgA = orgsA.data![0]!;
  // A community org may cap owned orgs below 2 — lift it so the second create
  // (and thus the two-org switcher) is reachable.
  await setEntitlementOverrideSql(orgA.id, "orgs.max_owned", 10);
  // Second org via the product path. Creating it flips the active-org cookie
  // to B, so we reset back to A afterwards.
  const created = await apiJson<{ id: string; slug: string; name: string }>(
    page.request,
    "/api/orgs",
    "POST",
    { name: `Switch B ${TAG}` },
  );
  if (created.status >= 400) throw new Error(`create org B failed: ${created.status} ${created.error?.message}`);
  const orgB = created.data!;
  // Reset active org to A so the test starts on A's settings.
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgA.id });
  return { orgA, orgB };
}

test("settings OrgSwitcher stays on the settings page under the new org", async ({ page }) => {
  const { orgA, orgB } = await seedTwoOrgUser(page);

  await page.goto(`/o/${orgA.slug}/settings`);
  await page.getByRole("button", { name: "Switch organisation" }).click();
  // The popover lists org B by name — click its row.
  await page.getByRole("menu").getByText(orgB.slug, { exact: true }).click();

  await page.waitForURL((u) => u.pathname.startsWith(`/o/${orgB.slug}`), { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  expect(page.url(), "settings switch should stay on /settings under org B").toContain(
    `/o/${orgB.slug}/settings`,
  );
});

test("breadcrumb org dropdown stays on the same page under the new org", async ({ page }) => {
  const { orgA, orgB } = await seedTwoOrgUser(page);

  await page.goto(`/o/${orgA.slug}/settings`);
  // The breadcrumb org crumb (top dark bar) is the always-visible switcher.
  // Its trigger shows org A's name with a chevron; open it and click org B.
  await page.getByRole("button", { name: orgA.name }).click();
  await page.getByRole("menuitem", { name: orgB.name }).click();

  await page.waitForURL((u) => u.pathname.startsWith(`/o/${orgB.slug}`), { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  expect(page.url(), "breadcrumb switch from settings should stay on settings under org B").toContain(
    `/o/${orgB.slug}/settings`,
  );
});
