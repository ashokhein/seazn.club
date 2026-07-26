// #267 Task 2 (SPEC-5 §2) — referral attribution: consumeReferralCookie's
// self-referral guard + createOrgForUser's referred_by_org_id stamp. T1's
// code/resolver primitive is covered by referral.test.ts; this file only
// covers the T2 attribution flow (no credit grants — that's T3).
// Real Postgres required; skipped without DATABASE_URL (test-infra recipe).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// consumeReferralCookie reads/deletes the "ref" cookie via next/headers —
// mock a controllable jar (same pattern as lib/tz.test.ts's cookies mock)
// so the guard logic runs against a real DB without a request context.
let mockCookieValue: string | undefined;
const mockDelete = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) =>
      k === "ref" && mockCookieValue !== undefined ? { value: mockCookieValue } : undefined,
    delete: (k: string) => mockDelete(k),
  }),
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { consumeReferralCookie, getOrCreateReferralCode } from "@/lib/referral";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

afterEach(() => {
  mockCookieValue = undefined;
  mockDelete.mockClear();
});

async function seedUser(email?: string): Promise<{ id: string; email: string }> {
  const em = email ?? `ref-${randomUUID().slice(0, 8)}@example.com`;
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${em}, 'Ref Tester', true)
    returning id`;
  return { id: u.id, email: em };
}

async function seedOrgFor(userId: string, name = `Org ${randomUUID().slice(0, 6)}`): Promise<string> {
  const org = await createOrgForUser(userId, name);
  return org.id;
}

describe.skipIf(!HAS_DB)("createOrgForUser referred_by_org_id stamp (#267 T2)", () => {
  it("opts.referredByOrgId stamps the new org's referred_by_org_id", async () => {
    const owner = await seedUser();
    const referrerOrgId = await seedOrgFor(owner.id);
    const newUser = await seedUser();

    const org = await createOrgForUser(newUser.id, "Referred Co", { referredByOrgId: referrerOrgId });

    const [row] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${org.id}`;
    expect(row.referred_by_org_id).toBe(referrerOrgId);
  });

  it("no opts → referred_by_org_id stays null (regression: existing callers unchanged)", async () => {
    const newUser = await seedUser();

    const org = await createOrgForUser(newUser.id, "Standalone Co");

    const [row] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${org.id}`;
    expect(row.referred_by_org_id).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("consumeReferralCookie self-referral guard (#267 T2)", () => {
  it("no cookie → null", async () => {
    mockCookieValue = undefined;
    const newUser = await seedUser();
    expect(await consumeReferralCookie(newUser.id)).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("unknown code → null, cookie still best-effort cleared", async () => {
    mockCookieValue = "NOSUCHCODEXX";
    const newUser = await seedUser();
    expect(await consumeReferralCookie(newUser.id)).toBeNull();
    expect(mockDelete).toHaveBeenCalledWith("ref");
  });

  it("valid, distinct referrer → returns the referrer org id, clears the cookie", async () => {
    const owner = await seedUser();
    const referrerOrgId = await seedOrgFor(owner.id);
    const code = await getOrCreateReferralCode(referrerOrgId);
    const newUser = await seedUser();
    mockCookieValue = code;

    const result = await consumeReferralCookie(newUser.id);

    expect(result).toBe(referrerOrgId);
    expect(mockDelete).toHaveBeenCalledWith("ref");
  });

  it("same user id (self-referral) → null even though the code resolves", async () => {
    const owner = await seedUser();
    const referrerOrgId = await seedOrgFor(owner.id);
    const code = await getOrCreateReferralCode(referrerOrgId);
    mockCookieValue = code;

    expect(await consumeReferralCookie(owner.id)).toBeNull();
    expect(mockDelete).toHaveBeenCalledWith("ref");
  });

  it("same email, different user id (case-insensitive) → null", async () => {
    // users.email's unique index is case-sensitive btree, so two DIFFERENT
    // user rows can carry the same address in different casing — exactly
    // the loophole the case-insensitive email compare in the guard closes.
    // The local-part is randomized (not just the casing) so a re-run against
    // this persistent test DB never collides with a prior run's row.
    const local = `samecase-${randomUUID().slice(0, 8)}`;
    const owner = await seedUser(`${local}@Example.com`);
    const referrerOrgId = await seedOrgFor(owner.id);
    const code = await getOrCreateReferralCode(referrerOrgId);
    const impostor = await seedUser(`${local}@example.com`);
    mockCookieValue = code;

    expect(await consumeReferralCookie(impostor.id)).toBeNull();
    expect(mockDelete).toHaveBeenCalledWith("ref");
  });
});

describe.skipIf(!HAS_DB)("end-to-end attribution through createOrgForUser (#267 T2)", () => {
  it("B (distinct email) referred by A's code → B's org stamped; A referring itself is not", async () => {
    const ownerA = await seedUser();
    const orgA = await seedOrgFor(ownerA.id, "Org A");
    const code = await getOrCreateReferralCode(orgA);

    // B lands via /refer/<code>, the cookie is set, then B creates an org.
    const userB = await seedUser();
    mockCookieValue = code;
    const referredByOrgId = await consumeReferralCookie(userB.id);
    const orgB = await createOrgForUser(userB.id, "Org B", { referredByOrgId });

    const [rowB] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${orgB.id}`;
    expect(rowB.referred_by_org_id).toBe(orgA);

    // A tries to use its own referral code for a second org — self-referral,
    // never stamped. Community caps orgs.max_owned at 1 and A already owns
    // orgA, so an unlimited override is needed purely to get PAST the quota
    // and exercise the stamp — orthogonal to the referral guard under test.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgA}, 'orgs.max_owned', null)`;
    await invalidateOrgEntitlements(orgA);

    mockCookieValue = code;
    const selfReferredByOrgId = await consumeReferralCookie(ownerA.id);
    expect(selfReferredByOrgId).toBeNull();
    const orgA2 = await createOrgForUser(ownerA.id, "Org A2", { referredByOrgId: selfReferredByOrgId });

    const [rowA2] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${orgA2.id}`;
    expect(rowA2.referred_by_org_id).toBeNull();
  });
});
