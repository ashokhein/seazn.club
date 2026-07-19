// Sponsor dispute lifecycle (payments-hardening Task 6, P0-2): a chargeback on
// a sponsor package charge is a destination-charge dispute exactly like an
// entry fee — the platform is liable, so `created` flags the order + parks the
// placement, `closed won` restores it, and `closed lost` writes the order off
// and reverses the club's transfer through the shared recovery core. Stripe is
// NOT mocked here: the keyless test env makes getStripe() throw, so recovery
// takes its audited failure path — we assert the money-record flips stuck and
// nothing threw. Real Postgres required; skipped without DATABASE_URL.
//
// Test hygiene: every seed is run-unique (randomUUID) — payment_intent_id and
// dispute ids included — so re-running the file never collides with rows a
// prior run left behind (the handler keys off payment_intent_id).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Observe the organiser notifications without touching the rest of the email
// module (send() is a no-op without RESEND_API_KEY either way).
const emailMock = vi.hoisted(() => ({
  alert: vi.fn().mockResolvedValue(true),
  lost: vi.fn().mockResolvedValue(true),
  won: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSponsorDisputeAlertEmail: emailMock.alert,
  sendSponsorDisputeLostEmail: emailMock.lost,
  sendSponsorDisputeWonEmail: emailMock.won,
}));

import { sql } from "@/lib/db";
import { handleSponsorDispute } from "../sponsors";
import { processStripeEvent } from "@/server/usecases/billing-events";

const HAS_DB = !!process.env.DATABASE_URL;

const uniq = () => randomUUID().slice(0, 12);

/** Paid, comp-scoped sponsor order + the active placement it activated, plus
 *  the org's owner (via org_members — the alert/lost mail recipient). The
 *  package is competition-scoped so the recovery audit sink has a competition
 *  to hang `sponsor.*` events on. Returns the run-unique payment intent. */
async function seedPaidSponsorOrder(): Promise<{
  intent: string;
  orderId: string;
  sponsorId: string;
  orgId: string;
  ownerEmail: string;
  orgName: string;
  packageName: string;
}> {
  const suffix = uniq();
  const intent = `pi_sp_${suffix}`;
  const ownerEmail = `owner-${suffix}@test.local`;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${ownerEmail}, 'Owner', true) returning id`;
  const orgName = "Sponsor Org " + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, stripe_account_id, stripe_charges_enabled)
    values (${orgName}, ${"sp-org-" + suffix}, ${"acct_" + suffix}, true) returning id`;
  await sql`insert into org_members (org_id, user_id, role)
            values (${orgId}, ${ownerId}, 'owner')`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Sponsor Cup " + suffix}, ${"sp-cup-" + suffix}) returning id`;
  const packageName = "Gold package";
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${compId}, ${packageName}, 25000, 'gbp', 'gold') returning id`;
  const [{ id: sponsorId }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, tier, status)
    values (${orgId}, ${compId}, 'Acme Corp', 'gold', 'active') returning id`;
  const [{ id: orderId }] = await sql<{ id: string }[]>`
    insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email,
                                amount_cents, currency, status, sponsor_id,
                                payment_intent_id, paid_at)
    values (${orgId}, ${packageId}, 'Acme Corp', 'billing@acme.test',
            25000, 'gbp', 'paid', ${sponsorId}, ${intent}, now()) returning id`;
  return { intent, orderId, sponsorId, orgId, ownerEmail, orgName, packageName };
}

const disputeFor = (intent: string, id: string, status = "needs_response") =>
  ({ id, payment_intent: intent, amount: 25000, status, charge: "ch_x" }) as unknown as Stripe.Dispute;

beforeEach(() => {
  emailMock.alert.mockClear();
  emailMock.lost.mockClear();
  emailMock.won.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});

describe.skipIf(!HAS_DB)("handleSponsorDispute", () => {
  it("created: flags the order and takes the placement to pending", async () => {
    const { intent, orderId, sponsorId, ownerEmail } = await seedPaidSponsorOrder();
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const [o] = await sql`select disputed_at, dispute_id from sponsor_orders where id = ${orderId}`;
    expect(o.dispute_id).toBe(did);
    expect(o.disputed_at).not.toBeNull();
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("pending");
    // The organiser is alerted, once, addressed to the owner (org_members).
    expect(emailMock.alert).toHaveBeenCalledTimes(1);
    expect(emailMock.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ownerEmail,
        packageName: "Gold package",
        sponsorName: "Acme Corp",
        amountCents: 25000,
      }),
    );
  });

  it("created replay: idempotent flag, no second alert email", async () => {
    const { intent, orderId, ownerEmail } = await seedPaidSponsorOrder();
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const [first] = await sql<{ disputed_at: Date }[]>`
      select disputed_at from sponsor_orders where id = ${orderId}`;
    // /admin/billing-events replay of the same created event.
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const [second] = await sql<{ disputed_at: Date }[]>`
      select disputed_at from sponsor_orders where id = ${orderId}`;
    expect(second.disputed_at).toEqual(first.disputed_at); // flag time preserved
    expect(emailMock.alert).toHaveBeenCalledTimes(1); // not re-notified
    expect(emailMock.alert.mock.calls[0]![0]).toMatchObject({ to: ownerEmail });
  });

  it("closed lost: order refunded-state, placement inactive, recovery audited", async () => {
    const { intent, orderId, sponsorId } = await seedPaidSponsorOrder();
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    await handleSponsorDispute(disputeFor(intent, did, "lost"), "closed");
    const [o] = await sql`select status from sponsor_orders where id = ${orderId}`;
    expect(o.status).toBe("refunded");
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("inactive");
    // Recovery ran through the shared core: keyless env → getStripe() throws →
    // the core catches and audits `sponsor.dispute_recovery_failed`. The flip
    // above must NOT depend on Stripe, and nothing may throw out of the handler.
    const audits = await sql`
      select 1 from competition_events
      where type = 'sponsor.dispute_recovery_failed' and payload->>'order_id' = ${orderId}`;
    expect(audits).toHaveLength(1);
    // Organiser hears about the loss (recoveredCents 0 — recovery could not run).
    expect(emailMock.lost).toHaveBeenCalledTimes(1);
    expect(emailMock.lost.mock.calls[0]![0]).toMatchObject({ recoveredCents: 0 });
  });

  it("closed lost replay: order + placement stay written off (idempotent)", async () => {
    const { intent, orderId, sponsorId } = await seedPaidSponsorOrder();
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const lost = disputeFor(intent, did, "lost");
    await handleSponsorDispute(lost, "closed");
    await handleSponsorDispute(lost, "closed"); // replay
    const [o] = await sql`select status from sponsor_orders where id = ${orderId}`;
    expect(o.status).toBe("refunded");
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("inactive");
  });

  it("closed won: flag cleared, placement re-activated (idempotent on replay)", async () => {
    const { intent, orderId, sponsorId, ownerEmail } = await seedPaidSponsorOrder();
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const won = disputeFor(intent, did, "won");
    await handleSponsorDispute(won, "closed");
    await handleSponsorDispute(won, "closed"); // replay converges, not toggles
    const [o] = await sql`select disputed_at from sponsor_orders where id = ${orderId}`;
    expect(o.disputed_at).toBeNull();
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("active");
    expect(emailMock.lost).not.toHaveBeenCalled(); // a win is not a loss
    // The organiser hears about the win exactly once — the replay above must
    // not re-notify (the flag was already clear on the second pass).
    expect(emailMock.won).toHaveBeenCalledTimes(1);
    expect(emailMock.won.mock.calls[0]![0]).toMatchObject({ to: ownerEmail });
  });

  it("ignores non-sponsor intents (reports no match)", async () => {
    await expect(
      handleSponsorDispute(disputeFor("pi_not_sponsor_" + uniq(), "dp_" + uniq()), "created"),
    ).resolves.toBe(false);
    expect(emailMock.alert).not.toHaveBeenCalled();
  });

  it("dispatch wires charge.dispute.created/closed to the sponsor handler", async () => {
    const { intent, orderId, sponsorId } = await seedPaidSponsorOrder();
    const did = "dp_" + uniq();
    await processStripeEvent({
      type: "charge.dispute.created",
      data: { object: disputeFor(intent, did) },
    } as unknown as Stripe.Event);
    const [flagged] = await sql`select dispute_id from sponsor_orders where id = ${orderId}`;
    expect(flagged.dispute_id).toBe(did);

    await processStripeEvent({
      type: "charge.dispute.closed",
      data: { object: disputeFor(intent, did, "won") },
    } as unknown as Stripe.Event);
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("active");
  });
});
