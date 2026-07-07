import { test, expect } from "@playwright/test";
import { seedScoredDivision } from "./helpers";

// PROMPT-22/23/24/26: the schedule console mounts the officials, history and
// constraints panels and the export links.
test("schedule console mounts officials/history/constraints panels + export links", async ({
  page,
  request,
}) => {
  const { divisionId } = await seedScoredDivision(request);

  await page.goto(`/divisions/${divisionId}/schedule`);

  // Jul3 panels (headings/labels rendered by the panels).
  await expect(page.getByText(/officials/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/history/i).first()).toBeVisible();
  await expect(page.getByText(/constraints/i).first()).toBeVisible();

  // Jul3/06 export links.
  await expect(page.getByRole("link", { name: /timetable pdf/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /participants xlsx/i })).toBeVisible();
});
