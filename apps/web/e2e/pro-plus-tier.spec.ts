import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  TAG,
  apiJson,
  activeOrg,
  loginUi,
  addEntrantsViaApi,
  createStageAndGenerate,
} from "./helpers";

// Pro Plus tier — browser contract (owner ask 2026-07-18, Task 18).
//
// PR #125 shipped the pro_plus tier (V290 matrix + V291 amendment) without
// browser e2e; this retrofits it. Every assertion runs through the RUNNING
// app: session surfaces (billing, /admin/entitlements) in the browser, quota
// and moved-up-feature gates through the real /api/v1 stack (page.request
// shares the session cookie — the same HTTP path the console UI drives), and
// the public pricing disclosure with no auth.
//
// PLAN-GENERICS (wave constraint, verbatim): tier logic must hold for pro AND
// pro_plus — never hardcode 'pro'. These tests exist to prove exactly that at
// the browser layer: the officials-per-fixture and checkpoint quotas are
// exercised on community (1) vs pro (5/∞) vs pro_plus (∞), and the moved-up
// features (officials.auto / api.write) are shown gated on Pro yet working on
// Pro Plus.
//
// State is SQL-seeded with run-unique tags (mirroring the wave's vitest seeds);
// each seeded org owns its own fresh owner (never the shared Pro e2e user → no
// 5-org budget impact), and public pages need no auth. No REDIS in e2e → SQL
// plan seeds resolve fresh on first read (invalidateOrgEntitlements is an
// in-process no-op round-trip), so seeding the plan at org-creation time never
// races a cached entitlement.
//
// The pricing-page reveal MECHANICS (hidden → click → $39) are already pinned
// by pricing-pro-plus.spec.ts; the reveal test below is complementary — it
// asserts the revealed card advertises this wave's moved-up features.

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const hex = () => randomBytes(4).toString("hex");

// ---------------------------------------------------------------------------
// One-shot SQL against the app's schema (helpers.ts keeps withDb private).
// ---------------------------------------------------------------------------

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
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

// ---------------------------------------------------------------------------
// SQL seed helpers (mirror the wave's vitest seeds; run-unique)
// ---------------------------------------------------------------------------

interface SeededOrg {
  orgId: string;
  orgSlug: string;
  ownerEmail: string;
  ownerId: string;
}

/** Org with its own fresh owner. plan seeds a subscription row; `staff` marks
 *  the owner a superadmin (for /admin/entitlements). */
async function seedOrg(opts: {
  plan?: "community" | "pro" | "pro_plus";
  staff?: boolean;
}): Promise<SeededOrg> {
  const tag = hex();
  const ownerEmail = `pp-owner-${TAG}-${tag}@example.com`;
  return withDb(async (sql) => {
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, is_staff, staff_role)
      values (${ownerEmail}, ${"PP Owner " + tag}, true,
              ${opts.staff ?? false}, ${opts.staff ? "superadmin" : null})
      returning id`;
    const orgSlug = `pp-org-${TAG}-${tag}`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"PP Org " + tag}, ${orgSlug}, 'active', ${ownerId})
      returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
    if (opts.plan) {
      await sql`
        insert into subscriptions (org_id, plan_key, status)
        values (${orgId}, ${opts.plan}, 'active')`;
    }
    return { orgId, orgSlug, ownerEmail, ownerId };
  });
}

/** N officials in an org, single 'referee' role (SQL — bypasses the free/Pro
 *  roles_multi gate; that gate is not under test here). */
async function seedOfficials(orgId: string, n: number): Promise<string[]> {
  return withDb(async (sql) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into officials (org_id, display_name, role_keys)
        values (${orgId}, ${`Ref ${TAG} ${i} ${hex()}`}, ${sql.json(["referee"])})
        returning id`;
      ids.push(id);
    }
    return ids;
  });
}

// ---------------------------------------------------------------------------
// API seed helpers (run as the CURRENT session's org)
// ---------------------------------------------------------------------------

/** A private comp + generic-score division under the session's active org. */
async function seedDivision(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ compId: string; divisionId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `PP ${TAG} ${hex()}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG, eligibility: [] },
  );
  return { compId: comp.data!.id, divisionId: div.data!.id };
}

/** A division with one generated fixture (2 entrants, league). */
async function seedFixture(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ divisionId: string; fixtureId: string }> {
  const { divisionId } = await seedDivision(request);
  await addEntrantsViaApi(request, divisionId, ["Alpha", "Bravo"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  if (!fixtureIds[0]) throw new Error("seedFixture: stage generated no fixtures");
  return { divisionId, fixtureId: fixtureIds[0] };
}

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

async function loginAsOwner(page: Page, email: string): Promise<void> {
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
}

/** POST a fixture-officials set and return {status, feature_key}. */
async function setFixtureOfficials(
  request: import("@playwright/test").APIRequestContext,
  fixtureId: string,
  officialIds: string[],
): Promise<{ status: number; featureKey?: string }> {
  const res = await request.patch(`/api/v1/fixtures/${fixtureId}/officials`, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({
      set: officialIds.map((id) => ({ official_id: id, role_key: "referee", locked: false })),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { feature_key?: string } };
  return { status: res.status(), featureKey: body.error?.feature_key };
}

/** POST a named checkpoint and return {status, feature_key}. */
async function createCheckpoint(
  request: import("@playwright/test").APIRequestContext,
  divisionId: string,
  label: string,
): Promise<{ status: number; featureKey?: string }> {
  const res = await request.post(`/api/v1/divisions/${divisionId}/checkpoints`, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ label }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { feature_key?: string } };
  return { status: res.status(), featureKey: body.error?.feature_key };
}

// ===========================================================================
// Step 2 — Billing surface
// ===========================================================================

test.describe("Pro Plus · billing surface", () => {
  test("Community billing advertises the Pro Plus upsell with a price and no dead Business plan", async ({
    page,
  }) => {
    const org = await seedOrg({ plan: "community" });
    await loginAsOwner(page, org.ownerEmail);
    await page.goto(`/o/${org.orgSlug}/settings/billing`);

    // The three-tier upgrade grid renders for a Community owner.
    await expect(page.getByRole("heading", { name: "Upgrade to Pro" })).toBeVisible({ timeout: 20_000 });
    // The Pro Plus card is present …
    await expect(page.getByText("Pro Plus", { exact: true }).first()).toBeVisible();
    // … and the Pro Plus CTA is a real move with a price in its label.
    const goPlus = page.getByRole("button", { name: /Go Pro Plus/ }).first();
    await expect(goPlus).toBeVisible();
    await expect(goPlus).toContainText(/\d/);
    // The retired v2 'business' plan leaves no remnant in the plan grid.
    await expect(page.getByText("Business", { exact: true })).toHaveCount(0);
  });

  test("Pro Plus org billing recognises the paid tier and hides the upgrade grid", async ({ page }) => {
    const org = await seedOrg({ plan: "pro_plus" });
    await loginAsOwner(page, org.ownerEmail);
    await page.goto(`/o/${org.orgSlug}/settings/billing`);

    // Current-plan panel names the tier (raw key, capitalised by CSS).
    await expect(
      page.locator('[data-tour="billing-plan"]').getByText("pro_plus", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    // A paid tier never sees the Community upgrade/compare grid …
    await expect(page.getByRole("heading", { name: "Upgrade to Pro" })).toHaveCount(0);
    // … and no dead Business plan anywhere.
    await expect(page.getByText("Business", { exact: true })).toHaveCount(0);
  });
});

// ===========================================================================
// Step 3 — Quota gates (plan-generic: community vs pro vs pro_plus)
// ===========================================================================

test.describe("Pro Plus · officials-per-fixture quota", () => {
  test("Community: one official per fixture is fine, a second 402s", async ({ page }) => {
    const org = await seedOrg({ plan: "community" });
    await loginAsOwner(page, org.ownerEmail);
    const orgId = (await activeOrg(page)).id;
    const { fixtureId } = await seedFixture(page.request);
    const [o1, o2] = await seedOfficials(orgId, 2);

    // Community includes ONE official per fixture (V290).
    const one = await setFixtureOfficials(page.request, fixtureId, [o1!]);
    expect(one.status).toBe(200);

    // A second official on the same fixture is over the community quota.
    const two = await setFixtureOfficials(page.request, fixtureId, [o1!, o2!]);
    expect(two.status).toBe(402);
    expect(two.featureKey).toBe("officials.per_fixture.max");
  });

  test("Pro: officials-per-fixture is unlimited", async ({ page }) => {
    // The default storageState is the shared Pro org (per-fixture = ∞).
    const orgId = (await activeOrg(page)).id;
    const { fixtureId } = await seedFixture(page.request);
    const [o1, o2] = await seedOfficials(orgId, 2);

    const two = await setFixtureOfficials(page.request, fixtureId, [o1!, o2!]);
    expect(two.status).toBe(200);
  });
});

test.describe("Pro Plus · schedule save-point quota", () => {
  test("Community: the 2nd save point 402s (limit 1)", async ({ page }) => {
    const org = await seedOrg({ plan: "community" });
    await loginAsOwner(page, org.ownerEmail);
    const { divisionId } = await seedDivision(page.request);

    expect((await createCheckpoint(page.request, divisionId, `cp1 ${hex()}`)).status).toBe(201);
    const second = await createCheckpoint(page.request, divisionId, `cp2 ${hex()}`);
    expect(second.status).toBe(402);
    expect(second.featureKey).toBe("schedule.checkpoints.max");
  });

  test("Pro: 5 save points are allowed, the 6th 402s (limit 5)", async ({ page }) => {
    // Shared Pro org (schedule.checkpoints.max = 5).
    const { divisionId } = await seedDivision(page.request);
    for (let i = 1; i <= 5; i++) {
      expect((await createCheckpoint(page.request, divisionId, `cp${i} ${hex()}`)).status).toBe(201);
    }
    const sixth = await createCheckpoint(page.request, divisionId, `cp6 ${hex()}`);
    expect(sixth.status).toBe(402);
    expect(sixth.featureKey).toBe("schedule.checkpoints.max");
  });

  test("Pro Plus: save points are unlimited (6+ all succeed)", async ({ page }) => {
    const org = await seedOrg({ plan: "pro_plus" });
    await loginAsOwner(page, org.ownerEmail);
    const { divisionId } = await seedDivision(page.request);

    for (let i = 1; i <= 6; i++) {
      expect((await createCheckpoint(page.request, divisionId, `cp${i} ${hex()}`)).status).toBe(201);
    }
  });
});

// ===========================================================================
// Step 4 — Moved-up features (Pro gated, Pro Plus works)
// ===========================================================================

test.describe("Pro Plus · moved-up features", () => {
  test("Pro: officials.auto + api.write are gated; read-only key still mints", async ({ page }) => {
    // Shared Pro org: V290 moved officials.auto + api.write up to Pro Plus.
    const orgId = (await activeOrg(page)).id;
    const { divisionId } = await seedDivision(page.request);

    // Auto-assign officials now needs Pro Plus.
    const auto = await page.request.post(`/api/v1/divisions/${divisionId}/officials/auto`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ policy: { roles: ["referee"] } }),
    });
    expect(auto.status()).toBe(402);
    expect(((await auto.json()) as { error?: { feature_key?: string } }).error?.feature_key).toBe(
      "officials.auto",
    );

    // A write-scoped API key needs api.write (Pro Plus) …
    const writeKey = await apiJson(page.request, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
      name: `pp write ${TAG} ${hex()}`,
      scopes: ["manage"],
    });
    expect(writeKey.status).toBe(402);
    const writeBody = await page.request
      .post(`/api/v1/orgs/${orgId}/api-keys`, {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ name: `pp write2 ${TAG} ${hex()}`, scopes: ["manage"] }),
      })
      .then((r) => r.json())
      .catch(() => ({}));
    expect((writeBody as { error?: { feature_key?: string } }).error?.feature_key).toBe("api.write");

    // … but a read-only key stays at Pro (api.access) — proves the boundary
    // is the write rung, not a broken route.
    const readKey = await apiJson(page.request, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
      name: `pp read ${TAG} ${hex()}`,
      scopes: ["read"],
    });
    expect(readKey.status).toBe(201);
  });

  test("Pro Plus: officials.auto + a write-scoped API key both work", async ({ page }) => {
    const org = await seedOrg({ plan: "pro_plus" });
    await loginAsOwner(page, org.ownerEmail);
    const orgId = (await activeOrg(page)).id;
    const { divisionId } = await seedDivision(page.request);

    // officials.auto is granted on Pro Plus (empty division → empty proposal).
    const auto = await page.request.post(`/api/v1/divisions/${divisionId}/officials/auto`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ policy: { roles: ["referee"] } }),
    });
    expect(auto.status()).toBe(200);

    // A write-scoped key mints (api.write granted).
    const writeKey = await apiJson(page.request, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
      name: `pp plus write ${TAG} ${hex()}`,
      scopes: ["manage"],
    });
    expect(writeKey.status).toBe(201);
  });
});

// ===========================================================================
// Step 5 — Pro Plus disclosure + /admin/entitlements matrix
// ===========================================================================

test.describe("Pro Plus · disclosure + admin matrix", () => {
  test("Pricing reveal surfaces the moved-up features as Pro Plus selling points", async ({
    browser,
  }) => {
    // Anonymous visitor (default storageState is signed-in), own context.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto("/en/pricing");
      await expect(page.locator("[data-plus-revealed]")).toHaveCount(0);
      await page.locator("[data-plus-reveal-cta]").click();

      const revealed = page.locator("[data-plus-revealed]");
      await expect(revealed).toBeVisible();
      // The features this wave moved onto Pro Plus are its headline offer.
      await expect(revealed).toContainText("AI-assisted scheduling");
      await expect(revealed).toContainText("Auto officials assignment");
      await expect(revealed).toContainText("Write API access");
    } finally {
      await ctx.close();
    }
  });

  test("/admin/entitlements shows the Pro Plus column incl. the V291 AI-cap row", async ({ page }) => {
    const org = await seedOrg({ plan: "pro_plus", staff: true });
    await loginAsOwner(page, org.ownerEmail);
    await page.goto("/admin/entitlements");

    // The staff matrix carries a Pro Plus column.
    await expect(page.getByRole("columnheader", { name: "Pro Plus" }).first()).toBeVisible({
      timeout: 20_000,
    });

    // V291 amendment: Pro AI scheduling capped at 5/division, Pro Plus unlimited.
    const capRow = page
      .locator("tbody tr")
      .filter({ has: page.getByRole("cell", { name: "scheduling.ai.runs_per_division.max", exact: true }) });
    await expect(capRow).toHaveCount(1);
    await expect(capRow.locator("td").nth(4)).toHaveText("5"); // Pro
    await expect(capRow.locator("td").nth(5)).toHaveText("∞"); // Pro Plus

    // V290 quota: officials-per-fixture community 1 / pro ∞ / pro_plus ∞.
    const ofpRow = page
      .locator("tbody tr")
      .filter({ has: page.getByRole("cell", { name: "officials.per_fixture.max", exact: true }) });
    await expect(ofpRow.locator("td").nth(2)).toHaveText("1"); // Community
    await expect(ofpRow.locator("td").nth(4)).toHaveText("∞"); // Pro
    await expect(ofpRow.locator("td").nth(5)).toHaveText("∞"); // Pro Plus

    // V290 hard move: api.write false on Pro, true on Pro Plus.
    const apiWriteRow = page
      .locator("tbody tr")
      .filter({ has: page.getByRole("cell", { name: "api.write", exact: true }) });
    await expect(apiWriteRow.locator("td").nth(4)).toHaveText("false"); // Pro
    await expect(apiWriteRow.locator("td").nth(5)).toHaveText("true"); // Pro Plus
  });
});
