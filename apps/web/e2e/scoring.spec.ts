import { test, expect } from "@playwright/test";
import {
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  seedScoredDivision,
  TAG,
} from "./helpers";

// Scoring discoverability + sport-shaped pads (organiser feedback: the score
// pad was hard to reach, and cricket should be over-by-over, not ball-by-ball).

test("every fixture row has a Score entry point", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);
  await page.goto(`/divisions/${divisionId}?tab=fixtures`);
  // decided fixtures show "View", live/scheduled show "Score"
  await expect(page.getByRole("link", { name: /^(Score|View)/ }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("forfeit dropdown closes when clicking outside", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Badminton ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "MS", sport_key: "badminton", variant_key: "bwf", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Asha", "Bala"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  await page.goto(`/fixtures/${fixtureIds[0]}`);
  await page.getByRole("button", { name: /Forfeit/ }).click({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /forfeits$/ }).first()).toBeVisible();

  // clicking anywhere outside the menu must dismiss it
  await page.getByRole("heading", { level: 1 }).click();
  await expect(page.getByRole("button", { name: /forfeits$/ })).toHaveCount(0);
});

test("badminton pad shows the current game number, not always game 1", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Badminton games ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "WS", sport_key: "badminton", variant_key: "bwf", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const { ids } = await addEntrantsViaApi(request, divisionId, ["Mina", "Rita"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  // start + take game 1 to 21-0 via the ledger API
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  for (let seq = 1; seq <= 21; seq++) {
    await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: seq,
      type: "badminton.rally",
      payload: { wonBy: ids[0] },
    });
  }

  await page.goto(`/fixtures/${fixtureId}`);
  await expect(page.getByText("Game 2", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/1 game won/)).toBeVisible();
});

test("badminton: an entered game score lands in the header summary live (v3/09 §1a)", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Badminton header ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "MS", sport_key: "badminton", variant_key: "bwf", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Priya", "Sana"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });

  await page.goto(`/fixtures/${fixtureId}`);
  // Coarse entry: record game 1 as 21-15 through the Game-totals form. Under
  // load the fill can land before React hydrates — re-fill until it sticks.
  await page.getByRole("button", { name: /Game totals/ }).click({ timeout: 20_000 });
  await expect(async () => {
    await page.getByLabel(/Priya points/).fill("21");
    await page.getByLabel(/Sana points/).fill("15");
    await expect(page.getByRole("button", { name: /Record game/ })).toBeEnabled({
      timeout: 1_000,
    });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: /Record game/ }).click();

  // The chosen score is reflected in the top score (intake #28a).
  await expect(page.getByText("1 — 0 · 21–15")).toBeVisible({ timeout: 20_000 });
});

test("cricket: undo mid-over keeps the scoring panel usable (v3/09 §2)", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Cricket undo ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "T20", sport_key: "cricket", variant_key: "t20", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      { kind: "team", display_name: "Kings", seed: 1 },
      { kind: "team", display_name: "Queens", seed: 2 },
    ],
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "knockout", name: "Final" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "cricket.toss",
    payload: { wonBy: entrants.data![0]!.id, elected: "bat" },
  });
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "core.start",
    payload: {},
  });
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 2,
    type: "cricket.innings.summary",
    payload: { runs: 12, wickets: 1, legalBalls: 6, partial: true },
  });

  await page.goto(`/fixtures/${fixtureId}`);
  await expect(page.getByText(/— total/)).toContainText("12/1", { timeout: 20_000 });

  // The intake #29 repro action: Undo last (voids the over).
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(page.getByText(/— total/)).toContainText("0/0", { timeout: 20_000 });

  // The panel stays usable — no blank screen, no dead-end: score again.
  await expect(page.getByRole("button", { name: "Over-by-over" })).toBeVisible();
  await expect(async () => {
    await page.getByLabel(/runs this over/i).fill("8");
    await expect(page.getByRole("button", { name: /add over/i })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: /add over/i }).click();
  await expect(page.getByText(/— total/)).toContainText("8/0", { timeout: 20_000 });

  // Undo storms past the start: the console never dead-ends. Two more undos
  // (the corrected over, then core.start) must land back on "Start match".
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(page.getByText(/— total/)).toContainText("0/0", { timeout: 20_000 });
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(page.getByRole("button", { name: "Start match" })).toBeVisible({
    timeout: 20_000,
  });
});

test("cricket scores over-by-over: add an over grows the total, then close innings", async ({
  page,
  request,
}) => {
  // a minimal cricket fixture
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Cricket ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "T20", sport_key: "cricket", variant_key: "t20", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      { kind: "team", display_name: "Lions", seed: 1 },
      { kind: "team", display_name: "Tigers", seed: 2 },
    ],
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "knockout", name: "Final" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  // open the first innings via toss + start so the pad lands ready to score
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "cricket.toss",
    payload: { wonBy: entrants.data![0]!.id, elected: "bat" },
  });
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "core.start",
    payload: {},
  });

  await page.goto(`/fixtures/${fixtureId}`);

  // over-by-over is the default mode
  await expect(page.getByRole("button", { name: "Over-by-over" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/— total/)).toContainText("0/0");

  // record one over: 12 runs, 1 wicket. Under load the fill can land before
  // React hydrates (DOM value set, state empty → button stays disabled), so
  // re-fill until the pad actually accepts the input.
  await expect(async () => {
    await page.getByLabel(/runs this over/i).fill("12");
    await expect(page.getByRole("button", { name: /add over/i })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByLabel(/wickets this over/i).fill("1");
  await page.getByRole("button", { name: /add over/i }).click();

  // the innings total grows (progressive summary folded)
  await expect(page.getByText(/— total/)).toContainText("12/1", { timeout: 20_000 });
  await expect(page.getByText(/\(1\.0 ov\)/)).toBeVisible();

  // close the innings — the second innings opens (total resets to 0/0)
  await page.getByRole("button", { name: /^Close innings$/ }).click();
  await expect(page.getByText(/— total/)).toContainText("0/0", { timeout: 20_000 });
});
