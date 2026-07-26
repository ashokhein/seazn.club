// Pass-to-Pro credit, subscription-created/updated arm (grant timing moved
// 2026-07-26 — see
// docs/superpowers/specs/2026-07-26-pass-credit-redemption-design.md §1).
// handleSubscriptionChanged is the webhook half of "learn a subscription
// started"; lib/billing.ts reconcileCheckout (own test file) is the other.
//
// creditPassTowardSubscription itself — the decision logic, the Stripe reads,
// the redemption row — is fully pinned in pass-credit.test.ts /
// pass-credit.live.test.ts. All that is testable HERE is the wiring: which
// org gets offered a credit attempt, and when the handler must not even try.
//
// Real Postgres required; skipped without DATABASE_URL. Fixture helpers mirror
// billing-webhook-group-resolution.test.ts (same file resolves the group this
// event writes to).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const creditMock = vi.hoisted(() => vi.fn(async () => ({ outcome: "no_pass" as const })));
vi.mock("@/server/usecases/pass-credit", () => ({
  creditPassTowardSubscription: creditMock,
}));

import { sql } from "@/lib/db";
import { processStripeEvent } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Group {
  subId: string;
  orgId: string;
}

/** One group, one org pointing at it — same shape as
 *  billing-webhook-group-resolution.test.ts's seedGroup. */
async function seedGroup(
  over: { status?: string; stripeSubId?: string | null; stripeCustomerId?: string | null } = {},
): Promise<Group> {
  const s = uniq();
  const [{ id: payerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`pc-evt-${s}@test.local`}, 'Pass Credit Payer', true) returning id`;
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions
      (owner_user_id, plan_key, status, stripe_subscription_id, stripe_customer_id)
    values (${payerId}, 'pro', ${over.status ?? "active"}, ${over.stripeSubId ?? null},
            ${over.stripeCustomerId ?? null})
    returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${"PC Evt Org " + s}, ${"pc-evt-org-" + s}, ${payerId}, ${subId}) returning id`;
  return { subId, orgId };
}

/** Minimal Stripe.Subscription + event wrapper, same shape as
 *  billing-webhook-group-resolution.test.ts's subEvent. Unknown price so
 *  syncSubscription preserves plan_key rather than touching `plans`. */
function subEvent(
  type: "customer.subscription.created" | "customer.subscription.updated",
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
        status: over.status ?? "active",
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

beforeEach(() => {
  creditMock.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("handleSubscriptionChanged → pass-to-Pro credit wiring", () => {
  it("customer.subscription.created carrying org_id triggers a credit attempt for that org", async () => {
    const stripeSubId = "sub_pc_created_" + uniq();
    const group = await seedGroup({ stripeSubId });

    await processStripeEvent(
      subEvent("customer.subscription.created", {
        id: stripeSubId,
        metadata: { subscription_id: group.subId, org_id: group.orgId },
      }),
    );

    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledWith(group.orgId);
  });

  it("customer.subscription.updated carrying org_id also triggers a credit attempt", async () => {
    // Unconditional by design (see the comment in billing-events.ts): the
    // group's one-lifetime-credit cap is enforced by groupAlreadyRedeemed
    // inside creditPassTowardSubscription, not by gating which event types are
    // allowed to attempt it — so an ordinary .updated (a seat change, a
    // dunning retry) attempts exactly like .created.
    const stripeSubId = "sub_pc_updated_" + uniq();
    const group = await seedGroup({ stripeSubId });

    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: stripeSubId,
        metadata: { subscription_id: group.subId, org_id: group.orgId },
      }),
    );

    expect(creditMock).toHaveBeenCalledTimes(1);
    expect(creditMock).toHaveBeenCalledWith(group.orgId);
  });

  it("does NOT attempt a credit when mayWriteGroup refuses the event", async () => {
    // Resolved via the CUSTOMER rung (no subscription_id stamp), where a
    // mismatch is never legitimate — unlike the stamped rung's re-buy
    // exemption (billing-webhook-group-resolution.test.ts "refuses a
    // demonstrably wrong row" pins the same refusal). The group is live on
    // sub_current; an unrelated subscription on the same customer must not
    // write it, and the credit attempt must not fire either — org_id is
    // present, but mayWriteGroup returning false has to short-circuit
    // handleSubscriptionChanged before the credit attempt, exactly like it
    // already does before syncSubscriptionForGroup.
    const customer = "cus_pc_conflict_" + uniq();
    const group = await seedGroup({
      stripeSubId: "sub_pc_current_" + uniq(),
      stripeCustomerId: customer,
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processStripeEvent(
        subEvent("customer.subscription.updated", {
          id: "sub_pc_other_" + uniq(),
          customer,
          metadata: { org_id: group.orgId }, // no subscription_id stamp
        }),
      );
      expect(err.mock.calls.flat().join(" ")).toMatch(/REFUSING to write group/);
    } finally {
      err.mockRestore();
    }

    expect(creditMock).not.toHaveBeenCalled();
  });

  it("an event with no org_id metadata does not attempt a credit, and does not crash", async () => {
    const stripeSubId = "sub_pc_noorg_" + uniq();
    const group = await seedGroup({ stripeSubId });

    await expect(
      processStripeEvent(
        subEvent("customer.subscription.updated", {
          id: stripeSubId,
          metadata: { subscription_id: group.subId }, // no org_id
        }),
      ),
    ).resolves.toBeUndefined();

    expect(creditMock).not.toHaveBeenCalled();
  });

  it("resolves nothing (no group, no write) → no credit attempt either", async () => {
    await processStripeEvent(
      subEvent("customer.subscription.updated", {
        id: "sub_pc_orphan_" + uniq(),
        metadata: { org_id: randomUUID() }, // names no real org/subscription
      }),
    );

    expect(creditMock).not.toHaveBeenCalled();
  });
});
