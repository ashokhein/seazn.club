import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  TAG,
  apiJson,
  activeOrg,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
} from "./helpers";

// v3/02 §4 viewport gate — runs ONLY in the mobile-se / mobile-14 projects
// (375×667, 390×844). Every audited route must render with zero page-level
// horizontal scroll; key surfaces must pass axe (serious/critical) and the
// public dashboard + registration page must LCP under 2.5 s on Fast-3G
// (v3/11 gaps 11, 12, 15).
test.describe.configure({ mode: "serial" });

// The check that guards every other 375px assertion in this file. It compared
// document.scrollWidth against clientWidth, which `overflow-x: clip`
// (globals.css:63) pins to the viewport — so a 525px overflow read as clean.
// This probe is the control: if it ever passes, the helper is blind again and
// every "no horizontal scroll" test in the suite is decorative.
test("CONTROL (#325): the overflow check itself can fail", async ({ page }) => {
  await page.goto("/pricing", { waitUntil: "load" });
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "overflow-probe";
    probe.style.cssText = "width:900px;height:8px;background:transparent";
    document.body.appendChild(probe);
  });
  await expect(expectNoHorizontalScroll(page)).rejects.toThrow(/overflow/i);
  await page.evaluate(() => document.getElementById("overflow-probe")?.remove());
  await expectNoHorizontalScroll(page);
});

let compId = "";
let compSlug = "";
let divisionId = "";
let orgSlug = "";

test("setup: public competition with an entrant-ready division", async ({ page, request }) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Mobile Gate ${TAG}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);
  compId = comp.data!.id;
  compSlug = comp.data!.slug;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Mobile Singles",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status).toBeLessThan(300);
  divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ada M", "Bea M", "Cal M", "Dev M"]);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: "individual",
      capacity: 10,
      fee_cents: 0,
      currency: "gbp",
      form_fields: [],
    },
  );
  expect(settings.status).toBeLessThan(300);
  orgSlug = (await activeOrg(page)).slug;
});

// "load" + a short settle instead of networkidle — the dev server's HMR
// socket keeps the network permanently busy and cold compiles already eat
// the budget.
async function auditRoute(page: Page, path: string) {
  await page.goto(path, { waitUntil: "load" });
  await page.waitForTimeout(300);
  await expectNoHorizontalScroll(page);
}

test("console routes: no horizontal scroll", async ({ page }) => {
  const routes = [
    "/dashboard",
    `/competitions/${compId}`,
    `/competitions/${compId}/settings`,
    `/divisions/${divisionId}`,
    `/divisions/${divisionId}?tab=fixtures`,
    `/divisions/${divisionId}?tab=standings`,
    `/divisions/${divisionId}/registrations`,
    "/settings?tab=organization",
    "/settings?tab=news",
    "/settings?tab=sponsors",
    "/settings?tab=team",
    "/settings?tab=api",
    "/settings?tab=account",
    "/settings/billing",
    // The Event Pass page (task 22). Its comparison table is three plans wide
    // and must scroll inside its own container, never the page body — the one
    // v3/02 §4 rule this surface is most likely to break. This account is Pro,
    // so it renders the paid-plan state; the offer / owned / ceiling states are
    // driven at 390×844 by e2e/event-pass.spec.ts.
    `/o/${orgSlug}/c/${compSlug}/upgrade`,
    "/directory",
    "/import",
    "/my-matches",
  ];
  for (const path of routes) {
    await auditRoute(page, path);
  }
});

test("public surfaces: no horizontal scroll (v3/11 gap 12)", async ({ browser }) => {
  // Anonymous context — public pages must hold without the authed shell.
  const anonCtx = await browser.newContext();
  try {
    const anon = await anonCtx.newPage();
    const routes = [
      "/",
      "/pricing",
      `/shared/${orgSlug}`,
      `/shared/${orgSlug}/${compSlug}`,
      `/shared/${orgSlug}/${compSlug}/register`,
    ];
    for (const path of routes) {
      await anon.goto(path, { waitUntil: "load" });
      await anon.waitForTimeout(300);
      await expectNoHorizontalScroll(anon);
    }
  } finally {
    await anonCtx.close();
  }
});

test("news (SPEC-2): feed + post page hold at mobile width", async ({ page, browser }) => {
  // Publish a manual post (free on every plan) so the public feed has content.
  const orgId = (await apiJson<{ id: string }[]>(page.request, "/api/orgs")).data![0]!.id;
  const created = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${orgId}/posts`, "POST", {
    title: `Mobile news ${TAG}`,
    body_md: "Weekend round-up on a narrow phone.",
    kind: "announcement",
  });
  const pub = await apiJson<{ slug: string }>(
    page.request,
    `/api/v1/posts/${created.data!.id}`,
    "PATCH",
    { action: "publish" },
  );
  const postSlug = pub.data!.slug;

  const anonCtx = await browser.newContext();
  try {
    const anon = await anonCtx.newPage();
    await anon.goto(`/shared/${orgSlug}/news`, { waitUntil: "load" });
    await anon.waitForTimeout(300);
    await expectNoHorizontalScroll(anon);
    // Assert the card while still ON the feed — the post page has no cards.
    await expect(anon.getByTestId("news-card").first()).toBeVisible();

    await anon.goto(`/shared/${orgSlug}/news/${postSlug}`, { waitUntil: "load" });
    await anon.waitForTimeout(300);
    await expectNoHorizontalScroll(anon);
  } finally {
    await anonCtx.close();
  }
});

test("axe: no serious/critical violations on key surfaces (v3/11 gap 11)", async ({ page }) => {
  const routes = [
    "/dashboard",
    `/competitions/${compId}`,
    `/divisions/${divisionId}?tab=standings`,
    "/settings?tab=organization",
    "/settings/billing",
    `/o/${orgSlug}/c/${compSlug}/upgrade`,
    `/shared/${orgSlug}/${compSlug}`,
  ];
  for (const path of routes) {
    await page.goto(path, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking.map((v) => `${path}: ${v.id} — ${v.nodes[0]?.html}`),
      `axe serious/critical on ${path}`,
    ).toEqual([]);
  }
});

test("page smokes: settings save + invoice/plan card render", async ({ page }) => {
  // Org rename round-trip proves forms submit on a phone viewport.
  await page.goto("/settings?tab=organization");
  const nameInput = page.getByLabel(/organi[sz]ation name/i);
  await expect(nameInput).toBeVisible();
  // Two "Save" buttons live on this tab (rename + payment details) — scope
  // to the rename form's own label container.
  const renameForm = page.locator("label", { has: nameInput });
  const orgName = await nameInput.inputValue();
  await nameInput.fill(`${orgName} ✓`);
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(renameForm.getByText("Saved.")).toBeVisible();
  // Restore — other specs assert on the org name.
  await nameInput.fill(orgName);
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(renameForm.getByText("Saved.")).toBeVisible();

  // Billing: the plan card is the invoice-adjacent surface every org has.
  await page.goto("/settings/billing");
  await expect(page.getByRole("heading", { name: /plan & billing/i })).toBeVisible();
  await expect(page.getByText(/current plan/i).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

// v3/11 gap 15: LCP < 2.5 s on Fast-3G for the money pages. CDP network
// emulation (Chromium only — the mobile projects are Chromium).
const FAST_3G = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150,
};

async function measureLcp(page: Page, path: string): Promise<number> {
  // Pre-warm: the dev server compiles a route on first hit — that cost is
  // build tooling, not page weight, so it stays out of the measurement.
  await page.request.get(path);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", FAST_3G);
  await page.goto(path);
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) resolve(last.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
        // No LCP entry (already settled) — fall back to nav timing.
        setTimeout(() => resolve(performance.now()), 4000);
      }),
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await cdp.detach();
  return lcp;
}

test("LCP < 2.5s on Fast-3G: public dashboard + registration (v3/11 gap 15)", async ({
  browser,
}) => {
  const anonCtx = await browser.newContext();
  try {
    const anon = await anonCtx.newPage();
    for (const path of [`/shared/${orgSlug}/${compSlug}`, `/shared/${orgSlug}/${compSlug}/register`]) {
      const lcp = await measureLcp(anon, path);
      expect(lcp, `LCP on ${path}`).toBeLessThan(2500);
    }
  } finally {
    await anonCtx.close();
  }
});

/**
 * #230 item 2 follow-up — the publish gate's confirm step at phone width.
 *
 * It is a bottom sheet under `sm` and it lists an arbitrary number of conflicts,
 * so it is exactly the shape that overflows a 375px page. This file is the ONLY
 * place a 375px assertion actually runs: the mobile projects are
 * `testMatch: /mobile\.spec\.ts/`, so the same assertion written into
 * schedule-board.spec.ts would silently run at desktop and pass.
 */
test("the publish gate's confirm sheet holds at phone width", async ({ page, request }) => {
  const DAY = Date.UTC(2026, 9, 19);
  const at = (hour: number) => new Date(DAY + hour * 3_600_000).toISOString();

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Gate Sheet ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Gate Sheet",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const gateDivisionId = div.data!.id;
  await addEntrantsViaApi(request, gateDivisionId, ["Eve M", "Fay M", "Gus M", "Hal M"]);
  const { fixtureIds } = await createStageAndGenerate(request, gateDivisionId);
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${gateDivisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: at(9),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["Court A", "Court B"],
        // A two-hour floor, so the hour-apart pair below is a `warn.rest` — a
        // warning, which is the case that HAS a confirm affordance to size.
        perEntrantMinRest: 120,
      },
    },
  );
  // Every ScheduleConfig field carries a `.default()`, so a rejected PUT still
  // leaves a usable config behind and the only symptom is "the dialog never
  // appeared" — a failure reported against the sheet, three screens from its
  // cause.
  expect(settings.status).toBe(200);

  type Row = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
  const rows = await Promise.all(
    fixtureIds.map(async (id) => (await apiJson<Row>(request, `/api/v1/fixtures/${id}`)).data!),
  );
  const first = rows[0]!;
  const sharer = rows.find(
    (f) =>
      f.id !== first.id &&
      [f.home_entrant_id, f.away_entrant_id].some((e) =>
        [first.home_entrant_id, first.away_entrant_id].includes(e),
      ),
  )!;
  await apiJson(request, `/api/v1/fixtures/${first.id}`, "PATCH", {
    scheduled_at: at(9),
    court_label: "Court A",
  });
  await apiJson(request, `/api/v1/fixtures/${sharer.id}`, "PATCH", {
    scheduled_at: at(10),
    court_label: "Court B",
  });

  await page.goto(await divisionPath(page.request, gateDivisionId, "/schedule?tab=board"), { waitUntil: "load" });
  const publish = page.getByTestId("board-publish-schedule");
  await expect(publish).toBeVisible({ timeout: 30_000 });
  await publish.click();

  const dialog = page.getByTestId("board-gate");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('[data-testid="board-gate-conflict"]').first()).toBeVisible();

  // The sheet is what is being audited: the page must not scroll sideways
  // behind it, and the sheet's own body must not either — the conflict list is
  // the part that grows without a ceiling.
  await expectNoHorizontalScroll(page);
  const clipped = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="board-gate"]');
    if (!root) return ["the gate sheet was not in the DOM"];
    const suspects: HTMLElement[] = [
      root,
      ...Array.from(root.querySelectorAll<HTMLElement>("p,ul,li")),
    ];
    return suspects
      .filter((el) => el.scrollWidth - el.clientWidth > 1)
      .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px`);
  });
  expect(clipped, "the gate sheet's content is clipped at this width").toEqual([]);

  for (const id of ["board-gate-confirm", "board-gate-cancel"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `${id} has no box`).not.toBeNull();
    expect(box!.height, `${id} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: "test-results/publish-gate-sheet-375.png" });

  // And it works from here — a sheet that renders but cannot be confirmed on a
  // phone is the same dead end in a nicer wrapper.
  await page.getByTestId("board-gate-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const after = await apiJson<{ status: string }>(request, `/api/v1/divisions/${gateDivisionId}`);
  expect(after.data!.status).toBe("scheduled");
  await expectNoHorizontalScroll(page);
});

/**
 * T15 — the z3 solver action bar and its result strip at phone width.
 *
 * THIS TEST CANNOT LIVE IN `z3-auto-schedule.spec.ts`. The `mobile-se`
 * (375×667) and `mobile-14` (390×844) projects are declared with
 * `testMatch: /mobile\.spec\.ts/`, so they run this one file and nothing else —
 * a new spec file gets desktop coverage only, however it is named. The 375px
 * gate for the feature is therefore a section here, by construction.
 *
 * Self-contained: it seeds its own competition rather than borrowing the file's
 * shared division, which has no stage and so renders no action bar at all.
 *
 * Three things are asserted, in the order they can be:
 *   - the three actions are hit-testable. `min-h-11 sm:min-h-0` on all three is
 *     the only reason they clear 44px — the shared `py-1.5 text-xs` button
 *     renders 28px, and the override is mobile-only, so nothing at desktop
 *     width would notice it being dropped.
 *   - the strip renders and its own content is not clipped. The metrics grid
 *     carries `overflow-hidden`, which means a grid that outgrew its container
 *     would silently truncate rather than push the page wide — invisible to the
 *     page-level scroll check below, and the reason this is measured separately.
 *   - no horizontal page scroll, checked AFTER the strip has rendered. The strip
 *     is the widest thing this surface ever shows; running the check on the
 *     board before a run would prove nothing about the element under test.
 */
// LAST IN THE FILE, DELIBERATELY. This whole spec is
// `test.describe.configure({ mode: "serial" })`, so a failure SKIPS every case
// after it — and this is the only case here that depends on a z3 solve, i.e. the
// one most likely to fail for a reason that is nothing to do with layout (a
// solver hiccup, a busy queue, a WASM that will not boot). Sitting mid-file it
// took the public-surface, news, axe, page-smoke and LCP cases down with it.
// Anything added below this line inherits that risk; add it above.
test("z3 schedule actions + result strip hold at phone width", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Mobile Solver ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Solver",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const solverDivisionId = div.data!.id;
  await addEntrantsViaApi(request, solverDivisionId, ["Ash M", "Brook M", "Clay M", "Dune M"]);
  const { fixtureIds } = await createStageAndGenerate(request, solverDivisionId);
  expect(fixtureIds.length).toBe(6);
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${solverDivisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["Court A", "Court B"],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);

  await page.goto(await divisionPath(page.request, solverDivisionId, "/schedule?tab=board"), { waitUntil: "load" });

  // Ids, not labels (#465): "Auto-schedule {name}" interpolates the division
  // name and "Improve times" is not the word "Polish".
  const auto = page.getByTestId("schedule-auto");
  const reflow = page.getByTestId("schedule-reflow");
  const polish = page.getByTestId("schedule-polish");
  for (const [name, button] of [
    ["schedule-auto", auto],
    ["schedule-reflow", reflow],
    ["schedule-polish", polish],
  ] as const) {
    await expect(button, `${name} is not visible at this width`).toBeVisible({ timeout: 30_000 });
    const box = await button.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.height, `${name} touch target is ${box!.height}px`).toBeGreaterThanOrEqual(44);
  }

  await auto.click();
  const strip = page.getByTestId("schedule-result-strip");
  await expect(strip).toBeVisible({ timeout: 45_000 });
  // The whole round trip, not just the proposal: `autoRun` clears `busy` in its
  // `finally`, after the apply POST and the refresh.
  await expect(auto).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByTestId("schedule-result-headline")).toBeVisible();

  // Nothing inside the strip is clipped or scrolled sideways — including the
  // metrics grid, whose `overflow-hidden` would otherwise hide the failure.
  const clipped = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="schedule-result-strip"]');
    if (!root) return ["the strip was not in the DOM"];
    const suspects: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>("dl,p"))];
    return suspects
      .filter((el) => el.scrollWidth - el.clientWidth > 1)
      .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px`);
  });
  expect(clipped, "result strip content is clipped at this width").toEqual([]);

  await expectNoHorizontalScroll(page);
});
