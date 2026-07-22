// #229 P0-1: the per-user org cap must hold under concurrency. createOrgForUser
// used to read the quota (assertMayOwnAnotherOrg) BEFORE opening its
// transaction, so two concurrent creates both saw spare capacity and each
// created an organisation plus a Community billing group — busting orgs.max_owned
// and multiplying per-org free-tier grants. The read, check and inserts are now
// serialized per user with a transaction-scoped advisory lock.
//
// A brand-new user may always create their FIRST org (owned.length === 0 is the
// free pass), and Community caps a user at one owned org. Two concurrent creates
// therefore race for that single slot: exactly one must win. Real Postgres
// required.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// A no-op cache: createOrgForUser calls invalidateUserOrgs, which needs no Redis
// here, and getLimit's entitlement reads must hit the DB, not a stale cache.
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { PaymentRequiredError } from "@/lib/errors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`capracer-${uniq()}@test.local`}, 'Cap Racer', true) returning id`;
  return id;
}

const ownedCount = async (userId: string) =>
  Number(
    (
      await sql<{ n: string }[]>`
        select count(*)::text as n from org_members
        where user_id = ${userId} and role = 'owner'`
    )[0].n,
  );

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("two concurrent org creates for one user", () => {
  it("cannot both take the user past the Community cap of one owned org", async () => {
    const userId = await makeUser();

    const results = await Promise.allSettled([
      createOrgForUser(userId, "Race A"),
      createOrgForUser(userId, "Race B"),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PaymentRequiredError);

    // The cap held: one owned org, and one billing group — never two of either.
    expect(await ownedCount(userId)).toBe(1);
    const [{ n: groups }] = await sql<{ n: string }[]>`
      select count(*)::text as n from subscriptions where owner_user_id = ${userId}`;
    expect(Number(groups)).toBe(1);
  });

  it("still lets a user create their legitimate first org", async () => {
    // Guard against a lock that deadlocks or refuses the happy path.
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Solo");
    expect(org.id).toBeTruthy();
    expect(await ownedCount(userId)).toBe(1);
  });
});
