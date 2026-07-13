import { test, expect } from "@playwright/test";
import {
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  TAG,
} from "./helpers";

// Resulted-division lifecycle (v3/09 §4, PROMPT-38): delete 409s with the
// archive hint, archive hides the division, restore round-trips from the
// competition-settings "Archived divisions" surface. Own competition —
// parallel-safe on the Pro org.

test("resulted division: 409 → archive → restore round-trip", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Arch Cycle ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string; name: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Resulted",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.error, JSON.stringify(div.error ?? {})).toBeUndefined();
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ana", "Ben"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "league",
    name: "League",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 0 },
  });

  // Hard delete is refused with the archive hint.
  const refused = await apiJson(request, `/api/v1/divisions/${divisionId}`, "DELETE");
  expect(refused.status).toBe(409);
  expect(refused.error?.code).toBe("DIVISION_HAS_RESULTS");

  // Archive from the division's danger zone (plain danger confirm, no typing).
  // v8: archive lives in Settings → Danger zone.
  await page.goto(`/divisions/${divisionId}?tab=settings`);
  await page.getByRole("button", { name: /Danger zone/ }).click({ timeout: 20_000 });
  await page.getByRole("button", { name: "Archive division" }).click({ timeout: 20_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Archive division" }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/?]+$/, { timeout: 20_000 });

  // Hidden from the console list.
  const listed = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
  );
  expect(listed.data!.every((d) => d.id !== divisionId)).toBe(true);

  // Restore from competition settings → Archived tab.
  await page.goto(`/competitions/${compId}/settings`);
  await page.getByRole("tab", { name: /Archived/ }).click({ timeout: 20_000 });
  const archivedSection = page.getByTestId("archived-divisions");
  await expect(archivedSection.getByText("Resulted")).toBeVisible({ timeout: 20_000 });
  // Purge is locked behind the 30-day cool-off.
  await expect(archivedSection.getByRole("button", { name: /Purge/ })).toBeDisabled();
  await archivedSection.getByRole("button", { name: "Restore" }).click();
  await expect(archivedSection).toHaveCount(0, { timeout: 20_000 });

  // Back in the list, results intact.
  const relisted = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
  );
  expect(relisted.data!.some((d) => d.id === divisionId)).toBe(true);
  const fixture = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${fixtureIds[0]}`);
  expect(fixture.data!.status).toBe("decided");
});
