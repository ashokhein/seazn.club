import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  setOrgPlanBySql,
  seedAiGeneratedRuns,
  getAiScheduleApply,
  getFixtureScheduleSources,
} from "./helpers";
import { startAiFixtureServer, FIXTURE_REFUSE, type AiFixtureServer } from "./ai-fixture-server";

// v4 Task 17 — the full AI Schedule Architect wizard, end to end, against a
// canned model (ai-fixture-server.ts). Scenarios:
//   1. Pro org: brief → run → CLEAN → officials auto-draft → apply → undo.
//   2. Model refusal (FIXTURE_REFUSE) → 422 AI_PLAN_FAILED → the console surfaces
//      the "invalid instruction" copy; proves the model was actually called.
//   3. Blackout injected over a scheduled fixture → amber repair nudge → console
//      opens in a scoped repair.
//   4. Community org at its 5-runs/division quota → 402 → quota copy, no model call.
//   5. 390px viewport: the happy flow, no horizontal scroll.
//
// Serial in one worker: the fixture server binds a fixed port (AI_FIXTURE_PORT),
// so the file must not fan out across workers (each would re-bind and collide).
test.describe.configure({ mode: "serial" });

const SHOTS = resolve(process.cwd(), "../../.superpowers/sdd/shots/t17");

let fixture: AiFixtureServer;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  fixture = await startAiFixtureServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true }).catch(() => undefined);
}

/** Create + activate a fresh Pro Plus org (officials.auto is a Pro Plus feature —
 *  V290 — so the officials auto-draft only runs there). Same fresh-org-by-id flip
 *  schedule-panels.spec uses to dodge the shared org's primed entitlement cache. */
async function activateFreshProPlusOrg(page: Page, request: APIRequestContext): Promise<string> {
  const org = await apiJson<{ id: string }>(request, "/api/orgs", "POST", {
    name: `AI Architect PP ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
  });
  await setOrgPlanBySql({ orgId: org.data!.id }, "pro_plus");
  const activated = await apiJson(request, "/api/orgs/active", "POST", { org_id: org.data!.id });
  expect(activated.status).toBeLessThan(300);
  return org.data!.id;
}

/** A generic RR division ready for the architect: 4 entrants → 6 movable
 *  fixtures, two courts, one wide session window. Fixtures stay unscheduled
 *  (status "scheduled", no slot) so a run reads as six fresh placements. */
async function seedAiDivision(
  request: APIRequestContext,
  opts: { officials?: boolean; settings?: boolean } = {},
): Promise<{ competitionId: string; divisionId: string; stageId: string; fixtureIds: string[] }> {
  const { officials = false, settings = true } = opts;
  const rand = Math.random().toString(36).slice(2, 6);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `AI Architect ${TAG}-${rand}`,
    visibility: "private",
  });
  const competitionId = comp.data!.id;
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    {
      name: "AI Division",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["Ada", "Bay", "Cy", "Dot"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const stageId = stage.data!.id;
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stageId}/generate`,
    "POST",
  );
  const fixtureIds = (gen.data?.fixtures ?? []).map((f) => f.id);

  if (settings) {
    await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 45,
        gapMinutes: 5,
        courts: ["Court A", "Court B"],
        sessionWindows: [
          {
            from: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
            to: new Date(Date.UTC(2026, 8, 21, 18, 0)).toISOString(),
          },
        ],
      },
    });
  }
  if (officials) {
    for (const n of ["Ref One", "Ref Two", "Ref Three"]) {
      await apiJson(request, "/api/v1/officials", "POST", {
        display_name: `${n} ${TAG}-${rand}`,
        role_keys: ["referee"],
      });
    }
  }
  return { competitionId, divisionId, stageId, fixtureIds };
}

/** Open the docked console from the board's launch button. */
async function openConsole(page: Page): Promise<void> {
  await page.getByRole("button", { name: "AI schedule", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI schedule architect" })).toBeVisible();
}

/** Add the "Finish by 18:00" wish chip and confirm it compiled into the brief. */
async function addFinishByWish(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Finish by", exact: true }).click();
  await page.locator('input[type="time"]').fill("18:00");
  await page.getByRole("button", { name: "Add wish" }).click();
  await expect(page.locator("#ai-instruction")).toHaveValue(/Finish by 18:00/);
}

test("pro: brief → run → CLEAN → officials → apply → undo", async ({ page, request }) => {
  fixture.reset();
  await activateFreshProPlusOrg(page, request); // officials.auto step needs Pro Plus
  const { divisionId } = await seedAiDivision(request, { officials: true });

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);

  // Pre-flight rows reflect the seeded division.
  await expect(page.getByText("Movable fixtures")).toBeVisible();
  await expect(page.getByText("6 fixtures")).toBeVisible();
  await expect(page.getByText("2 courts")).toBeVisible();

  // Wish chip compiles into the textarea.
  await addFinishByWish(page);
  await shot(page, "01-brief");

  // Run Phase A → the referee trace reaches CLEAN.
  await page.getByRole("button", { name: "Generate schedule" }).click();
  await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 20_000 });
  await shot(page, "02-schedule-clean");

  // The canned plan placed every movable fixture (echoed the deterministic draft).
  const scheduleCall = fixture.calls.find((c) => c.phase === "schedule");
  expect(scheduleCall).toBeTruthy();
  expect(scheduleCall!.assignments).toBe(6);

  // Officials step: the zero-token solver auto-draft renders its grid (no model call).
  await page.getByRole("button", { name: "Assign officials" }).click();
  await expect(page.getByLabel("Officials by fixture")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("Draft duty spread from the solver — no AI tokens used."),
  ).toBeVisible();
  expect(fixture.calls.some((c) => c.phase === "officials")).toBe(false);
  await shot(page, "03-officials");

  // Apply both phases.
  await page.getByRole("button", { name: "Review & apply" }).click();
  await page.getByRole("button", { name: "Apply schedule + officials" }).click();
  await expect(page.getByText("Applied. The board is updated.")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("Restore point saved — undo the AI changes in one tap."),
  ).toBeVisible();
  await shot(page, "04-applied");

  // Persistence: every fixture now carries schedule_source 'ai' + a slot, and the
  // apply audit carries the AI block with the compiled instruction.
  const sources = await getFixtureScheduleSources(divisionId);
  expect(sources.length).toBe(6);
  expect(sources.every((s) => s.schedule_source === "ai" && s.scheduled_at !== null)).toBe(true);
  const audit = await getAiScheduleApply(divisionId);
  expect(audit?.source).toBe("ai");
  expect(audit?.instruction).toContain("Finish by 18:00");

  // Undo restores the pre-apply (unscheduled) state via the 'before-ai' checkpoint.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Reverted to before the AI changes.")).toBeVisible({ timeout: 20_000 });
  const afterUndo = await getFixtureScheduleSources(divisionId);
  expect(afterUndo.every((s) => s.scheduled_at === null)).toBe(true);
});

test("a model refusal surfaces the AI_PLAN_FAILED copy (and proves the model was called)", async ({
  page,
  request,
}) => {
  fixture.reset();
  await activateFreshProPlusOrg(page, request);
  const { divisionId } = await seedAiDivision(request);

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);

  // The magic instruction makes the fixture server answer stop_reason:"refusal"
  // with empty content, which schedule-ai.ts maps to 422 AI_PLAN_FAILED.
  await page.locator("#ai-instruction").fill(`${FIXTURE_REFUSE} — do the impossible.`);
  await page.getByRole("button", { name: "Generate schedule" }).click();

  // aiErrorKey(422, "AI_PLAN_FAILED") → board.ai.error.invalid.
  await expect(
    page.getByText("That instruction couldn't be used — try rephrasing it."),
  ).toBeVisible({ timeout: 20_000 });
  await shot(page, "10-refusal");

  // The refusal path is exercised, not skipped: the fixture server logged the
  // call and flagged it as a refusal, so this scenario can't silently pass by
  // never reaching the model.
  expect(fixture.calls.length).toBeGreaterThanOrEqual(1);
  expect(fixture.calls.some((c) => c.refusal)).toBe(true);
});

test("blackout injected over a scheduled fixture surfaces the repair nudge", async ({
  page,
  request,
}) => {
  const { divisionId, stageId } = await seedAiDivision(request);

  // Give the fixtures real slots inside the window …
  const auto = await apiJson<{
    assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
  }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
    assignments: auto.data!.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_label: a.court_label,
    })),
    source: "auto",
  });

  // … then drop a blackout over the opening slots (settings PUT replaces config).
  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
      matchMinutes: 45,
      gapMinutes: 5,
      courts: ["Court A", "Court B"],
      sessionWindows: [
        {
          from: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
          to: new Date(Date.UTC(2026, 8, 21, 18, 0)).toISOString(),
        },
      ],
      blackouts: [
        {
          from: new Date(Date.UTC(2026, 8, 21, 8, 30)).toISOString(),
          to: new Date(Date.UTC(2026, 8, 21, 10, 0)).toISOString(),
        },
      ],
    },
  });

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  // The amber repair nudge appears from the client-derived disruption signal.
  await expect(page.getByText(/need(?:s)? repair/i)).toBeVisible({ timeout: 20_000 });
  await shot(page, "05-repair-banner");

  // Its CTA opens the console pre-armed in a scoped repair.
  await page.getByRole("button", { name: /Fix with AI/i }).click();
  await expect(page.getByRole("region", { name: "AI schedule architect" })).toBeVisible();
  await expect(page.getByText("Scoped run")).toBeVisible();
  await shot(page, "06-repair-scoped");
});

test.describe("community quota", () => {
  test.use({ storageState: "e2e/.auth/community.json" });

  test("a community org at its 5-runs/division cap is refused before any model call", async ({
    page,
    request,
  }) => {
    fixture.reset();
    const org = await activeOrg(page);
    // No settings PUT / officials — the quota gate fires before the pack builds.
    const { competitionId, divisionId } = await seedAiDivision(request, { settings: false });
    try {
      // Sit exactly at the free tier's cap: five prior generations for this division.
      await seedAiGeneratedRuns(competitionId, org.id, divisionId, 5);

      await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
      await openConsole(page);
      // The community org CAN open the wizard (V297 grants scheduling.ai) …
      await page.locator("#ai-instruction").fill("Spread the matches across the day.");
      await page.getByRole("button", { name: "Generate schedule" }).click();

      // … but the sixth run is refused with the quota copy, and no model call fires.
      await expect(page.getByText("AI scheduling needs a Pro plan.")).toBeVisible({ timeout: 20_000 });
      expect(fixture.calls.length).toBe(0);
      await shot(page, "07-community-quota");
    } finally {
      // Free the community org's single active-competition slot for the serial specs.
      await apiJson(request, `/api/v1/competitions/${competitionId}`, "PATCH", { status: "archived" });
    }
  });
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the happy flow runs at 390px with no horizontal scroll", async ({ page, request }) => {
    fixture.reset();
    await activateFreshProPlusOrg(page, request); // officials.auto step needs Pro Plus
    const { divisionId } = await seedAiDivision(request, { officials: true });

    await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
    await openConsole(page);
    await addFinishByWish(page);

    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 20_000 });

    // The diff panel groups the placements as an agenda list: the "Why it did
    // that" provenance section renders with all six seeded fixtures in the
    // "placed" group (they were unscheduled before the run).
    const region = page.getByRole("region", { name: "AI schedule architect" });
    await expect(region).toBeVisible();
    await expect(region.getByText("Why it did that")).toBeVisible();
    await expect(region.getByText("6 placed")).toBeVisible();
    // No board-grid ghosts at 390px: the board falls back to agenda density
    // (max-width 640px), so BoardGrid — the only source of [data-ghost-id] — is
    // never mounted.
    await expect(page.locator("[data-ghost-id]")).toHaveCount(0);
    await shot(page, "08-mobile-schedule");

    await page.getByRole("button", { name: "Assign officials" }).click();
    await expect(page.getByLabel("Officials by fixture")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Review & apply" }).click();
    // Apply actions stack vertically on mobile; both are reachable.
    await expect(page.getByRole("button", { name: "Apply schedule + officials" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply schedule only" })).toBeVisible();
    await page.getByRole("button", { name: "Apply schedule + officials" }).click();
    await expect(page.getByText("Applied. The board is updated.")).toBeVisible({ timeout: 20_000 });
    await shot(page, "09-mobile-applied");

    // The page-level viewport rule: nothing scrolls horizontally.
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    const sources = await getFixtureScheduleSources(divisionId);
    expect(sources.every((s) => s.schedule_source === "ai")).toBe(true);
  });
});
