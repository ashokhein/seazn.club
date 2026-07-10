import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createCompetitionViaUi,
  createDivisionViaUi,
  createStageAndGenerate,
  scoreFixture,
  scoreRemainingFixtures,
} from "./helpers";

// Full Pro lifecycle as one ordered story: create a competition through the
// wizard, add divisions (UI + API), enter entrants, generate fixtures, start,
// score to completion, then verify standings, the slideshow, and the public
// site. UI drives the moments that matter; the API seeds repetitive state
// (same split the other specs use).
test.describe.serial("pro lifecycle", () => {
  const PLAYERS = ["Ada", "Boole", "Curie", "Dirac", "Euler", "Fermi"];
  let competitionId: string;
  let competitionSlug: string;
  let uiDivisionId: string; // built through the tabbed builder (default sport)
  let divisionId: string; // generic/score division — scored + published below
  let divisionSlug: string;
  let stageId: string;
  let fixtureIds: string[] = [];
  let orgSlug: string;

  test("create a public competition via the wizard", async ({ page, request }) => {
    competitionId = await createCompetitionViaUi(page, `Pro Cup ${TAG}`, "public");
    await expect(page.getByRole("link", { name: /add division/i })).toBeVisible();
    const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${competitionId}`);
    competitionSlug = comp.data!.slug;
    expect(competitionSlug).toBeTruthy();
  });

  test("add two divisions — builder UI plus API (multi-division is Pro)", async ({
    page,
    request,
  }) => {
    uiDivisionId = await createDivisionViaUi(page, competitionId, "Premier");
    expect(uiDivisionId).toBeTruthy();

    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    // A 2nd division would 402 on community (divisions.per_competition.max = 1).
    expect(div.status).toBe(201);
    divisionId = div.data!.id;
    divisionSlug = div.data!.slug;
  });

  test("add entrants — one through the panel, the rest via API", async ({ page, request }) => {
    await page.goto(`/divisions/${divisionId}?tab=entrants`);
    // If other specs left teams in the shared org, the Add-entrant form
    // defaults to "Existing team" (and flips async once teams load, detaching
    // the fields) — pin it to the ad-hoc "New entrant" mode first.
    const modeToggle = page.getByRole("button", { name: "New entrant", exact: true });
    await modeToggle.click({ timeout: 3_000 }).catch(() => undefined);
    await page.getByPlaceholder("Riverside CC").fill(PLAYERS[0]!);
    await page.getByRole("button", { name: "Add entrant", exact: true }).click();
    await expect(page.getByRole("cell", { name: PLAYERS[0]! })).toBeVisible({ timeout: 20_000 });

    const bulk = await addEntrantsViaApi(request, divisionId, PLAYERS.slice(1), "individual", 1);
    expect(bulk.status).toBeLessThan(300);
    await page.reload();
    for (const name of PLAYERS) {
      await expect(page.getByRole("cell", { name })).toBeVisible();
    }
  });

  test("generate round-robin fixtures", async ({ request }) => {
    const out = await createStageAndGenerate(request, divisionId);
    stageId = out.stageId;
    fixtureIds = out.fixtureIds;
    // 6 entrants, single round robin → 15 fixtures.
    expect(fixtureIds.length).toBe(15);
  });

  test("start the tournament from the division console", async ({ page, request }) => {
    await page.goto(`/divisions/${divisionId}`);
    await page.getByRole("button", { name: "Start tournament" }).click();
    // Fixtures were pre-generated, so quick-start generates 0 and only
    // refreshes (no redirect). The button label flips to "Starting…" while the
    // POST is in flight, so poll the API for the real status change.
    await expect
      .poll(
        async () => {
          try {
            return (await apiJson<{ status: string }>(request, `/api/v1/divisions/${divisionId}`))
              .data?.status;
          } catch {
            return undefined; // transient dev-server hiccup — keep polling
          }
        },
        { timeout: 20_000 },
      )
      .toBe("active");
    await page.goto(`/divisions/${divisionId}?tab=fixtures`);
    await expect(page.getByRole("link", { name: /^Score/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("score one fixture on the pad, the rest via API", async ({ page, request }) => {
    await page.goto(`/divisions/${divisionId}?tab=fixtures`);
    await page.getByRole("link", { name: /^Score/ }).first().click();
    await page.waitForURL(/\/f\/\d+/, { timeout: 20_000 });
    // PROMPT-30: the URL carries the per-division ordinal — map back to the id.
    const padNo = Number(page.url().match(/\/f\/(\d+)/)![1]!);
    let padFixtureId = "";
    for (const id of fixtureIds) {
      const fx = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${id}`);
      if (fx.data!.fixture_no === padNo) {
        padFixtureId = id;
        break;
      }
    }
    expect(padFixtureId).not.toBe("");
    // Generic score pad: one labelled number input per side, then Record result.
    const inputs = page.getByRole("spinbutton");
    await inputs.nth(0).fill("3");
    await inputs.nth(1).fill("1");
    await page.getByRole("button", { name: "Record result" }).click();
    // The result is decided when the API says so (UI copy churns during save).
    await expect
      .poll(
        async () =>
          (await apiJson<{ status: string }>(request, `/api/v1/fixtures/${padFixtureId}/state`))
            .data?.status,
        { timeout: 20_000 },
      )
      .toMatch(/decided|finalized/);

    await scoreRemainingFixtures(request, fixtureIds, new Set([padFixtureId]));
    // Every fixture is now decided.
    for (const id of fixtureIds.slice(0, 3)) {
      const state = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${id}/state`);
      expect(["decided", "finalized"]).toContain(state.data!.status);
    }
  });

  test("complete the stage and verify the standings table", async ({ page, request }) => {
    const done = await apiJson(request, `/api/v1/stages/${stageId}/complete`, "POST");
    expect(done.status).toBeLessThan(300);

    await page.goto(`/divisions/${divisionId}?tab=standings`);
    // A ranked table with every entrant present (names render as rowheaders).
    for (const name of PLAYERS) {
      await expect(page.getByRole("row", { name: new RegExp(`\\b${name}\\b`) }).first()).toBeVisible(
        { timeout: 20_000 },
      );
    }
  });

  test("slideshow renders the standings slide", async ({ page }) => {
    await page.goto(`/slideshow/divisions/${divisionId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Open", {
      timeout: 20_000,
    });
    await expect(page.getByText(PLAYERS[0]!).first()).toBeVisible();
  });

  test("public site and public JSON expose the completed division", async ({
    page,
    request,
  }) => {
    orgSlug = (await activeOrg(page)).slug;

    // Public competition page lists the division.
    await page.goto(`/shared/${orgSlug}/${competitionSlug}`);
    await expect(page.getByText("Open").first()).toBeVisible({ timeout: 20_000 });

    // Division page defaults to the schedule tab — results show as links
    // ("Boole vs Ada 3 — 1"); the bare name also hides in a filter <option>,
    // so anchor on the visible fixture links, then the standings tab.
    await page.goto(`/shared/${orgSlug}/${competitionSlug}/${divisionSlug}`);
    await expect(
      page.getByRole("link", { name: new RegExp(`\\b${PLAYERS[0]!}\\b`) }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Standings" }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(`\\b${PLAYERS[0]!}\\b`) }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Public JSON endpoints respond with non-empty payloads.
    const base = `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/divisions/${divisionSlug}`;
    for (const leaf of ["entrants", "standings", "schedule"]) {
      const res = await apiJson<unknown[]>(request, `${base}/${leaf}`);
      expect(res.status, `${leaf} should be public`).toBe(200);
    }
  });

  test("a private competition is invisible on the public site", async ({ page, request }) => {
    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { name: `Secret ${TAG}`, visibility: "private" },
    );
    const res = await page.request.get(`/shared/${orgSlug}/${comp.data!.slug}`);
    expect(res.status()).toBe(404);
  });

  test("an unlisted competition is reachable by link but noindexed", async ({
    page,
    request,
  }) => {
    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { name: `Backdoor ${TAG}`, visibility: "unlisted" },
    );
    await page.goto(`/shared/${orgSlug}/${comp.data!.slug}`);
    await expect(page.getByRole("heading", { name: `Backdoor ${TAG}` })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("timetable export is available on Pro", async ({ request }) => {
    const res = await request.get(`/api/v1/competitions/${competitionId}/exports/timetable`);
    expect(res.status()).toBe(200);
  });
});
