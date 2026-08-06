import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { TAG, apiJson, activeOrg, loginUi, expectNoHorizontalScroll } from "./helpers";

/**
 * #402 — visual evidence for the "I'm registering myself" affirmation, at
 * desktop and at 375px, in each of the three states that differ.
 *
 * The control is conditional in two directions at once (signed in / signed out,
 * and guardian / no guardian), and the team variant grows a second control. A
 * suite that only drove the happy path would not show that the signed-out form
 * is untouched, which is the part registrants who never make an account see.
 */
const SHOTS =
  process.env.REGISTER_SHOTS_DIR ??
  resolve(process.cwd(), "../../.superpowers/sdd/shots/register-self-402");

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

async function both(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);
  await shot(page, `${name}-desktop`);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(150);
  await expectNoHorizontalScroll(page);
  await shot(page, `${name}-375`);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("register affirmation: signed out, signed in, team roster pick", async ({
  page,
  request,
  browser,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    { ends_on: "2030-12-31", name: `Self Shots ${TAG}`, visibility: "public" },
  );
  const compId = comp.data!.id;
  const compSlug = comp.data!.slug;

  // One individual division and one team division — the team one is the only
  // place the "Which player are you?" pick can appear.
  for (const [name, kind] of [
    ["Singles", "individual"],
    ["Squads", "team"],
  ] as const) {
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const settings = await apiJson(
      request,
      `/api/v1/divisions/${div.data!.id}/registration-settings`,
      "PUT",
      {
        enabled: true,
        entrant_kind: kind,
        capacity: 10,
        fee_cents: 0,
        currency: "gbp",
        form_fields: [],
      },
    );
    expect(settings.status).toBeLessThan(300);
  }

  const orgSlug = (await activeOrg(page)).slug;
  const registerUrl = `/shared/${orgSlug}/${compSlug}/register`;

  // --- Signed out: the affirmation must not exist at all ---
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const anon = await anonCtx.newPage();
    await anon.goto(registerUrl, { waitUntil: "load" });
    await anon.getByText("Singles").first().click();
    await expect(anon.getByRole("checkbox", { name: /registering myself/i })).toHaveCount(0);
    await both(anon, "signed-out");
  } finally {
    await anonCtx.close();
  }

  // --- Signed in: unticked (the default), then ticked ---
  const regCtx = await browser.newContext();
  try {
    const reg = await regCtx.newPage();
    await loginUi(reg, `e2e-selfshots-${TAG}@example.com`, registerUrl);

    await reg.goto(registerUrl, { waitUntil: "load" });
    await reg.getByText("Singles").first().click();
    const box = reg.getByRole("checkbox", { name: /registering myself/i });
    await expect(box).toBeVisible();
    // The safe state: being signed in is not consent to link.
    await expect(box).not.toBeChecked();
    await both(reg, "signed-in-unticked");

    await box.check();
    // Ticking makes date of birth mandatory — the server will not link without one.
    await expect(reg.getByLabel(/^date of birth/i)).toHaveAttribute("required", "");
    await both(reg, "signed-in-ticked");

    // A minor's date of birth withdraws the affirmation and raises the guardian
    // block instead — the form must not offer a link the server would veto.
    await reg.getByLabel(/^date of birth/i).fill("2015-04-01");
    await expect(reg.getByRole("checkbox", { name: /registering myself/i })).toHaveCount(0);
    await both(reg, "signed-in-minor-dob-guardian");

    // --- Team division: the roster pick ---
    await reg.goto(registerUrl, { waitUntil: "load" });
    await reg.getByText("Squads").first().click();
    // Real names first — the pick lists the roster the registrant just typed,
    // so an empty roster would only ever show "None of these".
    for (const [i, name] of ["Ada Rahman", "Jordan Blake"].entries()) {
      await reg.getByRole("button", { name: "+ Add player" }).click();
      await reg.getByLabel(`Player ${i + 1} name`).fill(name);
    }
    await reg.getByRole("checkbox", { name: /registering myself/i }).check();
    const pick = reg.getByLabel(/which player are you/i);
    await expect(pick).toBeVisible();
    await pick.selectOption({ label: "Ada Rahman" });
    await both(reg, "signed-in-team-roster-pick");

    const AxeBuilder = (await import("@axe-core/playwright")).default;
    const results = await new AxeBuilder({ page: reg }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
      "axe serious/critical on the public register form",
    ).toEqual([]);
  } finally {
    await regCtx.close();
  }
});
