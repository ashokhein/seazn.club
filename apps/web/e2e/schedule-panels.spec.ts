import { test, expect } from "@playwright/test";
import { apiJson, seedScoredDivision, setOrgPlanBySql, TAG } from "./helpers";

// PROMPT-22/23/24/26 schedule console (now tabbed): each panel mounts on its
// tab AND its core interaction works end-to-end (real POSTs, not just render).

test("tabs mount: board exports + each panel", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);

  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await expect(page.getByRole("link", { name: /timetable pdf/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: /participants xlsx/i })).toBeVisible();

  await page.goto(`/divisions/${divisionId}/schedule?tab=officials`);
  await expect(page.getByRole("heading", { name: "Officials", exact: true })).toBeVisible();

  await page.goto(`/divisions/${divisionId}/schedule?tab=history`);
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

  await page.goto(`/divisions/${divisionId}/schedule?tab=officials`);
  await page.getByRole("button", { name: /^Propose$/ }).click();

  const apply = page.getByRole("button", { name: /Apply \d+ assignments/ });
  await expect(apply).toBeVisible({ timeout: 20_000 });
  await apply.click();

  // applied → the proposal collapses (Apply button gone), no error
  await expect(apply).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(/failed/i)).toHaveCount(0);
});

test("history (PROMPT-23): undo then redo round-trips without error", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);
  await page.goto(`/divisions/${divisionId}/schedule?tab=history`);

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
  await page.goto(`/divisions/${divisionId}/schedule?tab=constraints`);

  const clash = page.getByLabel(/never be in two matches at once/i);
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
  await expect(page.getByLabel(/never be in two matches at once/i)).toBeChecked({
    checked: !startChecked,
    timeout: 20_000,
  });
  await expect(page.getByRole("spinbutton", { name: /minimum rest/i })).toHaveValue("12");
});
