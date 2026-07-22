// The Stripe-facing arms of extendTrial. admin-plan.test.ts covers the comped
// paths and never touches Stripe; this file mocks it so we can assert both
// that the trialing arm calls subscriptions.update and — just as important —
// that the arms which must NOT call it never do.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const subscriptionUpdate = vi.fn();
  return {
    subscriptionUpdate,
    stripe: { subscriptions: { update: subscriptionUpdate } },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { extendTrial } from "@/server/usecases/admin-plan";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<{ orgId: string; actorId: string }> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"AdmS " + s}, ${"adms-" + s}) returning id`;
  await setOrgPlan(orgId, "community");
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
               where id = (select subscription_id from organizations where id = ${orgId})`;

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
    const [row] = await sql<
      {
        comped_until: string | null;
        trial_end: string | null;
        trial_used_at: string | null;
      }[]
    >`
      select comped_until, trial_end, trial_used_at from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
    expect(row.comped_until).toBeNull(); // the subscription owns the lifecycle
    expect(row.trial_end).not.toBeNull();
    expect(new Date(row.trial_end as string).toISOString()).toBe(end);
    expect(row.trial_used_at).not.toBeNull(); // V277 stamp, written by the same UPDATE
  });

  // The real race, not a simulation of a tighter pin: the webhook cancels the
  // subscription WHILE the Stripe call is in flight. handleSubscriptionDeleted
  // moves STATUS and leaves the id intact, so only the status conjunct of the
  // pin can catch this — deleting it lets the write resurrect the row to
  // 'trialing' and this test reds.
  it("skips the local write when a cancellation lands during the Stripe call", async () => {
    const { orgId, actorId } = await seedOrg();
    // Backdate trial_end so "unchanged" cannot pass by colliding with the value
    // the unpinned write would have produced (now + 7 days).
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_racing', status = 'trialing',
                     plan_key = 'pro', trial_end = now() - interval '30 days'
               where id = (select subscription_id from organizations where id = ${orgId})`;
    const [seeded] = await sql<{ trial_end: string | null; status: string }[]>`
      select trial_end, status from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
    expect(seeded.trial_end).not.toBeNull();
    expect(seeded.status).toBe("trialing"); // the arm under test is the live one

    stripeMock.subscriptionUpdate.mockImplementation(async () => {
      // The racing webhook: status moves, the id stays.
      await sql`update subscriptions set status = 'canceled' where id = (select subscription_id from organizations where id = ${orgId})`;
      return { id: "sub_racing" };
    });

    await extendTrial(actorId, orgId, 7, "sales call");

    expect(stripeMock.subscriptionUpdate).toHaveBeenCalledTimes(1);
    const [after] = await sql<
      {
        trial_end: string | null;
        status: string;
        stripe_subscription_id: string | null;
      }[]
    >`
      select trial_end, status, stripe_subscription_id
        from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
    expect(after.status).toBe("canceled"); // the webhook's truth stands
    expect(after.stripe_subscription_id).toBe("sub_racing");
    expect(new Date(after.trial_end as string).getTime()).toBe(
      new Date(seeded.trial_end as string).getTime(),
    );

    const [audit] = await sql<{ detail: { local_write_skipped?: boolean } }[]>`
      select detail from staff_audit_log
      where target_id = ${orgId} and action = 'extend_trial'
      order by created_at desc limit 1`;
    expect(audit.detail.local_write_skipped).toBe(true);
  });

  it("never calls Stripe for a cancelled subscription that kept its id", async () => {
    const { orgId, actorId } = await seedOrg();
    await sql`update subscriptions
                 set stripe_subscription_id = 'sub_dead', status = 'canceled'
               where id = (select subscription_id from organizations where id = ${orgId})`;
    await extendTrial(actorId, orgId, 7, "win-back");
    expect(stripeMock.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("never calls Stripe for the refused arms", async () => {
    for (const status of ["active", "past_due"]) {
      const { orgId, actorId } = await seedOrg();
      await sql`update subscriptions
                   set stripe_subscription_id = ${"sub_" + status}, status = ${status}
                 where id = (select subscription_id from organizations where id = ${orgId})`;
      await expect(extendTrial(actorId, orgId, 7, "gift")).rejects.toThrow(/Stripe/i);
    }
    expect(stripeMock.subscriptionUpdate).not.toHaveBeenCalled();
  });
});
