import { test, expect } from "@playwright/test";
import { apiJson, TAG } from "./helpers";

// PROMPT-28 formats: the new stage presets are reachable from the division
// builder, and a ladder division renders its challenge panel.
test("division builder exposes the Jul3/08 format presets", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Formats ${TAG}`,
    visibility: "private",
  });
  await page.goto(`/competitions/${comp.data!.id}/divisions/new`);

  // The new presets are visible on the format picker.
  await expect(page.getByText("Triple round robin")).toBeVisible();
  await expect(page.getByText("Americano (padel)")).toBeVisible();
  await expect(page.getByText("Mexicano (padel)")).toBeVisible();
  await expect(page.getByText("Ladder", { exact: true })).toBeVisible();
});

test("ladder division renders the challenge panel", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Ladder ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Ladder", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["Alpha", "Bravo", "Charlie", "Delta"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1, kind: "ladder", name: "Ladder", config: { challengeRange: 2 },
  });

  await page.goto(`/divisions/${divisionId}?tab=fixtures`);
  // the ladder panel: challenge form + ranked entrants
  await expect(page.getByRole("button", { name: /issue challenge/i })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Alpha" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Charlie" })).toBeVisible();
});
