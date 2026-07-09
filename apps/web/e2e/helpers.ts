import { expect, type APIRequestContext, type Page } from "@playwright/test";

// Shared test tag so parallel/rerun state never collides.
export const TAG = Date.now().toString(36);
export const proEmail = () => `e2e-pro-${TAG}@example.com`;
export const communityEmail = () => `e2e-community-${TAG}@example.com`;

// Thin JSON helpers over the app's own endpoints — used to set up heavy state
// (scoring, entrants) fast so specs assert on UI, not on data entry speed.
export async function apiJson<T = unknown>(
  request: APIRequestContext,
  path: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
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

/**
 * Passwordless UI login on a fresh page (specs that need their own context).
 * Requests a magic link and opens the dev-exposed URL to establish the session;
 * an unknown email auto-creates the account.
 */
export async function loginUi(page: Page, email: string): Promise<void> {
  const res = await page.request.post("/api/auth/magic-link", { data: { email } });
  const loginUrl = ((await res.json()) as { data?: { login_url?: string } }).data?.login_url;
  if (!loginUrl) throw new Error("magic-link login_url missing — dev server required");
  await page.goto(loginUrl);
  await page.waitForURL(
    (u) => !u.pathname.startsWith("/login") && !u.pathname.startsWith("/magic-link"),
    { timeout: 20_000 },
  );
}

/** One-shot SQL client against the app's schema (DATABASE_URL must point at
 *  the same DB the dev server under test uses). */
async function withDb<T>(
  fn: (sql: import("postgres").Sql) => Promise<T>,
): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    // The app lives in a dedicated schema — unqualified table names resolve
    // only when the search_path points there.
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Set an org's plan directly in the DB (same trick auth.setup.ts uses for the
 * Pro account). Targets by org id or by owner email.
 */
export async function setOrgPlanBySql(
  target: { orgId?: string; email?: string },
  plan: "pro" | "community",
): Promise<void> {
  await withDb(async (sql) => {
    if (target.orgId) {
      await sql`
        insert into subscriptions (org_id, plan_key, status)
        values (${target.orgId}, ${plan}, 'active')
        on conflict (org_id) do update set plan_key = ${plan}, status = 'active'`;
    } else if (target.email) {
      await sql`
        with org as (
          select m.org_id from org_members m join users u on u.id = m.user_id
          where u.email = ${target.email} limit 1)
        insert into subscriptions (org_id, plan_key, status)
        select org_id, ${plan}, 'active' from org
        on conflict (org_id) do update set plan_key = ${plan}, status = 'active'`;
    } else {
      throw new Error("setOrgPlanBySql: pass orgId or email");
    }
  });
}

/** Force a subscription lifecycle state (trialing / past_due / …) for banner
 *  and CTA assertions — states Stripe would otherwise own. */
export async function setOrgSubscriptionSql(
  orgId: string,
  fields: { plan_key: string; status: string; trial_end?: string | null },
): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      insert into subscriptions (org_id, plan_key, status, trial_end)
      values (${orgId}, ${fields.plan_key}, ${fields.status}, ${fields.trial_end ?? null})
      on conflict (org_id) do update
        set plan_key = ${fields.plan_key}, status = ${fields.status},
            trial_end = ${fields.trial_end ?? null}`;
  });
}

export interface OrgInfo {
  id: string;
  slug: string;
  name: string;
  role: string;
}

/** The signed-in user's active org (id from the seazn_org cookie, joined with
 *  the membership list for slug/name — needed to build public /shared URLs). */
export async function activeOrg(page: Page): Promise<OrgInfo> {
  const { data: orgs } = await apiJson<OrgInfo[]>(page.request, "/api/orgs");
  if (!orgs?.length) throw new Error("no org memberships for the current user");
  const cookies = await page.context().cookies();
  const activeId = cookies.find((c) => c.name === "seazn_org")?.value;
  return orgs.find((o) => o.id === activeId) ?? orgs[0]!;
}

/** Bulk-add ad-hoc entrants through the API (same shape seedScoredDivision uses). */
export async function addEntrantsViaApi(
  request: APIRequestContext,
  divisionId: string,
  names: string[],
  kind: "individual" | "team" | "pair" = "individual",
  seedOffset = 0,
): Promise<{ status: number; ids: string[] }> {
  const res = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((n, i) => ({ kind, display_name: n, seed: seedOffset + i + 1 })),
  );
  return { status: res.status, ids: (res.data ?? []).map((e) => e.id) };
}

/** Create a stage and generate its fixtures; returns stage + fixture ids. */
export async function createStageAndGenerate(
  request: APIRequestContext,
  divisionId: string,
  stage: { kind: string; name: string; config?: Record<string, unknown> } = {
    kind: "league",
    name: "League",
  },
): Promise<{ stageId: string; fixtureIds: string[] }> {
  const created = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, ...stage },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${created.data!.id}/generate`,
    "POST",
  );
  return { stageId: created.data!.id, fixtureIds: (gen.data?.fixtures ?? []).map((f) => f.id) };
}

/** Record a generic.result for one fixture (reads last_seq for optimistic concurrency). */
export async function scoreFixture(
  request: APIRequestContext,
  fixtureId: string,
  p1Score: number,
  p2Score: number,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "generic.result",
    payload: { p1Score, p2Score },
  });
  if (res.status >= 400) {
    throw new Error(`scoreFixture(${fixtureId}) failed: ${res.status} ${res.error?.message}`);
  }
}

/** Score every still-undecided fixture in a list via the API. */
export async function scoreRemainingFixtures(
  request: APIRequestContext,
  fixtureIds: string[],
  skip: Set<string> = new Set(),
): Promise<void> {
  for (const id of fixtureIds) {
    if (skip.has(id)) continue;
    const state = await apiJson<{ status: string; last_seq: number }>(
      request,
      `/api/v1/fixtures/${id}/state`,
    );
    if (state.data && ["decided", "finalized"].includes(state.data.status)) continue;
    const res = await apiJson(request, `/api/v1/fixtures/${id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    // A fixture scored moments ago through the UI can reject with "outcome
    // already decided" before its status column reflects it — that's success.
    if (res.status >= 400 && !/already decided/i.test(res.error?.message ?? "")) {
      throw new Error(`scoreRemainingFixtures(${id}) failed: ${res.status} ${res.error?.message}`);
    }
  }
}

/** Create a competition through the wizard UI; returns its id (parsed from the URL). */
export async function createCompetitionViaUi(
  page: Page,
  name: string,
  visibility: "public" | "private" | "unlisted" = "public",
): Promise<string> {
  await page.goto("/competitions/new");
  await page.getByPlaceholder("Summer Championship 2026").fill(name);
  // Visibility is a radio-card group; the wizard defaults to PRIVATE, so
  // always select explicitly. The input hides behind the styled card, so
  // click the wrapping label and verify the radio took.
  const radio = page.getByRole("radio", { name: new RegExp(`^${visibility}`, "i") });
  await page.locator("label").filter({ has: radio }).click();
  await expect(radio).toBeChecked();
  await page.getByRole("button", { name: /create/i }).click();
  await page.waitForURL(/\/competitions\/[0-9a-f-]{36}/, { timeout: 20_000 });
  return page.url().match(/\/competitions\/([0-9a-f-]{36})/)![1]!;
}

/**
 * Create a division through the tabbed builder UI (basics → scheduling →
 * Create). Uses the builder's defaults for sport/format; returns the division
 * id parsed from the post-create URL.
 */
export async function createDivisionViaUi(
  page: Page,
  competitionId: string,
  name: string,
): Promise<string> {
  await page.goto(`/competitions/${competitionId}/divisions/new`);
  // The name field is the first textbox on the Basics tab (see formats.spec.ts).
  await page.getByRole("textbox").first().fill(name);
  // Creation is guarded to the last tab.
  await page.getByRole("button", { name: "Scheduling", exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/divisions\/[0-9a-f-]{36}/, { timeout: 20_000 });
  return page.url().match(/\/divisions\/([0-9a-f-]{36})/)![1]!;
}

/** Create a scored generic-league division via the API and return ids. */
export async function seedScoredDivision(
  request: APIRequestContext,
  names: string[] = ["A", "B", "C", "D"],
  opts: { decide?: boolean } = {},
): Promise<{ competitionId: string; divisionId: string; stageId: string }> {
  const { decide = true } = opts;
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
  // For the officials path (decide:false) give every fixture a kick-off time +
  // court — auto-assign only sees timed, undecided fixtures. Scored callers are
  // left untouched (no schedule events) so their assertions are unchanged.
  if (!decide) {
    const base = Date.UTC(2026, 8, 15, 9, 0, 0); // 2026-09-15 09:00Z
    for (let i = 0; i < gen.data!.fixtures.length; i++) {
      const at = new Date(base + i * 90 * 60_000).toISOString();
      await apiJson(request, `/api/v1/fixtures/${gen.data!.fixtures[i]!.id}`, "PATCH", {
        scheduled_at: at,
        court_label: String((i % 2) + 1),
      });
    }
  }
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  // Officials auto-assign only sees UNDECIDED timed fixtures — callers that
  // exercise that path pass { decide: false }.
  if (decide) {
    for (const f of gen.data!.fixtures) {
      const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
      await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: state.data!.last_seq,
        type: "generic.result",
        payload: { p1Score: 2, p2Score: 0 },
      });
    }
  }
  void entrants;
  return { competitionId, divisionId, stageId };
}
