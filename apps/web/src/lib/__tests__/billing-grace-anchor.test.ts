// status_changed_at maintenance (grace-anchor follow-up to payments-hardening
// Task 9): every subscription-status writer stamps status_changed_at ONLY on a
// real transition, so the 14-day past_due grace in entitlements.ts anchors on
// when dunning STARTED — repeated invoice.payment_failed retries touch
// updated_at but must never move the anchor.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { syncSubscription } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";

import { setOrgPlan } from "./_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`anchor-${suffix}@test.local`}, 'Anchor Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Anchor Org " + suffix}, ${"anchor-org-" + suffix}, ${ownerId}) returning id`;
  await setOrgPlan(orgId, "community");
  return orgId;
}

/** Minimal Stripe.Subscription shape syncSubscription reads. */
function stripeSub(over: { id: string; status: Stripe.Subscription.Status }): Stripe.Subscription {
  return {
    id: over.id,
    status: over.status,
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    items: {
      data: [
        {
          price: { id: "price_unknown" },
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

/** Minimal invoice.payment_failed event (Stripe v22 parent.subscription_details). */
function paymentFailedEvent(subId: string): Stripe.Event {
  return {
    id: `evt_${randomUUID().slice(0, 12)}`,
    type: "invoice.payment_failed",
    data: {
      object: {
        object: "invoice",
        parent: { subscription_details: { subscription: subId } },
      },
    },
  } as unknown as Stripe.Event;
}

async function readAnchor(orgId: string) {
  const [row] = await sql<{ status: string; status_changed_at: string | null }[]>`
    select status, status_changed_at from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
  return row;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("status_changed_at transition stamping", () => {
  it("syncSubscription stamps on a status change and holds on a same-status re-sync", async () => {
    const orgId = await seedOrg();
    const subId = `sub_anchor_${randomUUID().slice(0, 8)}`;

    // active(community) → past_due: transition, stamp moves to now.
    await syncSubscription(orgId, stripeSub({ id: subId, status: "past_due" }));
    const first = await readAnchor(orgId);
    expect(first.status).toBe("past_due");
    expect(first.status_changed_at).not.toBeNull();

    // Age the anchor, then re-sync the SAME status (webhook replay / retry).
    await sql`update subscriptions
              set status_changed_at = now() - interval '5 days'
              where id = (select subscription_id from organizations where id = ${orgId})`;
    await syncSubscription(orgId, stripeSub({ id: subId, status: "past_due" }));
    const held = await readAnchor(orgId);
    expect(new Date(held.status_changed_at!).getTime()).toBeLessThan(Date.now() - 4 * 86_400_000); // still ~5 days old — not re-stamped

    // past_due → active: transition again, stamp moves forward.
    await syncSubscription(orgId, stripeSub({ id: subId, status: "active" }));
    const flipped = await readAnchor(orgId);
    expect(new Date(flipped.status_changed_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("repeated invoice.payment_failed events do not move the anchor", async () => {
    const orgId = await seedOrg();
    const subId = `sub_dun_${randomUUID().slice(0, 8)}`;
    await sql`update subscriptions
              set plan_key = 'pro', status = 'active', stripe_subscription_id = ${subId}
              where id = (select subscription_id from organizations where id = ${orgId})`;

    // First failure: active → past_due, anchor stamped.
    await processStripeEvent(paymentFailedEvent(subId));
    const first = await readAnchor(orgId);
    expect(first.status).toBe("past_due");
    expect(first.status_changed_at).not.toBeNull();
    expect(new Date(first.status_changed_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Age the anchor, then a dunning RETRY fails again — same status, anchor holds.
    await sql`update subscriptions
              set status_changed_at = now() - interval '10 days'
              where id = (select subscription_id from organizations where id = ${orgId})`;
    await processStripeEvent(paymentFailedEvent(subId));
    const held = await readAnchor(orgId);
    expect(held.status).toBe("past_due");
    expect(new Date(held.status_changed_at!).getTime()).toBeLessThan(Date.now() - 9 * 86_400_000);
  });
});
