// AI credit wallet — UTC-safe period boundary (#292).
//
// spentThisPeriodByOrg (SPEC-5 §1's operator allocation derive) used to
// bound "this period" with `date_trunc('month', now())` — truncated in the
// DB SESSION's TimeZone GUC (Europe/London in prod), not UTC.
// grantMonthly's own period anchor (monthlyPeriod(), a plain
// toISOString().slice(0,7)) is always UTC. Around a month boundary the two
// could disagree by up to an hour: a spend recorded in the last hour of
// UTC June could read as "July" under a UTC+1 session TZ and wrongly count
// toward July's operator allocation cap. Real Postgres required; skipped
// without DATABASE_URL.
//
// Uses session TZ Europe/London specifically (production's session TZ, and
// the exact shape V334's org_has_feature fix reproduced) rather than a
// fixed always-offset zone like entitlements-sql-parity.test.ts's
// Etc/GMT-14 pair — so, like that choice trades away, this test only
// demonstrates the bug while Europe/London is genuinely ahead of UTC (BST,
// roughly late March-late October). It is valid today (2026-07-26, BST).
// If this ever needs to be season-proof, mirror
// entitlements-sql-parity.test.ts's Etc/GMT-14 / Etc/GMT+12 pair instead.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { spentThisPeriodByOrg } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`PeriodBoundary ${uniq()}`}, ${`period-boundary-${uniq()}`})
    returning id`;
  return org!.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("spentThisPeriodByOrg — UTC period boundary (#292)", () => {
  it("REGRESSION: excludes a hold from the PRIOR UTC month even under session TZ Europe/London, at the exact month-boundary edge", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    // 30 minutes before THIS UTC month started — genuinely last month in
    // UTC. Computed relative to Postgres's own (TZ-safe, double-converted)
    // clock so this holds regardless of which real day this suite runs on.
    const [{ edge }] = await sql<{ edge: string }[]>`
      select (date_trunc('month', now() at time zone 'utc') at time zone 'utc'
              - interval '30 minutes')::text as edge`;
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, spent_by_org_id, balance_after,
         idempotency_key, created_at)
      values (${walletId}, -1, 'run_spend', 'grant', ${orgId}, 0,
              ${`edge-${uniq()}`}, ${edge})`;

    const spent = await sql.begin(async (tx) => {
      await tx`set local time zone 'Europe/London'`;
      return spentThisPeriodByOrg(tx, walletId, orgId);
    });

    // Genuinely last month — must not count toward this period's spend no
    // matter what TZ the DB session happens to run under.
    expect(spent).toBe(0);
  });

  it("still counts a hold recorded inside the current UTC month", async () => {
    const walletId = randomUUID();
    const orgId = await seedOrg();
    const [{ edge }] = await sql<{ edge: string }[]>`
      select (date_trunc('month', now() at time zone 'utc') at time zone 'utc'
              + interval '1 second')::text as edge`;
    await sql`
      insert into ai_credit_ledger
        (wallet_id, delta, source, bucket, spent_by_org_id, balance_after,
         idempotency_key, created_at)
      values (${walletId}, -3, 'run_spend', 'grant', ${orgId}, 0,
              ${`this-month-${uniq()}`}, ${edge})`;

    const spent = await sql.begin(async (tx) => {
      await tx`set local time zone 'Europe/London'`;
      return spentThisPeriodByOrg(tx, walletId, orgId);
    });

    expect(spent).toBe(3);
  });
});
