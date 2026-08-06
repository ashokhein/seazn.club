import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate } from "./helpers";

// The scheduling board's write paths (schedule-panels.spec covers officials /
// history-tab / constraints-tab): settings → auto-propose → apply → validate →
// move/pin/freeze/checkpoint/clear → publish, plus the conflict + warning
// taxonomy and the plan/mode guards. Drag-and-drop itself is HTML5
// dataTransfer (not reliably scriptable) — the keyboard MovePanel and the
// PATCH route cover the same code path.
test.describe.serial("schedule board", () => {
  let divisionId: string;
  let stageId: string;
  let fixtureIds: string[] = [];
  const slotOf = new Map<string, { scheduled_at: string; court_label: string }>();

  interface FixtureRow {
    id: string;
    scheduled_at: string | null;
    court_label: string | null;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    schedule_locked?: boolean;
  }
  const getFixture = async (request: Parameters<typeof apiJson>[0], id: string) =>
    (await apiJson<FixtureRow>(request, `/api/v1/fixtures/${id}`)).data!;

  test("settings, auto-propose and apply build a two-court board", async ({ page, request }) => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Board ${TAG}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Board",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    divisionId = div.data!.id;
    await addEntrantsViaApi(request, divisionId, ["Bolt", "Wire", "Coil", "Fuse"]);
    const out = await createStageAndGenerate(request, divisionId);
    stageId = out.stageId;
    fixtureIds = out.fixtureIds;
    expect(fixtureIds.length).toBe(6);

    // Core ScheduleConfig: two courts, 45' matches, rest floor for the
    // warning test later. Multi-court/rest is the Pro constraints layer.
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 45,
        gapMinutes: 5,
        courts: ["Court A", "Court B"],
        perEntrantMinRest: 30,
      },
    });
    expect(settings.status).toBe(200);

    // Propose (nothing persisted) — both courts get used …
    const auto = await apiJson<{
      assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
      conflicts: { blocking: boolean }[];
    }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
    expect(auto.status).toBe(200);
    expect(auto.data!.assignments.length).toBe(6);
    expect(new Set(auto.data!.assignments.map((a) => a.court_label)).size).toBe(2);

    // … then persist the proposal.
    const applied = await apiJson<{ applied: number }>(
      request,
      `/api/v1/stages/${stageId}/schedule/apply`,
      "POST",
      {
        assignments: auto.data!.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
        source: "auto",
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.data!.applied).toBe(6);
    for (const a of auto.data!.assignments) {
      slotOf.set(a.fixture_id, { scheduled_at: a.scheduled_at, court_label: a.court_label });
    }

    // A full validation pass over the applied board reports no blockers.
    const validated = await apiJson<{ conflicts: { blocking: boolean }[] }>(
      request,
      `/api/v1/divisions/${divisionId}/schedule/validate`,
      "POST",
    );
    expect(validated.data!.conflicts.filter((c) => c.blocking)).toHaveLength(0);

    // The board tab renders the timetabled fixtures.
    await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
    await expect(page.getByText("Bolt").first()).toBeVisible({ timeout: 20_000 });
  });

  /**
   * #230 item 5 — a conflicts check that FAILED must not read as "no conflicts".
   *
   * The board's re-validation used to swallow every failure in a bare `catch`,
   * so a 500 or a dropped connection left the badge hidden and the panel empty
   * — byte-for-byte what a clean board looks like. The organiser then drags a
   * fixture onto an occupied court and is told nothing, because nobody asked.
   *
   * This is the only place the WHOLE loop is observable: the check has to
   * actually fail (so the request is aborted here rather than mocked in a unit
   * test), the notice has to survive a ZERO conflict count, and the retry has to
   * put the board back to normal once the network recovers.
   */
  test("a failed conflicts check says so, and the retry clears it", async ({ page }) => {
    let fail = true;
    await page.route(`**/api/v1/divisions/${divisionId}/schedule/validate`, async (route) => {
      if (fail) return route.abort("failed");
      return route.continue();
    });

    await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
    // The board itself still works — validation is advisory and always was.
    await expect(page.getByText("Bolt").first()).toBeVisible({ timeout: 20_000 });

    // …but it now says the list is not an answer. This board has no conflicts,
    // which is exactly the case the old code could not distinguish.
    const notice = page.getByText("Conflict check unavailable");
    await expect(notice).toBeVisible();
    const retry = page.getByRole("button", { name: "Check again" });
    await expect(retry).toBeVisible();
    await page.screenshot({ path: "test-results/conflicts-check-unavailable-desktop.png" });

    // 375px: the notice sits in the board toolbar, which must still not scroll.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(notice).toBeVisible();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    await page.screenshot({ path: "test-results/conflicts-check-unavailable-375.png" });

    // Recovery: the retry re-runs the check immediately and the notice goes.
    fail = false;
    await retry.click();
    await expect(notice).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("double-booking a court is a blocking conflict", async ({ request }) => {
    const when = new Date(Date.UTC(2026, 8, 22, 10, 0)).toISOString();
    const clash = await apiJson<{ conflicts: { code: string; blocking: boolean }[] }>(
      request,
      `/api/v1/stages/${stageId}/schedule/apply`,
      "POST",
      {
        assignments: [
          { fixture_id: fixtureIds[0]!, scheduled_at: when, court_label: "Court A" },
          { fixture_id: fixtureIds[1]!, scheduled_at: when, court_label: "Court A" },
        ],
        source: "manual",
      },
    );
    const blockingCourtClash =
      clash.status >= 400 ||
      (clash.data?.conflicts ?? []).some((c) => c.code === "conflict.court" && c.blocking);
    expect(blockingCourtClash).toBe(true);
  });

  test("insufficient rest is a non-blocking warning, not a rejection", async ({ request }) => {
    // Two fixtures sharing an entrant, back-to-back on different courts —
    // violates perEntrantMinRest (30') but must apply and only warn.
    const fixtures = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
    const byEntrant = new Map<string, FixtureRow[]>();
    for (const f of fixtures) {
      for (const e of [f.home_entrant_id, f.away_entrant_id]) {
        if (!e) continue;
        byEntrant.set(e, [...(byEntrant.get(e) ?? []), f]);
      }
    }
    const pair = [...byEntrant.values()].find((v) => v.length >= 2)!.slice(0, 2);
    const t0 = Date.UTC(2026, 8, 23, 9, 0);
    const tight = await apiJson<{ applied: number; conflicts: { code: string; blocking: boolean }[] }>(
      request,
      `/api/v1/stages/${stageId}/schedule/apply`,
      "POST",
      {
        assignments: [
          { fixture_id: pair[0]!.id, scheduled_at: new Date(t0).toISOString(), court_label: "Court A" },
          {
            fixture_id: pair[1]!.id,
            scheduled_at: new Date(t0 + 45 * 60_000).toISOString(), // 0' rest
            court_label: "Court B",
          },
        ],
        source: "manual",
      },
    );
    expect(tight.status).toBe(200); // warnings never reject
    const validated = await apiJson<{ conflicts: { code: string; blocking: boolean }[] }>(
      request,
      `/api/v1/divisions/${divisionId}/schedule/validate`,
      "POST",
    );
    const rest = validated.data!.conflicts.find((c) => c.code === "warn.rest");
    expect(rest).toBeTruthy();
    expect(rest!.blocking).toBe(false);
    // Restore the auto slots so later tests see a clean board.
    await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
      assignments: pair.map((f) => ({ fixture_id: f.id, ...slotOf.get(f.id)! })),
      source: "manual",
    });
  });

  test("a single fixture moves via PATCH; an occupied slot is rejected", async ({ request }) => {
    const free = new Date(Date.UTC(2026, 8, 24, 15, 0)).toISOString();
    const moved = await apiJson(request, `/api/v1/fixtures/${fixtureIds[2]!}`, "PATCH", {
      scheduled_at: free,
      court_label: "Court B",
    });
    expect(moved.status).toBe(200);
    const after = await getFixture(request, fixtureIds[2]!);
    expect(after.scheduled_at).toBe(free);
    expect(after.court_label).toBe("Court B");
    slotOf.set(fixtureIds[2]!, { scheduled_at: free, court_label: "Court B" });

    // Moving another fixture onto that exact slot is a blocking court clash.
    const onto = await apiJson(request, `/api/v1/fixtures/${fixtureIds[3]!}`, "PATCH", {
      scheduled_at: free,
      court_label: "Court B",
    });
    expect(onto.status).toBeGreaterThanOrEqual(400);
  });

  test("a pinned fixture survives re-flow of the rest", async ({ request }) => {
    const pinnedId = fixtureIds[2]!;
    const pinned = await apiJson(request, `/api/v1/fixtures/${pinnedId}`, "PATCH", {
      schedule_locked: true,
    });
    expect(pinned.status).toBe(200);

    const reflow = await apiJson<{
      assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
    }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: true });
    expect(reflow.status).toBe(200);
    // The locked fixture is a fixed obstacle — if the proposal mentions it at
    // all, it keeps exactly its current slot; and the stored slot never moves.
    const pinnedProposal = reflow.data!.assignments.find((a) => a.fixture_id === pinnedId);
    if (pinnedProposal) {
      expect(pinnedProposal.scheduled_at).toBe(slotOf.get(pinnedId)!.scheduled_at);
      expect(pinnedProposal.court_label).toBe(slotOf.get(pinnedId)!.court_label);
    }
    const still = await getFixture(request, pinnedId);
    expect(still.scheduled_at).toBe(slotOf.get(pinnedId)!.scheduled_at);
  });

  test("freezing the whole schedule blocks edits until unfrozen", async ({ request }) => {
    const frozen = await apiJson(request, `/api/v1/divisions/${divisionId}/locks`, "PATCH", {
      schedule_locked: true,
    });
    expect(frozen.status).toBe(200);

    const blocked = await apiJson(request, `/api/v1/fixtures/${fixtureIds[4]!}`, "PATCH", {
      scheduled_at: new Date(Date.UTC(2026, 8, 25, 9, 0)).toISOString(),
      court_label: "Court A",
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);

    const thawed = await apiJson(request, `/api/v1/divisions/${divisionId}/locks`, "PATCH", {
      schedule_locked: false,
    });
    expect(thawed.status).toBe(200);
  });

  test("checkpoint → move → restore returns the fixture to its slot", async ({ request }) => {
    const target = fixtureIds[5]!;
    const before = await getFixture(request, target);

    const cp = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/checkpoints`,
      "POST",
      { label: `pre-move ${TAG}` },
    );
    expect(cp.status).toBe(201);

    await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", {
      scheduled_at: new Date(Date.UTC(2026, 8, 26, 18, 0)).toISOString(),
      court_label: "Court A",
    });

    const restored = await apiJson(request, `/api/v1/divisions/${divisionId}/restore`, "POST", {
      checkpoint_id: cp.data!.id,
      confirm: true,
    });
    expect(restored.status).toBe(200);
    const after = await getFixture(request, target);
    expect(after.scheduled_at).toBe(before.scheduled_at);
    expect(after.court_label).toBe(before.court_label);
  });

  test("clear schedule empties unlocked slots but spares the pinned fixture", async ({ request }) => {
    const pinnedId = fixtureIds[2]!; // still schedule_locked from the re-flow test
    const cleared = await apiJson(request, "/api/v1/schedule/clear", "POST", {
      division_id: divisionId,
      scope: { excludeLocked: true },
      confirm: true,
    });
    expect(cleared.status).toBe(200);

    const pinned = await getFixture(request, pinnedId);
    expect(pinned.scheduled_at).not.toBeNull();
    const others = await Promise.all(
      fixtureIds.filter((id) => id !== pinnedId).map((id) => getFixture(request, id)),
    );
    expect(others.every((f) => f.scheduled_at === null)).toBe(true);
  });

  test("publish flips the division to scheduled", async ({ request }) => {
    // Re-schedule everything first (publish expects a timetable).
    const auto = await apiJson<{
      assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
    }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: true });
    await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
      assignments: auto.data!.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });

    // #230 item 2: publish is gated on a server-side revalidation of the board.
    // This spec asserts the STATUS FLIP, not that the board is spotless — the
    // fixtures it publishes have been moved, pinned and re-flowed by the
    // preceding tests in this serial chain, so a rest shortfall is fair game.
    // Acknowledging covers warnings only; a blocking conflict still 422s and
    // this assertion would still catch it.
    //
    // WHAT THE OVERRIDE COSTS, AND WHERE THAT DEBT IS PAID. Acknowledging means
    // this case no longer proves the auto pass yields a WARNING-FREE board — a
    // regression that made every auto board breach the rest floor would still
    // flip the status here. That proof lives in
    // `src/server/usecases/__tests__/schedule-auto-publishes-clean.test.ts`,
    // which auto-schedules a fresh division under a live rest floor and
    // publishes it with NO acknowledgement. Do not delete it on the grounds
    // that publish is already covered here.
    const published = await apiJson<{ published: boolean; status: string }>(
      request,
      `/api/v1/divisions/${divisionId}/publish-schedule`,
      "POST",
      { acknowledge_warnings: true },
    );
    expect(published.status).toBe(200);
    expect(published.data!.published).toBe(true);
    expect(published.data!.status).toBe("scheduled");
  });

  test("quick-start generates fixtures and opens scoring on a setup division", async ({
    request,
  }) => {
    // Fresh division with a stage but NO pre-generated fixtures — the path the
    // journey suites skip (they pre-generate, so start only refreshes).
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Quickstart ${TAG}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Quick",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    await addEntrantsViaApi(request, div.data!.id, ["Q1", "Q2", "Q3", "Q4"]);
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    });

    const started = await apiJson<{ generated: number; status: string }>(
      request,
      `/api/v1/divisions/${div.data!.id}/start`,
      "POST",
    );
    expect(started.status).toBe(200);
    expect(started.data!.generated).toBe(6);
    expect(started.data!.status).toBe("active");
  });

  // `scheduling_mode` is retired (#189): no screen ever offered it, so the
  // only way to reach 'flexible' was to hand-patch the v1 API — which then
  // dead-ended Auto-schedule (422) and AI Schedule (409) while the board let
  // you hand-build a timetable anyway. PatchDivision no longer accepts the
  // field, and auto treats every division alike.
  test("scheduling_mode is retired: the PATCH is rejected and auto still solves", async ({
    request,
  }) => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Flex ${TAG}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Flex",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    await addEntrantsViaApi(request, div.data!.id, ["X1", "X2"]);
    const patched = await apiJson(request, `/api/v1/divisions/${div.data!.id}`, "PATCH", {
      scheduling_mode: "flexible",
    });
    expect(patched.status).toBe(400);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    });
    await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");

    const auto = await apiJson(request, `/api/v1/stages/${stage.data!.id}/schedule/auto`, "POST", {});
    expect(auto.status).toBe(200);
  });
});

/**
 * #230 item 2 follow-up — the organiser's way through the publish gate.
 *
 * The gate itself is unit-tested; what only a browser can prove is the JOIN:
 * the button POSTs, the server 422s, and the console turns that refusal into a
 * confirm step whose button re-POSTs with `acknowledge_warnings: true`. Before
 * this, the same 422 produced a red toast and no path forward — the button was
 * a dead end on a live surface.
 *
 * Both halves in one test, deliberately. "A dialog appeared" is satisfied by a
 * dialog that always offers to publish anyway, which would be a promise the
 * server can never keep for a blocking board; the two states have to be seen
 * against each other.
 *
 * Outside the serial chain above: its division has been moved, pinned,
 * re-flowed and frozen, and an earlier failure there would SKIP this.
 */
test("the publish gate offers a way through for warnings, and none for a blocker", async ({
  page,
  request,
}) => {
  const DAY = Date.UTC(2026, 9, 12);
  const at = (hour: number) => new Date(DAY + hour * 3_600_000).toISOString();

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Gate ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Gate",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Gale", "Hail", "Iris", "Jade"]);
  const out = await createStageAndGenerate(request, divisionId);

  // A two-hour rest floor, so a 60-minute turnaround is a `warn.rest` — a
  // warning, NOT a blocker. (`conflict.start_window` is non-blocking and
  // `warn.window` IS blocking; the prefix decides nothing.)
  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: at(9),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court A", "Court B"],
      perEntrantMinRest: 120,
    },
  });

  // Two fixtures SHARING an entrant, an hour apart on different courts. The
  // rest of the board stays unscheduled on purpose — an incomplete board is not
  // a conflicted one, and the gate must not confuse the two.
  type Row = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
  const rows = await Promise.all(
    out.fixtureIds.map(async (id) => (await apiJson<Row>(request, `/api/v1/fixtures/${id}`)).data!),
  );
  const first = rows[0]!;
  const sharer = rows.find(
    (f) =>
      f.id !== first.id &&
      [f.home_entrant_id, f.away_entrant_id].some((e) =>
        [first.home_entrant_id, first.away_entrant_id].includes(e),
      ),
  );
  expect(sharer, "the generated round robin has no pair sharing an entrant").toBeTruthy();
  await apiJson(request, `/api/v1/fixtures/${first.id}`, "PATCH", {
    scheduled_at: at(9),
    court_label: "Court A",
  });
  await apiJson(request, `/api/v1/fixtures/${sharer!.id}`, "PATCH", {
    scheduled_at: at(10),
    court_label: "Court B",
  });

  await page.goto(`/competitions/${comp.data!.id}/schedule`);
  await page.getByTestId("board-publish-schedule").click();

  // The refusal became a question, and it names what is being acknowledged.
  const dialog = page.getByTestId("board-gate");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('p[data-kind="warnings"][data-action="publish"]')).toBeVisible();
  // `.first()`: a rest shortfall is reported once per CARD, so the pair yields
  // two rows and a strict locator resolves neither.
  await expect(
    dialog.locator('[data-testid="board-gate-conflict"][data-code="warn.rest"]').first(),
  ).toBeVisible();

  await page.getByTestId("board-gate-confirm").click();
  await expect(dialog).toBeHidden();

  const published = await apiJson<{ status: string }>(request, `/api/v1/divisions/${divisionId}`);
  expect(published.data!.status).toBe("scheduled");

  // --- and now the half with no way through ---------------------------------
  // Pull the timetable's last day back behind the board: every placed card is
  // outside the competition window, which IS blocking. Done through settings
  // because a card-level clash cannot be created through the API at all — the
  // delta gate refuses the PATCH that would introduce one.
  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: at(9),
      endAt: new Date(DAY - 3_600_000).toISOString(),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court A", "Court B"],
      perEntrantMinRest: 120,
    },
  });

  await page.reload();
  await page.getByTestId("board-publish-schedule").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('p[data-kind="blocking"]')).toBeVisible();
  await expect(dialog.locator('[data-testid="board-gate-conflict"][data-code="warn.window"]').first()).toBeVisible();
  // THE assertion. Not "disabled" — absent. There is no override for a board
  // that cannot be played, and offering one would be a lie the server rejects.
  await expect(page.getByTestId("board-gate-confirm")).toHaveCount(0);
  await expect(page.getByTestId("board-gate-cancel")).toBeVisible();
});

// Regression: with zero divisions the competition schedule page fed the
// competition id into the settings lookup and crashed with 404
// "division not found". It must render an empty state instead.
test("competition schedule shows an empty state when there are no divisions", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Board empty ${TAG}`,
    visibility: "private",
  });
  await page.goto(`/competitions/${comp.data!.id}/schedule`);
  await expect(
    page.getByRole("heading", { name: /competition schedule/i }),
  ).toBeVisible();
  await expect(page.getByText(/no divisions yet/i)).toBeVisible();
  await expect(page.getByText(/division not found/i)).not.toBeVisible();
});
