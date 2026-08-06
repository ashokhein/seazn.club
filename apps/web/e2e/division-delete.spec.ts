import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addEntrantsViaApi, apiJson, createStageAndGenerate, TAG } from "./helpers";

// The two sentences #376 part D added, read from the SHIPPED catalogue rather
// than retyped: this suite's whole point is that the customer meets that exact
// copy, and a hand-copied string turns a wording change into a passing test
// against text nobody ships. Read as a file, not `import … from "…json"` —
// Playwright's loader rejects a bare JSON import without an import attribute.
const uiEn = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

// Division delete on the free plan (v3/09 §4, PROMPT-38): deleting a
// setup-state division frees the divisions.per_competition slot — the honest
// behaviour, and the reason people ask for delete. Serial: community-org
// quotas are shared state.
test.use({ storageState: "e2e/.auth/community.json" });

/** Id of the division with this name in a list response, or a loud failure —
 *  an `undefined` id navigates to a 404 that reads as a missing warning. */
function listedIds(
  res: { data?: { id: string; name: string }[] | null },
  name: string,
): string {
  const hit = (res.data ?? []).find((d) => d.name === name);
  if (!hit) throw new Error(`no division named ${JSON.stringify(name)} in the list`);
  return hit.id;
}

const GENERIC = {
  sport_key: "generic",
  variant_key: "score",
  config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
};

test("deleting a setup division lifts the free-plan divisions gate", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
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
  for (const name of ["Filler 2", "Filler 3", "Filler 4"]) {
    const filler = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name,
      ...GENERIC,
    });
    expect(filler.status).toBe(201);
  }

  // Community divisions.per_competition.max = 4 (V319): the fifth is 402-gated.
  const gated = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Fifth",
    ...GENERIC,
  });
  expect(gated.status).toBe(402);

  // Delete through the UI: Danger zone → typed-name confirm.
  // v8: delete lives in Settings → Danger zone.
  await page.goto(`/divisions/${divisionId}?tab=settings`);
  await page.getByRole("button", { name: /Danger zone/ }).click({ timeout: 20_000 });
  await page.getByRole("button", { name: /Delete division/ }).click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Destroyed:/)).toBeVisible();
  await expect(dialog.getByText(/Kept:/)).toBeVisible();
  // The confirm button stays disabled until the exact name is typed.
  await expect(dialog.getByRole("button", { name: "Delete division" })).toBeDisabled();
  await dialog.getByRole("textbox").fill("Only Slot");
  await dialog.getByRole("button", { name: "Delete division" }).click();

  // Redirects to the competition page; the division is gone.
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/?]+$/, { timeout: 20_000 });
  const goneRes = await apiJson(request, `/api/v1/divisions/${divisionId}`);
  expect(goneRes.status).toBe(404);

  // The gate has lifted — the slot is free again.
  const retried = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Fifth",
    ...GENERIC,
  });
  expect(retried.status).toBe(201);

  // Cleanup: free the community org's competitions.max_active slot.
  await apiJson(request, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "archived",
    visibility: "private",
  });
});

// The other half of the same rule, and the honest one (#376 part D, task 8).
// Archiving a PLAYED division does NOT free its slot (V354) — so the org ends
// up looking at three divisions, a limit of four, and a paywall. Both ends now
// say why: the danger zone warns before the click, and the wizard names the
// invisible cause under the 402.
//
// Lives in this spec rather than division-archive.spec.ts because community
// quotas are shared state and this file is already in the SERIAL project;
// division-archive runs in parallel on the Pro org, where no limit bites.
test("a played division keeps its slot, and both surfaces say so", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Slot Truth ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;

  // Fill community's 4 (V319). The FIRST one gets played and archived; the
  // other three stay visible, so the console shows 3 against a limit of 4
  // while the create is refused — the arithmetic that used to be unexplained.
  const played = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    { name: "Played Grade", ...GENERIC },
  );
  expect(played.status).toBe(201);
  const playedId = played.data!.id;
  for (const name of ["Filler 2", "Filler 3", "Filler 4"]) {
    const filler = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name,
      ...GENERIC,
    });
    expect(filler.status).toBe(201);
  }

  // A real recorded result, through the fixture event stream — the slot rule
  // reads fixture STATUS, so a division that merely started would not do.
  await addEntrantsViaApi(request, playedId, ["Ana", "Ben"]);
  const { fixtureIds } = await createStageAndGenerate(request, playedId, {
    kind: "league",
    name: "League",
  });
  await apiJson(request, `/api/v1/divisions/${playedId}/start`, "POST");
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

  // Non-vacuity guard for the locator below: an UNPLAYED division's danger
  // zone must carry no warning at all. Without this a `data-slot-warning`
  // rendered unconditionally would satisfy every positive assertion here.
  const unplayed = listedIds(
    await apiJson<{ id: string; name: string }[]>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
    ),
    "Filler 2",
  );
  await page.goto(`/divisions/${unplayed}?tab=settings`);
  await page.getByRole("button", { name: /Danger zone/ }).click({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Archive division" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("[data-slot-warning]")).toHaveCount(0);

  // Surface 1: the warning is on screen BEFORE the archive button is clicked.
  await page.goto(`/divisions/${playedId}?tab=settings`);
  await page.getByRole("button", { name: /Danger zone/ }).click({ timeout: 20_000 });
  const warning = page.locator("[data-slot-warning]");
  await expect(warning).toBeVisible({ timeout: 20_000 });
  await expect(warning).toHaveText(uiEn["division.archive.slotWarning"]);

  await page.getByRole("button", { name: "Archive division" }).click({ timeout: 20_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Archive division" }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/?]+$/, { timeout: 20_000 });

  // The slot did NOT come back — three divisions visible, still refused.
  const listed = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
  );
  expect(listed.data!.length).toBe(3);
  const gated = await apiJson(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Fifth",
    ...GENERIC,
  });
  expect(gated.status).toBe(402);

  // Surface 2: the same refusal through the wizard names the invisible cause.
  await page.goto(`/competitions/${compId}/divisions/new`);
  await page.getByRole("textbox").first().fill("Fifth");
  await page.getByRole("button", { name: "Scheduling", exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await expect(
    page.locator('[data-feature="divisions.per_competition.max"]'),
  ).toBeVisible({ timeout: 30_000 });
  const note = page.locator("[data-archived-slot-note]");
  await expect(note).toBeVisible();
  await expect(note).toHaveText(uiEn["division.limit.archivedCount"]);

  // Cleanup: free the community org's competitions.max_active slot.
  await apiJson(request, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "archived",
    visibility: "private",
  });
});
