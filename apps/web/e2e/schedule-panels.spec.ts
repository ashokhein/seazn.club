import { test, expect } from "@playwright/test";
import { apiJson, seedScoredDivision, setOrgPlanBySql, TAG, divisionPath } from "./helpers";

// PROMPT-22/23/24/26 schedule console (now tabbed): each panel mounts on its
// tab AND its core interaction works end-to-end (real POSTs, not just render).

test("tabs mount: board + each panel, exports in the Documents menu", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
  await expect(page.getByRole("group", { name: /board density/i })).toBeVisible({ timeout: 20_000 });

  // #189 moved the five loose export buttons off this header into the
  // Documents menu on the fixtures view — one home for every document — so
  // that is where the timetable and the participants sheet now live.
  await page.goto(await divisionPath(page.request, divisionId));
  await page.getByTestId("documents-menu-trigger").click();
  const documents = page.getByRole("menu", { name: /documents/i });
  await expect(documents.getByText("Order of play")).toBeVisible({ timeout: 20_000 });
  await expect(documents.getByText("Participants")).toBeVisible();

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=officials"));
  await expect(page.getByRole("heading", { name: "Officials", exact: true })).toBeVisible();

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=history"));
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
});

test("officials (PROMPT-22): propose → apply an auto-assignment", async ({ page, request }) => {
  // V290: officials.auto is Pro Plus. Run this flow in a FRESH org flipped to
  // pro_plus by id — a fresh org has no cached entitlements, and flipping the
  // shared setup org would race the 5-min ent cache primed by sibling tests.
  const org = await apiJson<{ id: string }>(request, "/api/orgs", "POST", {
    name: `Panels ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
  });
  await setOrgPlanBySql({ orgId: org.data!.id }, "pro_plus");
  const activated = await apiJson(request, "/api/orgs/active", "POST", { org_id: org.data!.id });
  expect(activated.status).toBeLessThan(300);

  // Officials attach to timed, UNDECIDED fixtures — keep results off so the
  // auto-assign engine has something to place.
  const { divisionId } = await seedScoredDivision(request, undefined, { decide: false });
  await apiJson(request, "/api/v1/officials", "POST", {
    display_name: `Ref ${TAG}`,
    role_keys: ["referee"],
  });

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=officials"));
  await page.getByRole("button", { name: /^Propose$/ }).click();

  const apply = page.getByRole("button", { name: /Apply \d+ assignments/ });
  await expect(apply).toBeVisible({ timeout: 20_000 });
  await apply.click();

  // applied → the proposal collapses (Apply button gone), no error
  await expect(apply).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(/failed/i)).toHaveCount(0);
});

// #448 — the auto-assign cap must count the ORGANISATION's calendar day. Drive
// it through the panel a user actually clicks: an org in America/Los_Angeles,
// one referee capped at 2/day, and four fixtures on ONE local Saturday whose
// evening half is already Sunday in UTC. Bucketing on UTC sees 2 + 2 and offers
// to apply all six; the org's own day allows 2 there, so it offers four and
// reports the two it could not fill.
test("officials (#448): maxPerDay caps on the org day across a UTC midnight", async ({
  page,
  request,
}) => {
  const org = await apiJson<{ id: string }>(request, "/api/orgs", "POST", {
    name: `TZ448 ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
  });
  await setOrgPlanBySql({ orgId: org.data!.id }, "pro_plus");
  const activated = await apiJson(request, "/api/orgs/active", "POST", { org_id: org.data!.id });
  expect(activated.status).toBeLessThan(300);

  // The governing clock. Everything below is chosen against this zone.
  const tzSet = await apiJson(request, `/api/orgs/${org.data!.id}`, "PATCH", {
    timezone: "America/Los_Angeles",
  });
  expect(tzSet.status).toBeLessThan(300);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `TZ448 ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
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
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtures = gen.data!.fixtures;
  expect(fixtures.length).toBe(6); // 4 entrants, round robin

  // 2026-07-11 in Los Angeles (PDT, UTC-7). 10:00 and 12:00 local are still
  // Saturday in UTC; 18:00 and 20:00 local are Sunday 01:00Z and 03:00Z.
  const localSaturday = [
    "2026-07-11T17:00:00.000Z",
    "2026-07-11T19:00:00.000Z",
    "2026-07-12T01:00:00.000Z",
    "2026-07-12T03:00:00.000Z",
  ];
  for (const [i, at] of localSaturday.entries()) {
    await apiJson(request, `/api/v1/fixtures/${fixtures[i]!.id}`, "PATCH", {
      scheduled_at: at,
      court_label: "1",
    });
  }
  // The remaining two sit on their own days well clear of the Saturday, so they
  // consume none of its cap and are expected to fill.
  for (const [i, f] of fixtures.slice(4).entries()) {
    await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", {
      scheduled_at: `2026-09-2${i}T18:00:00.000Z`,
      court_label: "1",
    });
  }
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  // Exactly ONE referee, capped at 2 a day — no one else can absorb the
  // overflow, so the cap is what decides the outcome.
  await apiJson(request, "/api/v1/officials", "POST", {
    display_name: `Capped Ref ${TAG}`,
    role_keys: ["referee"],
    max_per_day: 2,
  });

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=officials"));
  await page.getByRole("button", { name: /^Propose$/ }).click();

  // 2 on the local Saturday + 1 on each September day = 4, not 6.
  await expect(page.getByRole("button", { name: "Apply 4 assignments" })).toBeVisible({
    timeout: 20_000,
  });
  // and the two slots the cap refused are reported, not silently dropped
  await expect(page.getByText(/role_unfilled/)).toHaveCount(2);
});

test("history (PROMPT-23): undo then redo round-trips without error", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=history"));

  // Exact labels: the panel's Tip ⓘ ("About: Undo and save points") would
  // otherwise collide with a loose /Undo/ match.
  const undo = page.getByRole("button", { name: "↩ Undo" });
  const redo = page.getByRole("button", { name: "↪ Redo" });
  await expect(undo).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Recent edits" })).toBeVisible();

  await undo.click();
  // undo appends an inverse event — an "undo" entry appears in the list
  await expect(page.getByText(/undo/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/failed/i)).toHaveCount(0);

  await redo.click();
  await expect(page.getByText(/failed/i)).toHaveCount(0);
  await expect(redo).toBeEnabled();
});

test("constraints (PROMPT-24): edits save and persist across reload", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=constraints"));

  const clash = page.getByLabel(/never in two matches at once/i);
  const rest = page.getByRole("spinbutton", { name: /minimum rest/i });
  await expect(clash).toBeVisible({ timeout: 20_000 });
  const startChecked = await clash.isChecked();

  // single click (each change auto-saves via a GET+PUT round-trip; the
  // controlled checkbox flips only after it lands, so click once and wait)
  await clash.click();
  await expect(clash).toBeChecked({ checked: !startChecked, timeout: 20_000 });

  await rest.fill("12");
  await rest.blur();
  await expect(rest).toHaveValue("12", { timeout: 20_000 });
  await expect(page.getByText(/failed/i)).toHaveCount(0);

  // persisted server-side: a fresh load reflects both edits
  await page.reload();
  await expect(page.getByLabel(/never in two matches at once/i)).toBeChecked({
    checked: !startChecked,
    timeout: 20_000,
  });
  await expect(page.getByRole("spinbutton", { name: /minimum rest/i })).toHaveValue("12");
});
