import { test, expect } from "@playwright/test";
import { apiJson, TAG } from "./helpers";

// Division delete on the free plan (v3/09 §4, PROMPT-38): deleting a
// setup-state division frees the divisions.per_competition slot — the honest
// behaviour, and the reason people ask for delete. Serial: community-org
// quotas are shared state.
test.use({ storageState: "e2e/.auth/community.json" });

const GENERIC = {
  sport_key: "generic",
  variant_key: "score",
  config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
};

test("deleting a setup division lifts the free-plan divisions gate", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Del Gate ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;

  const first = await apiJson<{ id: string; name: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    { name: "Only Slot", ...GENERIC },
  );
  expect(first.status).toBe(201);
  const divisionId = first.data!.id;

  // Community divisions.per_competition.max = 1: the second is 402-gated.
  const gated = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Second",
    ...GENERIC,
  });
  expect(gated.status).toBe(402);

  // Delete through the UI: Danger zone → typed-name confirm.
  await page.goto(`/divisions/${divisionId}`);
  await page.getByRole("button", { name: /Delete division/ }).click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Destroyed:/)).toBeVisible();
  await expect(dialog.getByText(/Kept:/)).toBeVisible();
  // The confirm button stays disabled until the exact name is typed.
  await expect(dialog.getByRole("button", { name: "Delete division" })).toBeDisabled();
  await dialog.getByRole("textbox").fill("Only Slot");
  await dialog.getByRole("button", { name: "Delete division" }).click();

  // Redirects to the competition page; the division is gone.
  await page.waitForURL(`**/competitions/${compId}`, { timeout: 20_000 });
  const goneRes = await apiJson(request, `/api/v1/divisions/${divisionId}`);
  expect(goneRes.status).toBe(404);

  // The gate has lifted — the slot is free again.
  const retried = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Second",
    ...GENERIC,
  });
  expect(retried.status).toBe(201);

  // Cleanup: free the community org's competitions.max_active slot.
  await apiJson(request, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "archived",
    visibility: "private",
  });
});
