// The org-less billing group nothing retired (#375, split out of #367).
//
// Real Postgres, mocked Stripe. The mock is deliberately STRICT: it throws for
// any subscription id this file did not seed. `sweepOrphanGroups` is a
// schema-wide sweep and the suite runs files in parallel against one shared
// schema, so a permissive mock would let it write a canned status onto rows
// belonging to other suites. A throw lands those in `failed`, which writes
// nothing — the blast radius is zero, and the assertions below stay about our
// own rows rather than about counts nobody controls (#321).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const subs = vi.hoisted(() => new Map<string, unknown>());
const retrieved = vi.hoisted(() => [] as string[]);
const cancelled = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => {
        retrieved.push(id);
        const sub = subs.get(id);
        if (!sub) throw new Error(`no such subscription: ${id}`);
        return sub;
      },
      cancel: async (id: string) => {
        cancelled.push(id);
        return subs.get(id);
      },
    },
  }),
}));

import { sql } from "@/lib/db";
import { sweepOrphanGroups } from "@/server/usecases/billing-groups";

const TAG = randomUUID().slice(0, 8);

/** A Stripe subscription with no items: `planItem` answers null, so the sync
 *  keeps whatever plan the row already holds instead of resolving a price. The
 *  status is the only thing these tests are about. */
function fakeSub(id: string, status: string): Stripe.Subscription {
  return {
    id,
    status,
    items: { data: [] },
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    customer: `cus_${id}`,
    default_payment_method: null,
  } as unknown as Stripe.Subscription;
}

/** The payer every fixture group belongs to. `subscriptions.owner_user_id` is
 *  NOT NULL — a group always has somebody paying it, even an abandoned one. */
let ownerId = "";
async function owner(): Promise<string> {
  if (ownerId) return ownerId;
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`orphan-owner-${TAG}@test.local`}, 'Orphan Owner', true) returning id`;
  ownerId = u!.id;
  return ownerId;
}

/** A billing group with a Stripe id, a status, and NO organisations. */
async function seedOrphan(
  status: string,
  opts: { stripeStatus?: string; agedDays?: number; stripeMissing?: boolean } = {},
): Promise<{ id: string; stripeId: string }> {
  const s = `${TAG}-${randomUUID().slice(0, 6)}`;
  const stripeId = `sub_orphan_${s}`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid,
                               stripe_subscription_id, stripe_customer_id, trial_used_at)
    values (${await owner()}, 'pro', ${status}, 1, ${stripeId}, ${`cus_${s}`}, now())
    returning id`;
  // updated_at is `now()` on insert, and the sweep only looks at rows untouched
  // for a day — so every fixture that should be SELECTED has to be aged here.
  const days = opts.agedDays ?? 2;
  await sql`update subscriptions set updated_at = now() - (${days} || ' days')::interval
             where id = ${id}`;
  if (!opts.stripeMissing) subs.set(stripeId, fakeSub(stripeId, opts.stripeStatus ?? status));
  return { id, stripeId };
}

async function row(id: string) {
  const [r] = await sql<
    {
      status: string;
      plan_key: string;
      stripe_subscription_id: string | null;
      stripe_customer_id: string | null;
      trial_used_at: string | null;
    }[]
  >`
    select status, plan_key, stripe_subscription_id, stripe_customer_id, trial_used_at
      from subscriptions where id = ${id}`;
  return r!;
}

beforeEach(() => {
  retrieved.length = 0;
  cancelled.length = 0;
});

afterAll(async () => {
  await sql`delete from subscriptions where stripe_subscription_id like ${`sub_orphan_${TAG}%`}`;
  if (ownerId) await sql`delete from users where id = ${ownerId}`;
});

describe.skipIf(!process.env.DATABASE_URL)("sweepOrphanGroups (#375)", () => {
  it("retires an abandoned checkout in place once Stripe says it expired", async () => {
    // The exact state the issue is about: `cancelGroupIfEmpty` declined this row
    // because `incomplete` is outside the set it cancels, and nothing else looks
    // at it. Stripe voided the invoice and expired the subscription hours later.
    const { id, stripeId } = await seedOrphan("incomplete", {
      stripeStatus: "incomplete_expired",
    });

    const res = await sweepOrphanGroups();

    expect(retrieved).toContain(stripeId);
    expect(res.retired).toBeGreaterThanOrEqual(1);
    const after = await row(id);
    // `canceled`, not `incomplete_expired` — the sweep writes through
    // STATUS_MAP's one translation rather than carrying a second copy of it.
    expect(after.status).toBe("canceled");
    // IN PLACE: the identity the row exists to carry survives. Dropping it would
    // clear trial_used_at and hand the payer a fresh trial for the price of
    // abandoning an unpaid checkout (#241's farm, on a different path).
    expect(after.stripe_subscription_id).toBe(stripeId);
    expect(after.stripe_customer_id).not.toBeNull();
    expect(after.trial_used_at).not.toBeNull();
    // Nothing is cancelled at Stripe: it is already dead there.
    expect(cancelled).toEqual([]);
  });

  it("does not cancel a subscription Stripe still calls live — it raises it", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { id, stripeId } = await seedOrphan("incomplete", { stripeStatus: "active" });

      const res = await sweepOrphanGroups();

      expect(res.stillLive).toBeGreaterThanOrEqual(1);
      // The row is corrected to Stripe's answer — a group claiming `incomplete`
      // while Stripe bills it monthly is drift in the expensive direction.
      expect((await row(id)).status).toBe("active");
      // But the subscription itself is left alone. An unattended cancel of a
      // paying customer's subscription is not a sweep's call to make.
      expect(cancelled).toEqual([]);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("live and billing for nobody")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a group that still has an organisation alone", async () => {
    // The canary against a predicate that selects everything: without this, a
    // sweep that ignored the org count would pass every other test here.
    const { id, stripeId } = await seedOrphan("incomplete", {
      stripeStatus: "incomplete_expired",
    });
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`orphan-sweep-${TAG}@test.local`}, 'Orphan Probe', true) returning id`;
    await sql`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`Orphan Probe ${TAG}`}, ${`orphan-probe-${TAG}`}, ${userId}, ${id})`;
    try {
      await sweepOrphanGroups();
      expect(retrieved).not.toContain(stripeId);
      expect((await row(id)).status).toBe("incomplete");
    } finally {
      await sql`delete from organizations where subscription_id = ${id}`;
      await sql`delete from users where id = ${userId}`;
    }
  });

  it("leaves a row touched within the last day alone", async () => {
    // A detach in flight, or a checkout the customer is still paying: Stripe has
    // 23 hours to expire an `incomplete` subscription, so anything younger than
    // a day has not reached its final answer yet.
    const { id, stripeId } = await seedOrphan("incomplete", {
      stripeStatus: "incomplete_expired",
      agedDays: 0,
    });
    await sweepOrphanGroups();
    expect(retrieved).not.toContain(stripeId);
    expect((await row(id)).status).toBe("incomplete");
  });

  it("leaves an already-cancelled group alone", async () => {
    // The wider net the issue warned about: an org-less `canceled` group is
    // every ordinary cancellation ever made, and there is nothing left to
    // retire. Selecting it would cost a Stripe read per cancelled customer, for
    // ever, to change nothing.
    const { id, stripeId } = await seedOrphan("canceled");
    await sweepOrphanGroups();
    expect(retrieved).not.toContain(stripeId);
    expect((await row(id)).status).toBe("canceled");
  });

  it("leaves the row untouched when Stripe cannot be read", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { id } = await seedOrphan("incomplete", { stripeMissing: true });
      const res = await sweepOrphanGroups();
      expect(res.failed).toBeGreaterThanOrEqual(1);
      // Writing `canceled` off a FAILED read is the guess this refuses to make:
      // a key with the wrong mode, or a transient 500, would otherwise retire
      // live groups in bulk.
      expect((await row(id)).status).toBe("incomplete");
    } finally {
      err.mockRestore();
    }
  });
});
