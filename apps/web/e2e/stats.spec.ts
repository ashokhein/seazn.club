import { test, expect } from "@playwright/test";
import { seedScoredDivision } from "./helpers";

// PROMPT-27 player stats: the leaderboard tab renders one of its settled
// states. seedScoredDivision scores at result level, and W4 gave the generic
// module a playerStats model (generic.score → person), so a result-only
// division is exactly the case the "requires detailed scoring" notice exists
// for — no per-person rows, decided fixtures, wrong zeros refused.
//
// The assertion anchors on the test id, not the copy: the strings live in four
// dictionaries and the notice's wording ("stats require detailed") stopped
// matching the old /requires detailed/i probe without failing anything, because
// the panel was landing in the empty state until W4.
test("stats tab renders the requires-detailed notice for result-level scoring", async ({
  page,
  request,
}) => {
  const { divisionId } = await seedScoredDivision(request);

  await page.goto(`/divisions/${divisionId}?tab=stats`);
  await expect(page.getByTestId("stats-requires-detailed")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("stats-board")).toHaveCount(0);
});
