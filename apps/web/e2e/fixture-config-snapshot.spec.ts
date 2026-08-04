import { test, expect } from "@playwright/test";
import {
  TAG,
  activeOrg,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  fixtureConfigSnapshotSql,
  setDivisionConfigSql,
  setOwnerStaffSql,
} from "./helpers";

// A CONFIG EDIT MUST NOT REACH BACK INTO A SCORED FIXTURE (V347), end to end
// over the real rail — the API, the ISR-free state route and the /admin escape
// hatch, not the adapter in isolation.
//
// SERIAL: borrows the shared Pro owner's staff bit for the /admin half.

const CFG_WITH_DRAWS = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** A generic division with one scored fixture, and the ids to poke at it. */
async function seedDrawnFixture(
  request: Parameters<typeof apiJson>[0],
  label: string,
): Promise<{ divisionId: string; fixtureId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Cfg snapshot ${label} ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: CFG_WITH_DRAWS },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Asha", "Bala"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "league",
    name: "League",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  const fixtureId = fixtureIds[0]!;
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  // A DRAW, on purpose: `allowDraws` is an ungated cfg-derived refusal inside
  // generic's apply(), so flipping the flag afterwards is the sharpest available
  // reproduction of "a config edit bricks a recorded fixture".
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "generic.result",
    payload: { p1Score: 1, p2Score: 1 },
  });
  return { divisionId, fixtureId };
}

test("the first event freezes the config the fixture is scored under", async ({ request }) => {
  const { fixtureId } = await seedDrawnFixture(request, "freeze");
  expect(await fixtureConfigSnapshotSql(fixtureId)).toMatchObject({ allowDraws: true });
});

test("editing the division config neither rescores nor locks the scorer out", async ({
  request,
}) => {
  const { divisionId, fixtureId } = await seedDrawnFixture(request, "edit");
  const before = await apiJson<{ outcome: unknown; summary: unknown }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(before.data!.outcome).toEqual({ kind: "draw" });

  // The organiser bans draws, weeks later. `/events` re-folds the WHOLE stream
  // on every append, so before V347 this made every further write to the fixture
  // fail — core.void included, so there was no undo that recovered it and the
  // organiser could never finalize the match they had already played.
  await setDivisionConfigSql(divisionId, { ...CFG_WITH_DRAWS, allowDraws: false });

  const finalize = await request.post(`/api/v1/fixtures/${fixtureId}/events`, {
    data: { expected_seq: 2, type: "core.finalize", payload: {} },
  });
  expect(finalize.status(), await finalize.text()).toBe(201);

  const after = await apiJson<{ outcome: unknown; summary: unknown; status: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(after.data!.status).toBe("finalized");
  // The result the organiser published is the one that got finalized.
  expect(after.data!.outcome).toEqual({ kind: "draw" });
  expect(after.data!.summary).toEqual(before.data!.summary);
});

test("staff can re-snapshot a reopened fixture, and the hatch holds at 375px", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureId } = await seedDrawnFixture(request, "hatch");
  // A correction the recorded draw can still be read under — the route refuses
  // one that cannot, which `admin-fixture-config.test.ts` pins separately.
  await setDivisionConfigSql(divisionId, { ...CFG_WITH_DRAWS, points: { w: 2, d: 1, l: 0 } });

  const org = await activeOrg(page);
  await setOwnerStaffSql(org.id, true);
  try {
    // Reference phone first: /admin is functional-bar, but it still may not
    // scroll sideways at 375px.
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/admin/fixtures?id=${fixtureId}`);

    const panel = page.getByTestId("fixture-config-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // The whole reason staff open this page.
    await expect(panel).toHaveAttribute("data-diverged", "yes");
    await expect(panel).toHaveAttribute("data-can-resnapshot", "yes");
    await expectNoHorizontalScroll(page);

    await page.getByTestId("resnapshot-reason").fill("e2e: organiser fixed the points table");
    await page.getByTestId("resnapshot-submit").click();

    // router.refresh() re-renders the server component with the new snapshot.
    await expect(panel).toHaveAttribute("data-diverged", "no", { timeout: 20_000 });
    await expect(page.getByTestId("resnapshot-error")).toHaveCount(0);
    expect(await fixtureConfigSnapshotSql(fixtureId)).toMatchObject({
      points: { w: 2, d: 1, l: 0 },
    });
    await expectNoHorizontalScroll(page);

    // …and the fixture still reads.
    const after = await apiJson<{ outcome: unknown }>(
      request,
      `/api/v1/fixtures/${fixtureId}/state`,
    );
    expect(after.data!.outcome).toEqual({ kind: "draw" });
  } finally {
    await setOwnerStaffSql(org.id, false);
  }
});

test("a finalized fixture is refused until it is reopened", async ({ page, request }) => {
  const { fixtureId } = await seedDrawnFixture(request, "locked");
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 2,
    type: "core.finalize",
    payload: {},
  });

  const org = await activeOrg(page);
  await setOwnerStaffSql(org.id, true);
  try {
    await page.goto(`/admin/fixtures?id=${fixtureId}`);
    const panel = page.getByTestId("fixture-config-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toHaveAttribute("data-can-resnapshot", "no");
    await expect(page.getByTestId("resnapshot-blocked")).toContainText(/reopen/i);
    await expect(page.getByTestId("resnapshot-submit")).toHaveCount(0);
  } finally {
    await setOwnerStaffSql(org.id, false);
  }
});
