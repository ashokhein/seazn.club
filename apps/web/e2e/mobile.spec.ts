import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TAG, apiJson, activeOrg, expectNoHorizontalScroll, addEntrantsViaApi } from "./helpers";

// v3/02 §4 viewport gate — runs ONLY in the mobile-se / mobile-14 projects
// (375×667, 390×844). Every audited route must render with zero page-level
// horizontal scroll; key surfaces must pass axe (serious/critical) and the
// public dashboard + registration page must LCP under 2.5 s on Fast-3G
// (v3/11 gaps 11, 12, 15).
test.describe.configure({ mode: "serial" });

let compId = "";
let compSlug = "";
let divisionId = "";
let orgSlug = "";

test("setup: public competition with an entrant-ready division", async ({ page, request }) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Mobile Gate ${TAG}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);
  compId = comp.data!.id;
  compSlug = comp.data!.slug;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Mobile Singles",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status).toBeLessThan(300);
  divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ada M", "Bea M", "Cal M", "Dev M"]);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: "individual",
      capacity: 10,
      fee_cents: 0,
      currency: "gbp",
      form_fields: [],
    },
  );
  expect(settings.status).toBeLessThan(300);
  orgSlug = (await activeOrg(page)).slug;
});

// "load" + a short settle instead of networkidle — the dev server's HMR
// socket keeps the network permanently busy and cold compiles already eat
// the budget.
async function auditRoute(page: Page, path: string) {
  await page.goto(path, { waitUntil: "load" });
  await page.waitForTimeout(300);
  await expectNoHorizontalScroll(page);
}

test("console routes: no horizontal scroll", async ({ page }) => {
  const routes = [
    "/dashboard",
    `/competitions/${compId}`,
    `/competitions/${compId}/settings`,
    `/divisions/${divisionId}`,
    `/divisions/${divisionId}?tab=fixtures`,
    `/divisions/${divisionId}?tab=standings`,
    `/divisions/${divisionId}/registrations`,
    "/settings?tab=organization",
    "/settings?tab=sponsors",
    "/settings?tab=team",
    "/settings?tab=api",
    "/settings?tab=account",
    "/settings/billing",
    "/directory",
    "/import",
    "/my-matches",
  ];
  for (const path of routes) {
    await auditRoute(page, path);
  }
});

test("public surfaces: no horizontal scroll (v3/11 gap 12)", async ({ browser }) => {
  // Anonymous context — public pages must hold without the authed shell.
  const anonCtx = await browser.newContext();
  try {
    const anon = await anonCtx.newPage();
    const routes = [
      "/",
      "/pricing",
      `/shared/${orgSlug}`,
      `/shared/${orgSlug}/${compSlug}`,
      `/shared/${orgSlug}/${compSlug}/register`,
    ];
    for (const path of routes) {
      await anon.goto(path, { waitUntil: "load" });
      await anon.waitForTimeout(300);
      await expectNoHorizontalScroll(anon);
    }
  } finally {
    await anonCtx.close();
  }
});

test("axe: no serious/critical violations on key surfaces (v3/11 gap 11)", async ({ page }) => {
  const routes = [
    "/dashboard",
    `/competitions/${compId}`,
    `/divisions/${divisionId}?tab=standings`,
    "/settings?tab=organization",
    "/settings/billing",
    `/shared/${orgSlug}/${compSlug}`,
  ];
  for (const path of routes) {
    await page.goto(path, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking.map((v) => `${path}: ${v.id} — ${v.nodes[0]?.html}`),
      `axe serious/critical on ${path}`,
    ).toEqual([]);
  }
});

test("page smokes: settings save + invoice/plan card render", async ({ page }) => {
  // Org rename round-trip proves forms submit on a phone viewport.
  await page.goto("/settings?tab=organization");
  const nameInput = page.getByLabel(/organi[sz]ation name/i);
  await expect(nameInput).toBeVisible();
  // Two "Save" buttons live on this tab (rename + payment details) — scope
  // to the rename form's own label container.
  const renameForm = page.locator("label", { has: nameInput });
  const orgName = await nameInput.inputValue();
  await nameInput.fill(`${orgName} ✓`);
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(renameForm.getByText("Saved.")).toBeVisible();
  // Restore — other specs assert on the org name.
  await nameInput.fill(orgName);
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(renameForm.getByText("Saved.")).toBeVisible();

  // Billing: the plan card is the invoice-adjacent surface every org has.
  await page.goto("/settings/billing");
  await expect(page.getByRole("heading", { name: /plan & billing/i })).toBeVisible();
  await expect(page.getByText(/current plan/i).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

// v3/11 gap 15: LCP < 2.5 s on Fast-3G for the money pages. CDP network
// emulation (Chromium only — the mobile projects are Chromium).
const FAST_3G = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150,
};

async function measureLcp(page: Page, path: string): Promise<number> {
  // Pre-warm: the dev server compiles a route on first hit — that cost is
  // build tooling, not page weight, so it stays out of the measurement.
  await page.request.get(path);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", FAST_3G);
  await page.goto(path);
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) resolve(last.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
        // No LCP entry (already settled) — fall back to nav timing.
        setTimeout(() => resolve(performance.now()), 4000);
      }),
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await cdp.detach();
  return lcp;
}

test("LCP < 2.5s on Fast-3G: public dashboard + registration (v3/11 gap 15)", async ({
  browser,
}) => {
  const anonCtx = await browser.newContext();
  try {
    const anon = await anonCtx.newPage();
    for (const path of [`/shared/${orgSlug}/${compSlug}`, `/shared/${orgSlug}/${compSlug}/register`]) {
      const lcp = await measureLcp(anon, path);
      expect(lcp, `LCP on ${path}`).toBeLessThan(2500);
    }
  } finally {
    await anonCtx.close();
  }
});
