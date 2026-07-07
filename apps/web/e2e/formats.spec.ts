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

  // issue a challenge: #3 (Charlie) challenges #1 (Alpha), within range 2
  await page.getByLabel("Challenger").selectOption({ label: "Charlie" });
  await page.getByLabel(/challenges \(must be above\)/i).selectOption({ label: "Alpha" });
  await page.getByRole("button", { name: /issue challenge/i }).click();

  // success clears the form (the challenge fixture was created) and no red
  // error banner appears
  await expect(page.getByLabel("Challenger")).toHaveValue("", { timeout: 20_000 });
  await expect(page.locator(".bg-red-50")).toHaveCount(0);
});

test("americano renders the rotation grid", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Americano ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Padel", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  const divisionId = div.data!.id;
  // americano needs individuals backed by persons
  const players = [];
  for (let i = 0; i < 8; i++) {
    const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: `Padel ${i + 1} ${TAG}`,
      consent: {},
    });
    players.push({
      kind: "individual", display_name: `Player ${i + 1}`, seed: i + 1,
      members: [{ person_id: p.data!.id, is_captain: false, roles: [] }],
    });
  }
  await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", players);
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 5 } },
  );
  await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  await page.goto(`/divisions/${divisionId}?tab=fixtures`);
  // the rotation grid: mode chip + round cards + courts (scoped to the panel)
  const grid = page.getByLabel("Americano rotation");
  await expect(grid.getByText("americano", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(grid.getByRole("heading", { name: "Round 1" })).toBeVisible();
  await expect(grid.getByText(/Court 1/).first()).toBeVisible();

  // in-grid scoring: fill the first match's two score boxes and save
  const scoreInputs = grid.getByRole("spinbutton");
  await scoreInputs.nth(0).fill("24");
  await scoreInputs.nth(1).fill("18");
  await grid.getByRole("button", { name: /save score/i }).first().click();

  // the match flips to scored and the personal-points leaderboard populates
  await expect(grid.getByText(/✓ scored/).first()).toBeVisible({ timeout: 20_000 });
  await expect(grid.getByRole("heading", { name: "Personal points" })).toBeVisible();
  // the scored pair's players now carry 24 points on the leaderboard
  await expect(grid.getByRole("cell", { name: "24", exact: true }).first()).toBeVisible();
});
