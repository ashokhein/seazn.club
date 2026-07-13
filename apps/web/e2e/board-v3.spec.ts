import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  setOrgPlanBySql,
  expectNoHorizontalScroll,
} from "./helpers";

// PROMPT-33 acceptance (v3/04 §2 + v3/11 gaps 10/11/15): five-division board
// — legend filter with URL state, injected rest violation → badge → panel →
// jump, pick-then-place on mobile emulation AND keyboard, no page-level
// horizontal scroll, two-client stale write → 409 + refreshed board, and the
// initial payload budget. Drag-and-drop itself is HTML5 dataTransfer (not
// reliably scriptable) — pick/place and the PATCH route cover the move path.

const DIVISIONS = ["U16 Boys", "U16 Girls", "U18 Boys", "U18 Girls", "Open Singles"];

/** Per-division court pair — divisions must not share courts or every slot
 *  would be a cross-division court clash (siblingAssignments checks the whole
 *  competition) and the seeding PATCHes would 409. */
const courtsOf = (di: number): [string, string] => [`P${di}A`, `P${di}B`];

interface Rig {
  compSlug: string;
  orgSlug: string;
  divisions: { id: string; slug: string; name: string }[];
  /** per division: generated fixture ids in creation order */
  fixtures: Record<string, string[]>;
  /** two fixtures in division[0] sharing an entrant (rest-violation bait) */
  sharedEntrantFixtures: [string, string];
}

async function buildRig(request: APIRequestContext, page: Page): Promise<Rig> {
  const org = await activeOrg(page);
  await setOrgPlanBySql({ orgId: org.id }, "pro");

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Board v3 ${TAG}`,
    visibility: "private",
    starts_on: "2026-09-15",
    ends_on: "2026-09-17",
  });

  const divisions: Rig["divisions"] = [];
  const fixtures: Rig["fixtures"] = {};
  let sharedEntrantFixtures: [string, string] | null = null;

  for (const [di, name] of DIVISIONS.entries()) {
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const d = { id: div.data!.id, slug: div.data!.slug, name };
    divisions.push(d);

    await apiJson(
      request,
      `/api/v1/divisions/${d.id}/entrants`,
      "POST",
      Array.from({ length: 12 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `${name} P${i + 1}`,
        seed: i + 1,
      })),
    );
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${d.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    });
    await apiJson(request, `/api/v1/divisions/${d.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-15T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtsOf(di),
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const gen = await apiJson<{ fixtures: { id: string; home_entrant_id: string }[] }>(
      request,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );
    const ids = gen.data!.fixtures.map((f) => f.id);
    fixtures[d.id] = ids;

    // Timetable: spread every fixture over the three days, two courts, no
    // shared-entrant adjacency (league rounds already alternate players).
    const base = Date.UTC(2026, 8, 15, 9, 0, 0);
    for (let i = 0; i < ids.length; i++) {
      const day = i % 3;
      const slot = Math.floor(i / 3);
      await apiJson(request, `/api/v1/fixtures/${ids[i]!}`, "PATCH", {
        scheduled_at: new Date(base + day * 24 * 60 * 60_000 + slot * 60 * 60_000).toISOString(),
        court_label: courtsOf(di)[i % 2],
      });
    }

    // Rest bait in the first division: two fixtures sharing a home entrant.
    if (!sharedEntrantFixtures) {
      const byEntrant = new Map<string, string[]>();
      for (const f of gen.data!.fixtures) {
        const list = byEntrant.get(f.home_entrant_id) ?? [];
        list.push(f.id);
        byEntrant.set(f.home_entrant_id, list);
      }
      const pairList = [...byEntrant.values()].find((l) => l.length >= 2);
      if (pairList) sharedEntrantFixtures = [pairList[0]!, pairList[1]!];
    }
  }

  return {
    compSlug: comp.data!.slug,
    orgSlug: org.slug,
    divisions,
    fixtures,
    sharedEntrantFixtures: sharedEntrantFixtures!,
  };
}

test.describe.serial("board v3 (PROMPT-33)", () => {
  let rig: Rig;
  let boardUrl: string;

  test("seed: five divisions × ~66 fixtures land under the payload budget (gap 15)", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000); // 5 divisions × 66 sequential PATCHes
    rig = await buildRig(request, page);
    boardUrl = `/o/${rig.orgSlug}/c/${rig.compSlug}/schedule`;

    const resp = await page.goto(boardUrl);
    expect(resp?.ok()).toBe(true);
    await expect(page.getByRole("group", { name: "Board density" })).toBeVisible();
    // Gap 15 budgets the board's JSON payload — the RSC flight segments in
    // the document (the dev-mode HTML around them carries HMR/dev overhead
    // that never ships). Parse the response body: hydration may have drained
    // the runtime __next_f array by the time we could evaluate.
    const html = (await resp!.body()).toString("utf8");
    const flightBytes = [...html.matchAll(/__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)].reduce(
      (n, m) => n + m[1]!.length,
      0,
    );
    expect(flightBytes).toBeGreaterThan(0);
    expect(flightBytes).toBeLessThan(250_000);
  });

  test("legend filters to two divisions in two taps; the URL is shareable", async ({ page }) => {
    await page.goto(boardUrl);
    await page.getByRole("button", { name: "U16 Boys", exact: true }).click();
    await page.getByRole("button", { name: "U16 Girls", exact: true }).click();
    await expect(page).toHaveURL(/d=u16-boys(%2C|,)u16-girls/);

    // Only the two selected divisions' chips render on blocks.
    await expect(page.locator("[data-fixture-id]").first()).toBeVisible();
    const chips = await page
      .locator("[data-fixture-id] [data-division-chip]")
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-division-chip")))]);
    expect(chips.sort()).toEqual(["U16B", "U16G"]);

    // Fresh navigation to the same URL keeps the filter (shareable view).
    await page.goto(page.url());
    const chipsAfter = await page
      .locator("[data-fixture-id] [data-division-chip]")
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-division-chip")))]);
    expect(chipsAfter.sort()).toEqual(["U16B", "U16G"]);
  });

  test("injected rest violation → badge count → panel → jump-to-fixture", async ({
    page,
    request,
  }) => {
    const d0 = rig.divisions[0]!;
    // Tighten rest, then butt the shared-entrant fixtures against each other
    // on different courts (same time + court would 409 as a court clash).
    await apiJson(request, `/api/v1/divisions/${d0.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-15T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtsOf(0),
        perEntrantMinRest: 60,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const [fa, fb] = rig.sharedEntrantFixtures;
    await apiJson(request, `/api/v1/fixtures/${fa}`, "PATCH", {
      scheduled_at: "2026-09-15T09:00:00.000Z",
      court_label: "P0A",
    });
    await apiJson(request, `/api/v1/fixtures/${fb}`, "PATCH", {
      scheduled_at: "2026-09-15T09:30:00.000Z",
      court_label: "P0B",
    });

    await page.goto(boardUrl);
    const badge = page.getByRole("button", { name: /conflicts? — open the list/ });
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.click();

    const panel = page.getByRole("region", { name: "Schedule conflicts" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("rest", { exact: true }).first()).toBeVisible();
    await panel.getByRole("button", { name: "Jump to fixture →" }).first().click();
    await expect(panel).toBeHidden();
    // The offending block is highlighted and scrolled into view.
    await expect(page.locator(".animate-pulse [data-fixture-id]").first()).toBeInViewport();
  });

  test("pick-then-place schedules a fixture on 390px emulation (agenda default)", async ({
    page,
    request,
  }) => {
    const d0 = rig.divisions[0]!;
    const target = rig.fixtures[d0.id]![4]!;
    await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", {
      scheduled_at: null,
      court_label: null,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${boardUrl}?d=${d0.slug}`);
    await expectNoHorizontalScroll(page);

    // Bottom sheet → pick the unscheduled fixture → place on a time group.
    await page.getByRole("button", { name: /^Unscheduled/ }).click();
    const sheet = page.getByRole("region", { name: "Unscheduled fixtures" });
    await sheet.locator("[data-fixture-id] button[aria-pressed]").first().click();
    await page.getByRole("button", { name: "Place picked match here" }).first().click();

    await expect
      .poll(
        async () =>
          (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`))
            .data!.scheduled_at,
        { timeout: 15_000 },
      )
      .not.toBeNull();
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test("pick-then-place is keyboard-operable (fixture and slot, Enter to pick/place)", async ({
    page,
    request,
  }) => {
    const d0 = rig.divisions[0]!;
    const target = rig.fixtures[d0.id]![5]!;
    await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", {
      scheduled_at: null,
      court_label: null,
    });

    await page.goto(`${boardUrl}?d=${d0.slug}`);
    // Board density on desktop: grid slots become tabbable once picked.
    await page.getByRole("button", { name: "Board", exact: true }).click();

    const trayFixture = page
      .locator("aside[aria-label='Unscheduled fixtures'] [data-fixture-id] button[aria-pressed]")
      .first();
    await trayFixture.focus();
    await page.keyboard.press("Enter"); // pick
    await expect(trayFixture).toHaveAttribute("aria-pressed", "true");

    const slot = page.getByRole("button", { name: /^Place picked match at/ }).first();
    await slot.focus();
    await page.keyboard.press("Enter"); // place

    await expect
      .poll(
        async () =>
          (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`))
            .data!.scheduled_at,
        { timeout: 15_000 },
      )
      .not.toBeNull();
    await expectNoHorizontalScroll(page);
  });

  test("two clients: the stale one 409s, toasts, and refreshes (gap 10)", async ({
    page,
    context,
  }) => {
    const d0 = rig.divisions[0]!;
    const filtered = `${boardUrl}?d=${d0.slug}`;
    const pageB = await context.newPage();
    // The premise is that B writes with a STALE seq. Where Supabase realtime
    // is live (staging), A's move broadcasts schedule_changed and B silently
    // router.refresh()es to the new seq — its write then fails on a court
    // clash instead of SEQ_CONFLICT. Deafen B's websocket so it provably
    // keeps the pre-move seq; a no-op where realtime isn't configured.
    await pageB.routeWebSocket(/realtime/, () => {});
    await page.goto(filtered);
    await pageB.goto(filtered);

    // Client A moves a fixture through the pick → MovePanel path.
    const move = async (p: Page, when: string) => {
      await p.locator("[data-fixture-id] button[aria-pressed]").first().click();
      const dialog = p.getByRole("dialog", { name: /^Move / });
      await dialog.locator("input[type=datetime-local]").fill(when);
      await dialog.getByRole("button", { name: "Move", exact: true }).click();
    };
    await move(page, "2026-09-16T18:00");
    // A's own board refreshes without complaint.
    await expect(page.getByText("Schedule changed by someone else")).toHaveCount(0);

    // Client B still holds the pre-move seq: its write must 409 → toast.
    await move(pageB, "2026-09-16T19:00");
    await expect(pageB.getByText("Schedule changed by someone else — board refreshed.")).toBeVisible(
      { timeout: 15_000 },
    );
    await pageB.close();
  });
});
