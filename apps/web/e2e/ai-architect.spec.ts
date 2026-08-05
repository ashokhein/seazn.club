import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  setOrgPlanBySql,
  drainAiCredits,
  aiCreditBalance,
  getAiScheduleApply,
  getFixtureScheduleSources,
} from "./helpers";
import {
  startAiFixtureServer,
  FIXTURE_CLASH,
  FIXTURE_CLASH_SECONDS,
  FIXTURE_CLASH_OFFSET_MS,
  FIXTURE_REFUSE,
  FIXTURE_COMPILE_BRIEF,
  FIXTURE_COMPILE_SOFT,
  FIXTURE_COMPILE_UNPARSED,
  type AiFixtureServer,
} from "./ai-fixture-server";

// v4 Task 17 — the full AI Schedule Architect wizard, end to end, against a
// canned model (ai-fixture-server.ts). Scenarios:
//   1. Pro org: brief → run → CLEAN → officials auto-draft → apply → undo.
//   2. Model refusal (FIXTURE_REFUSE) → 422 AI_PLAN_FAILED → the console surfaces
//      the "invalid instruction" copy; proves the model was actually called.
//   3. Blackout injected over a scheduled fixture → amber repair nudge → console
//      opens in a scoped repair.
//   4. Community org at its 5-runs/division quota → 402 → quota copy, no model call.
//   5. 390px viewport: the happy flow, no horizontal scroll.
//   6. #400 (W5): the confirm gate. Every run above now goes brief → compile →
//      receipt card → confirm, and the wave's acceptance case is the one that
//      DECLINES the receipt and proves the credit ledger did not move.
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
  return (await activateFreshProPlusOrgWithSlug(page, request)).id;
}

/** The same thing, plus the org's SLUG. The `/o/[orgSlug]/…` competition board
 *  is addressed by slug, and `activeOrg(page)` would answer with the BROWSER
 *  context's active org — which is still the shared Pro one, because the
 *  activation above happens on the separate `request` context. Taking the slug
 *  from the create response is the only reading that names the org this test
 *  actually owns. */
async function activateFreshProPlusOrgWithSlug(
  page: Page,
  request: APIRequestContext,
): Promise<{ id: string; slug: string }> {
  const org = await apiJson<{ id: string; slug: string }>(request, "/api/orgs", "POST", {
    name: `AI Architect PP ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
  });
  await setOrgPlanBySql({ orgId: org.data!.id }, "pro_plus");
  const activated = await apiJson(request, "/api/orgs/active", "POST", { org_id: org.data!.id });
  expect(activated.status).toBeLessThan(300);
  return { id: org.data!.id, slug: org.data!.slug };
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
  await page.getByRole("button", { name: "AI Schedule", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI Schedule" })).toBeVisible();
}

/** The docked single-division console. */
function consoleDock(page: Page): Locator {
  return page.getByRole("region", { name: "AI Schedule" });
}

/**
 * W5 (#400) — a run is TWO clicks now, and this is both of them.
 *
 * The first COMPILES the sentence (stage 1: no credit, no architect call) and
 * the card that comes back is the receipt for it; only that card's own confirm
 * starts a chargeable run. There is no "Generate schedule" button to click
 * until something has been confirmed, so every scenario below routes through
 * here.
 *
 * Everything is scoped to the console, and the card's assertions to
 * `[data-preview-*]` — the brief textarea still holds the organiser's own
 * sentence a few hundred pixels above, so a page-wide getByText for anything
 * the card renders matches the textarea too and passes for the wrong reason.
 */
async function compileAndConfirm(page: Page, scope: Locator = consoleDock(page)): Promise<void> {
  await scope.getByRole("button", { name: "Check what this means" }).click();
  await expect(scope.locator('[data-preview-state="ready"]')).toBeVisible({ timeout: 20_000 });
  await scope.locator("[data-preview-confirm]").click();
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

  // Pre-flight rows reflect the seeded division. SCOPED to the pre-flight card:
  // #348's run-cost receipt renders "6 fixtures · 2 courts · ~9K tokens" a few
  // hundred pixels below, so an unscoped getByText matches two elements and
  // fails strict mode — and would have gone on "passing" against whichever one
  // it happened to find.
  const preflight = page.getByRole("region", { name: "Schedule readiness" });
  await expect(preflight.getByText("Movable fixtures")).toBeVisible();
  await expect(preflight.getByText("6 fixtures")).toBeVisible();
  await expect(preflight.getByText("2 courts")).toBeVisible();

  // Wish chip compiles into the textarea.
  await addFinishByWish(page);
  await shot(page, "01-brief");

  // Run Phase A, through the W5 gate → the referee trace reaches CLEAN.
  await compileAndConfirm(page);
  await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 20_000 });
  await shot(page, "02-schedule-clean");

  // The canned plan placed every movable fixture (echoed the deterministic draft).
  const scheduleCall = fixture.calls.find((c) => c.phase === "schedule");
  expect(scheduleCall).toBeTruthy();
  expect(scheduleCall!.assignments).toBe(6);

  // Officials step: #383 — arriving no longer spends anything. The organiser
  // presses the button, and only then does the zero-token solver draft run.
  await page.getByRole("button", { name: "Assign officials" }).click();
  await expect(page.getByLabel("Officials by fixture")).toHaveCount(0);
  await page.getByRole("button", { name: /Draft the duty spread.*1 credit\b/ }).click();
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

// ---------------------------------------------------------------------------
// #400 (W5) — the confirm gate
// ---------------------------------------------------------------------------

/**
 * THE ACCEPTANCE CASE FOR THE WHOLE WAVE.
 *
 * An organiser types a sentence, is shown what the machine made of it, and
 * decides not to run. The claim being tested is that this cost them nothing —
 * and it is a claim about MONEY, so it is read from the credit ledger by SQL
 * and not from anything on screen. Every on-screen number in this console is
 * rendered by the same component tree that would be wrong; the wallet is the
 * only observable that can disagree with it.
 *
 * The card assertions come first and are not decoration: a "declining spends
 * nothing" test that never establishes there was something to decline passes
 * just as well against a card that failed to compile, which is the state that
 * spends nothing by accident. So the fixture compiles this brief for real
 * (`FIXTURE_COMPILE_BRIEF`) and the card is checked to be the full receipt —
 * two enforced rules, one passed-on wish, one clause we could not use, the
 * reading of the calendar, and the window — before the decline is taken.
 */
test("pro: declining the compiled instruction spends no credit", async ({ page, request }) => {
  fixture.reset();
  const orgId = await activateFreshProPlusOrg(page, request);
  const { divisionId } = await seedAiDivision(request);

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);
  const dock = consoleDock(page);
  const before = await aiCreditBalance(orgId);

  await page.locator("#ai-instruction").fill(FIXTURE_COMPILE_BRIEF);
  await dock.getByRole("button", { name: "Check what this means" }).click();

  const card = dock.locator('[data-preview-state="ready"]');
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The receipt, scoped to the card. The per-day cap and the weekday rule on
  // the final are the two that BIND; the window is not among them (it becomes
  // the run's calendar, which the verifier already checks) and renders on its
  // own line, which is why the ledger holds two rows and not three.
  await expect(card.locator('[data-preview-rule="hard"]')).toHaveCount(2);
  await expect(card.getByText("at most 2 matches a day")).toBeVisible();
  await expect(card.locator('[data-preview-rule="soft"]')).toHaveCount(1);
  await expect(card.getByText(FIXTURE_COMPILE_SOFT)).toBeVisible();
  // Quoted VERBATIM — the one section where a paraphrase would be a lie.
  await expect(card.locator("[data-preview-unparsed]")).toHaveText([FIXTURE_COMPILE_UNPARSED]);
  await expect(card.locator("[data-preview-assumption]").first()).toBeVisible();
  await expect(card.locator("[data-preview-window]")).toBeVisible();

  // Stage 1 and nothing else: the architect was never called. `every` alone is
  // vacuous on an empty log, so the length is pinned too.
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]!.phase).toBe("parse");
  await shot(page, "11-preview-ready");

  // DECLINE. A pure client action — no request is made at all.
  await dock.getByRole("button", { name: "Back to the brief" }).click();
  await expect(dock.locator('[data-preview-state="ready"]')).toHaveCount(0);
  // The organiser's sentence survives the decline (they are meant to edit it) …
  await expect(page.locator("#ai-instruction")).toHaveValue(FIXTURE_COMPILE_BRIEF);
  // … and the CTA is back to the gate rather than armed to run.
  await expect(dock.locator("[data-ai-stage]")).toHaveAttribute("data-ai-stage", "check");

  // THE POINT OF THE WAVE.
  expect(await aiCreditBalance(orgId)).toBe(before);
  // Nor was anything quietly scheduled: declining is not a run with no receipt.
  const sources = await getFixtureScheduleSources(divisionId);
  expect(sources.length).toBe(6);
  expect(sources.every((s) => s.scheduled_at === null)).toBe(true);
});

// ---------------------------------------------------------------------------
// #348 — the credits confirm card
// ---------------------------------------------------------------------------

/** A division the #348 predictor sizes at rung 2, so the pre-selected chip is
 *  the MIDDLE one and an arrow can move in both directions from the default.
 *
 *  `sizeScore = movable + 0.5·entrants + 2·courts` with `s1 = 60`
 *  (`lib/ai-rung.ts`): 12 entrants round-robin = 66 fixtures →
 *  66 + 6 + 4 = 76, which is over s1 and well under s2 (200). */
async function seedRungTwoDivision(
  request: APIRequestContext,
): Promise<{ divisionId: string }> {
  const rand = Math.random().toString(36).slice(2, 6);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `AI Rung ${TAG}-${rand}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Rung Division",
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
    Array.from({ length: 12 }, (_, i) => ({
      kind: "individual",
      display_name: `Rung ${i + 1}`,
      seed: i + 1,
    })),
  );
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
      matchMinutes: 20,
      gapMinutes: 0,
      courts: ["Court A", "Court B"],
      sessionWindows: [
        {
          from: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
          to: new Date(Date.UTC(2026, 8, 21, 21, 0)).toISOString(),
        },
      ],
    },
  });
  await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  return { divisionId };
}

/**
 * The credits control is a REAL radio group — and specifically, arrows move
 * DOM focus, not just `aria-checked`.
 *
 * This test is the only place that assertion can live. The unit suite renders
 * with `renderToStaticMarkup`, which has no focus and no `document`, so
 * deleting the `.focus()` call in `RungChips` leaves every other test green
 * while a keyboard user is left with the ring and the screen-reader cursor on
 * one chip and `aria-checked`/`tabIndex=0` on another — i.e. unable to tell
 * what they have just bought.
 *
 * The control spends money, so the whole WAI-ARIA contract is pinned here:
 * one tab stop, arrows that move-and-select with wrapping, Home/End, and a Tab
 * that still leaves the group.
 */
test("the credits picker is a real radio group — arrows move the selection AND the focus", async ({
  page,
  request,
}) => {
  await activateFreshProPlusOrg(page, request);
  const { divisionId } = await seedRungTwoDivision(request);

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);
  // Brief first, credits second — the organiser's real order, and the CTA is
  // `disabled` (so not a tab stop) until the instruction is long enough. The
  // Tab assertion at the end needs a real next stop to name.
  await page.locator("#ai-instruction").fill("Spread the matches across the day.");

  const card = page.getByRole("region", { name: "What this run costs" });
  await expect(card).toBeVisible();
  const chips = card.getByRole("radio");
  await expect(chips).toHaveCount(3);

  // The server's own prediction is pre-selected, and the group is ONE tab stop.
  await expect(chips.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(chips.nth(1)).toHaveAttribute("tabindex", "0");
  await expect(card.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await expect(card).toHaveAttribute("data-ai-credits", "2");

  // ArrowRight: the check, the roving tabindex and the FOCUS all land on 3.
  await chips.nth(1).focus();
  await page.keyboard.press("ArrowRight");
  await expect(chips.nth(2)).toBeFocused();
  await expect(chips.nth(2)).toHaveAttribute("aria-checked", "true");
  await expect(chips.nth(2)).toHaveAttribute("tabindex", "0");
  await expect(chips.nth(1)).toHaveAttribute("aria-checked", "false");
  await expect(chips.nth(1)).toHaveAttribute("tabindex", "-1");
  // …and the price the organiser is about to confirm follows on the card.
  // W5 (#400) moved the priced button behind the gate: the CTA at this point
  // compiles, it does not run, so it names no price. The price the organiser
  // actually presses is asserted at the end of this test, on the confirm.
  await expect(card).toHaveAttribute("data-ai-credits", "3");

  // Wrapping, at both ends.
  await page.keyboard.press("ArrowRight");
  await expect(chips.nth(0)).toBeFocused();
  await expect(chips.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(card).toHaveAttribute("data-ai-credits", "1");
  await page.keyboard.press("ArrowLeft");
  await expect(chips.nth(2)).toBeFocused();
  await expect(card).toHaveAttribute("data-ai-credits", "3");

  // Home / End jump to the ends.
  await page.keyboard.press("Home");
  await expect(chips.nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(chips.nth(2)).toBeFocused();

  // Tab still LEAVES the group: the key handler returns early for anything it
  // does not own, so the browser's own focus order is untouched. Asserted by
  // NAMING the next stop — a bare `[role=radio]:focus` count of 0 is equally
  // satisfied by the card having vanished (a navigation, a crash), which is not
  // what this sentence claims. Every other assertion here names an element.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Check what this means" })).toBeFocused();

  // Below the prediction is allowed, and warned about in as many words.
  await chips.nth(0).click();
  await expect(
    card.getByText("Below the recommended credits. This run may stop before a full schedule."),
  ).toBeVisible();
  await expect(card).toHaveAttribute("data-ai-credits", "1");
  // Clicking the RECOMMENDED chip returns to "follow the prediction" and clears
  // the warning — it is not a visual no-op.
  await chips.nth(1).click();
  await expect(card.getByText("Below the recommended credits.", { exact: false })).toHaveCount(0);
  await expect(card).toHaveAttribute("data-ai-credits", "2");

  // W5 (#400): the picked price has to survive the gate. The button that
  // actually spends is the confirm INSIDE the preview card, so that is where
  // the number the organiser agreed to must appear — a receipt card that
  // quotes 2 above a confirm that spends 3 is the defect this asserts against.
  await page.getByRole("button", { name: "Check what this means" }).click();
  const confirm = page.locator("[data-preview-confirm]");
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await expect(confirm).toHaveAttribute("data-ai-credits", "2");
  await expect(confirm).toHaveText(/Run with these rules.*2 credits/);
});

/**
 * Phase B carries the same control, and only when there is something to price.
 *
 * Two states, and the boundary between them is one string: the officials run
 * is the deterministic solver draft — no model call — exactly when the
 * instruction is empty. Empty box → flat 1 credit and NO picker (there is
 * nothing to size); a typed brief → the picker, and a Re-plan button that
 * names what it will spend.
 */
test("the officials step prices itself: free draft with no picker, priced once a brief is typed", async ({
  page,
  request,
}) => {
  fixture.reset();
  await activateFreshProPlusOrg(page, request);
  const { divisionId } = await seedAiDivision(request, { officials: true });

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);
  await page.locator("#ai-instruction").fill("Spread the matches across the day.");
  await compileAndConfirm(page);
  await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Assign officials" }).click();

  // #383: the card is on screen BEFORE anything has run, which is the whole
  // point — this used to be reachable only after the auto-run had already
  // charged for it.
  const card = page.getByRole("region", { name: "What this run costs" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("radiogroup")).toHaveCount(0);
  await expect(
    card.getByText("The first pass runs on the solver, without the AI model — a flat 1 credit."),
  ).toBeVisible();

  // The draft happens when it is asked for. This test's own subject — a free
  // draft shows no rung picker — is unchanged either side of the press.
  await page.getByRole("button", { name: /Draft the duty spread.*1 credit\b/ }).click();
  await expect(page.getByLabel("Officials by fixture")).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("radiogroup")).toHaveCount(0);

  // A typed brief is a model call, so the card becomes a priced one.
  await page.locator("#ai-officials-instruction").fill("keep one referee per team's group games");
  await expect(card.getByRole("radiogroup")).toHaveCount(1);
  const chips = card.getByRole("radio");
  await expect(chips.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /Re-plan officials.*1 credit\b/ })).toBeVisible();

  // Same keyboard contract as Phase A, including the focus move.
  await chips.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(chips.nth(1)).toBeFocused();
  await expect(chips.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /Re-plan officials.*2 credits/ })).toBeVisible();
});

/**
 * #383 — the officials step does not spend before the organiser presses.
 *
 * THE assertion that would have caught the bug, and it is a claim about MONEY,
 * so it is read from the credit ledger by SQL rather than from the screen. The
 * screen is rendered by the same component tree that was wrong; the wallet is
 * not. Arriving at the step is free, and the press costs exactly the 1 credit
 * the card promised — no more (a double-fire) and no less (a button that only
 * looks like it ran).
 */
test("pro: the officials draft spends nothing until the organiser presses", async ({
  page,
  request,
}) => {
  fixture.reset();
  const orgId = await activateFreshProPlusOrg(page, request);
  const { divisionId } = await seedAiDivision(request, { officials: true });

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);
  await page.locator("#ai-instruction").fill("Spread the matches across the day.");
  await compileAndConfirm(page);
  await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 20_000 });

  // Phase A has been paid for; measure from HERE, so what follows is attributed
  // to the officials step alone.
  await page.getByRole("button", { name: "Assign officials" }).click();
  const card = page.getByRole("region", { name: "What this run costs" });
  await expect(card).toBeVisible();
  const before = await aiCreditBalance(orgId);

  // Arriving is free. The grid is absent because nothing has run — that absence
  // is the feature, not a loading state.
  await expect(page.getByLabel("Officials by fixture")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-ai-credits", "1");
  expect(await aiCreditBalance(orgId)).toBe(before);

  // The press, and exactly one credit.
  await page.getByRole("button", { name: /Draft the duty spread.*1 credit\b/ }).click();
  await expect(page.getByLabel("Officials by fixture")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("Draft duty spread from the solver — no AI tokens used."),
  ).toBeVisible();
  expect(await aiCreditBalance(orgId)).toBe(before - 1);
  // Zero-token by construction: the empty-instruction path calls no model.
  expect(fixture.calls.some((c) => c.phase === "officials")).toBe(false);
});

/**
 * The confirm card prices the LIVE board, not the props the page was rendered
 * with.
 *
 * `useBoardActions` applies a move OPTIMISTICALLY and only then PATCHes; the
 * card has to read that optimistic board, or an organiser who narrows a repair
 * and then drags a match into its scope is quoted for the board as it was when
 * the page loaded. No static render can tell the two apart: with no
 * interaction the overrides map is empty and the two lists are element-wise
 * identical, which is why this was routed here.
 *
 * The PATCH is HELD for the duration of the assertion, deliberately. Once it
 * lands the board refreshes and the server props catch up — at which point the
 * correct implementation and the broken one agree, and any assertion made after
 * that point passes either way.
 */
test("a move re-prices the open console before the server has even answered", async ({
  page,
  request,
}) => {
  await activateFreshProPlusOrg(page, request);
  const { divisionId, stageId } = await seedAiDivision(request);

  // Give every fixture a slot, then black out a MID-DAY window. The repair
  // scope is `from` = the earliest disrupted fixture, so the fixtures before it
  // are out of scope — which is what makes moving one INTO the scope observable.
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
          from: new Date(Date.UTC(2026, 8, 21, 10, 30)).toISOString(),
          to: new Date(Date.UTC(2026, 8, 21, 11, 30)).toISOString(),
        },
      ],
    },
  });

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await page.getByRole("button", { name: /Fix with AI/i }).click();
  const dock = page.getByRole("region", { name: "AI Schedule" });
  await expect(dock.getByText("Scoped run")).toBeVisible();

  const card = page.getByRole("region", { name: "What this run costs" });
  const sizeLine = card.locator("[data-ai-line-tokens]");
  const before = Number((await sizeLine.getAttribute("data-ai-line-tokens")) ?? "0");
  const beforeText = (await sizeLine.innerText()).trim();
  const scoped = Number(/^(\d+) fixtures/.exec(beforeText)?.[1] ?? "0");
  // The scope has to be a strict subset, or the assertion below is about
  // nothing: a repair that already covers the whole board cannot grow.
  expect(scoped).toBeGreaterThan(0);
  expect(scoped).toBeLessThan(6);

  // Hold the PATCH. The optimistic override is applied BEFORE the request, so
  // this window is exactly where the live board and the server props disagree.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/fixtures/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await held;
    // The test releases and then tears the route down; whichever wins, the
    // request still goes through. Swallowing here keeps a teardown race from
    // being reported as a product failure.
    await route.continue().catch(() => undefined);
  });

  // Pick the EARLIEST fixture — it sits before the blackout, so it is outside
  // the repair scope — and place it in the LAST free slot of the day, which is
  // inside it. Court A, and the last slot by position rather than by a
  // hard-coded clock time: the row labels are rendered in the reader's zone, so
  // naming one would pin this test to the machine's timezone, and the dock
  // overlays the right-hand column.
  await page.locator("[data-fixture-id]").first().getByRole("button").first().click();
  const freeSlots = page.getByRole("button", { name: /^Place picked match at .* on Court A$/ });
  await freeSlots.last().click();

  // Still in flight: nothing has come back from the server, and no refresh has
  // run — so this number can only have come from the board's own optimistic
  // state.
  await expect(sizeLine).toHaveText(new RegExp(`^${scoped + 1} fixtures`));
  const during = Number((await sizeLine.getAttribute("data-ai-line-tokens")) ?? "0");
  expect(during).toBeGreaterThan(before);

  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// ---------------------------------------------------------------------------
// #350 — the competition board's joint console
// ---------------------------------------------------------------------------

/**
 * One competition, two plannable divisions on the SAME court names — and
 * DELIBERATELY DIFFERENT SIZES.
 *
 * Shared courts are matched by name and nothing else, so identical labels are
 * what makes this a joint run rather than two runs on two venues. The sizes,
 * though, must differ: two identical divisions make every per-row assertion
 * satisfiable by a component that reads `lines[0]` for every row, and make the
 * batch discount indistinguishable from a flat rule. They also make a DOWN-PICK
 * impossible, since a rung-1 division has nothing below it.
 *
 * `sizeScore = movable + 0.5·entrants + 2·courts` (`lib/ai-rung.ts`, s1 = 60):
 *   - big:   12 entrants → 66 fixtures → 66 + 6 + 6 = 78  → predicted rung 2
 *   - small:  4 entrants →  6 fixtures →  6 + 2 + 6 = 14  → predicted rung 1
 *
 * Three courts and 20-minute slots over a 12-hour window give 108 placements
 * for 72 fixtures, so the joint draft has room to place every one of them and
 * the review's per-division counts are exact rather than "however many fitted".
 */
async function seedJointCompetition(
  request: APIRequestContext,
): Promise<{ competitionId: string; compSlug: string; divisionIds: string[] }> {
  const rand = Math.random().toString(36).slice(2, 6);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `AI Joint ${TAG}-${rand}`,
    visibility: "private",
  });
  const competitionId = comp.data!.id;
  const divisionIds: string[] = [];
  for (const [name, entrantCount] of [
    ["Joint Big", 12],
    ["Joint Small", 4],
  ] as const) {
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      {
        name,
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
      Array.from({ length: entrantCount }, (_, i) => ({
        kind: "individual",
        display_name: `${name} ${i + 1}`,
        seed: i + 1,
      })),
    );
    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
      "POST",
      { seq: 1, kind: "league", name: "League" },
    );
    await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 20,
        gapMinutes: 0,
        courts: ["Court A", "Court B", "Court C"],
        sessionWindows: [
          {
            from: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
            to: new Date(Date.UTC(2026, 8, 21, 21, 0)).toISOString(),
          },
        ],
      },
    });
    await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    divisionIds.push(divisionId);
  }
  return { competitionId, compSlug: comp.data!.slug, divisionIds };
}

/**
 * The whole joint flow on the competition board: picker → price → DOWN-PICK →
 * run → review → apply, ending at the wallet.
 *
 * The price assertions are against LITERALS, never against another field of the
 * same payload. `max(1, Σ rungs − 1)` is the arithmetic a support ticket is
 * about, and a check that reads the total back out of the card proves only that
 * the attribute exists.
 *
 * The DOWN-PICK is the half a unit test cannot reach. `ai-joint-console-wiring`
 * already pins the request body the console builds; what it cannot see is
 * whether the server honours a cheaper rung and charges for it. So the big
 * division is dropped from its predicted 2 to 1 before the run — a genuine
 * below-recommendation pick, warning and all — and the assertion is the
 * ORGANISATION'S WALLET, read from SQL. `plan.credits` renders nowhere on this
 * board, so the wallet is the only observable that says what was actually
 * charged; every on-screen number can only ever show the card agreeing with
 * itself.
 */
test("competition board: pick divisions → price the batch → run → review → apply", async ({
  page,
  request,
}) => {
  fixture.reset();
  const org = await activateFreshProPlusOrgWithSlug(page, request);
  const { compSlug, divisionIds } = await seedJointCompetition(request);
  const [bigDivision, smallDivision] = divisionIds as [string, string];

  await page.goto(`/o/${org.slug}/c/${compSlug}/schedule`);
  await page.getByRole("button", { name: "AI Schedule", exact: true }).click();
  const dock = page.getByRole("region", { name: "AI schedule for the whole competition" });
  await expect(dock).toBeVisible();

  // ---- PICKER: both divisions, both selected, and the run is armed.
  const picker = dock.getByRole("region", { name: "Divisions to schedule together" });
  await expect(picker.locator("input[data-division-id]")).toHaveCount(2);
  await expect(picker.getByText("2 of 2 selected")).toBeVisible();
  // Sized differently on purpose — a symmetric pair makes every per-row
  // assertion below satisfiable by a card that renders row 0 twice.
  await expect(picker.getByText("66 fixtures to place")).toBeVisible();
  // `exact` because "6 fixtures to place" is a SUBSTRING of "66 fixtures to
  // place" — getByText is a substring match, and the two rows are the whole
  // point of an asymmetric seed.
  await expect(picker.getByText("6 fixtures to place", { exact: true })).toBeVisible();

  // ---- PRICE: one receipt line per division, each with its own control.
  const card = dock.getByRole("region", { name: "What this run costs" });
  const groups = card.getByRole("radiogroup");
  await expect(groups).toHaveCount(2);
  const rungs = card.locator("[data-ai-line-rung]");
  // Predicted 2 and 1: Σ = 3, charged max(1, 3−1) = 2, one credit forgiven.
  await expect(rungs.nth(0)).toHaveAttribute("data-ai-line-rung", "2");
  await expect(rungs.nth(1)).toHaveAttribute("data-ai-line-rung", "1");
  await expect(card).toHaveAttribute("data-ai-credits", "2");
  await expect(card.locator("[data-ai-discount]")).toHaveAttribute("data-ai-discount", "1");

  // Arrows are CONTAINED in a row: moving the first division's control leaves
  // the second's alone, and only the first line's amount moves.
  const rowOne = groups.nth(0).getByRole("radio");
  const rowTwo = groups.nth(1).getByRole("radio");
  await rowOne.nth(1).focus();
  await page.keyboard.press("End");
  await expect(rowOne.nth(2)).toBeFocused();
  await expect(rowTwo.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(rungs.nth(0)).toHaveAttribute("data-ai-line-rung", "3");
  await expect(rungs.nth(1)).toHaveAttribute("data-ai-line-rung", "1");
  // Σ = 4 → charged 3, and the CTA agrees with the receipt above it.
  await expect(card).toHaveAttribute("data-ai-credits", "3");
  await expect(dock.locator("[data-ai-joint-run]")).toHaveAttribute("data-ai-joint-cta-credits", "3");

  // Tab moves BETWEEN rows — one stop per division, landing on its checked chip.
  await page.keyboard.press("Tab");
  await expect(rowTwo.nth(0)).toBeFocused();

  // ---- DOWN-PICK: the big division goes BELOW its recommendation.
  await page.keyboard.press("Home"); // (row two, already at 1 — a no-op that must stay a no-op)
  await expect(rungs.nth(1)).toHaveAttribute("data-ai-line-rung", "1");
  await rowOne.nth(0).click();
  await expect(rungs.nth(0)).toHaveAttribute("data-ai-line-rung", "1");
  await expect(
    card.getByText("Below the recommended credits. This run may stop before a full schedule."),
  ).toBeVisible();
  // Σ = 2 → charged 1: strictly less than the 2 the recommendation would cost.
  await expect(card).toHaveAttribute("data-ai-credits", "1");
  await expect(dock.locator("[data-ai-joint-run]")).toHaveAttribute("data-ai-joint-cta-credits", "1");

  // ---- RUN: ONE model call carrying BOTH divisions' movable fixtures.
  const walletBefore = await aiCreditBalance(org.id);
  await page.locator("#ai-joint-instruction").fill("keep the divisions off each other's courts");
  // W5 (#400): the same gate, on this console. The CTA compiles first — and
  // the down-picked price has to reach the button that actually spends, or the
  // wallet assertion below would be checking a number nobody was shown.
  await dock.locator("[data-ai-joint-run]").click();
  await expect(dock.locator('[data-preview-state="ready"]')).toBeVisible({ timeout: 60_000 });
  await expect(dock.locator("[data-preview-confirm]")).toHaveAttribute("data-ai-credits", "1");
  await dock.locator("[data-preview-confirm]").click();
  await expect(
    dock.getByText("Review the proposal, then apply it to every division at once."),
  ).toBeVisible({ timeout: 60_000 });

  const scheduleCalls = fixture.calls.filter((c) => c.phase === "schedule");
  expect(scheduleCalls).toHaveLength(1);
  // 66 + 6. A per-division loop would have sent two calls; one joint pack is
  // the whole point of the feature.
  expect(scheduleCalls[0]!.movable).toBe(72);

  // THE ASSERTION THE UNIT TESTS CANNOT MAKE: the server honoured the cheaper
  // rung and billed it. 2 would mean the down-pick was dropped somewhere
  // between the card and `spendCredit`; 3 would mean the earlier End press was.
  expect(await aiCreditBalance(org.id)).toBe(walletBefore - 1);

  // The review is a per-division ledger, in the picker's order, with each
  // division's own count.
  await expect(dock.locator("[data-division-chip]")).toHaveCount(2);
  await expect(dock.getByText("66 fixtures placed")).toBeVisible();
  await expect(dock.getByText("6 fixtures placed", { exact: true })).toBeVisible();

  // ---- APPLY: one action, every division.
  await dock.locator("[data-ai-joint-apply]").click();
  await expect(dock.getByText("Applied to 2 divisions.")).toBeVisible({ timeout: 60_000 });
  await expect(
    dock.getByText("A restore point was saved for each division — undo in one tap."),
  ).toBeVisible();
  // Applying costs nothing — the run was already paid for.
  expect(await aiCreditBalance(org.id)).toBe(walletBefore - 1);

  // Persistence, per division and at the EXACT size — "applied" reporting a
  // number is not the same as both boards being written, and a partial second
  // board is what the atomic apply exists to prevent.
  for (const [divisionId, expected] of [
    [bigDivision, 66],
    [smallDivision, 6],
  ] as const) {
    const sources = await getFixtureScheduleSources(divisionId);
    expect(sources.length).toBe(expected);
    expect(sources.every((s) => s.schedule_source === "ai" && s.scheduled_at !== null)).toBe(true);
  }
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
  const dock = consoleDock(page);

  // W5 (#400): the compile hits the same refusal first, so this is also the
  // ONLY e2e that walks the failed-compile card and its fallback. The card
  // must NOT offer a confirm — there is nothing to confirm and no preview_id
  // to reuse — and taking "Send it as written" is an EXPLICIT choice that
  // hands the sentence to the architect as a preference. Nothing falls back on
  // the organiser's behalf.
  await dock.getByRole("button", { name: "Check what this means" }).click();
  await expect(dock.locator('[data-preview-state="failed"]')).toBeVisible({ timeout: 20_000 });
  await expect(dock.locator("[data-preview-confirm]")).toHaveCount(0);
  await expect(dock.locator("[data-preview-unparsed]")).toContainText(FIXTURE_REFUSE);
  await shot(page, "12-preview-failed");
  await page.getByRole("button", { name: "Send it as written" }).click();
  // Only now is there a priced run button, and it is the ordinary one.
  await expect(dock.locator("[data-ai-stage]")).toHaveAttribute("data-ai-stage", "run");
  await page.getByRole("button", { name: /Generate schedule/ }).click();

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

test("a double-booked plan is repaired by the solver before the organiser sees it (#401)", async ({
  page,
  request,
}) => {
  fixture.reset();
  await activateFreshProPlusOrg(page, request);
  const { divisionId } = await seedAiDivision(request);

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);

  // FIXTURE_CLASH makes the canned plan put two cards on one court at one time.
  // The runner's verifier scores that as a blocking `court` conflict, which is
  // what sends the board to the constraint solver instead of straight to a
  // second LLM round.
  await page.locator("#ai-instruction").fill(`${FIXTURE_CLASH} — squeeze the order.`);
  await compileAndConfirm(page);

  // The organiser is shown a CLEAN board. That is the whole point: the clash was
  // real, and it was gone before this screen rendered.
  await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 30_000 });

  const strip = page.locator('[data-testid="ai-repair-strip"]');
  await expect(strip).toBeVisible();
  // Exactly one move. The rest of the board is free, so one card had to shift and
  // no more — a strip reporting 2+ would mean the solver found an answer but not
  // the minimal one, which is the property this wave exists to deliver.
  await expect(strip).toHaveAttribute("data-moved", "1");
  await expect(strip).toHaveAttribute("data-unresolved", "0");
  await shot(page, "13-repair-strip");

  // Proof the model was actually asked and the clash actually came back, so this
  // cannot pass by quietly never reaching the fixture server.
  const scheduleCall = fixture.calls.find((c) => c.phase === "schedule");
  expect(scheduleCall).toBeTruthy();

  // No second LLM round was spent: the solver answered, so the repair loop never
  // had to pay for another schedule call.
  expect(fixture.calls.filter((c) => c.phase === "schedule").length).toBe(1);

  // 375px: the strip wraps rather than truncating, and nothing it adds pushes the
  // page into horizontal scroll.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(strip).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "13-repair-strip-375");
});

/**
 * #452 — the same repair, on a board that is not on the minute grid.
 *
 * The test above cannot reach this. Every instant the deterministic draft
 * produces is minute-aligned, so the encoder's minutes and the verifier's
 * milliseconds agree on that board by construction — which is precisely why
 * #457 (an obstacle ending at 10:00:20 rounded DOWN to 10:00, letting z3 permit
 * a 20-second overlap the verifier rejects) shipped past a green suite.
 * `FIXTURE_CLASH_SECONDS` pushes the four cards that are NOT in the clash off
 * the minute, so the card the solver has to move is routed around real
 * sub-minute occupancy; see that constant for why it is those cards and not
 * the clashing pair.
 *
 * What this pins that nothing else does: sub-minute instants crossing every
 * layer of the real stack — model plan → engine verifier → z3 repair → the
 * repair's own re-verification → the apply gate → `timestamptz`. A repair whose
 * encoding drifts does not come back merely wrong; `repairAndVerify` throws
 * `RepairVerificationError` and the run drops through to the PAID LLM repair
 * round, so both the CLEAN board and the "exactly one schedule call" assertion
 * below are load-bearing.
 *
 * HONEST LIMIT, so nobody over-claims this later: it is not proven that this
 * board would have gone red on the pre-#457 encoder. z3 is free to choose any
 * minimal repair, and only some of those choices put the moved card adjacent
 * enough to a rounded obstacle for the old `roundMin` to matter. What IS true
 * is that no minute-aligned board can go red on it at all, so this is the first
 * e2e that can.
 *
 * Deliberately kept ALONGSIDE the whole-minute test rather than replacing it:
 * that one is the minimal-repair proof on a wholly aligned board, and the two
 * agreeing on `data-moved="1"` / `proved` is itself an assertion.
 */
test("a clash off the minute boundary is repaired without losing its seconds (#452)", async ({
  page,
  request,
}) => {
  fixture.reset();
  await activateFreshProPlusOrg(page, request);
  const { divisionId } = await seedAiDivision(request);

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await openConsole(page);

  await page.locator("#ai-instruction").fill(`${FIXTURE_CLASH_SECONDS} — squeeze the order.`);
  await compileAndConfirm(page);

  // Same organiser-facing outcome as the whole-minute case. If the encoder and
  // the verifier disagree about the extra 20 seconds, the solver's answer fails
  // its own re-verification and this never renders.
  await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 30_000 });
  const strip = page.locator('[data-testid="ai-repair-strip"]');
  await expect(strip).toBeVisible();
  // The SAME verdict the whole-minute clash produces — one move, proved minimal,
  // nothing given up. That parity is the point: putting four off-minute cards on
  // the board must not degrade the repair. (It does when the CLASH pair is the
  // off-minute one: measured `data-moved="2"`, `data-minimality="upper_bound"`.
  // See `FIXTURE_CLASH_SECONDS`.)
  await expect(strip).toHaveAttribute("data-moved", "1");
  await expect(strip).toHaveAttribute("data-minimality", "proved");
  await expect(strip).toHaveAttribute("data-unresolved", "0");
  await shot(page, "14-repair-strip-offminute");

  // One schedule call. A repair that failed verification is not a silent
  // downgrade — it costs a second, chargeable model round, so this is the
  // assertion that separates "the solver answered" from "the solver was
  // overruled".
  expect(fixture.calls.filter((c) => c.phase === "schedule").length).toBe(1);

  // Through the apply gate and into the column, because a truncation anywhere
  // downstream would be invisible on the board (which renders to the minute).
  // "Skip to apply", not "Review & apply": this division seeds no officials, so
  // the officials step is skipped and its own onward button never renders.
  await page.getByRole("button", { name: "Skip to apply" }).click();
  await page.getByRole("button", { name: "Apply schedule only" }).click();
  await expect(page.getByText("Applied. The board is updated.")).toBeVisible({ timeout: 20_000 });

  const placed = (await getFixtureScheduleSources(divisionId)).filter(
    (r) => r.scheduled_at !== null,
  );
  expect(placed).toHaveLength(6);
  const seconds = placed.map((r) => new Date(r.scheduled_at!).getUTCSeconds());
  const offMinute = FIXTURE_CLASH_OFFSET_MS / 1000;
  // FOUR off-minute cards in, four out. The fixture server offsets every draft
  // card from the third on; none of them is in the clash, so a minimal repair
  // leaves all four exactly where they were, to the millisecond. Fewer than four
  // means something between the model and the `timestamptz` column truncated to
  // the minute — the failure #457 was about, and the one no minute-aligned
  // board can show.
  expect(seconds.filter((s) => s === offMinute)).toHaveLength(4);
  // The clash pair: one card never moved, one was repaired back onto the minute
  // grid. Pinned so a future fixture-server edit that started offsetting the
  // pair too (which measurably costs the minimal repair) fails here rather than
  // quietly changing what this test covers.
  expect(seconds.filter((s) => s === 0)).toHaveLength(2);
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
  await expect(page.getByRole("region", { name: "AI Schedule" })).toBeVisible();
  await expect(page.getByText("Scoped run")).toBeVisible();
  await shot(page, "06-repair-scoped");
});

test.describe("community credit gate", () => {
  test.use({ storageState: "e2e/.auth/community.json" });

  test("a community org with an empty AI-credit wallet is refused before any model call", async ({
    page,
    request,
  }) => {
    fixture.reset();
    const org = await activeOrg(page);
    // No settings PUT / officials — the credit reserve refuses before the pack builds.
    const { competitionId, divisionId } = await seedAiDivision(request, { settings: false });
    try {
      // v17: AI is credit-metered (1 credit/run). Drain the community wallet to 0
      // so the next run's reserve refuses (V322 credit wallet replaced the retired
      // V302 per-division run cap).
      await drainAiCredits(org.id);

      await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
      await openConsole(page);
      // The community org CAN open the wizard (scheduling.ai is granted) …
      await page.locator("#ai-instruction").fill("Spread the matches across the day.");
      // W5 (#400): the refusal now happens one step EARLIER. The preview runs
      // its own affordability check before spending our parse tokens, so an
      // empty wallet is turned away before the compile — the run's 402 is
      // unchanged behind it, but this click is the one an organiser makes now.
      const refused = page.waitForResponse(
        (r) => r.url().includes("/schedule/ai-preview") && r.status() === 402,
        { timeout: 20_000 },
      );
      await page.getByRole("button", { name: "Check what this means" }).click();

      // … and it IS a refusal, asserted on the response rather than on the
      // absence of a card: "no card appeared" is equally satisfied by a request
      // that never fired, which is the opposite of what this test claims.
      await refused;
      // No compile, so no model call — the whole point of checking the wallet
      // before the parse round rather than after it.
      expect(fixture.calls.length).toBe(0);
      // Nothing was compiled, so there is nothing to confirm and no run armed.
      await expect(page.locator("[data-preview-state]")).toHaveCount(0);
      await expect(consoleDock(page).locator("[data-ai-stage]")).toHaveAttribute(
        "data-ai-stage",
        "check",
      );
      // …and the organiser is TOLD, which is the half that was missing: the
      // preview's error was stored but the console's error block was gated on
      // `state.run === "error"`, which a free compile never sets, so a refused
      // check showed a spinner that stopped and nothing else. Asserted on the
      // copy an organiser reads, in the dock, not on a data attribute — the
      // failure this guards is a silent surface.
      const outOfCredits = consoleDock(page).getByRole("alert").filter({
        hasText: "You're out of AI credits for this billing period.",
      });
      await expect(outOfCredits).toBeVisible({ timeout: 10_000 });
      // Not a dead end: the recovery block's own CTAs, and the check still on
      // offer underneath once the wallet is topped up.
      await expect(outOfCredits.getByRole("button", { name: "Buy credits" })).toBeVisible();
      await expect(outOfCredits.locator('[data-upgrade="pro_plus"]')).toBeVisible();
      await shot(page, "07-community-out-of-credits");

      // The same block at the reference phone. Its three recovery CTAs stack
      // (flex-col below sm) and the dock is the full width of the screen, so
      // this is where a recovery block turns into a sideways scroll.
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(outOfCredits).toBeVisible();
      await expect(outOfCredits.getByRole("button", { name: "Buy credits" })).toBeVisible();
      const spills = await page.evaluate(() => {
        const el = document.scrollingElement!;
        return el.scrollWidth > el.clientWidth;
      });
      expect(spills).toBe(false);
      await shot(page, "07-community-out-of-credits-375");
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

    // The gate is on the phone too, and the card it opens must not push the
    // page sideways — the viewport assertion at the end of this test covers
    // the whole flow, card included.
    await compileAndConfirm(page);
    await expect(page.getByText(/CLEAN · 0 blocking/)).toBeVisible({ timeout: 20_000 });

    // The diff panel groups the placements as an agenda list: the "Why it did
    // that" provenance section renders with all six seeded fixtures in the
    // "placed" group (they were unscheduled before the run).
    const region = page.getByRole("region", { name: "AI Schedule" });
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
