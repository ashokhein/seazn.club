import { test, expect } from "@playwright/test";
import { TAG, apiJson } from "./helpers";

// Unified Add-Entrant: enroll an EXISTING team into a division from the UI
// (the "Existing team" mode), instead of re-running the CSV import.
test("enroll an existing team into a division via the UI", async ({ page }) => {
  // Seed a team by importing it (no Division column → directory only, no entry).
  const csv = `Club,Team,Player\nRiverside ${TAG},Riverside U12 ${TAG},Ada ${TAG}`;
  const up = await page.request.post("/api/v1/imports", {
    multipart: { file: { name: "p.csv", mimeType: "text/csv", buffer: Buffer.from(csv) } },
  });
  const importId = ((await up.json()) as { data: { importId: string } }).data.importId;
  await page.request.post(`/api/v1/imports/${importId}/commit`, { data: {} });

  // A competition + division to enroll into.
  const comp = (await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    name: `Enroll ${TAG}`,
    visibility: "public",
  })).data!;
  const div = (await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    },
  )).data!;

  await page.goto(`/divisions/${div.id}?tab=entrants`);
  await page.getByRole("button", { name: "Existing team" }).click();
  await page.getByRole("textbox", { name: "Search teams" }).fill(`Riverside U12 ${TAG}`);
  await page.getByText(`Riverside U12 ${TAG}`, { exact: true }).first().click();
  await page.getByRole("button", { name: /Enroll team/ }).click();

  // The team now appears as an entrant in the division table.
  await expect(page.getByRole("cell", { name: `Riverside U12 ${TAG}` })).toBeVisible();
});
