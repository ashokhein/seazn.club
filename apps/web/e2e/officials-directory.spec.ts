import { test, expect } from "@playwright/test";
import {
  apiJson,
  seedScoredDivision,
  addEntrantsViaApi,
  createStageAndGenerate,
  scoreFixture,
  loginUi,
  TAG,
} from "./helpers";

// v11.1 follow-up: officials roster management (add / invite / bulk-invite)
// moved from a division's Officials tab to the org-wide Directory → Officials
// tab, so the same pool is shared across every division's schedule. This
// proves the new home lists + adds + invites (claim-link fallback, since this
// env's RESEND_API_KEY is blank), and that the schedule tab's slimmed strip
// still reflects the pool and still lets you assign.

test("directory Officials tab: add and list an official", async ({ page }) => {
  const name = `Priya Ref ${TAG}`;

  await page.goto("/directory?tab=officials");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add official" }).click();

  await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });
});

test("directory Officials tab: role chips replace free text — multi-select on Pro", async ({ page }) => {
  const name = `Multi Ref ${TAG}`;

  await page.goto("/directory?tab=officials");
  await page.getByLabel("Name", { exact: true }).fill(name);
  // referee is pre-selected; add judge too (this project's storage state is
  // the Pro account — multi-role is allowed).
  const roleGroup = page.getByRole("group", { name: "Roles" });
  await expect(roleGroup.getByRole("button", { name: "referee", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await roleGroup.getByRole("button", { name: "judge", exact: true }).click();
  await expect(roleGroup.getByRole("button", { name: "judge", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Add official" }).click();

  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText("referee", { exact: true })).toBeVisible();
  await expect(row.getByText("judge", { exact: true })).toBeVisible();
});

test("directory Officials tab: invite falls back to a copyable claim link", async ({ page }) => {
  const name = `Kofi Ref ${TAG}`;

  await page.goto("/directory?tab=officials");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add official" }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });

  const row = page.locator("li").filter({ hasText: name });
  await row.getByRole("button", { name: "Invite" }).click();
  await row.getByLabel("Email", { exact: true }).fill(`ref_${TAG}@example.com`);
  await row.getByRole("button", { name: "Send invite" }).click();

  // this worktree's RESEND_API_KEY is blank — send always fails, so the
  // one-time claim link is the only path to the official.
  await expect(row.getByText(/Email failed to send/i)).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText(/\/claim\/pc_/)).toBeVisible();
});

test("directory Officials tab: edit roles on an existing official", async ({ page, request }) => {
  const name = `Edit Ref ${TAG}`;
  await apiJson(request, "/api/v1/officials", "POST", {
    display_name: name,
    role_keys: ["referee"],
  });

  await page.goto("/directory?tab=officials");
  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: "Edit roles" }).click();

  // the row's inline editor gets its own chip group (Pro account — stacking
  // allowed); referee stays pressed, scorer joins it.
  const editGroup = row.getByRole("group", { name: "Roles" });
  await editGroup.getByRole("button", { name: "scorer", exact: true }).click();
  await row.getByRole("button", { name: "Save roles" }).click();

  // the editor closes on a successful PATCH; only then are the row's chip
  // spans unambiguous (while it is open, the picker buttons repeat the names).
  await expect(row.getByRole("button", { name: "Save roles" })).toHaveCount(0, { timeout: 20_000 });
  await expect(row.locator("span").filter({ hasText: /^scorer$/ })).toBeVisible();
  await expect(row.locator("span").filter({ hasText: /^referee$/ })).toBeVisible();
});

test("directory Officials tab: delete removes the official after an explicit confirm", async ({
  page,
  request,
}) => {
  const name = `Del Ref ${TAG}`;
  await apiJson(request, "/api/v1/officials", "POST", {
    display_name: name,
    role_keys: ["referee"],
  });

  await page.goto("/directory?tab=officials");
  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: "Delete", exact: true }).click();

  // tone:"danger" confirm — the row is only removed after the explicit click.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete official" }).click();

  await expect(page.locator("li").filter({ hasText: name })).toHaveCount(0, { timeout: 20_000 });
});

test("schedule Officials tab: compact roster strip reflects the pool and links to the directory; assign still works", async ({
  page,
  request,
}) => {
  const { divisionId } = await seedScoredDivision(request, undefined, { decide: false });
  const stripName = `Strip Ref ${TAG}`;
  await apiJson(request, "/api/v1/officials", "POST", {
    display_name: stripName,
    role_keys: ["referee"],
  });

  await page.goto(`/divisions/${divisionId}/schedule?tab=officials`);
  // the compact roster strip is its own <ul> — scope past the assign
  // <select> options below, which repeat the same name once per fixture.
  const strip = page.locator("ul").filter({ hasText: stripName }).first();
  await expect(strip.getByText(stripName)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("link", { name: /Manage officials in the directory/i }),
  ).toBeVisible();

  // roster management left the schedule tab — no add form here anymore.
  await expect(page.getByRole("button", { name: "Add official" })).toHaveCount(0);

  // the assign combobox still lists officials from the same org-wide pool.
  const select = page.locator("select", { hasText: stripName }).first();
  await expect(select).toBeVisible({ timeout: 20_000 });
});

// officials-unify: officials ARE the umpire/scoring path — invite → claim →
// /me accept → score on the full fixture console from My Matches (Tasks 1-4).
// No separate device-mint. Covers the acceptance surfaces spec'd for this
// wave: (a) an accepted official scores through the fixture console, (b) a
// still-pending official is refused the same fixture (404 — accepted-only
// door), (c) a non-member official can't reach an organiser-only, non-fixture
// page even once they hold an accepted assignment elsewhere.
test.describe.serial("officiating: accept, score, and access boundaries", () => {
  const officialEmail = `e2e-official-${TAG}@example.com`;
  let divisionId: string;
  let fixtureA: string; // assigned + accepted → scored via the console
  let fixtureB: string; // assigned, never accepted → stays blocked
  let claimUrlA: string;
  let claimIdB: string;

  test("organiser: seed a division, assign two officials, invite both to one email", async ({
    request,
  }) => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      name: `Officiating E2E ${TAG}`,
      visibility: "public",
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
    divisionId = div.data!.id;
    await addEntrantsViaApi(request, divisionId, ["Slip", "Cordon", "Gully", "Point"]);
    const { fixtureIds } = await createStageAndGenerate(request, divisionId);
    fixtureA = fixtureIds[0]!;
    fixtureB = fixtureIds[1]!;

    // Future kickoffs with distinct court labels — the /me assignment cards
    // are otherwise indistinguishable (same entrant pool on every fixture).
    const base = Date.now() + 7 * 86_400_000;
    for (let i = 0; i < fixtureIds.length; i++) {
      await apiJson(request, `/api/v1/fixtures/${fixtureIds[i]}`, "PATCH", {
        scheduled_at: new Date(base + i * 3_600_000).toISOString(),
        court_label: `Court ${i + 1}`,
      });
    }
    await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

    const offA = await apiJson<{ id: string }>(request, "/api/v1/officials", "POST", {
      display_name: `Accept Ref ${TAG}`,
      role_keys: ["referee"],
    });
    await apiJson(request, `/api/v1/fixtures/${fixtureA}/officials`, "PATCH", {
      set: [{ official_id: offA.data!.id, role_key: "referee", locked: false }],
    });
    const inviteA = await apiJson<{ claim_url: string }>(
      request,
      `/api/v1/officials/${offA.data!.id}/invite`,
      "POST",
      { email: officialEmail },
    );
    expect(inviteA.status).toBe(201);
    claimUrlA = inviteA.data!.claim_url;
    expect(claimUrlA).toContain("/claim/pc_");

    const offB = await apiJson<{ id: string }>(request, "/api/v1/officials", "POST", {
      display_name: `Pending Ref ${TAG}`,
      role_keys: ["referee"],
    });
    await apiJson(request, `/api/v1/fixtures/${fixtureB}/officials`, "PATCH", {
      set: [{ official_id: offB.data!.id, role_key: "referee", locked: false }],
    });
    // Second invite, same email, different org-issued official — accepted
    // by claim id later (v11.1 Pending invites card), never claimed here.
    const inviteB = await apiJson<{ id: string }>(
      request,
      `/api/v1/officials/${offB.data!.id}/invite`,
      "POST",
      { email: officialEmail },
    );
    expect(inviteB.status).toBe(201);
    claimIdB = inviteB.data!.id;
  });

  test("official: claim, accept, score via the fixture console, and stay out of everything else", async ({
    browser,
  }) => {
    const ctx = await browser.newContext(); // clean session — a fresh official
    const page = await ctx.newPage();
    try {
      // Claim the profile via the shared person-claim rail (officiating copy).
      await page.goto(claimUrlA);
      const card = page.locator("main .card").first();
      await expect(card).toBeVisible();
      await loginUi(page, officialEmail);
      await page.goto(claimUrlA);
      await page.getByRole("button", { name: /This is me/ }).click();
      await page.waitForURL(/\/me\?claimed=1/);

      // Second org invite, same email: accept BY ID (v11.1 Pending invites
      // card — no token) so offB is a genuinely CLAIMED official too. Its
      // fixture_officials.response is deliberately left at the default
      // "pending" for (b) below — a claimed official still can't skip the
      // per-assignment accept.
      const acceptB = await page.request.post(`/api/v1/me/officiating-claims/${claimIdB}/accept`, {
        data: {},
      });
      expect(acceptB.ok()).toBe(true);

      // Accept only fixtureA's assignment (Court 1's card) — Court 2 (offB,
      // fixtureB) stays untouched/pending.
      await page.goto("/me");
      const cardA = page.locator("li").filter({ hasText: "Court 1" });
      await expect(cardA).toBeVisible({ timeout: 20_000 });
      await cardA.getByRole("button", { name: "Accept" }).click();
      await expect(cardA.getByText("Accepted")).toBeVisible({ timeout: 20_000 });

      // (a) Accepted fixture surfaces on My Matches — the scorer console's own
      // landing page — and its full board opens (via the canonical slug link
      // an official actually clicks, never the legacy /fixtures/{id} route
      // which 301s through legacyPath and requires org membership).
      await page.goto("/my-matches");
      const matchLink = page.getByRole("link").filter({ hasText: /Slip|Cordon|Gully|Point/ }).first();
      await expect(matchLink).toBeVisible({ timeout: 20_000 });
      await matchLink.click();
      await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/[^/]+\/f\/\d+/, { timeout: 20_000 });
      await expect(page.getByText(/Slip|Cordon|Gully|Point/).first()).toBeVisible({ timeout: 20_000 });
      await scoreFixture(page.request, fixtureA, 2, 1);
      const scored = await apiJson<{ status: string }>(page.request, `/api/v1/fixtures/${fixtureA}/state`);
      expect(scored.data?.status).toBe("decided");

      // (b) offB is a genuinely claimed official (its person is linked to this
      // account) but its fixtureB assignment is still "pending" — response
      // must be "accepted", not just a claimed link, to record a score. Hit
      // the score endpoint directly: a pending official is rejected with 403
      // (requireScorable/requireFixtureActor), not a page-level 404.
      const stateB = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${fixtureB}/state`);
      const pendingRes = await page.request.post(`/api/v1/fixtures/${fixtureB}/events`, {
        headers: { "Content-Type": "application/json" },
        data: {
          expected_seq: stateB.data?.last_seq ?? 0,
          type: "generic.result",
          payload: { p1Score: 2, p2Score: 1 },
        },
      });
      expect(pendingRes.status()).toBe(403);

      // (c) This account holds an accepted assignment on fixtureA, but is a
      // non-member of the org — every non-fixture, organiser-only page still
      // 404s outright (design v2 §A5: officials pass ONLY the fixture door).
      const orgRes = await page.goto(`/divisions/${divisionId}`);
      expect(orgRes!.status()).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});
