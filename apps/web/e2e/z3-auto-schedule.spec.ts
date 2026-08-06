import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, divisionPath } from "./helpers";

// T15 — the three z3 solver actions on the schedule board, driven through the
// UI against the real engine.
//
// WHY THIS EXISTS AND WHAT ONLY IT CAN SEE. `schedule-board.spec.ts` already
// exercises `/schedule/auto` over HTTP, so the endpoint is covered. What nothing
// else covers is the loop an organiser actually performs: the button posts, the
// proposal comes back, `useBoardActions` APPLIES it, and the result strip
// reports what the solver did. Three things can only fail here —
//
//   1. the z3 WASM not being reachable from a production-shaped server (it has
//      shipped as a silent prod no-op before, and every unit test stayed green);
//   2. a button wired to the wrong solver — all three render identically and
//      differ only in the body they send;
//   3. the strip reporting a run that did not happen, or not reporting one that
//      did. `lastRun` is client state set between the auto POST and the apply
//      POST; nothing server-side has an opinion about it.
//
// SELECTORS ARE IDS, NEVER COPY (#465). `board.autoSchedule` renders
// "Auto-schedule {name}" — it interpolates the division name — and
// `board.polish` renders "Improve times", not "Polish". Text is asserted in
// exactly one place below, deliberately, where the assertion IS about the copy.
//
// Each test seeds its own competition/division/stage, so the file needs no
// serial mode and no shared fixture: the result strip is per-page client state,
// which means every strip assertion has to live in the same test as the click
// that produced it anyway.

/** A Wednesday well inside the seeded competition's window. */
const START = new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString();
/** 30-minute matches, no turnaround — the grid every board below sits on. */
const SLOT_MIN = 30;
const slotAt = (n: number) =>
  new Date(Date.parse(START) + n * SLOT_MIN * 60_000).toISOString();

/**
 * The two statuses a working build/reflow can return.
 *
 * `z3_unavailable`, `verifier_rejected` and `solver_busy` are deliberately NOT
 * accepted. All three are graceful degradations the product is right to render,
 * and all three mean the solver did not do the thing this spec exists to prove —
 * a run that quietly fell back to the greedy pass would otherwise pass every
 * assertion here. This list is the whole of the file's teeth; it does not grow.
 */
const SOLVED = ["ok", "already_optimal"];

/**
 * `solver_busy` is a LIVE status, and this file stays honest about it by
 * RETRYING rather than by accepting it.
 *
 * The comment here used to say `buildSchedule` waits on the z3 lock. That has
 * not been true since the queue cap landed: it now answers `solver_busy`
 * immediately — with a greedy board, without taking the lock — once two builds
 * are already in flight. That is reachable in this suite exactly as it stands.
 * The project is `fullyParallel` at four workers, the Auto-schedule and
 * Improve-times tests are both on the build path, and under `test:e2e:all` the
 * two mobile projects each fire one more.
 *
 * Adding `solver_busy` to `SOLVED` would be the cheap fix and the wrong one: the
 * file would then pass against a solver that never ran, which is the single
 * thing it exists to catch. The refusal is transient by construction — the cap
 * clears the moment the runs ahead of it finish, and the strip's own copy for
 * this status is "Try again for a better board" — so a bounded re-click is the
 * honest response. What is asserted at the end is unchanged: a real solve.
 */
const BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 4_000;

interface FixtureRow {
  id: string;
  scheduled_at: string | null;
  court_label: string | null;
  schedule_locked?: boolean;
}
const getFixture = async (request: APIRequestContext, id: string): Promise<FixtureRow> =>
  (await apiJson<FixtureRow>(request, `/api/v1/fixtures/${id}`)).data!;

/** `${scheduled_at}@${court_label}` — the whole slot as one comparable value, so
 *  a card that kept its time but changed court still reads as moved. */
const slotKey = (f: FixtureRow) => `${f.scheduled_at ?? "-"}@${f.court_label ?? "-"}`;

/** A private competition + a 4-entrant round-robin division (6 fixtures) on a
 *  two-court, 30-minute grid. Own everything: nothing here is shared state. */
async function seedBoard(
  request: APIRequestContext,
  label: string,
): Promise<{ divisionId: string; stageId: string; fixtureIds: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    // #376 — mandatory, and far enough out that nothing here renders a
    // finished/locked competition state.
    ends_on: "2030-12-31",
    name: `Z3 ${label} ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: label,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ash", "Brook", "Clay", "Dune"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId);
  // A 4-entrant round robin is 6 matches over 3 rounds of 2 — so a 2-court grid
  // has an exact 3-slot optimum, which is what makes the polish test's
  // improvement forced rather than merely likely.
  expect(fixtureIds.length).toBe(6);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: START,
        matchMinutes: SLOT_MIN,
        gapMinutes: 0,
        courts: ["Court A", "Court B"],
        // 0, not a rest floor: a rest shortfall is a WARN, and a board carrying
        // warnings would let "the solver produced nothing useful" and "the
        // solver produced a legal board" look the same in the strip's tone.
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);
  return { divisionId, stageId, fixtureIds };
}

/**
 * Click one solver action and wait for the WHOLE run to land.
 *
 * Two waits, and both are load-bearing. The strip appears as soon as the auto
 * POST returns — BEFORE the apply POST that persists anything — so a test that
 * read the database at that point would be racing the write. `autoRun` clears
 * `busy` in its `finally`, i.e. after apply and after `router.refresh()`, so the
 * button becoming enabled again is the only signal that the round trip is
 * complete. Neither wait asserts on copy.
 *
 * A `solver_busy` answer is RE-CLICKED rather than accepted — see `BUSY_RETRIES`
 * for why that is the version of this that keeps the file's teeth. The status is
 * read only after the button is enabled again, so a locator that momentarily
 * matched the previous attempt's strip cannot be the one that answers: `autoRun`
 * clears `lastRun` before it posts, and a locator resolves at read time.
 */
async function runSolver(page: Page, divisionId: string, testid: string): Promise<Locator> {
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
  const button = page.getByTestId(testid);
  await expect(button).toBeVisible({ timeout: 30_000 });
  const strip = page.getByTestId("schedule-result-strip");

  for (let attempt = 1; attempt <= BUSY_RETRIES; attempt++) {
    await button.click();
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(button).toBeEnabled({ timeout: 45_000 });
    if ((await strip.getAttribute("data-status")) !== "solver_busy") return strip;
    // Somebody else's build holds the queue. Give it room to drain rather than
    // hammering the cap this test is itself contributing to.
    if (attempt < BUSY_RETRIES) await page.waitForTimeout(BUSY_BACKOFF_MS);
  }
  throw new Error(
    `${testid} answered solver_busy on all ${BUSY_RETRIES} attempts — the solver queue never ` +
      `drained. That is contention rather than a wiring fault, and the greedy board it handed ` +
      `back is a valid board, but this spec exists to prove a REAL solve and will not accept one.`,
  );
}

/**
 * The strip's own report, asserted on VALUES rather than on presence.
 *
 * A bare "the attribute is there" probe is vacuous on this surface: React
 * serialises an omitted prop as the string `"$undefined"`, so an attribute that
 * lost its source still reads as present. Every read below is compared against
 * an explicit expected value or membership list, which `"$undefined"` and `null`
 * both fail.
 */
async function expectSolvedStrip(strip: Locator, opts: { tone: string }): Promise<void> {
  const status = await strip.getAttribute("data-status");
  expect(SOLVED, `solver reported data-status="${status}"`).toContain(status);
  await expect(strip).toHaveAttribute("data-tone", opts.tone);
}

test("Auto-schedule places an empty board and the strip reports the run", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedBoard(request, "Build");
  // Nothing is scheduled yet — this is the fresh-board case the button is for.
  const before = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(before.every((f) => f.scheduled_at === null)).toBe(true);

  const strip = await runSolver(page, divisionId, "schedule-auto");

  // COVER 1 — a complete board, and the strip agrees it is complete. `plain`
  // rather than `flag`: the tone flips to amber the moment anything is dropped,
  // so asserting the exact value pins "nothing was left behind" as well.
  await expectSolvedStrip(strip, { tone: "plain" });
  const after = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(after.filter((f) => f.scheduled_at !== null)).toHaveLength(6);
  expect(after.every((f) => f.court_label !== null)).toBe(true);
  // Two courts exist and a 6-match round robin cannot fit on one inside this
  // grid without doubling the makespan — a board that used a single court is a
  // solver that ignored its own configuration.
  expect(new Set(after.map((f) => f.court_label)).size).toBe(2);

  // COVER 2 — the strip carries THIS run's telemetry, not a placeholder.
  const headline = page.getByTestId("schedule-result-headline");
  await expect(headline).toBeVisible();
  expect(((await headline.textContent()) ?? "").trim().length).toBeGreaterThan(0);

  // The one deliberate copy assertion in this file. `board.result.provenance`
  // renders "<engine> · <elapsed> · <churn>", and the engine name is the only
  // thing on screen that says which solver produced the board — "Quick pass" is
  // the greedy fallback, "Solver"/"Solver, then refined" are z3. A regex over
  // the three shipped labels is what makes the difference visible; a non-empty
  // check here would pass on all three and on a blank engine key.
  await expect(page.getByTestId("schedule-result-provenance")).toHaveText(
    /^(Quick pass|Solver, then refined|Solver) · /,
  );

  // COVER 5 — `schedule-result-lost` on a board that dropped nothing.
  //
  // DEVIATION FROM THE BRIEF, and it is a fact about the component rather than a
  // choice: the line is rendered under `lost > 0` (result-strip.tsx), and its
  // dictionary entries are "One match lost the slot it had." / "{count} matches
  // lost the slots they had." — there is no zero form to read. Asserting it
  // "reads zero" is not implementable without changing the component, which is
  // out of scope here. The absence is therefore asserted directly, and anchored
  // on the strip being present so it cannot be satisfied by the page having gone
  // away: the strip is here, it reports a solved board, and it is saying nothing
  // about lost slots. A future non-zero still shows up as this assertion failing.
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("schedule-result-lost")).toHaveCount(0);
});

test("Re-flow places the unscheduled cards and leaves a pinned one alone", async ({
  page,
  request,
}) => {
  const { divisionId, stageId, fixtureIds } = await seedBoard(request, "Reflow");

  // Build a full board over the API first — the UI click under test is the
  // RE-FLOW, so the starting board must not come from one.
  const auto = await apiJson<{
    assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
  }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false });
  expect(auto.status).toBe(200);
  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    { assignments: auto.data!.assignments, source: "auto" },
  );
  expect(applied.data!.applied).toBe(6);

  const pinnedId = fixtureIds[0]!;
  expect((await apiJson(request, `/api/v1/fixtures/${pinnedId}`, "PATCH", {
    schedule_locked: true,
  })).status).toBe(200);
  const pinnedBefore = await getFixture(request, pinnedId);
  expect(pinnedBefore.scheduled_at).not.toBeNull();

  // Empty every UNLOCKED slot. This is what makes the test non-vacuous: a
  // re-flow that did nothing at all leaves five cards with no time, which is
  // visible, whereas over an already-legal board the repair solver is entitled
  // to return `clean` and move nothing — and "the pinned card stayed" would then
  // pass on a button that was never wired up.
  const cleared = await apiJson(request, "/api/v1/schedule/clear", "POST", {
    division_id: divisionId,
    scope: { excludeLocked: true },
    confirm: true,
  });
  expect(cleared.status).toBe(200);
  const others = fixtureIds.filter((id) => id !== pinnedId);
  const emptied = await Promise.all(others.map((id) => getFixture(request, id)));
  expect(emptied.every((f) => f.scheduled_at === null)).toBe(true);

  const strip = await runSolver(page, divisionId, "schedule-reflow");
  await expectSolvedStrip(strip, { tone: "plain" });

  // The pinned card kept its EXACT slot — time and court both, since a card
  // moved across courts at the same minute is still a card the organiser was
  // told the wrong thing about.
  const pinnedAfter = await getFixture(request, pinnedId);
  expect(slotKey(pinnedAfter)).toBe(slotKey(pinnedBefore));
  expect(pinnedAfter.schedule_locked).toBe(true);

  // …and the other half: the run demonstrably did something.
  const refilled = await Promise.all(others.map((id) => getFixture(request, id)));
  expect(refilled.filter((f) => f.scheduled_at !== null).length).toBeGreaterThanOrEqual(1);
  expect(refilled.every((f) => f.scheduled_at !== null && f.court_label !== null)).toBe(true);
});

test("Improve times compacts the board without moving a locked card", async ({ page, request }) => {
  const { divisionId, stageId, fixtureIds } = await seedBoard(request, "Polish");

  // A deliberately POOR but entirely LEGAL board: all six matches strung down
  // Court A in consecutive 30-minute slots, Court B untouched. Polish runs the
  // tier solver over a board that is already valid, so the board has to be
  // improvable or the test proves nothing — here the makespan is 3 hours where
  // the two-court optimum is 90 minutes, and the court spread is the whole
  // board, so the very first tier has somewhere to go. `perEntrantMinRest: 0`
  // is what keeps back-to-back matches for one entrant legal.
  const board = fixtureIds.map((id, i) => ({
    fixture_id: id,
    scheduled_at: slotAt(i),
    court_label: "Court A",
  }));
  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    { assignments: board, source: "manual" },
  );
  expect(applied.status).toBe(200);
  expect(applied.data!.applied).toBe(6);

  // Lock the FIRST slot. At 09:00 on the board's own start it constrains
  // neither the makespan floor nor the court balance, so a solver that honours
  // it can still reach the optimum — an unmoved locked card here is a freeze
  // being respected, not a solver that had no room to move anything.
  const lockedId = fixtureIds[0]!;
  expect((await apiJson(request, `/api/v1/fixtures/${lockedId}`, "PATCH", {
    schedule_locked: true,
  })).status).toBe(200);

  const before = new Map<string, string>();
  for (const id of fixtureIds) before.set(id, slotKey(await getFixture(request, id)));

  const strip = await runSolver(page, divisionId, "schedule-polish");
  await expectSolvedStrip(strip, { tone: "plain" });

  const lockedAfter = await getFixture(request, lockedId);
  expect(slotKey(lockedAfter)).toBe(before.get(lockedId));
  expect(lockedAfter.schedule_locked).toBe(true);

  // The second half, without which "the locked card stayed" is satisfied by a
  // button that does nothing: at least one unlocked card must have taken a
  // different slot.
  const moved: string[] = [];
  for (const id of fixtureIds) {
    if (id === lockedId) continue;
    if (slotKey(await getFixture(request, id)) !== before.get(id)) moved.push(id);
  }
  expect(moved.length, "polish left every unlocked card exactly where it was").toBeGreaterThanOrEqual(1);
});
