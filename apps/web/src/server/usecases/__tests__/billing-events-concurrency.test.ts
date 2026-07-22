// #229 P0-2: two concurrent deliveries of the SAME Stripe event must run the
// handler — and therefore its side effects — exactly once. The webhook used to
// SELECT-then-INSERT and always process, so a duplicate delivery double-fired
// the handler (a second dunning analytics event, a second email) while only one
// ledger row was written. runEvent now claims the event atomically under a
// lease and only the claimant processes.
//
// The side effect counted here is the PAYMENT_FAILED analytics capture that
// handleInvoicePaymentFailed fires once per run: with the bug it is called
// twice, with the fix once. Real Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const captureServer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/posthog-server", () => ({ captureServer }));
// A no-op cache so invalidateGroupEntitlements does not need Redis.
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { runEvent, ledgerByIds, eventStatus } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`racer-${uniq()}@test.local`}, 'Racer', true) returning id`;
  return id;
}

/** A live group with a Stripe subscription id and one org, so a payment-failed
 *  event resolves to a primary org and the analytics capture actually fires. */
async function makeGroupWithOrg(stripeSubId: string): Promise<void> {
  const owner = await makeUser();
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid, stripe_subscription_id)
    values (${owner}, 'pro', 'active', 1, ${stripeSubId}) returning id`;
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, subscription_id)
    values (${`Race ${s}`}, ${`race-${s}`}, ${owner}, ${subId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner}, 'owner')`;
}

function paymentFailedEvent(stripeSubId: string): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "invoice.payment_failed",
    data: {
      object: {
        id: `in_${uniq()}`,
        parent: { subscription_details: { subscription: stripeSubId } },
        metadata: {},
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  captureServer.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("concurrent webhook delivery of one event", () => {
  it("runs the handler and its side effects exactly once", async () => {
    const stripeSubId = "sub_race_" + uniq();
    await makeGroupWithOrg(stripeSubId);
    const event = paymentFailedEvent(stripeSubId);

    // Both deliveries land at the same instant. Without an atomic claim both
    // pass the "already recorded?" check and both process.
    await Promise.all([runEvent(event), runEvent(event)]);

    // The side effect fired once, not once per delivery.
    expect(captureServer).toHaveBeenCalledTimes(1);

    // Exactly one ledger row, and it is processed.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from billing_events where id = ${event.id}`;
    expect(Number(n)).toBe(1);
    const rows = await ledgerByIds([event.id]);
    expect(eventStatus(rows.get(event.id))).toBe("processed");
  });

  it("still heals a stuck row: a redelivery of an unprocessed, unleased event reprocesses it", async () => {
    // Recovery must survive the atomic claim. A row recorded but never processed
    // (crash mid-handler) has a null/expired lease; the next delivery — or the
    // stuck-event sweep — takes it over and runs the handler.
    const stripeSubId = "sub_stuck_" + uniq();
    await makeGroupWithOrg(stripeSubId);
    const event = paymentFailedEvent(stripeSubId);
    // Seed a stuck row: recorded, unprocessed, no lease (as a legacy/crashed row).
    await sql`
      insert into billing_events (id, type, org_id, payload, processing_started_at)
      values (${event.id}, ${event.type}, null, ${JSON.stringify(event.data.object)}, null)`;

    const ran = await runEvent(event);

    expect(ran).toBe(true);
    expect(captureServer).toHaveBeenCalledTimes(1);
    const rows = await ledgerByIds([event.id]);
    expect(eventStatus(rows.get(event.id))).toBe("processed");
  });
});
