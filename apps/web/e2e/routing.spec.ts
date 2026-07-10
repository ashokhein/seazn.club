// PROMPT-30 acceptance (v3/01): slug URLs are the source of truth.
// - login lands on /o/[orgSlug]
// - legacy /divisions/[id] 301s to the slug chain
// - two tabs on two orgs don't corrupt each other (URL beats cookie)
// - breadcrumbs link every level; the back button reaches the parent
// - a renamed competition's old slug keeps redirecting
//
// Magic-link budget (rate limit 5/5min/IP): this file mints ONE new user —
// the fresh-login + two-tab checks share it.
import { test, expect } from "@playwright/test";
import { apiJson, loginUi, activeOrg, seedScoredDivision, setOrgPlanBySql } from "./helpers";

test("legacy division id URL 301s to the slug chain and keeps ?tab=", async ({ page }) => {
  const { divisionId } = await seedScoredDivision(page.request, ["A", "B"], { decide: false });
  await page.goto(`/divisions/${divisionId}?tab=fixtures`);
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/[^/?]+\?tab=fixtures/, { timeout: 20_000 });
});

test("breadcrumbs link each level and the back button targets the parent", async ({ page }) => {
  const { divisionId, competitionId } = await seedScoredDivision(page.request, ["A", "B"], {
    decide: false,
  });
  const org = await activeOrg(page);
  const comp = await apiJson<{ slug: string; name: string }>(
    page.request,
    `/api/v1/competitions/${competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(page.request, `/api/v1/divisions/${divisionId}`);

  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}/schedule`);

  // Back button (§4): aria-label names the structural parent (the division).
  const back = page.getByRole("link", { name: /^Back to / });
  await expect(back).toBeVisible();
  expect(await back.getAttribute("href")).toBe(
    `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}`,
  );

  // Desktop trail: the competition crumb navigates to the competition page.
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: comp.data!.name })
    .click();
  await page.waitForURL(`**/o/${org.slug}/c/${comp.data!.slug}`, { timeout: 20_000 });
});

test("a renamed competition's old slug redirects", async ({ page }) => {
  const { competitionId } = await seedScoredDivision(page.request, ["A", "B"], {
    decide: false,
  });
  const org = await activeOrg(page);
  const before = await apiJson<{ slug: string }>(
    page.request,
    `/api/v1/competitions/${competitionId}`,
  );
  const oldSlug = before.data!.slug;
  const renamed = await apiJson<{ slug: string }>(
    page.request,
    `/api/v1/competitions/${competitionId}`,
    "PATCH",
    { name: `Renamed ${Date.now().toString(36)}` },
  );
  expect(renamed.data!.slug).not.toBe(oldSlug);

  await page.goto(`/o/${org.slug}/c/${oldSlug}`);
  await page.waitForURL(`**/o/${org.slug}/c/${renamed.data!.slug}`, { timeout: 20_000 });
});

test("fresh login lands on /o/[slug]; two org tabs stay independent", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const pageA = await context.newPage();
  await loginUi(pageA, `routing-${Date.now().toString(36)}@e2e.seazn.club`);
  await pageA.request.post("/api/onboarding/complete", { data: {} });

  // Landing: authenticated visits to the legacy home resolve to the slug home.
  await pageA.goto("/dashboard");
  await pageA.waitForURL(/\/o\/[^/?]+$/, { timeout: 20_000 });

  // Second org needs headroom beyond community's 1-owned-org cap.
  const orgs = await apiJson<{ id: string; slug: string }[]>(pageA.request, "/api/orgs");
  const orgA = orgs.data![0]!;
  await setOrgPlanBySql({ orgId: orgA.id }, "pro");
  const created = await apiJson<{ id: string; slug: string }>(pageA.request, "/api/orgs", "POST", {
    name: `Second Org ${Date.now().toString(36)}`,
  });
  const orgB = created.data!;

  await pageA.goto(`/o/${orgA.slug}`);
  await expect(pageA.getByRole("heading", { name: "Competitions", exact: true })).toBeVisible();

  // Tab B on org B flips the seazn_org cookie…
  const pageB = await context.newPage();
  await pageB.goto(`/o/${orgB.slug}`);
  await expect(pageB.getByRole("heading", { name: "Competitions", exact: true })).toBeVisible();

  // …but tab A's URL still decides what tab A shows.
  await pageA.reload();
  await expect(pageA).toHaveURL(new RegExp(`/o/${orgA.slug}$`));
  await expect(pageA.getByRole("heading", { name: "Competitions", exact: true })).toBeVisible();
  await context.close();
});
