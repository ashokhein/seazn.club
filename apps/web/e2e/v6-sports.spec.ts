import { test, expect, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, TAG } from "./helpers";

// design/v6 (PROMPT-48..50): tennis on the nested kernel, ice/field hockey on
// the period kernel — pads, phase machine, suspensions/strength, shootouts,
// and the public surfaces (scorebug chip, goals-by-period, discipline).

async function makeDivision(
  request: APIRequestContext,
  opts: { comp: string; sport: string; variant: string; entrants: string[]; kind?: "individual" | "team"; visibility?: string },
): Promise<{ divisionId: string; fixtureId: string; stageId: string; entrantIds: string[]; compId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: opts.comp,
    visibility: opts.visibility ?? "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: opts.sport, sport_key: opts.sport, variant_key: opts.variant, config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const { ids } = await addEntrantsViaApi(request, divisionId, opts.entrants, opts.kind ?? "individual");
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  return { divisionId, fixtureId: fixtureIds[0]!, stageId, entrantIds: ids, compId: comp.data!.id };
}

async function sendEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  // A pad click in the open page can land between our seq read and the
  // append — retry the optimistic-concurrency 409 with a fresh seq.
  for (let attempt = 0; ; attempt++) {
    const state = await apiJson<{ last_seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/state`,
    );
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type,
      payload,
    });
    if (res.status === 201) return;
    if (res.status === 409 && attempt < 3) continue;
    throw new Error(`event ${type} → ${res.status}`);
  }
}

test("tennis: device-width pad speaks the score, banks a tie-break set, undo restores the point", async ({
  page,
  request,
}) => {
  const { fixtureId, entrantIds } = await makeDivision(request, {
    comp: `Tennis rally ${TAG}`,
    sport: "tennis",
    variant: "tour",
    entrants: ["Rune", "Sasha"],
  });
  const [rune, sasha] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/fixtures/${fixtureId}`);

  // One tap per point; the pad speaks 15 then 30.
  await page.getByRole("button", { name: /Rune/ }).click({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Rune/ })).toContainText("15", { timeout: 20_000 });
  await page.getByRole("button", { name: /Rune/ }).click();
  await expect(page.getByRole("button", { name: /Rune/ })).toContainText("30");

  // Drive to 6–6 via the ledger (games alternate), then the TB to 7–0.
  const game = async (by: string) => {
    for (let i = 0; i < 4; i++) await sendEvent(request, fixtureId, "tennis.point", { by });
  };
  // Rune sits at 30-0: two more points close game 1.
  await sendEvent(request, fixtureId, "tennis.point", { by: rune });
  await sendEvent(request, fixtureId, "tennis.point", { by: rune });
  for (let i = 0; i < 5; i++) await game(sasha);
  for (let i = 0; i < 5; i++) await game(rune);
  await game(sasha); // 6–6 → tie-break
  await page.reload();
  await expect(page.getByText(/tie-break/i).first()).toBeVisible({ timeout: 20_000 });
  for (let i = 0; i < 7; i++) await sendEvent(request, fixtureId, "tennis.point", { by: rune });
  await page.reload();
  // Set strip shows the 7–6(0) form.
  await expect(page.getByText("7–6(0)").first()).toBeVisible({ timeout: 20_000 });

  // Undo restores the live point: score one, undo, the tally is unchanged.
  await page.getByRole("button", { name: /Rune/ }).click();
  await expect(page.getByRole("button", { name: /Rune/ })).toContainText("15");
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(page.getByRole("button", { name: /Rune/ })).toContainText("0", { timeout: 20_000 });
});

test("tennis: console set-totals entry needs tie-break points for a 7–6 set", async ({
  page,
  request,
}) => {
  const { fixtureId } = await makeDivision(request, {
    comp: `Tennis totals ${TAG}`,
    sport: "tennis",
    variant: "tour",
    entrants: ["Mira", "Tess"],
  });
  await sendEvent(request, fixtureId, "core.start", {});
  await page.goto(`/fixtures/${fixtureId}`);
  await page.getByRole("button", { name: /Set totals/ }).click({ timeout: 20_000 });
  await expect(async () => {
    await page.getByLabel(/Mira games/).fill("7");
    await page.getByLabel(/Tess games/).fill("6");
    await page.getByPlaceholder("Mira").fill("7");
    await page.getByPlaceholder("Tess").fill("5");
    await expect(page.getByRole("button", { name: /Record set/ })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: /Record set/ }).click();
  await expect(page.getByText("1 — 0 · 7–6(5)")).toBeVisible({ timeout: 20_000 });
});

test("icehockey: penalties drive the strength chip (5v4 → 5v3 → release), OT goal decides", async ({
  page,
  request,
}) => {
  const { fixtureId, entrantIds } = await makeDivision(request, {
    comp: `Ice pad ${TAG}`,
    sport: "icehockey",
    variant: "iihf",
    entrants: ["Bears", "Kings"],
    kind: "team",
  });
  const [bears, kings] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});
  await page.goto(`/fixtures/${fixtureId}`);

  // Penalty flow on the pad: Kings minor → 5v4.
  const kingsPad = page.locator("div.rounded-xl", { hasText: "Kings" }).last();
  await kingsPad.getByRole("button", { name: /Penalty \/ card/ }).click({ timeout: 20_000 });
  await kingsPad.getByLabel("Class").selectOption("minor");
  await kingsPad.getByRole("button", { name: /^Record$/ }).click();
  await expect(page.getByText("5v4").first()).toBeVisible({ timeout: 20_000 });

  // Second minor → 5v3; releasing one → back to 5v4. API-side events don't
  // stream into the console — reload to pick them up.
  await sendEvent(request, fixtureId, "icehockey.suspension.start", { by: kings, class: "minor" });
  await page.reload();
  await expect(page.getByText("5v3").first()).toBeVisible({ timeout: 20_000 });
  // A click straight after reload can land pre-hydration — retry until the
  // release actually takes (same pattern as the repo's re-fill loops).
  await expect(async () => {
    await page.getByRole("button", { name: /Release/ }).first().click();
    await expect(page.getByText("5v4").first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // Quick goal + period advances into sudden-death OT; the OT goal ends it.
  const bearsPad = page.locator("div.rounded-xl", { hasText: "Bears" }).first();
  await bearsPad.getByRole("button", { name: "+ Goal" }).click();
  await sendEvent(request, fixtureId, "icehockey.goal", { by: kings });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P2" });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P3" });
  await page.reload();
  await expect(page.getByRole("button", { name: /End P3/ })).toBeVisible({ timeout: 20_000 });

  // axe on the pad region (PROMPT-50): goal / penalty / release controls are
  // labelled and operable. Scoped to the pad — the wider console carries
  // pre-existing contrast debt outside this wave.
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="score-pad"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious).toEqual([]);

  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "FT" });
  await sendEvent(request, fixtureId, "icehockey.goal", { by: bears });
  const state = await apiJson<{ status: string; summary: { headline: string } }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(state.data!.status).toBe("decided");
  expect(state.data!.summary.headline).toContain("(OT)");
});

test("icehockey: GWS recorder alternates attempts and decides", async ({ page, request }) => {
  const { fixtureId, entrantIds } = await makeDivision(request, {
    comp: `Ice GWS ${TAG}`,
    sport: "icehockey",
    variant: "iihf",
    entrants: ["Aces", "Blades"],
    kind: "team",
  });
  const [aces] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});
  for (const to of ["P2", "P3", "FT", "FT"]) {
    await sendEvent(request, fixtureId, "icehockey.period.advance", { to });
  }
  await page.goto(`/fixtures/${fixtureId}`);
  await expect(page.getByText(/Shoot-out — record each attempt/)).toBeVisible({ timeout: 20_000 });

  // First attempt by Aces; the recorder then expects Blades (Aces disabled).
  const scored = (team: string) =>
    page
      .locator("span", { hasText: `${team}:` })
      .getByRole("button", { name: /scored/ });
  await scored("Aces").click();
  await expect(scored("Aces")).toBeDisabled({ timeout: 20_000 });
  // Drive the rest through the ledger: Blades miss ×3, Aces score ×2 more.
  const [, blades] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: blades, scored: false });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: aces, scored: true });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: blades, scored: false });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: aces, scored: true });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: blades, scored: false });
  const state = await apiJson<{ status: string; summary: { headline: string } }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(state.data!.status).toBe("decided");
  expect(state.data!.summary.headline).toContain("GWS 3–0");
});

test("hockey (FIH): quarters, team-short chip, escalation hint, draw stands in standings", async ({
  page,
  request,
}) => {
  // Team entrants with real persons so the pad's person picker can select
  // the carded player (escalation hint keys off the person).
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `FIH ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "hockey", sport_key: "hockey", variant_key: "fih-outdoor", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const p1 = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
    full_name: `Card Magnet ${TAG}`,
    consent: {},
  });
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      { kind: "team", display_name: "Falcons", seed: 1 },
      {
        kind: "team",
        display_name: "Herons",
        seed: 2,
        members: [{ person_id: p1.data!.id, is_captain: false, roles: [] }],
      },
    ],
  );
  const [falcons, herons] = entrants.data!.map((e) => e.id) as [string, string];
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "league",
    name: "League",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  await sendEvent(request, fixtureId, "core.start", {});

  // Green card on the named Heron: the team plays short — 11v10.
  await sendEvent(request, fixtureId, "hockey.suspension.start", {
    by: herons,
    person: p1.data!.id,
    class: "green",
  });
  await page.goto(`/fixtures/${fixtureId}`);
  await expect(page.getByText("11v10").first()).toBeVisible({ timeout: 20_000 });

  // Picking the same player for the next card surfaces the escalation hint.
  const heronsPad = page.locator("div.rounded-xl", { hasText: "Herons" }).last();
  await heronsPad.getByRole("button", { name: /Penalty \/ card/ }).click();
  await heronsPad.getByLabel(/Player/).selectOption(p1.data!.id);
  await expect(page.getByText(/Prior green card this match/)).toBeVisible({ timeout: 20_000 });

  // Quarters advance Q1→Q4; a level game at FT is a draw worth 1/1.
  await sendEvent(request, fixtureId, "hockey.suspension.end", { by: herons, class: "green" });
  await sendEvent(request, fixtureId, "hockey.goal", { by: falcons, kind: "pc" });
  await sendEvent(request, fixtureId, "hockey.goal", { by: herons });
  await sendEvent(request, fixtureId, "hockey.period.advance", { to: "Q2" });
  await page.reload();
  await expect(page.getByRole("button", { name: /End Q2/ })).toBeVisible({ timeout: 20_000 });
  for (const to of ["Q3", "Q4", "FT"]) {
    await sendEvent(request, fixtureId, "hockey.period.advance", { to });
  }
  const standings = await apiJson<{ rows: { entrantId: string; points: number; drawn: number }[] }>(
    request,
    `/api/v1/stages/${stageId}/standings`,
  );
  const rows = standings.data!.rows;
  expect(rows.find((r) => r.entrantId === falcons)?.points).toBe(1);
  expect(rows.find((r) => r.entrantId === herons)?.drawn).toBe(1);
});

test("public fixture page: phase + strength chip live, goals-by-period + discipline when decided", async ({
  page,
  request,
}) => {
  const { fixtureId, entrantIds, compId } = await makeDivision(request, {
    comp: `Ice public ${TAG}`,
    sport: "icehockey",
    variant: "iihf",
    entrants: ["Orcas", "Wolves"],
    kind: "team",
    visibility: "public",
  });
  const [orcas, wolves] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});
  await sendEvent(request, fixtureId, "icehockey.goal", { by: orcas });
  await sendEvent(request, fixtureId, "icehockey.suspension.start", { by: wolves, class: "minor" });

  const org = await activeOrg(page);
  const comp = await apiJson<{ slug: string; divisions: { slug: string }[] }>(
    request,
    `/api/v1/competitions/${compId}`,
  );
  const compSlug = comp.data!.slug;
  const divList = await apiJson<{ items?: { slug: string }[] } | { slug: string }[]>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
  );
  const divisions = Array.isArray(divList.data)
    ? divList.data
    : (divList.data as { items?: { slug: string }[] }).items ?? [];
  const divSlug = divisions[0]!.slug;
  const publicPath = `/shared/${org.slug}/${compSlug}/${divSlug}/fixtures/${fixtureId}`;

  await page.goto(publicPath);
  await expect(page.getByText("1 — 0 · P1")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("5v4")).toBeVisible();

  // Decide it and check the period table + discipline list render.
  await sendEvent(request, fixtureId, "icehockey.suspension.end", { by: wolves, class: "minor" });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P2" });
  await sendEvent(request, fixtureId, "icehockey.goal", { by: wolves });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P3" });
  await sendEvent(request, fixtureId, "icehockey.goal", { by: orcas });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "FT" });
  await page.goto(publicPath);
  await expect(page.getByText("Goals by period")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Discipline")).toBeVisible();
  await expect(page.getByText("Minor")).toBeVisible();
});
