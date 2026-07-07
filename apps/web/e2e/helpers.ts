import type { APIRequestContext, Page } from "@playwright/test";

// Shared test tag so parallel/rerun state never collides.
export const TAG = Date.now().toString(36);
export const PASSWORD = "e2epass123";
export const proEmail = () => `e2e-pro-${TAG}@example.com`;

// Thin JSON helpers over the app's own endpoints — used to set up heavy state
// (scoring, entrants) fast so specs assert on UI, not on data entry speed.
export async function apiJson<T = unknown>(
  request: APIRequestContext,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<{ status: number; data?: T; error?: { code?: string; message?: string } }> {
  const res = await request.fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { data: body } : {}),
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    data?: T;
    error?: { code?: string; message?: string };
  };
  return { status: res.status(), data: json.data, error: json.error };
}

/** UI login on a fresh page (used by specs that need their own context). */
export async function loginUi(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator("form").getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

/** Create a scored generic-league division via the API and return ids. */
export async function seedScoredDivision(
  request: APIRequestContext,
  names: string[] = ["A", "B", "C", "D"],
): Promise<{ competitionId: string; divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `E2E ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  const competitionId = comp.data!.id;
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const stageId = stage.data!.id;
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stageId}/generate`,
    "POST",
  );
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  for (const f of gen.data!.fixtures) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
    await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  }
  void entrants;
  return { competitionId, divisionId, stageId };
}
