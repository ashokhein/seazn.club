import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { TAG, apiJson, loginUi, addEntrantsViaApi, createStageAndGenerate } from "./helpers";

/**
 * Division scheduling is open to every plan (#382, V353) — proven in the
 * browser, on a real COMMUNITY org.
 *
 * Why this file exists. V353 is a data change: three rows flipped, five
 * inserted. Nothing in TypeScript moved, so every unit suite could stay green
 * with the migration unapplied — and `entitlements-scheduling.test.ts` proves
 * only that `hasFeature` answers true, never that the organiser reaches the
 * board. The three `requireFeature` calls it unblocks
 * (`putScheduleSettings`, `applySchedule`, `moveFixture`) are only exercised
 * end-to-end from here.
 *
 * EVERY TEST IS TWO-SIDED where a paywall still exists. Asserting only "the
 * community org got a 200" is satisfied by an entitlement table with no gates
 * left at all, which is precisely the over-shoot to guard against:
 * `scheduling.multi_division` must STILL refuse community, or #382 quietly gave
 * away the one scheduling feature that was meant to stay paid.
 *
 * Own org, own owner, own competition — nothing here touches the shared Pro
 * user's org budget, so it belongs in the parallel project.
 */

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const hex = () => randomBytes(4).toString("hex");

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

interface SeededOrg {
  orgId: string;
  orgSlug: string;
  ownerEmail: string;
}

/** A COMMUNITY org with its own fresh owner — explicitly on the free plan, so
 *  nothing here can accidentally read as a Pro result. */
async function seedCommunityOrg(): Promise<SeededOrg> {
  const tag = hex();
  const ownerEmail = `os-owner-${TAG}-${tag}@example.com`;
  return withDb(async (sql) => {
    const [owner] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"OS Owner " + tag}, true)
      returning id`;
    const orgSlug = `os-org-${TAG}-${tag}`;
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"OS Org " + tag}, ${orgSlug}, 'active', ${owner!.id})
      returning id`;
    await sql`
      insert into org_members (org_id, user_id, role)
      values (${org!.id}, ${owner!.id}, 'owner')`;
    const [group] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${owner!.id}, 'community', 'active')
      returning id`;
    await sql`update organizations set subscription_id = ${group!.id} where id = ${org!.id}`;
    return { orgId: org!.id, orgSlug, ownerEmail };
  });
}

async function loginAsOwner(page: Page, email: string): Promise<void> {
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
}

interface Rig {
  compId: string;
  compSlug: string;
  divisionId: string;
  divSlug: string;
  stageId: string;
  fixtureIds: string[];
}

/** A private competition, a generic division with four entrants, and one
 *  stage's fixtures — created through the API as the signed-in owner. Slugs are
 *  read back, because the console pages are slug-routed. */
async function seedRig(request: import("@playwright/test").APIRequestContext): Promise<Rig> {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Open Sched ${TAG} ${hex()}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: `Open ${hex()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    },
  );
  await addEntrantsViaApi(request, div.data!.id, ["Bolt", "Wire", "Coil", "Fuse"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id);
  return {
    compId: comp.data!.id,
    compSlug: comp.data!.slug,
    divisionId: div.data!.id,
    divSlug: div.data!.slug,
    stageId,
    fixtureIds,
  };
}

test.describe("Community reaches the board and the constraints (#382)", () => {
  test("a Community org stores a constraint-bearing schedule setting", async ({ page }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    // Every one of these trips `usesConstraints` on its own: a rest floor, a
    // blackout AND a second court. Before V353 this was a flat 402 on community.
    const res = await page.request.put(`/api/v1/divisions/${rig.divisionId}/schedule-settings`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({
        tz: "UTC",
        config: {
          startAt: new Date(Date.UTC(2026, 9, 12, 9, 0)).toISOString(),
          matchMinutes: 45,
          gapMinutes: 5,
          courts: ["Court A", "Court B"],
          perEntrantMinRest: 30,
        },
      }),
    });
    expect(res.status(), await res.text()).toBe(200);

    // …and it STUCK. A 200 that stored nothing would pass a status-only check.
    const read = await apiJson<{ config: { courts: string[]; perEntrantMinRest: number } }>(
      page.request,
      `/api/v1/divisions/${rig.divisionId}/schedule-settings`,
    );
    expect(read.data!.config.courts).toEqual(["Court A", "Court B"]);
    expect(read.data!.config.perEntrantMinRest).toBe(30);
  });

  test("a Community org edits the board: a manual apply and a pin", async ({ page }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    // `source: "manual"` is the branch gated on `scheduling.board`.
    const applied = await page.request.post(`/api/v1/stages/${rig.stageId}/schedule/apply`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({
        source: "manual",
        assignments: [
          {
            fixture_id: rig.fixtureIds[0],
            scheduled_at: new Date(Date.UTC(2026, 9, 12, 9, 0)).toISOString(),
            court_label: "Court A",
          },
        ],
      }),
    });
    expect(applied.status(), await applied.text()).toBe(200);

    // `schedule_locked` on a move is the other `scheduling.board` branch.
    const pinned = await page.request.patch(`/api/v1/fixtures/${rig.fixtureIds[0]}`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ schedule_locked: true }),
    });
    expect(pinned.status(), await pinned.text()).toBe(200);

    const fixture = await apiJson<{ schedule_locked: boolean; court_label: string | null }>(
      page.request,
      `/api/v1/fixtures/${rig.fixtureIds[0]}`,
    );
    expect(fixture.data!.schedule_locked).toBe(true);
    expect(fixture.data!.court_label).toBe("Court A");
  });

  test("the division board page renders no scheduling paywall for Community", async ({ page }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    await page.goto(`/o/${org.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}/schedule`);
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible({ timeout: 30_000 });
    // The UpgradeGate carries data-feature; neither scheduling key may appear.
    await expect(page.locator('[data-feature="scheduling.board"]')).toHaveCount(0);
    await expect(page.locator('[data-feature="scheduling.constraints"]')).toHaveCount(0);
  });

  test("multi-division stays the ONE scheduling paywall on Community", async ({ page }) => {
    // The two-sided half of this file. If this ever goes green-by-absence, #382
    // gave away the feature it was explicitly meant to keep behind the wall.
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    await page.goto(`/o/${org.orgSlug}/c/${rig.compSlug}/schedule`);
    await expect(page.locator('[data-feature="scheduling.multi_division"]')).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe("At the save-point cap the window rolls, and the panel says so (#382)", () => {
  test("the third save point names the one it replaced", async ({ page }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    await page.goto(`/o/${org.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}/schedule`);
    const input = page.getByLabel("Save point label");
    await expect(input).toBeVisible({ timeout: 30_000 });
    const save = page.getByRole("button", { name: "Save point" });

    const first = `before rain ${hex()}`;
    for (const label of [first, `after rain ${hex()}`]) {
      await input.fill(label);
      await save.click();
      await expect(page.getByText(label, { exact: false })).toBeVisible({ timeout: 20_000 });
    }
    // Two saves, still under the community cap of 2 — no notice yet. Asserting
    // its ABSENCE first is what stops a notice that always renders from passing
    // the assertion below.
    await expect(page.getByText("was replaced", { exact: false })).toHaveCount(0);

    await input.fill(`third ${hex()}`);
    await save.click();

    // The save SUCCEEDED (no paywall), and the notice names the label that went.
    await expect(page.getByText(first, { exact: false })).toHaveCount(0, { timeout: 20_000 });
    const notice = page.getByText("was replaced", { exact: false });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText(first);
    await expect(notice).toContainText("2 save points");
    // A notice, not a paywall: nothing was refused.
    await expect(page.locator('[data-feature="schedule.checkpoints.max"]')).toHaveCount(0);
    await expect(page.getByText("Undo still rewinds past it", { exact: false })).toBeVisible();
  });
});
