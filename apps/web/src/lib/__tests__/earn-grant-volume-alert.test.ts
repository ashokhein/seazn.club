// v17 gap #296 — daily earn_grant volume backstop. A farming attempt spreads
// across many throwaway orgs (each its own wallet), so this counts
// GLOBALLY across every wallet, not per-wallet — the point is to catch the
// PATTERN, not one org's total. shouldAlertOnEarnGrantVolume carries the
// threshold decision as a pure function (no DB, no flake risk from other
// suites concurrently writing earn_grant rows into the same shared schema);
// earnGrantVolumeToday and checkEarnGrantVolumeAlert are thin wiring on top,
// exercised in the "clearly over" direction only — see the file's own
// comments for why the "under threshold" direction is proven at the pure
// level instead of against a DB whose day-total this suite doesn't own.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, sendEarnGrantVolumeAlertEmail: vi.fn().mockResolvedValue(true) };
});

import { sql } from "@/lib/db";
import { sendEarnGrantVolumeAlertEmail } from "@/lib/email";
import {
  EARN_GRANT_DAILY_ALERT_THRESHOLD,
  checkEarnGrantVolumeAlert,
  earnGrantVolumeToday,
  shouldAlertOnEarnGrantVolume,
} from "../credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedEarnGrantRow(): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${randomUUID()}, 10, 'earn_grant', 'pack', 10, ${`vol-${uniq()}`})`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

afterEach(() => {
  vi.mocked(sendEarnGrantVolumeAlertEmail).mockClear();
  delete process.env.STAFF_ALERT_EMAIL;
});

describe("shouldAlertOnEarnGrantVolume (pure, v17 gap #296)", () => {
  it("false strictly below the threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD - 1)).toBe(false);
  });
  it("true at or above the threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD)).toBe(true);
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD + 5)).toBe(true);
  });
  it("respects a custom threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(3, 5)).toBe(false);
    expect(shouldAlertOnEarnGrantVolume(5, 5)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("earnGrantVolumeToday (v17 gap #296)", () => {
  it("counts only today's earn_grant rows, across every wallet (delta-based — other suites share this table)", async () => {
    const before = await earnGrantVolumeToday();
    await seedEarnGrantRow();
    await seedEarnGrantRow();
    expect(await earnGrantVolumeToday()).toBe(before + 2);
  });
});

describe.skipIf(!HAS_DB)("checkEarnGrantVolumeAlert (v17 gap #296)", () => {
  it("alerts once today's count is clearly over the threshold", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    for (let i = 0; i < EARN_GRANT_DAILY_ALERT_THRESHOLD; i++) await seedEarnGrantRow();
    await checkEarnGrantVolumeAlert();
    expect(sendEarnGrantVolumeAlertEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendEarnGrantVolumeAlertEmail).mock.calls[0]![0];
    expect(args.count).toBeGreaterThanOrEqual(EARN_GRANT_DAILY_ALERT_THRESHOLD);
    expect(args.threshold).toBe(EARN_GRANT_DAILY_ALERT_THRESHOLD);
  });

  it("no STAFF_ALERT_EMAIL configured -> no email attempted even over threshold", async () => {
    delete process.env.STAFF_ALERT_EMAIL;
    for (let i = 0; i < EARN_GRANT_DAILY_ALERT_THRESHOLD; i++) await seedEarnGrantRow();
    await checkEarnGrantVolumeAlert();
    expect(sendEarnGrantVolumeAlertEmail).not.toHaveBeenCalled();
  });

  it("never throws — a check failure is swallowed", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    vi.mocked(sendEarnGrantVolumeAlertEmail).mockRejectedValueOnce(new Error("boom"));
    for (let i = 0; i < EARN_GRANT_DAILY_ALERT_THRESHOLD; i++) await seedEarnGrantRow();
    await expect(checkEarnGrantVolumeAlert()).resolves.toBeUndefined();
  });
});
