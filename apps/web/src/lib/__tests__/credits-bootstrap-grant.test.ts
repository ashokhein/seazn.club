// v17 Phase-2 final-review IMPORTANT 2: createOrgForUser used to insert the
// org + its (group-of-one) subscription row and stop there — the new wallet
// sat empty until the daily billing-grant cron (grantMonthlyForAllWallets)
// next ran, up to 24h later. A brand-new Community org would 402
// ({featureKey: "ai.credits"}) on its very first AI Schedule/Officials
// attempt, worse than the old free per-division cap it replaced. Fix:
// createOrgForUser now grants the org's current-period monthly credits
// (community = 10) synchronously, right after the org/subscription/member
// rows commit. grantMonthly's own `(wallet_id, period)` idempotency key means
// the daily cron catching the same wallet later in the same calendar month is
// a no-op, not a double grant.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

// createOrgForUser calls invalidateUserOrgs; no Redis needed for this test,
// and getLimit's/grantMonthly's entitlement reads must hit the DB directly,
// not a stale cache (same setup as org-create-concurrency.test.ts).
import { vi } from "vitest";
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { balance, grantMonthlyForAllWallets, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`bootstrap-${uniq()}@test.local`}, 'Bootstrap Owner', true) returning id`;
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("createOrgForUser — AI credit wallet bootstrap grant", () => {
  it("a freshly-created Community org has 10 credits immediately (no 402 on first AI attempt)", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Fresh Org");

    const walletId = await walletIdFor(org.id);
    expect(await balance(walletId)).toBe(10);
  });

  it("the daily cron run in the same calendar month is a no-op for the bootstrap-granted wallet", { timeout: 30000 }, async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Fresh Org Two");
    const walletId = await walletIdFor(org.id);
    expect(await balance(walletId)).toBe(10);

    await grantMonthlyForAllWallets();

    // Same idempotency key (`monthly:${walletId}:${period}`) as the bootstrap
    // call — the cron sees it already granted this period and skips, so the
    // balance stays 10, not 20.
    expect(await balance(walletId)).toBe(10);
  });
});
