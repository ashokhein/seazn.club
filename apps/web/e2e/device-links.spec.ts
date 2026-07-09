import { test, expect } from "@playwright/test";
import { apiJson, seedScoredDivision } from "./helpers";

// Courtside device-link scoring: an editor mints a one-per-fixture dl_ token;
// the token alone opens the score pad and authorises event writes. Pro-only.

const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";

test("device link opens the pad anonymously and authorises scoring", async ({
  request,
  browser,
  playwright,
}) => {
  const { fixtureIds } = await (async () => {
    const seeded = await seedScoredDivision(request, ["Echo", "Foxtrot"], { decide: false });
    const gen = await apiJson<{ fixtures: { id: string }[] }>(
      request,
      `/api/v1/stages/${seeded.stageId}/generate`,
      "POST",
    );
    return { fixtureIds: gen.data!.fixtures.map((f) => f.id) };
  })();
  const fixtureId = fixtureIds[0]!;

  const minted = await apiJson<{ id: string; secret: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}/device-links`,
    "POST",
    { label: "Court 1" },
  );
  expect(minted.status).toBe(201);
  const secret = minted.data!.secret;
  expect(secret.startsWith("dl_")).toBe(true);

  // A signed-out browser opens the pad from the token alone.
  const anonCtx = await browser.newContext();
  try {
    const page = await anonCtx.newPage();
    await page.goto(`/score/${secret}`);
    await expect(page.getByText(/Echo|Foxtrot/).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await anonCtx.close();
  }

  // The token is also the API credential for this fixture's events.
  const dlApi = await playwright.request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  try {
    const state = await dlApi.get(`/api/v1/fixtures/${fixtureId}/state`);
    expect(state.ok()).toBe(true);
    const lastSeq = ((await state.json()) as { data: { last_seq: number } }).data.last_seq;
    const event = await dlApi.post(`/api/v1/fixtures/${fixtureId}/events`, {
      data: { expected_seq: lastSeq, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
    });
    expect(event.ok()).toBe(true);
  } finally {
    await dlApi.dispose();
  }
});

test("device links are Pro-only", async ({ browser }) => {
  // Runs before journey-community (alphabetical), so the community org has
  // competition headroom — and the competition is archived afterwards so it
  // never counts against that journey's max_active assertions.
  const ctx = await browser.newContext({ storageState: "e2e/.auth/community.json" });
  try {
    const req = ctx.request;
    const comp = await apiJson<{ id: string }>(req, "/api/v1/competitions", "POST", {
      name: `DL Gate ${Date.now().toString(36)}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(
      req,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    await apiJson(req, `/api/v1/divisions/${div.data!.id}/entrants`, "POST", [
      { kind: "individual", display_name: "A", seed: 1 },
      { kind: "individual", display_name: "B", seed: 2 },
    ]);
    const stage = await apiJson<{ id: string }>(req, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    });
    const gen = await apiJson<{ fixtures: { id: string }[] }>(
      req,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );

    const minted = await apiJson(
      req,
      `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/device-links`,
      "POST",
      { label: "Court 1" },
    );
    expect(minted.status).toBe(402);
    expect(minted.error?.code).toBe("PAYMENT_REQUIRED");

    // Free the community org's active-competition slot for later specs.
    const archived = await apiJson(req, `/api/v1/competitions/${comp.data!.id}`, "PATCH", {
      status: "archived",
    });
    expect(archived.status).toBeLessThan(300);
  } finally {
    await ctx.close();
  }
});
