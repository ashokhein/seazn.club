import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// PROMPT-33 item 4 (v3/04 §3): the division fixtures page groups rounds with
// date ranges, renders times in the COMPETITION timezone (browser pinned to
// Tokyo to prove it), pins unscheduled fixtures with an auto-schedule CTA,
// and inline reschedule is undoable.
test.use({ timezoneId: "Asia/Tokyo" });

test("rounds group with dates, times honour the competition tz, reschedule undoes", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `DivSched ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-09-15T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court 1"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  // Schedule all but one — the leftover pins to the unscheduled section.
  const ids = gen.data!.fixtures.map((f) => f.id);
  const base = Date.UTC(2026, 8, 15, 9, 0, 0);
  for (let i = 0; i < ids.length - 1; i++) {
    await apiJson(request, `/api/v1/fixtures/${ids[i]!}`, "PATCH", {
      scheduled_at: new Date(base + i * 60 * 60_000).toISOString(),
      court_label: "Court 1",
    });
  }

  const org = await activeOrg(page);
  const url = `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=fixtures`;
  await page.goto(url);

  // Round grouping with the round's date range (item 1). The range text is
  // locale-formatted, so assert presence + the day-of-month rather than an
  // exact "15 Sep"/"Sep 15" ordering.
  await expect(page.getByText("Round 1", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("round-dates").first()).toContainText("15");

  // Timezone honesty (item 2): competition tz caption, and the 09:00Z fixture
  // renders as nine o'clock ("09:00" or "9:00 AM") — NOT 18:00/6:00 PM Tokyo
  // browser time.
  await expect(page.getByTestId("tz-caption")).toHaveText("Times shown in UTC");
  await expect(page.getByText(/\b0?9:00/).first()).toBeVisible();
  await expect(page.getByText(/18:00|6:00\s?PM/)).toHaveCount(0);

  // Unscheduled section pinned with count + CTA (item 3).
  await expect(page.getByText("Not scheduled yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto-schedule remaining" })).toBeVisible();

  // Inline reschedule (item 5) → notice grows an Undo that restores the slot.
  const before = (
    await apiJson<{ scheduled_at: string }>(request, `/api/v1/fixtures/${ids[0]!}`)
  ).data!.scheduled_at;
  await page.getByRole("button", { name: "Edit time" }).first().click();
  await page.locator("input[type=datetime-local]").first().fill("2026-09-16T15:00");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(
      async () =>
        (await apiJson<{ scheduled_at: string }>(request, `/api/v1/fixtures/${ids[0]!}`)).data!
          .scheduled_at,
      { timeout: 15_000 },
    )
    .toBe(before);
});
