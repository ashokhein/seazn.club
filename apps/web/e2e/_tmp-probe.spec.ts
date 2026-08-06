import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, divisionPath } from "./helpers";

// THROWAWAY probe — settles whether the "board still shows every card as
// unscheduled after Auto-schedule" symptom is caused by the legacy id-route
// shim (router.refresh() refetching a 308) or is independent of the URL.
// Delete before commit.

const START = new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString();

async function seedBoard(
  request: APIRequestContext,
  label: string,
): Promise<{ divisionId: string; fixtureIds: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Probe ${label} ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: label,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ash", "Brook", "Clay", "Dune"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length).toBe(6);
  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: START,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court A", "Court B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  return { divisionId, fixtureIds };
}

for (const mode of ["id", "slug"] as const) {
  test(`probe ${mode}`, async ({ page, request }) => {
    const { divisionId, fixtureIds } = await seedBoard(request, mode);
    const url =
      mode === "id"
        ? `/divisions/${divisionId}/schedule?tab=board`
        : await divisionPath(request, divisionId, "/schedule?tab=board");
    await page.goto(url);
    console.log(`PROBE[${mode}] requested=${url}`);
    console.log(`PROBE[${mode}] landed=${page.url()}`);

    const tray = page.locator('aside[aria-label="Unscheduled fixtures"]');
    await expect(tray).toBeVisible({ timeout: 30_000 });

    const button = page.getByTestId("schedule-auto");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    const strip = page.getByTestId("schedule-result-strip");
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(button).toBeEnabled({ timeout: 45_000 });
    console.log(`PROBE[${mode}] status=${await strip.getAttribute("data-status")}`);

    // Give the RSC refresh a generous window; the symptom is "never self-corrects".
    await page.waitForTimeout(8_000);
    const trayCount = await tray.count();
    console.log(`PROBE[${mode}] urlAfter=${page.url()}`);
    console.log(`PROBE[${mode}] trayStillPresent=${trayCount}`);
    if (trayCount > 0) {
      console.log(`PROBE[${mode}] trayHeading=${await tray.locator("h4").textContent()}`);
    }
    // Ground truth from the server.
    const rows = await Promise.all(
      fixtureIds.map(async (id) =>
        (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${id}`)).data!,
      ),
    );
    console.log(
      `PROBE[${mode}] dbScheduled=${rows.filter((f) => f.scheduled_at !== null).length}/${rows.length}`,
    );
  });
}
