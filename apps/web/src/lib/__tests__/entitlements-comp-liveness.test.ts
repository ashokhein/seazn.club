// The comp-expiry arm's status list is DERIVED from LIVE_SUBSCRIPTION_STATUSES,
// not hand-written in SQL. This suite is the enforcement: it iterates the
// exported array, so adding a status to the array without the SQL following
// would fail here rather than silently leaving a grant running for ever (or
// 409-ing a live org out of checkout — the same defect class, three times over).
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, hasFeature } from "@/lib/entitlements";

// Proof that the degrade landed on COMMUNITY rather than merely losing a Pro
// flag. `exports` is true on both matrices (V285), so asserting it holds for
// every plan_key the CASE can return and cannot fail; competitions.max_active
// is 1 on community and unlimited (null) on pro, so it genuinely separates them.
const COMMUNITY_MAX_ACTIVE = 1;
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Seed a pro org whose comp/grant has already lapsed (comped_until in the
 *  past), with an explicit subscription status and a stripe id unless told
 *  otherwise. `statusChangedDaysAgo` positions the past_due grace anchor. */
async function seedLapsedComp(over: {
  status: string;
  withStripeId?: boolean;
  statusChangedDaysAgo?: number;
}): Promise<string> {
  const suffix = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`compliv-${suffix}@test.local`}, 'Comp Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Comp Org " + suffix}, ${"comp-org-" + suffix}, ${ownerId}) returning id`;
  await sql`
    insert into subscriptions
      (org_id, plan_key, status, stripe_subscription_id, comped_until, status_changed_at)
    values (${orgId}, 'pro', ${over.status},
            ${over.withStripeId === false ? null : "sub_" + suffix},
            now() - interval '1 day',
            now() - (${over.statusChangedDaysAgo ?? 1} * interval '1 day'))`;
  return orgId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("comp-expiry arm derives its status list from billing", () => {
  // The tie-proof: parameterised over the array itself.
  for (const status of LIVE_SUBSCRIPTION_STATUSES) {
    it(`a live '${status}' subscription still owns the plan despite a lapsed comped_until`, async () => {
      const orgId = await seedLapsedComp({ status });
      expect(await hasFeature(orgId, "exports.branded")).toBe(true);
    });
  }

  it("a terminal 'canceled' subscription lets the lapsed comp expire", async () => {
    const orgId = await seedLapsedComp({ status: "canceled" });
    expect(await hasFeature(orgId, "exports.branded")).toBe(false);
    // Community matrix, not a blanket deny — pro is unlimited here.
    expect(await getLimit(orgId, "competitions.max_active")).toBe(COMMUNITY_MAX_ACTIVE);
  });

  // subscriptions.status is NOT NULL, so a null status only reaches this CASE
  // via the LEFT JOIN (no subscription row) — where comped_until is null too and
  // the arm cannot fire. The coalesce therefore cannot be observed from the DB;
  // it stays as the guard for any future nullable status, since a bare NOT IN
  // over NULL yields NULL rather than true and would kill the arm silently.

  // 'suspended' is written by api/admin/orgs/[id]/suspend and is in no
  // STATUS_MAP — the column's vocabulary is wider than Stripe's. The arm negates
  // the live list rather than naming dead statuses precisely so non-Stripe
  // statuses like this one degrade too; hand-written dead-status SQL would miss it.
  it("a non-Stripe 'suspended' status lets the lapsed comp expire", async () => {
    const orgId = await seedLapsedComp({ status: "suspended" });
    expect(await hasFeature(orgId, "exports.branded")).toBe(false);
    expect(await getLimit(orgId, "competitions.max_active")).toBe(COMMUNITY_MAX_ACTIVE);
  });

  it("no stripe id at all (pure staff grant) expires on comped_until", async () => {
    const orgId = await seedLapsedComp({ status: "canceled", withStripeId: false });
    expect(await hasFeature(orgId, "exports.branded")).toBe(false);
  });

  it("does not swallow the past_due grace arm — dunning past 14 days still degrades", async () => {
    // Live per the list above, so the comp arm exempts it; the NEXT arm must
    // still see it and degrade. Ordering regression guard.
    const orgId = await seedLapsedComp({ status: "past_due", statusChangedDaysAgo: 20 });
    expect(await hasFeature(orgId, "exports.branded")).toBe(false);
    expect(await getLimit(orgId, "competitions.max_active")).toBe(COMMUNITY_MAX_ACTIVE);
  });
});
