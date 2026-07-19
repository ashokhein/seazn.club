// Dispute-before-activation race (stg repro 2026-07-19): Stripe can deliver
// charge.dispute.created BEFORE checkout.session.completed — the sponsor order
// (or registration/pass) doesn't carry its payment_intent_id yet, all three
// dispute handlers miss, and the event used to be ACKed as processed: the
// dispute silently never flagged anything. Now an unmatched dispute THROWS, so
// the ledger keeps the event unprocessed and the stuck-event sweeper (or a
// manual /admin/billing-events replay) re-runs it once the money row knows its
// intent. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSponsorDisputeAlertEmail: vi.fn().mockResolvedValue(true),
  sendStaffDisputeAlertEmail: vi.fn().mockResolvedValue(true),
}));

import { sql } from "@/lib/db";
import { processStripeEvent } from "@/server/usecases/billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 12);

function disputeEvent(intent: string, disputeId: string): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "charge.dispute.created",
    data: {
      object: {
        id: disputeId,
        object: "dispute",
        status: "needs_response",
        payment_intent: intent,
        charge: `ch_${uniq()}`,
        amount: 1000,
        currency: "gbp",
      },
    },
  } as unknown as Stripe.Event;
}

/** Sponsor order mid-checkout: row exists, payment_intent_id NOT yet written. */
async function seedPendingSponsorOrder(): Promise<{ orderId: string; orgId: string }> {
  const suffix = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`race-${suffix}@test.local`}, 'Race Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, stripe_account_id, stripe_charges_enabled, created_by)
    values (${"Race Org " + suffix}, ${"race-org-" + suffix}, ${"acct_" + suffix}, true, ${ownerId})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency)
    values (${orgId}, 'Perimeter', 1000, 'gbp') returning id`;
  const [{ id: orderId }] = await sql<{ id: string }[]>`
    insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status)
    values (${orgId}, ${packageId}, 'Race Sponsor', ${"sponsor-" + suffix + "@test.local"}, 1000, 'gbp', 'pending')
    returning id`;
  return { orderId, orgId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("unmatched disputes stay unprocessed for retry", () => {
  it("dispute racing ahead of checkout completion throws, then flags on the retry", async () => {
    const { orderId } = await seedPendingSponsorOrder();
    const intent = `pi_race_${uniq()}`;
    const did = `dp_race_${uniq()}`;

    // Dispute lands FIRST — nothing carries the intent yet: must throw so the
    // ledger keeps the event unprocessed (sweeper/replay territory).
    await expect(processStripeEvent(disputeEvent(intent, did))).rejects.toThrow(/dispute/i);
    const [before] = await sql<{ disputed_at: string | null }[]>`
      select disputed_at from sponsor_orders where id = ${orderId}`;
    expect(before.disputed_at).toBeNull();

    // Checkout completes: the order learns its intent…
    await sql`update sponsor_orders
              set payment_intent_id = ${intent}, status = 'paid', paid_at = now()
              where id = ${orderId}`;

    // …and the replay (sweeper or admin button) now matches and flags.
    await processStripeEvent(disputeEvent(intent, did));
    const [after] = await sql<{ disputed_at: string | null; dispute_id: string | null }[]>`
      select disputed_at, dispute_id from sponsor_orders where id = ${orderId}`;
    expect(after.disputed_at).not.toBeNull();
    expect(after.dispute_id).toBe(did);
  });

  it("a dispute matching nothing at all is surfaced (throws), never silently ACKed", async () => {
    await expect(
      processStripeEvent(disputeEvent(`pi_ghost_${uniq()}`, `dp_ghost_${uniq()}`)),
    ).rejects.toThrow(/dispute/i);
  });
});
