import { test, expect } from "@playwright/test";
import { apiJson, TAG, grantCompetitionPassSql, competitionPath } from "./helpers";

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
      // Column headers come from the plans; rows from plan_entitlements. The
      // Event Pass is TWO columns since v17 #294 — "Event Pass M" and "Event
      // Pass L" — so the pass heading is asserted at both sizes.
      for (const col of ["Community", "Event Pass M", "Event Pass L", "Pro"]) {
        await expect(matrix.locator("thead")).toContainText(col);
      }
      await expect(matrix.locator("tbody")).toContainText("Entrants per division");
      // Straight from plan_entitlements: 64 / 128 / ∞ / 256. V319 raised
      // Community 32 → 64 and the Event Pass 64 → 128, so the old 32 appears
      // nowhere in this row — asserting it fails against the live matrix.
      const entrantsRow = matrix.locator("tr", { hasText: "Entrants per division" });
      await expect(entrantsRow).toContainText("64");
      await expect(entrantsRow).toContainText("128");
      await expect(entrantsRow).toContainText("256");
      // V341: L's cap is NULL — unlimited. This ∞ is the figure the L rung is
      // sold on, and the one an L buyer would be misquoted if the table still
      // had a single pass column.
      await expect(entrantsRow).toContainText("∞");

      // The rest of what V310/V311 repackaged, on the page that sells it.
      // These are the rows this branch MOVED, so a matrix drift shows up here
      // before a buyer finds it (task 22).
      // Cell 0 of every row is the feature LABEL (a <td>, not a <th>), so the
      // plan columns start at 1. The order is lib/pricing-matrix's
      // PRICING_PLAN_KEYS: community, event pass M, event pass L, pro, pro
      // plus. v17 #294 inserted L at index 2, shifting pro and pro plus right.
      const cell = (label: string, plan: 0 | 1 | 2 | 3 | 4) =>
        matrix.locator("tr", { hasText: label }).locator("td").nth(plan + 1);
      // Divisions per competition: community 4, M 10, L 20 — the two rungs'
      // own ceilings, and one of only two rows where they differ at all.
      await expect(cell("Divisions per competition", 0)).toHaveText("4");
      await expect(cell("Divisions per competition", 1)).toHaveText("10");
      await expect(cell("Divisions per competition", 2)).toHaveText("20");
      // Entrants: the other. L renders ∞ where M renders its 128 cap.
      await expect(cell("Entrants per division", 1)).toHaveText("128");
      await expect(cell("Entrants per division", 2)).toHaveText("∞");
      // The fee ladder — flat across the rungs by decision (#294): L buys a
      // bigger event, never a cheaper cut.
      await expect(cell("Platform fee on entry fees", 0)).toContainText("8%");
      await expect(cell("Platform fee on entry fees", 1)).toContainText("5%");
      await expect(cell("Platform fee on entry fees", 2)).toContainText("5%");
      await expect(cell("Platform fee on entry fees", 3)).toContainText("2%");
      // V308 added player profiles to the pass columns — BOTH of them, since
      // V341 derives L's matrix from M's.
      await expect(cell("Public player profiles", 0)).toHaveText("—");
      await expect(cell("Public player profiles", 1)).toHaveText("✓");
      await expect(cell("Public player profiles", 2)).toHaveText("✓");
      // …and V310 made `branding` free on EVERY plan, so the community cell
      // must NOT be a dash. Re-gating it would be a silent takeaway.
      await expect(cell("Custom branding", 0)).toHaveText("✓");

      // The dark Business plan never surfaces on marketing pages (v3/03 §6).
      expect(await page.locator("body").innerText()).not.toContain("Business");

      // Annual is the default framing; the currency switcher re-prices.
      await expect(page.locator("[data-annual-toggle]")).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("main")).toContainText("$");
      await page.locator("[data-currency-switcher]").selectOption("gbp");
      // Annual framing renders round(annual/12): Pro GBP 12500/12 → £10.42.
      // (Repriced by the Pro $19 + 30%-annual change — the old £33 was Pro
      // Plus monthly, which now sits behind the PlusReveal disclosure.)
      await expect(page.locator("main")).toContainText("£10.42", { timeout: 15_000 });
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
    // This test owns the community org's whole quota story, and earlier
    // serial specs legitimately leave active competitions behind (journey-
    // community's `Limits …` comp keeps serving its later gating tests).
    // Sweep EVERY active competition — not just our own leftovers — so the
    // free max_active slot is provably empty before we count against it.
    const leftovers = await apiJson<{ items: { id: string; name: string }[] }>(
      request,
      "/api/v1/competitions",
    );
    for (const c of leftovers.data?.items ?? []) {
      await apiJson(request, `/api/v1/competitions/${c.id}`, "PATCH", {
        status: "archived",
        visibility: "private",
      });
    }

    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: `Pass Gate ${TAG}`, visibility: "private" },
    );
    const compId = comp.data!.id;
    const orgId = (
      await apiJson<{ id: string }[]>(request, "/api/orgs")
    ).data![0]!.id;

    // Fill the free quota (4 divisions), then hit the wall.
    for (const name of ["One", "Two", "Three", "Four"]) {
      const d = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
      expect(d.status).toBe(201);
    }
    const gated = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Five",
      ...GENERIC,
    });
    expect(gated.status).toBe(402);

    // The gate renders where the limit bites: submitting a 3rd division in
    // the builder 402s and the paywall offers BOTH paths (v3/07 §3) — the
    // one-time pass CTA links to this competition's upgrade page.
    await page.goto(await competitionPath(page.request, compId));
    await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+/, { timeout: 20_000 });
    await page.goto(`${new URL(page.url()).pathname}/d/new`);
    await page.getByPlaceholder("U16 Boys T20").fill("Gate Trigger");
    // The builder is a stepped wizard — submit lives on the last tab.
    await page.getByRole("button", { name: "Scheduling" }).click();
    await page.getByRole("button", { name: "Create division" }).click();
    const gate = page.locator("[data-pass-gate]").first();
    await expect(gate).toBeVisible({ timeout: 20_000 });
    await expect(gate.locator("[data-pass-cta]")).toContainText("$29");
    const passHref = await gate.locator("[data-pass-cta]").getAttribute("href");
    // The gate appends `?feature=<key>` so the upgrade page can render its
    // ceiling state; anchor on the path, not the whole string.
    expect(passHref).toMatch(new RegExp(`/c/${comp.data!.slug}/upgrade(\\?|$)`));
    expect(passHref).toContain("feature=divisions.per_competition.max");

    // Purchase (SQL analogue — test-infra convention), then the gate lifts…
    // The 402 above cached this org's resolved limit server-side, so the
    // grant must also bust the entitlement cache (staging has Redis).
    await grantCompetitionPassSql(orgId, compId, "event_pass", request);
    const fifth = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Five",
      ...GENERIC,
    });
    expect(fifth.status).toBe(201);

    // …the upgrade page confirms, and the pass frees the active-comp slot
    // for a sibling that stays community-capped.
    await page.goto(passHref!);
    await expect(page.locator("[data-pass-active]")).toBeVisible({ timeout: 20_000 });

    // …and from here on, no gate under this competition offers the pass a
    // second time (spec D1). Assert that where the pass's OWN ceiling bites —
    // the division cap, M's 10 — because that is the surface still gated for a
    // holder. This block used to read the competition-wide schedule board on
    // the premise that it was Pro-only and the pass never lifted it; V353
    // (#382/#478) granted `scheduling.multi_division` to event_pass, so that
    // page renders the real board and emits no gate at all. #478 migrated the
    // sibling assertions in event-pass.spec.ts and pro-plus-tier.spec.ts onto
    // the still-unlifted key and left this one behind — the "element(s) not
    // found" was the stale premise, not a regression.
    for (const name of ["Six", "Seven", "Eight", "Nine", "Ten"]) {
      const d = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
      expect(d.status).toBe(201);
    }
    const eleventh = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Eleven",
      ...GENERIC,
    });
    expect(eleventh.status).toBe(402);

    await page.goto(passHref!.replace(/\/upgrade(\?.*)?$/, "/d/new"));
    await page.getByPlaceholder("U16 Boys T20").fill("Owned Card");
    await page.getByRole("button", { name: "Scheduling" }).click();
    await page.getByRole("button", { name: "Create division" }).click();
    // Scoped to the feature that actually bit, never `.first()` — the same
    // reason event-pass.spec.ts scopes it: `.first()` reads whichever gate
    // happens to come first on the page and asserts nothing about divisions.
    const owned = page.locator('[data-pass-owned][data-feature="divisions.per_competition.max"]');
    await expect(owned).toBeVisible({ timeout: 20_000 });
    // `grantCompetitionPassSql` grants M, and since v17 #294 this card names
    // the rung rather than the product family.
    await expect(owned).toContainText("Event Pass M active");
    await expect(owned).not.toContainText("$29");
    await expect(page.locator("[data-pass-cta]")).toHaveCount(0);

    const sibling = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Pass Gate Sibling ${TAG}`,
      visibility: "private",
    });
    expect(sibling.status).toBe(201);
    for (const name of ["S1", "S2", "S3", "S4"]) {
      await apiJson(request, `/api/v1/competitions/${sibling.data!.id}/divisions`, "POST", {
        name,
        ...GENERIC,
      });
    }
    const siblingGated = await apiJson(
      request,
      `/api/v1/competitions/${sibling.data!.id}/divisions`,
      "POST",
      { name: "S5", ...GENERIC },
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
