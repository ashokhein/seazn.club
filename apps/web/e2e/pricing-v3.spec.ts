import { test, expect } from "@playwright/test";
import { apiJson, TAG, grantCompetitionPassSql } from "./helpers";

// PROMPT-36 (v3/07): pricing page renders three offers from plan_entitlements
// with a working currency switcher and zero "Business"; the in-competition
// two-button gate lifts for THAT competition once a pass lands. Serial: the
// community org's competitions.max_active slot is shared state.

const GENERIC = {
  sport_key: "generic",
  variant_key: "score",
  config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
};

test.describe("pricing page v3", () => {
  test("three columns from data, currency switch, no Business", async ({ browser }) => {
    // Marketing surface — assert it exactly as an anonymous visitor sees it.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto("/pricing");
      const matrix = page.locator("[data-pricing-matrix]");
      await expect(matrix).toBeVisible();
      // Column headers come from the three plans; rows from plan_entitlements.
      for (const col of ["Community", "Event Pass", "Pro"]) {
        await expect(matrix.locator("thead")).toContainText(col);
      }
      await expect(matrix.locator("tbody")).toContainText("Entrants per division");
      // The v3 numbers, straight from the seed: 16 / 32 / 256.
      const entrantsRow = matrix.locator("tr", { hasText: "Entrants per division" });
      await expect(entrantsRow).toContainText("16");
      await expect(entrantsRow).toContainText("32");
      await expect(entrantsRow).toContainText("256");

      // The dark Business plan never surfaces on marketing pages (v3/03 §6).
      expect(await page.locator("body").innerText()).not.toContain("Business");

      // Annual is the default framing; the currency switcher re-prices.
      await expect(page.locator("[data-annual-toggle]")).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("main")).toContainText("$");
      await page.locator("[data-currency-switcher]").selectOption("gbp");
      await expect(page.locator("main")).toContainText("£33", { timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });
});

test.describe.serial("event pass gate (community org)", () => {
  test.use({ storageState: "e2e/.auth/community.json" });

  test("division cap shows the two-button gate; a pass lifts this comp only", async ({
    page,
    request,
  }) => {
    // Retire leftovers from earlier attempts — both free ceilings are shared.
    const leftovers = await apiJson<{ items: { id: string; name: string }[] }>(
      request,
      "/api/v1/competitions",
    );
    for (const c of leftovers.data?.items ?? []) {
      if (c.name.startsWith("Pass Gate ")) {
        await apiJson(request, `/api/v1/competitions/${c.id}`, "PATCH", {
          status: "archived",
          visibility: "private",
        });
      }
    }

    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { name: `Pass Gate ${TAG}`, visibility: "private" },
    );
    const compId = comp.data!.id;
    const orgId = (
      await apiJson<{ id: string }[]>(request, "/api/orgs")
    ).data![0]!.id;

    // Fill the free quota (2 divisions), then hit the wall.
    for (const name of ["One", "Two"]) {
      const d = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
      expect(d.status).toBe(201);
    }
    const gated = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Three",
      ...GENERIC,
    });
    expect(gated.status).toBe(402);

    // The gate renders where the limit bites: submitting a 3rd division in
    // the builder 402s and the paywall offers BOTH paths (v3/07 §3) — the
    // one-time pass CTA links to this competition's upgrade page.
    await page.goto(`/competitions/${compId}`);
    await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+/, { timeout: 20_000 });
    await page.goto(`${new URL(page.url()).pathname}/d/new`);
    await page.getByPlaceholder("U16 Boys T20").fill("Gate Trigger");
    // The builder is a stepped wizard — submit lives on the last tab.
    await page.getByRole("button", { name: "Scheduling" }).click();
    await page.getByRole("button", { name: "Create division" }).click();
    const gate = page.locator("[data-pass-gate]").first();
    await expect(gate).toBeVisible({ timeout: 20_000 });
    await expect(gate.locator("[data-pass-cta]")).toContainText("$39");
    const passHref = await gate.locator("[data-pass-cta]").getAttribute("href");
    expect(passHref).toMatch(new RegExp(`/c/${comp.data!.slug}/upgrade$`));

    // Purchase (SQL analogue — test-infra convention), then the gate lifts…
    await grantCompetitionPassSql(orgId, compId);
    const third = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Three",
      ...GENERIC,
    });
    expect(third.status).toBe(201);

    // …the upgrade page confirms, and the pass frees the active-comp slot
    // for a sibling that stays community-capped.
    await page.goto(passHref!);
    await expect(page.locator("[data-pass-active]")).toBeVisible({ timeout: 20_000 });

    const sibling = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      name: `Pass Gate Sibling ${TAG}`,
      visibility: "private",
    });
    expect(sibling.status).toBe(201);
    for (const name of ["S1", "S2"]) {
      await apiJson(request, `/api/v1/competitions/${sibling.data!.id}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
    }
    const siblingGated = await apiJson(
      request,
      `/api/v1/competitions/${sibling.data!.id}/divisions`,
      "POST",
      { name: "S3", ...GENERIC },
    );
    expect(siblingGated.status).toBe(402);

    // Cleanup: free the community org's shared slots for later suites.
    await apiJson(request, `/api/v1/competitions/${sibling.data!.id}`, "PATCH", {
      status: "archived",
      visibility: "private",
    });
    await apiJson(request, `/api/v1/competitions/${compId}`, "PATCH", {
      status: "archived",
      visibility: "private",
    });
  });
});
