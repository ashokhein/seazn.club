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
  utcDayStart,
} from "../credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedEarnGrantRow(createdAt: Date = new Date()): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key, created_at)
    values (${randomUUID()}, 10, 'earn_grant', 'pack', 10, ${`vol-${uniq()}`}, ${createdAt})`;
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

describe("utcDayStart (pure, #292 discipline)", () => {
  // The SQL comparison itself (timestamptz column vs timestamptz PARAMETER)
  // is TZ-immune by construction — see utcMonthStart's docstring for the
  // proven session-TZ divergence that rules out SQL date_trunc. What needs
  // pinning here is that the JS truncation really is UTC, not local.
  it("truncates to 00:00 UTC of the same UTC day", () => {
    expect(utcDayStart(new Date("2026-07-27T23:59:59.999Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
    expect(utcDayStart(new Date("2026-07-27T00:00:00.000Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
  });
  it("a pre-UTC-midnight instant belongs to the PREVIOUS UTC day (the case a London session TZ gets wrong)", () => {
    // 2026-06-30 23:30 UTC is 2026-07-01 00:30 in Europe/London — a session-TZ
    // date_trunc('day', …) would file it under July 1; UTC truncation must not.
    expect(utcDayStart(new Date("2026-06-30T23:30:00.000Z")).toISOString()).toBe(
      "2026-06-30T00:00:00.000Z",
    );
  });
});

describe.skipIf(!HAS_DB)("earnGrantVolumeToday (v17 gap #296)", () => {
  it("counts exactly the rows at/after the passed anchor — deterministic via a future window no neighbor suite can touch", async () => {
    // Neighbor suites (credits-earn, publish-earn-gate, referral-grants, …)
    // insert earn_grant rows with created_at = now(), which can never land
    // at/after a FUTURE anchor — so the window's contents are fully
    // test-owned and the delta is exact, unlike a live-window `before + 2`
    // (which raced a parallel worker in review). Delta-based rather than
    // absolute so prior RUNS of this same file (persistent schema) can't
    // break it either.
    const anchor = utcDayStart(new Date(Date.now() + 2 * 86_400_000));
    const before = await earnGrantVolumeToday(anchor);
    await seedEarnGrantRow(new Date(anchor.getTime() - 1000)); // 1s BEFORE the boundary — excluded
    await seedEarnGrantRow(anchor); // exactly AT the boundary — included (>=)
    await seedEarnGrantRow(new Date(anchor.getTime() + 3_600_000)); // inside the day — included
    expect(await earnGrantVolumeToday(anchor)).toBe(before + 2);
  });

  it("live window sanity: seeding rows raises today's count (>= — the shared schema has concurrent writers)", async () => {
    // Anchor captured ONCE so even a UTC-midnight rollover mid-test cannot
    // shrink the window between the two reads.
    const dayStart = utcDayStart();
    const before = await earnGrantVolumeToday(dayStart);
    await seedEarnGrantRow();
    await seedEarnGrantRow();
    expect(await earnGrantVolumeToday(dayStart)).toBeGreaterThanOrEqual(before + 2);
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

// The module-level vi.mock above swaps sendEarnGrantVolumeAlertEmail out for
// everyone importing @/lib/email — which the wiring tests need, but it leaves
// the real renderer with zero coverage. Same remedy as ai-run-cost-alert:
// pull the unmocked implementation out of vi.importActual; `send()` returns
// false without RESEND_API_KEY, so the full render path runs with no network.
describe("sendEarnGrantVolumeAlertEmail (real render, v17 gap #296)", () => {
  it("renders and returns false with no provider configured (no network, no throw)", async () => {
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
      await expect(
        actual.sendEarnGrantVolumeAlertEmail({ to: "ops@seazn.test", count: 37, threshold: 20 }),
      ).resolves.toBe(false);
    } finally {
      if (key !== undefined) process.env.RESEND_API_KEY = key;
    }
  });
});
