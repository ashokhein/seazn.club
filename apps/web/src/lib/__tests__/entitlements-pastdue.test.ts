// past_due read-time grace (payments-hardening Task 9, spec P1-6).
//
// A subscription can sit in status='past_due' indefinitely (missed webhook,
// Stripe retries exhausted) and would otherwise keep paid entitlements forever.
// The entitlements resolver gives dunning a 14-day grace window, then degrades
// reads to the community matrix until an invoice succeeds (which flips status
// back to active). Read-time only — no cron, no writes; the 5-min entitlements
// cache bounds staleness, exactly like the comped_until read-time flip in the
// same CASE.
//
// Non-community plans are generic — pro AND pro_plus must degrade identically.
//
// NOTE on the feature key: the spec brief names `exports`, but in this schema
// `exports` is true for EVERY plan (community included, since the v12
// free-plain-exports change), so it can't observe a pro→community degradation.
// `exports.branded` is the Pro-gated export feature (true for pro/pro_plus,
// false for community) and is used here to actually detect the flip. Plain
// `exports` staying true is asserted alongside to prove reads land on the
// COMMUNITY matrix (a degrade), not a blanket deny.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Seed an org + a subscription with an explicit status and updated_at age
 *  (days before DB now(), computed server-side to avoid JS/DB clock skew). */
async function seedSubOrg(over: {
  plan: string;
  status: string;
  daysAgo: number;
}): Promise<string> {
  const suffix = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`pastdue-${suffix}@test.local`}, 'PastDue Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"PastDue Org " + suffix}, ${"pastdue-org-" + suffix}, ${ownerId}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status, stripe_subscription_id, updated_at)
    values (${orgId}, ${over.plan}, ${over.status}, ${"sub_" + suffix},
            now() - (${over.daysAgo} * interval '1 day'))`;
  return orgId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("past_due read-time grace (P1-6)", () => {
  it("pro past_due beyond the 14-day grace degrades to community", async () => {
    const orgId = await seedSubOrg({ plan: "pro", status: "past_due", daysAgo: 20 });
    expect(await hasFeature(orgId, "exports.branded")).toBe(false); // Pro gate revoked
    expect(await hasFeature(orgId, "exports")).toBe(true); // lands on community matrix, not a deny
  });

  it("pro past_due within the grace window keeps paid entitlements", async () => {
    const orgId = await seedSubOrg({ plan: "pro", status: "past_due", daysAgo: 2 });
    expect(await hasFeature(orgId, "exports.branded")).toBe(true);
  });

  it("pro_plus past_due beyond grace degrades to community (plan-generic)", async () => {
    const orgId = await seedSubOrg({ plan: "pro_plus", status: "past_due", daysAgo: 20 });
    expect(await hasFeature(orgId, "exports.branded")).toBe(false);
    expect(await hasFeature(orgId, "exports")).toBe(true);
  });

  it("pro_plus past_due within grace keeps paid entitlements (plan-generic)", async () => {
    const orgId = await seedSubOrg({ plan: "pro_plus", status: "past_due", daysAgo: 2 });
    expect(await hasFeature(orgId, "exports.branded")).toBe(true);
  });

  it("at the 14-day boundary the grace has lapsed (<=) — degrades", async () => {
    // Seeded at now()-14d; by read time DB now() has advanced past the boundary.
    const orgId = await seedSubOrg({ plan: "pro", status: "past_due", daysAgo: 14 });
    expect(await hasFeature(orgId, "exports.branded")).toBe(false);
  });

  it("an old but ACTIVE sub is untouched — only past_due degrades", async () => {
    const orgId = await seedSubOrg({ plan: "pro", status: "active", daysAgo: 60 });
    expect(await hasFeature(orgId, "exports.branded")).toBe(true);
  });
});
