import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// SPEC-1 discipline (PROMPT-79): on the shared Pro org, five person-attributed
// yellows across a division auto-raise a pending suspension the organiser
// confirms in the console; the confirmed ban then surfaces as an entrant chip,
// a public strip line, and a soft pad banner. Serial: each test builds on the
// division the first one created (mind the mobile project's concurrency).
test.describe.serial("discipline suspensions", () => {
  let orgSlug: string;
  let compSlug: string;
  let divSlug: string;
  let divId: string;
  let roversId: string;
  let playerId: string;
  let firstFixtureNo: number;

  test("5 yellows raise a pending ban the organiser confirms in the console", async ({ page }) => {
    const org = await activeOrg(page);
    orgSlug = org.slug;

    const comp = await apiJson<{ id: string; slug: string }>(
      page.request,
      "/api/v1/competitions",
      "POST",
      { name: `Disc E2E ${TAG}`, visibility: "public" },
    );
    compSlug = comp.data!.slug;
    const div = await apiJson<{ id: string; slug: string }>(
      page.request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      { name: "Prem", sport_key: "football", variant_key: "11-a-side" },
    );
    divId = div.data!.id;
    divSlug = div.data!.slug;

    const player = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
      full_name: `Booking Magnet ${TAG}`,
      consent: { public_name: true },
    });
    playerId = player.data!.id;
    const ents = await apiJson<{ id: string }[]>(
      page.request,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      [
        { kind: "team", display_name: `Rovers ${TAG}`, seed: 1, members: [{ person_id: playerId }] },
        { kind: "team", display_name: `City ${TAG}`, seed: 2 },
      ],
    );
    roversId = ents.data![0]!.id;

    const rules = await apiJson(page.request, `/api/v1/divisions/${divId}/discipline-rules`, "PUT", {
      enabled: true,
      rules: {
        accumulation: [{ key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 }],
        dismissal: [],
      },
    });
    expect(rules.status).toBe(200);

    const stage = await apiJson<{ id: string }>(page.request, `/api/v1/divisions/${divId}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
      config: { legs: 5 },
    });
    const gen = await apiJson<{ fixtures: { id: string; fixture_no: number }[] }>(
      page.request,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );
    const fixtures = gen.data!.fixtures;
    expect(fixtures.length).toBe(5);
    firstFixtureNo = fixtures[0]!.fixture_no;
    await apiJson(page.request, `/api/v1/divisions/${divId}/start`, "POST");

    // Seed a yellow per fixture (lineup must carry the player for the card).
    for (const fx of fixtures) {
      await apiJson(page.request, `/api/v1/fixtures/${fx.id}/lineups/${roversId}`, "PUT", {
        slots: [{ person_id: playerId, slot: "starting", position_key: "FW", order_no: 1, roles: [] }],
      });
      const started = await apiJson<{ seq: number }>(page.request, `/api/v1/fixtures/${fx.id}/events`, "POST", {
        expected_seq: 0,
        type: "core.start",
        payload: {},
      });
      await apiJson(page.request, `/api/v1/fixtures/${fx.id}/events`, "POST", {
        expected_seq: started.data!.seq,
        type: "football.card",
        payload: { by: roversId, person: playerId, color: "yellow" },
      });
    }

    const pending = await apiJson<{ id: string; source: string }[]>(
      page.request,
      `/api/v1/divisions/${divId}/suspensions?status=pending`,
    );
    expect(pending.data!.some((s) => s.source === "auto_accumulation")).toBe(true);

    // Confirm through the console UI.
    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}?tab=discipline`);
    await expect(page.getByTestId("discipline-panel")).toBeVisible();
    await page
      .getByTestId("pending-row")
      .first()
      .getByRole("button", { name: /^confirm$/i })
      .click();
    await expect(page.getByTestId("active-row").first()).toBeVisible();
  });

  test("the confirmed ban shows on the entrant chip, public strip and pad banner", async ({ page }) => {
    // Entrant chip on the entrants tab.
    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}?tab=entrants`);
    await expect(page.getByTestId("suspension-chip").first()).toBeVisible();

    // Public "Suspensions" strip under the Standings tab.
    await page.goto(`/shared/${orgSlug}/${compSlug}/${divSlug}`);
    await page.getByRole("tab", { name: /standings/i }).click();
    await expect(page.getByTestId("public-suspensions")).toBeVisible();

    // Soft pad banner on a fixture the suspended player was recorded in.
    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/${firstFixtureNo}`);
    await expect(page.getByTestId("pad-suspension-banner").first()).toBeVisible();
  });
});
