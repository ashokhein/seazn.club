import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createCompetitionViaUi,
  createStageAndGenerate,
  scoreRemainingFixtures,
} from "./helpers";

// The free tier runs a real (small) tournament end-to-end, and every plan
// ceiling bites with the contextual UpgradeGate (`data-feature` carries the
// same feature_key as the 402 — the stable selector).
test.use({ storageState: "e2e/.auth/community.json" });

test.describe.serial("community lifecycle", () => {
  const PLAYERS = ["North", "East", "South", "West"];
  let competitionId: string;
  let competitionSlug: string;
  let divisionId: string;
  let divisionSlug: string;
  let crowdedDivisionId: string; // created in the limits test; never started
  let limitsCompetitionId: string; // the limits test's own competition
  let fixtureIds: string[] = [];

  test("run a full small tournament on the free plan", async ({ page, request }) => {
    // On CI the dev server pays first-compile for the slideshow AND the public
    // division page inside this single test — 60s is not enough on a 2-core
    // runner (Turbopack took ~14s + ~19s for those two routes alone).
    test.slow();

    // A failed earlier attempt leaves its competition behind, and BOTH free
    // ceilings then 402 the wizard on retry: competitions.max_active counts
    // draft/published/live, and dashboard.public.max counts public rows in
    // ANY status. Retire leftovers on both axes (TAG differs per attempt —
    // match on the stable prefix).
    const leftovers = await apiJson<{ items: { id: string; name: string }[] }>(
      request,
      "/api/v1/competitions",
    );
    for (const c of leftovers.data?.items ?? []) {
      if (c.name.startsWith("Village Cup ") || c.name.startsWith("Limits ")) {
        await apiJson(request, `/api/v1/competitions/${c.id}`, "PATCH", {
          status: "archived",
          visibility: "private",
        });
      }
    }

    competitionId = await createCompetitionViaUi(page, `Village Cup ${TAG}`, "public");
    const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${competitionId}`);
    competitionSlug = comp.data!.slug;

    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      {
        name: "Village",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    expect(div.status).toBe(201);
    divisionId = div.data!.id;
    divisionSlug = div.data!.slug;

    const bulk = await addEntrantsViaApi(request, divisionId, PLAYERS);
    expect(bulk.status).toBeLessThan(300);

    const gen = await createStageAndGenerate(request, divisionId);
    fixtureIds = gen.fixtureIds;
    expect(fixtureIds.length).toBe(6); // 4 entrants, single RR

    // Start from the console (same UI moment the pro journey exercises).
    // Fixtures are pre-generated → quick-start refreshes without redirecting;
    // poll the API for the status flip (the button label churns meanwhile).
    await page.goto(`/divisions/${divisionId}`);
    await page.getByRole("button", { name: "Start tournament" }).click();
    await expect
      .poll(
        async () =>
          (await apiJson<{ status: string }>(request, `/api/v1/divisions/${divisionId}`)).data
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("active");

    await scoreRemainingFixtures(request, fixtureIds);

    // Standings render for the free org (names render as rowheaders).
    await page.goto(`/divisions/${divisionId}?tab=standings`);
    for (const name of PLAYERS) {
      await expect(page.getByRole("row", { name: new RegExp(`\\b${name}\\b`) }).first()).toBeVisible(
        { timeout: 20_000 },
      );
    }

    // Slideshow page renders (live updates are Pro; the noticeboard is not).
    await page.goto(`/slideshow/divisions/${divisionId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Village", {
      timeout: 20_000,
    });

    // Public site + JSON — community gets its public dashboard. The division
    // page defaults to the schedule tab; names as bare text hide in a filter
    // <option>, so anchor on the visible fixture links.
    const orgSlug = (await activeOrg(page)).slug;
    await page.goto(`/shared/${orgSlug}/${competitionSlug}/${divisionSlug}`);
    await expect(
      page.getByRole("link", { name: new RegExp(`\\b${PLAYERS[0]!}\\b`) }).first(),
    ).toBeVisible({ timeout: 20_000 });
    const pub = await apiJson<unknown[]>(
      request,
      `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/divisions/${divisionSlug}/standings`,
    );
    expect(pub.status).toBe(200);
  });

  test("17th entrant is blocked: 402 + contextual upgrade gate", async ({ page, request }) => {
    // The v3 free plan allows 1 active competition — retire the Village Cup
    // before this test's own competition, or the create itself 402s.
    if (competitionId) {
      await apiJson(request, `/api/v1/competitions/${competitionId}`, "PATCH", {
        status: "archived",
        visibility: "private",
      });
    }
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      name: `Limits ${TAG}`,
      visibility: "private",
    });
    limitsCompetitionId = comp.data!.id;
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    crowdedDivisionId = div.data!.id;

    // 16 fit exactly…
    const sixteen = await addEntrantsViaApi(
      request,
      crowdedDivisionId,
      Array.from({ length: 16 }, (_, i) => `P${i + 1}`),
    );
    expect(sixteen.status).toBeLessThan(300);

    // …the 17th 402s with the feature key…
    const overflow = await apiJson(
      request,
      `/api/v1/divisions/${crowdedDivisionId}/entrants`,
      "POST",
      { kind: "individual", display_name: "One Too Many" },
    );
    expect(overflow.status).toBe(402);
    expect(overflow.error?.code).toBe("PAYMENT_REQUIRED");

    // …and the same attempt through the panel renders the UpgradeGate.
    await page.goto(`/divisions/${crowdedDivisionId}?tab=entrants`);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Gate Trigger");
    await page.getByRole("button", { name: "Add entrant", exact: true }).click();
    await expect(page.locator('[data-feature="entrants.per_division.max"]')).toBeVisible({
      timeout: 20_000,
    });
  });

  test("3rd division in a competition is Pro-only (free cap: 2)", async ({ request }) => {
    const GENERIC = {
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    };
    // The limits competition holds one division; the 2nd fits the v3 cap…
    const second = await apiJson(
      request,
      `/api/v1/competitions/${limitsCompetitionId}/divisions`,
      "POST",
      { name: "Reserves", ...GENERIC },
    );
    expect(second.status).toBe(201);
    // …the 3rd is the paid layer.
    const third = await apiJson(
      request,
      `/api/v1/competitions/${limitsCompetitionId}/divisions`,
      "POST",
      { name: "Thirds", ...GENERIC },
    );
    expect(third.status).toBe(402);
    expect(third.error?.code).toBe("PAYMENT_REQUIRED");
  });

  test("2nd active competition hits the ceiling in the wizard", async ({ page, request }) => {
    // The limits competition holds the single free slot (v3). The API says 402…
    const third = await apiJson(request, "/api/v1/competitions", "POST", {
      name: `Ceiling ${TAG}`,
      visibility: "private",
    });
    expect(third.status).toBe(402);

    // …and the wizard shows the paywall instead of a dead error.
    await page.goto("/competitions/new");
    await page.getByPlaceholder("Summer Championship 2026").fill(`Ceiling UI ${TAG}`);
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page.locator('[data-feature="competitions.max_active"]')).toBeVisible({
      timeout: 20_000,
    });
  });

  test("plain exports are free since V285 (branded chrome stays Pro)", async ({ request }) => {
    // V285 flipped community `exports` to true — clean tables + "Powered by
    // seazn.club" footer; `exports.branded` (courtside chrome) stays Pro.
    const res = await request.get(
      `/api/v1/competitions/${competitionId}/exports/timetable`,
    );
    expect(res.status()).toBe(200);
  });

  test("advanced formats (ladder) are gated for community", async ({ request }) => {
    // Use the un-started limits division — stage edits on an active division
    // would fail for lifecycle reasons before the paywall is consulted.
    const res = await apiJson(request, `/api/v1/divisions/${crowdedDivisionId}/stages`, "POST", {
      seq: 1,
      kind: "ladder",
      name: "Ladder",
      config: { challengeRange: 2 },
    });
    expect(res.status).toBe(402);
    expect(res.error?.code).toBe("PAYMENT_REQUIRED");
  });
});
