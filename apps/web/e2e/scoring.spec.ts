import { test, expect } from "@playwright/test";
import { apiJson, seedScoredDivision, TAG } from "./helpers";

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

  // record one over: 12 runs, 1 wicket
  await page.getByLabel(/runs this over/i).fill("12");
  await page.getByLabel(/wickets this over/i).fill("1");
  await page.getByRole("button", { name: /add over/i }).click();

  // the innings total grows (progressive summary folded)
  await expect(page.getByText(/— total/)).toContainText("12/1", { timeout: 20_000 });
  await expect(page.getByText(/\(1\.0 ov\)/)).toBeVisible();

  // close the innings — the second innings opens (total resets to 0/0)
  await page.getByRole("button", { name: /^Close innings$/ }).click();
  await expect(page.getByText(/— total/)).toContainText("0/0", { timeout: 20_000 });
});
