// The Stripe-facing arms of extendTrial. admin-plan.test.ts covers the comped
// paths and never touches Stripe; this file mocks it so we can assert both
// that the trialing arm calls subscriptions.update and — just as important —
// that the arms which must NOT call it never do.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const subscriptionUpdate = vi.fn();
  return { subscriptionUpdate, stripe: { subscriptions: { update: subscriptionUpdate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { extendTrial } from "@/server/usecases/admin-plan";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"AdmS " + s}, ${"adms-" + s}) returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active') on conflict (org_id) do nothing`;
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${"staffs-" + s + "@test.local"}, 'Staff', true, 'superadmin') returning id`;
  return { orgId, actorId };
}

beforeEach(() => {
  stripeMock.subscriptionUpdate.mockReset().mockResolvedValue({ id: "sub_ok" });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("extendTrial Stripe arms", () => {
  it("pushes trial_end into Stripe for a live trialing sub and leaves comped_until alone", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_trialing', status = 'trialing',
                     plan_key = 'pro'
               where org_id = ${orgId}`;

    const end = await extendTrial(actorId, orgId, 7, "sales call");

    expect(stripeMock.subscriptionUpdate).toHaveBeenCalledTimes(1);
    const [subId, params] = stripeMock.subscriptionUpdate.mock.calls[0];
    expect(subId).toBe("sub_trialing");
    expect(params.trial_end).toBe(Math.floor(new Date(end).getTime() / 1000));
    expect(params.proration_behavior).toBe("none");

    // plan_key would be a vacuous probe here: the seed sets 'pro', the live arm
    // never writes it. What needs proving is that the PINNED local UPDATE ran at
    // all — a pin that matched nothing would leave the row untouched and be
    // invisible otherwise.
    const [row] = await sql<{
      comped_until: string | null; trial_end: string | null; trial_used_at: string | null;
    }[]>`
      select comped_until, trial_end, trial_used_at from subscriptions where org_id = ${orgId}`;
    expect(row.comped_until).toBeNull(); // the subscription owns the lifecycle
    expect(row.trial_end).not.toBeNull();
    expect(new Date(row.trial_end as string).toISOString()).toBe(end);
    expect(row.trial_used_at).not.toBeNull(); // V277 stamp, written by the same UPDATE
  });

  it("never calls Stripe for a cancelled subscription that kept its id", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_dead', status = 'canceled'
               where org_id = ${orgId}`;
    await extendTrial(actorId, orgId, 7, "win-back");
    expect(stripeMock.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("never calls Stripe for the refused arms", async () => {
    for (const status of ["active", "past_due"]) {
      const { orgId, actorId } = await seedOrg();
      await sql`update subscriptions
                   set stripe_subscription_id = ${"sub_" + status}, status = ${status}
                 where org_id = ${orgId}`;
      await expect(extendTrial(actorId, orgId, 7, "gift")).rejects.toThrow(/Stripe/i);
    }
    expect(stripeMock.subscriptionUpdate).not.toHaveBeenCalled();
  });
});
