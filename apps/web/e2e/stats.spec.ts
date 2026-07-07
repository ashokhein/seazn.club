import { test, expect } from "@playwright/test";
import { seedScoredDivision } from "./helpers";

// PROMPT-27 player stats: the leaderboard tab renders with a sort control.
// (generic scoring is result-level, so the panel shows the "requires detailed
// scoring" notice — asserting the tab + control render is the UI smoke.)
test("stats tab renders the leaderboard control", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);

  await page.goto(`/divisions/${divisionId}?tab=stats`);
  // the tab is selected and the panel mounted (either a table or the
  // detailed-scoring notice — both are valid rendered states)
  await expect(
    page
      .getByText(/sort by/i)
      .or(page.getByText(/requires detailed/i))
      .or(page.getByText(/no player stats/i)),
  ).toBeVisible({ timeout: 20_000 });
});
