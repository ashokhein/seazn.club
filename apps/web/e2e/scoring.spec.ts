import { test, expect } from "@playwright/test";
import {
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  expectNoHorizontalScroll,
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

// #451 — DLS reads a published resource table that is fixed at 6-ball overs and
// 10 wickets, so a division whose format is neither must have its inputs
// converted onto those scales before the lookup. `hundred` is the sharpest case
// on the overs axis: its overs are FIVE balls, so a 10-over revision is 50
// balls, not 60, and reading it as 60 inflates both resource percentages and
// publishes a target of 86 where the method says 84.
//
// Asserted through the API, not the DOM, on purpose: no surface paints
// `revisedTarget` or `targetSource` today (#467), and a DOM probe for a value
// that is never rendered passes in both states. `cricket.revise` also accepts a
// manual `target`, which stamps targetSource "manual" and skips the maths
// entirely — this sends `oversPerSide` alone and pins targetSource "dls", so a
// revise that quietly fell through to the manual branch cannot pass it.
test("cricket DLS scales a five-ball-over format onto the published table", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Cricket DLS ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "The Hundred",
      sport_key: "cricket",
      variant_key: "hundred",
      // The only override the rail needs: scoring.ts reads dls.enabled straight
      // off divisions.config to decide a revise is a DLS one.
      config: { dls: { enabled: true, edition: "standard" } },
      eligibility: [],
    },
  );
  const divisionId = div.data!.id;
  const { ids: entrantIds } = await addEntrantsViaApi(
    request,
    divisionId,
    ["Century Kings", "Century Queens"],
    "team",
  );
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  const send = async (seq: number, type: string, payload: unknown) => {
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: seq,
      type,
      payload,
    });
    expect(res.status, `${type}: ${res.error?.code ?? ""} ${res.error?.message ?? ""}`).toBe(201);
  };
  await send(0, "cricket.toss", { wonBy: entrantIds[0]!, elected: "bat" });
  await send(1, "core.start", {});
  // The full first innings: 150/0 off the whole 100-ball quota.
  await send(2, "cricket.innings.summary", {
    runs: 150,
    wickets: 0,
    legalBalls: 100,
    partial: true,
  });
  // Rain cuts the chase to 10 overs — FIVE-ball overs, so 50 balls.
  await send(3, "cricket.revise", { oversPerSide: 10 });

  const state = await apiJson<{
    state: {
      r1: number | null;
      r2: number | null;
      revisedTarget: number | null;
      targetSource: string | null;
    };
  }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const fold = state.data!.state;
  // R1 is the resource for a 100-ball innings, R2 for the 50 balls that remain
  // — read as 6-ball overs they come out 56.6 / 32.1 and the target with them.
  expect(fold.r1).toBeCloseTo(49.13333333333333, 9);
  expect(fold.r2).toBeCloseTo(27.366666666666667, 9);
  expect(fold.targetSource).toBe("dls");
  expect(fold.revisedTarget).toBe(84);

  // And the shortened match is still scoreable — the pad opens on the chase.
  await page.goto(`/fixtures/${fixtureId}`);
  await expect(page.getByText(/— total/)).toContainText("0/0", { timeout: 20_000 });

  // #467 — the 84 asserted off the state API above must also be ON SCREEN.
  // Until this, the revised target was verifiable only through /state, which is
  // how #451 (a DLS bug that awarded the match to the wrong side) survived: an
  // unrendered derivation is an unverified one. The pad must also say the
  // figure is DLS-derived rather than one the organiser typed.
  const target = page.getByTestId("ck-revised-target");
  await expect(target).toBeVisible({ timeout: 20_000 });
  await expect(target).toContainText("84");
  await expect(target).toContainText(/DLS/i);

  // Every surface works at 375px with no horizontal page scroll (v3/02 §4).
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(target).toBeVisible();
  await expectNoHorizontalScroll(page);
});
