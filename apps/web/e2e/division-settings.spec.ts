import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// v8 acceptance (spec 2026-07-13): the division Settings tab collects
// general/format/sharing/danger; the format locks once fixtures exist (UI
// read-only + PATCH 409 FORMAT_LOCKED); cards wear their new identity —
// sport banner on competitions, monogram tile on divisions.

async function seedRig(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `V8 Settings ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Tile Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  return { compSlug: comp.data!.slug, divisionId: div.data!.id, divSlug: div.data!.slug };
}

test("settings tab: sections render, rename works, format locks with fixtures", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRig(request);
  const base = `/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}`;

  await page.goto(`${base}?tab=settings`);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: 20_000 });
  for (const section of ["General", "Format", "Sharing & embed", "Danger zone"]) {
    await expect(page.getByRole("button", { name: new RegExp(section) })).toBeVisible();
  }

  // Rename from General persists — and the client follows the regenerated
  // slug WITHOUT losing the settings tab (demo-caught regression).
  await page.getByLabel("Division name").fill("Tile Open Renamed");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.waitForURL(/\/d\/tile-open-renamed\?tab=settings/, { timeout: 15_000 });
  await expect(page.getByTestId("division-settings")).toBeVisible();

  // Format editor is live pre-fixtures — structured fields, no JSON needed.
  await page.getByRole("button", { name: /Format/ }).click();

  // Competition format: pick Groups + Knockout, apply, structure rebuilds.
  await page.getByTestId("format-template").selectOption("groups_ko");
  await page.getByRole("spinbutton", { name: "Top N advance" }).fill("2");
  await page.getByTestId("apply-structure").click();
  await expect(page.getByText("Format changed — stages rebuilt.")).toBeVisible();
  await expect(page.getByTestId("stage-structure")).toContainText("Group stage");
  await expect(page.getByTestId("stage-structure")).toContainText("Knockout");

  // Match rules still apply independently.
  await page.getByRole("spinbutton", { name: "Win" }).fill("5");
  await page.getByRole("button", { name: "Apply format" }).click();
  await expect(page.getByText("Format updated.")).toBeVisible();

  // The strays moved: no embed snippet / danger zone under other tabs.
  await page.goto(`${base}?tab=entrants`);
  await expect(page.getByTestId("division-settings")).toHaveCount(0);
  await expect(page.getByText("Danger zone")).toHaveCount(0);

  // Generate fixtures on the new structure → the format is history.
  await apiJson(
    request,
    `/api/v1/divisions/${rig.divisionId}/entrants`,
    "POST",
    ["Alpha", "Bravo", "Cara", "Drew"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stagesNow = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${rig.divisionId}/stages`);
  await apiJson(request, `/api/v1/stages/${stagesNow.data![0]!.id}/generate`, "POST");

  // Renames regenerate the slug — resolve the current one before navigating.
  const fresh = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${rig.divisionId}`);
  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${fresh.data!.slug}?tab=settings`);
  await page.getByRole("button", { name: /Format/ }).click();
  await expect(page.getByTestId("format-locked")).toBeVisible();
  await expect(page.getByText("Format is locked — fixtures exist")).toBeVisible();

  const res = await page.request.patch(`/api/v1/divisions/${rig.divisionId}`, {
    data: { variant_key: "score" },
  });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("FORMAT_LOCKED");

  const swap = await page.request.put(`/api/v1/divisions/${rig.divisionId}/stages`, {
    data: [{ seq: 1, kind: "league", name: "L", config: {}, qualification: null }],
  });
  expect(swap.status()).toBe(409);
  expect(((await swap.json()) as { error?: { code?: string } }).error?.code).toBe("FORMAT_LOCKED");
});

test("cards wear their identity: sport banner on comps, monogram tile on divisions", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRig(request);

  await page.goto(`/o/${org.slug}`);
  await expect(page.getByTestId("card-banner").first()).toBeVisible({ timeout: 20_000 });

  await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
  const tile = page.getByTestId("card-tile").first();
  await expect(tile).toBeVisible();
  await expect(tile).toHaveText("T"); // "Tile Open" → monogram T
});
