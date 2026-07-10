import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// Regression: carrom had no pad, fell through to GenericPad, and every score
// attempt died with `unknown event type "generic.result"` (organiser report
// 2026-07-10). The carrom pad records boards via carrom.board.summary.
test("carrom fixture scores board-by-board through its own pad", async ({ page, request }) => {
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Carrom ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Boards", sport_key: "carrom", variant_key: "icf", config: {} },
  );
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Meena", seed: 1 },
    { kind: "individual", display_name: "Ravi", seed: 2 },
  ]);
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const gen = await apiJson<{ fixtures: { id: string; fixture_no: number }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  const fixtureNo = gen.data!.fixtures[0]!.fixture_no;

  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${fixtureNo}`);

  // The carrom pad renders (not the generic score-entry pad).
  await expect(page.getByText("Board won by")).toBeVisible({ timeout: 20_000 });

  // Record one board: Meena wins, 4 coins left, queen covered by Meena.
  await page.getByRole("button", { name: "Meena", exact: true }).click();
  await page.getByLabel(/Opponent's coins left/).fill("4");
  await page.getByLabel(/Queen covered by/).selectOption({ label: "Meena" });
  await page.getByRole("button", { name: "Record board" }).click();

  // The board banks points (4 coins + queen 3 = 7) — and no unknown-event
  // error surfaces anywhere.
  await expect(page.getByText(/\(7\)/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/unknown event/i)).toHaveCount(0);
});
