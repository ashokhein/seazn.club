// v17 SPEC-6 §A3 — the Credits-tab view model (server/usecases/credits-tab.ts).
// Real-Postgres integration test: skips without DATABASE_URL. Exercises the
// pure read/derive over the ledger — balance, the grant meter (cap − grant
// balance), never-expire packs, shared-org count, and the run history mapping.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  grantMonthly,
  recordPackPurchase,
  reserve,
  settle,
  walletIdFor,
} from "@/lib/credits";
import { seedOrg } from "./_seed";
import { getCreditsTab } from "../credits-tab";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("getCreditsTab", () => {
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("derives balance, grant meter, packs and history for a Pro wallet", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);

    expect(await grantMonthly(walletId, "pro", 1)).toBe(60);
    expect(await recordPackPurchase(walletId, 100, `pack-${randomUUID()}`)).toBe(100);
    const hold = await reserve(walletId, auth.orgId, 1);
    await settle(hold, randomUUID());

    const view = await getCreditsTab(auth.orgId);

    expect(view.balance).toBe(159); // 60 grant + 100 pack − 1 spend
    expect(view.grantCap).toBe(60);
    expect(view.grantUsed).toBe(1); // one grant credit spent this period
    expect(view.packBalance).toBe(100);
    expect(view.sharedOrgCount).toBe(1);
    expect(view.grantResetsInDays).toBeGreaterThan(0);
    expect(view.grantResetsInDays).toBeLessThanOrEqual(31);

    expect(view.history).toHaveLength(3);
    const run = view.history.find((r) => r.action === "run");
    expect(run?.delta).toBe(-1);
    expect(view.history.find((r) => r.action === "monthlyGrant")?.delta).toBe(60);
    expect(view.history.find((r) => r.action === "pack")?.delta).toBe(100);
    // No ai_runs table yet — model/competition are null, org names present.
    expect(run?.model).toBeNull();
    expect(run?.competitionName).toBeNull();
  });

  it("caps the grant meter at the Community flat 10 and starts empty", async () => {
    const { auth } = await seedOrg("community");

    const view = await getCreditsTab(auth.orgId);
    expect(view.grantCap).toBe(10);
    expect(view.grantUsed).toBe(0);
    expect(view.balance).toBe(0);
    expect(view.sharedOrgCount).toBe(1);
    expect(view.history).toHaveLength(0);
  });
});
