import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  loginUi,
  setOrgPlanBySql,
  setFixtureStatusSql,
  invalidateOrgEntitlements,
  expectNoHorizontalScroll,
} from "./helpers";

// SPEC-3 marks & reports (PROMPT-81). On the shared Pro org: an organiser rates
// an accepted official once the fixture is decided (five scoreboard-digit tiles
// → the profile summary badge), and the claimed official files a match report
// with a red-card incident from their /me home → the misconduct bridge raises a
// pending suspension that the discipline panel tags "From match report".
// Serial: the second test files the report the first test's fixture set up
// (mind the mobile project's concurrency).
test.describe.serial("official marks & match reports", () => {
  let orgSlug: string;
  let compSlug: string;
  let divSlug: string;
  let fixtureNo: number;
  let officialName: string;
  let playerName: string;
  let playerId: string;
  let officialCtx: BrowserContext;
  let officialPage: Page;

  test.afterAll(async () => {
    await officialCtx?.close();
  });

  test("organiser rates an accepted, decided official; the profile summary updates", async ({
    page,
    browser,
  }) => {
    const org = await activeOrg(page);
    orgSlug = org.slug;
    await setOrgPlanBySql({ orgId: org.id }, "pro"); // marks + discipline.enforced
    await invalidateOrgEntitlements(page.request, org.id);

    const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `Marks E2E ${TAG}`,
      visibility: "public",
    });
    compSlug = comp.data!.slug;
    // Football → the sport has a discipline model, so the Discipline tab renders.
    const div = await apiJson<{ id: string; slug: string }>(
      page.request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      { name: "Prem", sport_key: "football", variant_key: "11-a-side" },
    );
    const divId = div.data!.id;
    divSlug = div.data!.slug;

    // Enable discipline so the panel (and the report bridge tag) renders.
    await apiJson(page.request, `/api/v1/divisions/${divId}/discipline-rules`, "PUT", {
      enabled: true,
      rules: { accumulation: [], dismissal: [{ key: "red", color: "red", ban_matches: 1 }] },
    });

    playerName = `Sent Off ${TAG}`;
    const player = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
      full_name: playerName,
      consent: { public_name: true },
    });
    playerId = player.data!.id;
    await apiJson(page.request, `/api/v1/divisions/${divId}/entrants`, "POST", [
      { kind: "team", display_name: `Rovers ${TAG}`, seed: 1, members: [{ person_id: playerId }] },
      { kind: "team", display_name: `City ${TAG}`, seed: 2 },
    ]);
    const stage = await apiJson<{ id: string }>(page.request, `/api/v1/divisions/${divId}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    });
    const gen = await apiJson<{ fixtures: { id: string; fixture_no: number }[] }>(
      page.request,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );
    const fixture = gen.data!.fixtures[0]!;
    fixtureNo = fixture.fixture_no;
    await apiJson(page.request, `/api/v1/divisions/${divId}/start`, "POST");

    // An official assigned to the fixture; invited through the shared claim rail.
    officialName = `Mark Ref ${TAG}`;
    const off = await apiJson<{ id: string }>(page.request, "/api/v1/officials", "POST", {
      display_name: officialName,
      role_keys: ["referee"],
    });
    await apiJson(page.request, `/api/v1/fixtures/${fixture.id}/officials`, "PATCH", {
      set: [{ official_id: off.data!.id, role_key: "referee", locked: false }],
    });
    const officialEmail = `e2e-official-${TAG}@example.com`;
    const invite = await apiJson<{ claim_url: string }>(
      page.request,
      `/api/v1/officials/${off.data!.id}/invite`,
      "POST",
      { email: officialEmail },
    );
    const token = invite.data!.claim_url.split("/claim/")[1]!;

    // Second user (the official) — own context, magic-link login, claims + accepts.
    officialCtx = await browser.newContext();
    officialPage = await officialCtx.newPage();
    await loginUi(officialPage, officialEmail);
    const claimed = await apiJson(officialPage.request, `/api/claims/${token}/accept`, "POST");
    expect(claimed.status).toBe(200);
    const acc = await apiJson(
      officialPage.request,
      `/api/v1/me/assigned-fixtures/${fixture.id}/response`,
      "PATCH",
      { response: "accepted" },
    );
    expect(acc.status).toBe(200);

    // The fixture is decided (the mark + report window). SQL flip skips the
    // sport-specific full-time scoring dance — the windows only read status.
    await setFixtureStatusSql(fixture.id, "decided");

    // Rate: the schedule Officials tab now carries the Rate-officials section.
    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}/schedule?tab=officials`);
    const rate = page.getByTestId("rate-officials");
    await expect(rate).toBeVisible();
    await expectNoHorizontalScroll(page);
    const tile = rate.getByRole("button", { name: "Rate 4 out of 5" });
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");

    // Persists: a reload prefills the lit tile from the saved mark.
    await page.reload();
    await expect(
      page.getByTestId("rate-officials").getByRole("button", { name: "Rate 4 out of 5" }),
    ).toHaveAttribute("aria-pressed", "true");

    // The org official profile (Directory → Officials → Marks) shows the badge.
    await page.goto("/directory?tab=officials");
    const row = page.locator("li").filter({ hasText: officialName }).first();
    await row.getByRole("button", { name: "Marks" }).click();
    await expect(page.getByTestId("mark-badge")).toBeVisible();
    await expect(page.getByTestId("mark-badge")).toContainText("4.0");
  });

  test("the claimed official files a red-card report → a tagged pending suspension appears", async ({
    page,
  }) => {
    // Official files the report on /me.
    await officialPage.goto("/me");
    await expectNoHorizontalScroll(officialPage);
    await officialPage.locator("summary").filter({ hasText: /completed/i }).click();
    await officialPage.getByRole("button", { name: /file match report/i }).click();
    const form = officialPage.getByTestId("report-form");
    await expect(form).toBeVisible();

    await form.getByLabel("What happened").fill("Tense derby, one sending-off.");
    await form.getByRole("button", { name: /add incident/i }).click();
    const incident = form.getByTestId("incident-row").first();
    await incident.getByLabel("Kind").selectOption({ label: "Red card" });
    await incident.getByLabel("Player (optional)").selectOption(playerId);
    await incident.getByLabel("Note").fill("violent conduct in the 88th");
    // blur triggers the draft autosave
    await incident.getByLabel("Note").blur();

    await form.getByRole("button", { name: "Submit report" }).click();
    await expect(officialPage.getByText(/you can't edit it after/i)).toBeVisible();
    await officialPage.getByRole("button", { name: "Submit report" }).click();
    await expect(officialPage.getByTestId("report-submitted")).toBeVisible();

    // Organiser: the discipline panel tags the report-sourced pending row.
    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}?tab=discipline`);
    await expect(page.getByTestId("discipline-panel")).toBeVisible();
    await expect(page.getByTestId("pending-row").filter({ hasText: playerName })).toBeVisible();
    await expect(page.getByText("From match report")).toBeVisible();
  });
});
