import { test, expect, type Page } from "@playwright/test";
import { TAG, apiJson, activeOrg, loginUi } from "./helpers";

// PROMPT-53 acceptance: invite → claim → RSVP on /me → organiser sees the
// chip in the lineup picker → QR self-check-in marks presence. Consent flip
// by the player revalidates the public card immediately; unclaimed persons
// stay invisible everywhere; a second claim attempt fails clean.
//
// Serial: creates a player user (magic-link budget) and leans on the shared
// Pro org.

const playerEmail = `e2e-player-${TAG}@example.com`;

interface Person {
  id: string;
  full_name: string;
  user_id: string | null;
}
interface MyFixtureOut {
  id: string;
  fixture_no: number;
  availability: { status: string; note: string | null } | null;
  checked_in_at: string | null;
}

test.describe("player accounts (PROMPT-53)", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  let orgSlug: string;
  let compSlug: string;
  let divSlug: string;
  let compId: string;
  let divisionId: string;
  let ada: Person; // claimed by the player
  let ben: Person; // stays unclaimed — the regression control
  let claimUrl: string;
  let playerPage: Page;

  test.beforeAll(async ({ browser }) => {
    playerPage = await (await browser.newContext()).newPage();
  });
  test.afterAll(async () => {
    await playerPage.context().close();
  });

  test("organiser: roster persons, generate fixtures, invite Ada to claim", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    orgSlug = org.slug;

    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Players ${TAG}`,
      visibility: "public",
    });
    compId = comp.data!.id;
    compSlug = comp.data!.slug;
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    divisionId = div.data!.id;
    divSlug = div.data!.slug;

    const mk = async (name: string) =>
      (
        await apiJson<Person>(request, "/api/v1/persons", "POST", {
          full_name: `${name} ${TAG}`,
          consent: {},
        })
      ).data!;
    ada = await mk("Ada");
    ben = await mk("Ben");

    await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "individual", display_name: ada.full_name, seed: 1, members: [{ person_id: ada.id }] },
      { kind: "individual", display_name: ben.full_name, seed: 2, members: [{ person_id: ben.id }] },
    ]);
    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
      "POST",
      { seq: 1, kind: "league", name: "League" },
    );
    await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

    // Invite Ada — the claim_url embeds the one-time secret (e2e token trick).
    const invite = await apiJson<{ claim_url: string }>(
      request,
      `/api/v1/persons/${ada.id}/claim-invites`,
      "POST",
      { email: playerEmail },
    );
    expect(invite.status).toBe(201);
    claimUrl = invite.data!.claim_url;
    expect(claimUrl).toContain("/claim/pc_");
  });

  test("player: claim via magic link and land on /me", async () => {
    // Logged out, the auth card must sit centred in the night-stage column
    // (regression: the max-w-sm card sat left-aligned inside the max-w-md
    // claim column until it got mx-auto).
    await playerPage.goto(claimUrl);
    const card = playerPage.locator("main .card").first();
    await expect(card).toBeVisible();
    const cardBox = (await card.boundingBox())!;
    const viewport = playerPage.viewportSize()!;
    expect(Math.abs(cardBox.x + cardBox.width / 2 - viewport.width / 2)).toBeLessThan(3);

    await loginUi(playerPage, playerEmail);
    await playerPage.goto(claimUrl);
    await playerPage.getByRole("button", { name: /This is me/ }).click();
    await playerPage.waitForURL(/\/me\?claimed=1/);
    await expect(playerPage.getByText("Profile claimed")).toBeVisible();
    // The claimed fixture list shows the league match against Ben.
    await expect(playerPage.getByText(ben.full_name).first()).toBeVisible();
  });

  test("player: RSVP Out with a note from the /me hero", async () => {
    await playerPage.goto("/me");
    // Hero = next match; Ada has exactly one fixture (vs Ben). exact: true —
    // substring matching would hit the header's "Sign out" button.
    await playerPage.getByRole("button", { name: "Out", exact: true }).first().click();
    await expect(playerPage.getByText("Saved").first()).toBeVisible();
    const note = playerPage
      .getByPlaceholder("Add a note for the organiser (optional)")
      .first();
    await note.fill("away that weekend");
    await note.blur();
    await expect(playerPage.getByText("Saved").first()).toBeVisible();

    const mine = await apiJson<{ upcoming: MyFixtureOut[] }>(
      playerPage.request,
      "/api/v1/me/fixtures",
    );
    const rsvpd = mine.data!.upcoming.find((f) => f.availability?.status === "out");
    expect(rsvpd, "RSVP persisted to the API read").toBeTruthy();
    expect(rsvpd!.availability!.note).toBe("away that weekend");
  });

  test("organiser: lineup picker shows Ada's ✗ chip and Ben's — chip", async ({
    page,
    request,
  }) => {
    const mine = await apiJson<{ upcoming: MyFixtureOut[] }>(playerPage.request, "/api/v1/me/fixtures");
    const fixture = mine.data!.upcoming[0]!;
    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/${fixture.fixture_no}`);

    // Ada RSVP'd out → ✗ with the note as tooltip; Ben never claimed → "—".
    const adaChip = page.getByLabel(`${ada.full_name}: unavailable — away that weekend`);
    await expect(adaChip.first()).toBeVisible({ timeout: 20_000 });
    const benChip = page.getByLabel(`${ben.full_name}: no availability answer`);
    await expect(benChip.first()).toBeVisible();

    // Mint the check-in QR from the console (editor session).
    const link = await apiJson<{ url: string }>(
      request,
      `/api/v1/fixtures/${fixture.id}/checkin-link`,
      "POST",
    );
    expect(link.status).toBe(201);
    process.env.E2E_CHECKIN_URL = link.data!.url;
  });

  test("player: QR check-in marks presence; organiser sees the venue dot", async ({ page }) => {
    await playerPage.goto(process.env.E2E_CHECKIN_URL!);
    await playerPage.getByRole("button", { name: /check in/i }).click();
    await expect(playerPage.getByTestId("checkin-done")).toBeVisible();

    const mine = await apiJson<{ upcoming: MyFixtureOut[] }>(playerPage.request, "/api/v1/me/fixtures");
    const fixture = mine.data!.upcoming[0]!;
    expect(fixture.checked_in_at).toBeTruthy();
    // Check-in never clobbers an explicit RSVP: Ada stays "out".
    expect(fixture.availability?.status).toBe("out");

    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/${fixture.fixture_no}`);
    await expect(
      page.getByLabel(`${ada.full_name}: checked in at the venue`).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("second claim fails clean: 409 re-invite, dead link, unclaimed regression", async ({
    request,
  }) => {
    // Re-inviting a claimed person is a clean 409.
    const again = await apiJson(request, `/api/v1/persons/${ada.id}/claim-invites`, "POST", {
      email: "someone-else@example.com",
    });
    expect(again.status).toBe(409);
    expect(again.error?.message).toContain("already claimed");

    // The used link is a dead end with its own copy, not a crash.
    await playerPage.goto(claimUrl);
    await expect(playerPage.getByText("Already claimed")).toBeVisible();

    // Ben (unclaimed) is untouched by all of the above.
    const persons = await apiJson<Person[]>(request, "/api/v1/persons?limit=200");
    const benRow = persons.data && "items" in (persons.data as object)
      ? (persons.data as unknown as { items: Person[] }).items.find((p) => p.id === ben.id)
      : undefined;
    expect(benRow?.user_id ?? null).toBeNull();
  });

  test("consent flip by the player revalidates the public card; unclaimed stays 404", async ({
    request,
  }) => {
    const cardUrl = (personId: string) =>
      `/shared/${orgSlug}/${compSlug}/players/${personId}`;

    // Before consent: both cards 404 (public_players_v is consent-gated).
    expect((await request.get(cardUrl(ada.id))).status()).toBe(404);
    expect((await request.get(cardUrl(ben.id))).status()).toBe(404);

    // Player flips public_name ON from /me.
    await playerPage.goto("/me");
    await playerPage.getByLabel("Show my name publicly").check();
    await expect
      .poll(async () => (await request.get(cardUrl(ada.id))).status(), {
        message: "public card appears after consent ON",
        timeout: 15_000,
      })
      .toBe(200);
    const body = await (await request.get(cardUrl(ada.id))).text();
    expect(body).toContain(ada.full_name);

    // …and OFF again: the card disappears just as fast.
    await playerPage.getByLabel("Show my name publicly").uncheck();
    await expect
      .poll(async () => (await request.get(cardUrl(ada.id))).status(), {
        message: "public card disappears after consent OFF",
        timeout: 15_000,
      })
      .toBe(404);

    // The unclaimed control never appeared at any point.
    expect((await request.get(cardUrl(ben.id))).status()).toBe(404);
  });
});
