// Which billing GROUP does a customer.subscription.* webhook write to? (V310)
//
// Before billing groups a subscription belonged to exactly one org, so the
// webhook could resolve through `metadata.org_id → that org's subscription`.
// It cannot any more: many orgs share one group and an org can MOVE between
// groups (detach), after which its stamp names a group it no longer bills
// through. Resolving through it would overwrite a different customer's plan,
// status and period end — silently, with no error to notice.
//
// So resolution is a chain: the durable `metadata.subscription_id` stamp, then
// the stored stripe_subscription_id, then the stripe_customer_id, and only then
// the legacy org_id. This file pins each rung AND the ordering between them —
// the moved-org test below fails if the legacy rung is consulted any earlier.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { processStripeEvent } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Group {
  subId: string;
  orgId: string;
  payerId: string;
}

/** One group, one org pointing at it. Stripe ids are opt-in so each test can
 *  seed exactly the rungs of the chain it means to exercise. */
async function seedGroup(
  over: {
    plan?: string;
    status?: string;
    stripeSubId?: string | null;
    stripeCustomerId?: string | null;
  } = {},
): Promise<Group> {
  const s = uniq();
  const [{ id: payerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`grp-res-${s}@test.local`}, 'Resolution Payer', true) returning id`;
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, stripe_subscription_id, stripe_customer_id)
    values (${payerId}, ${over.plan ?? "pro"}, ${over.status ?? "active"},
            ${over.stripeSubId ?? null}, ${over.stripeCustomerId ?? null})
    returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${"Res Org " + s}, ${"res-org-" + s}, ${payerId}, ${subId}) returning id`;
  return { subId, orgId, payerId };
}

/** Move an org onto another group — what detach will do. */
async function moveOrgToGroup(orgId: string, subscriptionId: string): Promise<void> {
  await sql`update organizations set subscription_id = ${subscriptionId} where id = ${orgId}`;
}

const readGroup = async (subscriptionId: string) =>
  (
    await sql<
      {
        plan_key: string;
        status: string;
        stripe_subscription_id: string | null;
        current_period_end: Date | null;
      }[]
    >`select plan_key, status, stripe_subscription_id, current_period_end
        from subscriptions where id = ${subscriptionId}`
  )[0];

/** Minimal Stripe.Subscription + event wrapper. The price is deliberately
 *  UNKNOWN to `plans`, so syncSubscription preserves plan_key and `status` is
 *  the field that proves whether the write landed. */
function subEvent(
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  over: {
    id: string;
    status?: Stripe.Subscription.Status;
    customer?: string | null;
    metadata?: Record<string, string>;
  },
): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type,
    data: {
      object: {
        id: over.id,
        status: over.status ?? "past_due",
        customer: over.customer ?? null,
        metadata: over.metadata ?? {},
        trial_end: null,
        cancel_at_period_end: false,
        currency: "usd",
        items: {
          data: [
            {
              price: { id: "price_unknown_" + uniq() },
              current_period_end: Math.floor(Date.now() / 1000) + 86_400,
            },
          ],
        },
      },
    },
  } as unknown as Stripe.Event;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("webhook → billing group resolution", () => {
  it("(a) resolves via the metadata.subscription_id stamp", async () => {
    const stripeSubId = "sub_stamp_" + uniq();
    const group = await seedGroup({ stripeSubId });
    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: stripeSubId,
        metadata: { subscription_id: group.subId, org_id: group.orgId },
      }),
    );
    expect((await readGroup(group.subId)).status).toBe("past_due");
  });

  it("(a) prefers the stamp over the org_id, even when they disagree", async () => {
    // The stamp names group 1; the org_id names an org that bills through
    // group 2. Only the stamped group may be written.
    const stripeSubId = "sub_stamp2_" + uniq();
    const stamped = await seedGroup({ stripeSubId });
    const other = await seedGroup({ status: "active" });
    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: stripeSubId,
        metadata: { subscription_id: stamped.subId, org_id: other.orgId },
      }),
    );
    expect((await readGroup(stamped.subId)).status).toBe("past_due");
    expect((await readGroup(other.subId)).status).toBe("active");
  });

  it("(b) resolves via the stored stripe_subscription_id when there is no stamp", async () => {
    // The whole pre-stamp population looks like this: Stripe metadata cannot be
    // back-filled, so without this rung every legacy customer falls to (d).
    const stripeSubId = "sub_stored_" + uniq();
    const group = await seedGroup({ stripeSubId });
    await processStripeEvent(
      subEvent("customer.subscription.updated", { id: stripeSubId, metadata: {} }),
    );
    expect((await readGroup(group.subId)).status).toBe("past_due");
  });

  it("(c) resolves via the stripe_customer_id when stamp and stored sub id are absent", async () => {
    const customer = "cus_res_" + uniq();
    const group = await seedGroup({ stripeSubId: null, stripeCustomerId: customer });
    const stripeSubId = "sub_bycust_" + uniq();
    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: stripeSubId,
        customer,
        metadata: {},
      }),
    );
    const after = await readGroup(group.subId);
    expect(after.status).toBe("past_due");
    expect(after.stripe_subscription_id).toBe(stripeSubId);
  });

  it("(d) falls back to metadata.org_id for a legacy row, and says so", async () => {
    const group = await seedGroup({ stripeSubId: null, stripeCustomerId: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await processStripeEvent(
        subEvent("customer.subscription.updated", {
          id: "sub_legacy_" + uniq(),
          metadata: { org_id: group.orgId },
        }),
      );
      expect((await readGroup(group.subId)).status).toBe("past_due");
      // Observable, so the un-stamped population can eventually be retired.
      expect(warn.mock.calls.flat().join(" ")).toMatch(/LEGACY metadata\.org_id/);
    } finally {
      warn.mockRestore();
    }
  });

  it("resolves nothing — and writes nothing — when every rung misses", async () => {
    const group = await seedGroup({ stripeSubId: null });
    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: "sub_orphan_" + uniq(),
        customer: "cus_unknown_" + uniq(),
        metadata: {},
      }),
    );
    expect((await readGroup(group.subId)).status).toBe("active");
  });
});

describe.skipIf(!HAS_DB)("webhook → an org that MOVED groups", () => {
  // The reason this whole chain exists. Detach leaves org A carrying the
  // metadata stamp of the group it used to be in, while it bills through a new
  // one; the old group's subscription keeps sending events naming that org.
  it("an event naming a moved org writes the SUBSCRIPTION's group, never the org's new one", async () => {
    const stripeSubId = "sub_moved_" + uniq();
    // Group 1: the paying group the subscription actually belongs to.
    const paying = await seedGroup({ plan: "pro", status: "active", stripeSubId });
    // Group 2: where the org went. Fresh and never billed — so a mis-resolution
    // would find nothing to bounce off and would corrupt it outright.
    const landed = await seedGroup({ plan: "community", status: "active", stripeSubId: null });
    await moveOrgToGroup(paying.orgId, landed.subId);

    // Legacy event: the org_id stamp only, from before subscription_id existed.
    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: stripeSubId,
        status: "past_due",
        metadata: { org_id: paying.orgId },
      }),
    );

    // Resolved by (b), the subscription's own id — the group that owes the money.
    expect((await readGroup(paying.subId)).status).toBe("past_due");
    // The group the org moved to is untouched: not its subscription, not its
    // status, not its period end. This is the assertion that fails if the
    // legacy org_id rung is consulted any earlier in the chain.
    const after = await readGroup(landed.subId);
    expect(after.status).toBe("active");
    expect(after.plan_key).toBe("community");
    expect(after.stripe_subscription_id).toBeNull();
    expect(after.current_period_end).toBeNull();
  });

  it("a DELETE naming a moved org does not cancel the group it moved to", async () => {
    const stripeSubId = "sub_moveddel_" + uniq();
    const paying = await seedGroup({ plan: "pro", status: "active", stripeSubId });
    const landed = await seedGroup({ plan: "pro", status: "active", stripeSubId: null });
    await moveOrgToGroup(paying.orgId, landed.subId);

    await processStripeEvent(
      subEvent("customer.subscription.deleted", {
        id: stripeSubId,
        status: "canceled",
        metadata: { org_id: paying.orgId },
      }),
    );

    expect((await readGroup(paying.subId)).status).toBe("canceled");
    const after = await readGroup(landed.subId);
    expect(after.status).toBe("active");
    expect(after.plan_key).toBe("pro");
  });
});

describe.skipIf(!HAS_DB)("webhook → refuses a demonstrably wrong row", () => {
  it("does not write when the resolved group bills a DIFFERENT subscription", async () => {
    // Resolved by customer: the group is live on sub_current, and an unrelated
    // subscription on the same customer must not overwrite it.
    const customer = "cus_conflict_" + uniq();
    const group = await seedGroup({
      plan: "pro",
      status: "active",
      stripeSubId: "sub_current_" + uniq(),
      stripeCustomerId: customer,
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processStripeEvent(
        subEvent("customer.subscription.updated", {
          id: "sub_other_" + uniq(),
          customer,
          metadata: {},
        }),
      );
      expect(err.mock.calls.flat().join(" ")).toMatch(/REFUSING to write group/);
    } finally {
      err.mockRestore();
    }
    expect((await readGroup(group.subId)).status).toBe("active");
  });

  it("still lets a stamped RE-BUY replace the group's cancelled subscription", async () => {
    // The one legitimate mismatch: a cancelled sub id stays on the row for ever,
    // and the new purchase carries the same group stamp.
    const group = await seedGroup({
      plan: "community",
      status: "canceled",
      stripeSubId: "sub_dead_" + uniq(),
    });
    const rebuy = "sub_rebuy_" + uniq();
    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: rebuy,
        status: "active",
        metadata: { subscription_id: group.subId, org_id: group.orgId },
      }),
    );
    const after = await readGroup(group.subId);
    expect(after.stripe_subscription_id).toBe(rebuy);
    expect(after.status).toBe("active");
  });
});
