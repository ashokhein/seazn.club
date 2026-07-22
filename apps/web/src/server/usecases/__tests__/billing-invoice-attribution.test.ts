// Durable group-invoice attribution (#223).
//
// invoice.* events carry NO subscription_id in Stripe object metadata — Stripe
// never copies subscription metadata onto an invoice — so attribution cannot
// rely on live object metadata. runEvent now resolves the billing GROUP behind
// the event at ingest and stamps it durably on billing_events.subscription_id
// (V317). This pins that stamp for an invoice event: the group is found via the
// Stripe subscription id read off invoice.parent.subscription_details.subscription.
//
// The admin billing-events page then PREFERS that durable stamp over live object
// metadata when labelling a row, so a group invoice reads "N organisations · Payer".
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { runEvent } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

(HAS_DB ? describe : describe.skip)("durable group-invoice attribution (#223)", () => {
  const s = uniq();
  const stripeSubId = `sub_${s}`;
  const eventId = `evt_${s}`;
  let payerId: string;
  let groupId: string;

  beforeAll(async () => {
    [{ id: payerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`inv-attr-${s}@test.local`}, 'Invoice Payer', true) returning id`;
    [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, stripe_subscription_id, stripe_customer_id)
      values (${payerId}, 'pro', 'active', ${stripeSubId}, ${`cus_${s}`}) returning id`;
    // three orgs on the one group
    for (let i = 0; i < 3; i++) {
      await sql`insert into organizations (name, slug, created_by, subscription_id)
                values (${`Org ${i} ${s}`}, ${`org-${i}-${s}`}, ${payerId}, ${groupId})`;
    }
  });

  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("an invoice event stamps the ledger with the group behind the Stripe subscription", async () => {
    // An invoice event with NO subscription_id in metadata — exactly the shape
    // Stripe sends. invoiceSubId reads invoice.parent.subscription_details.subscription.
    const event = {
      id: eventId,
      type: "invoice.payment_succeeded",
      data: { object: {
        object: "invoice",
        metadata: {},
        parent: { subscription_details: { subscription: stripeSubId } },
      } as unknown as Stripe.Invoice },
    } as unknown as Stripe.Event;

    await runEvent(event);

    const [row] = await sql<{ subscription_id: string | null }[]>`
      select subscription_id from billing_events where id = ${event.id}`;
    expect(row.subscription_id).toBe(groupId);
  });

  it("groupLabelsByIds renders the 3-org group as 'N organisations · Payer'", async () => {
    const { groupLabelsByIds } = await import("@/app/admin/billing-events/page");
    const labels = await groupLabelsByIds([groupId]);
    const label = labels.get(groupId)!;
    expect(label).toMatch(/3 organisations/);
    expect(label).toContain("Invoice Payer");
  });
});
