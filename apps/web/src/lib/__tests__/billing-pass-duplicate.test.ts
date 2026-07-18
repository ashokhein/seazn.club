// P0-3b (payments hardening): two owners — or one double-click / two tabs —
// can both pay for the same competition's Event Pass. The pass is keyed by
// competition_id, so the first insert wins and the SECOND payment used to be
// silently kept. recordPassPurchase now reports the losing intent so the
// checkout/webhook path sends it straight back (registrations' duplicate
// contract). A REPLAY of the same intent (webhook + reconcile racing on ONE
// payment) is not a duplicate and must never trigger a refund.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// The duplicate refund is the only Stripe call on this path; spy on it without
// a live network (sibling convention: registrations.test.ts).
const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test" });
  return { refundCreate, stripe: { refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { recordPassPurchase } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";

const HAS_DB = !!process.env.DATABASE_URL;

/** A paid, pass-shaped checkout.session.completed event as the webhook /
 *  replay path sees it. */
const passCheckoutEvent = (orgId: string, competitionId: string, intent: string) =>
  ({
    type: "checkout.session.completed",
    data: {
      object: {
        metadata: { org_id: orgId, competition_id: competitionId, pass_key: "event_pass" },
        payment_status: "paid",
        payment_intent: intent,
      },
    },
  }) as unknown as Stripe.Event;

/** Sibling-suite seeding style (billing-pass-revoke): a fresh org + competition,
 *  the only two FK parents a competition_passes row needs. */
async function seedOrgWithComp(): Promise<{ orgId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Dup Org " + suffix}, ${"dup-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Dup Cup " + suffix}, ${"dup-cup-" + suffix}) returning id`;
  return { orgId, compId };
}

beforeEach(() => {
  stripeMock.refundCreate.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("recordPassPurchase duplicates", () => {
  it("first purchase records; second DIFFERENT intent reports a duplicate", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    const a = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_a" });
    expect(a).toEqual({ recorded: true, duplicateIntent: null });
    const b = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_b" });
    expect(b).toEqual({ recorded: false, duplicateIntent: "pi_b" });
    const same = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_a" });
    expect(same).toEqual({ recorded: false, duplicateIntent: null }); // replay, not duplicate
  });

  it("a null-intent second purchase reports no refundable duplicate", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_first" });
    // Reconcile-on-return passes null when the session's intent isn't a string;
    // there is nothing to refund, so it must not be reported as a duplicate.
    const res = await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: null });
    expect(res).toEqual({ recorded: false, duplicateIntent: null });
  });

  it("two concurrent purchases: exactly one records, the other is a refundable duplicate", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    // Two webhooks / a double-click racing on ONE comp. The competition_id
    // primary key serialises them: exactly one wins, and the loser reports ITS
    // OWN intent (a real second charge) so it can be sent back — never null,
    // never two records.
    const results = await Promise.all(
      ["pi_race_a", "pi_race_b"].map((intent) =>
        recordPassPurchase({ orgId, competitionId: compId, paymentIntent: intent }).then((r) => ({
          intent,
          r,
        })),
      ),
    );
    const winners = results.filter((x) => x.r.recorded);
    const losers = results.filter((x) => !x.r.recorded);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].r.duplicateIntent).toBeNull();
    expect(losers[0].r.duplicateIntent).toBe(losers[0].intent);
  });
});

describe.skipIf(!HAS_DB)("Event Pass duplicate payment → auto-refund (checkout dispatch)", () => {
  it("refunds a duplicate charge with an idempotency key; the original pass is untouched", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    // First owner already paid — pass recorded under pi_first.
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_first" });
    stripeMock.refundCreate.mockClear();

    // Second owner's checkout completes for the same, already-passed comp.
    await processStripeEvent(passCheckoutEvent(orgId, compId, "pi_second"));

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_second" },
      { idempotencyKey: "pass-dup-refund-pi_second" },
    );
    // The first payment's pass row is kept as-is.
    const [row] = await sql<{ stripe_payment_intent: string }[]>`
      select stripe_payment_intent from competition_passes where competition_id = ${compId}`;
    expect(row.stripe_payment_intent).toBe("pi_first");
  });

  it("a replay of the SAME intent (webhook + reconcile on one payment) refunds nothing", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_solo" });
    stripeMock.refundCreate.mockClear();

    await processStripeEvent(passCheckoutEvent(orgId, compId, "pi_solo"));

    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
  });

  it("a Stripe refund failure never blocks the webhook ACK", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_keep" });
    stripeMock.refundCreate.mockClear();
    stripeMock.refundCreate.mockRejectedValueOnce(new Error("stripe unavailable"));

    // The dispatch must resolve (never throw) so processed_at is still stamped.
    await expect(processStripeEvent(passCheckoutEvent(orgId, compId, "pi_dup"))).resolves.toBeUndefined();
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeTruthy();
  });
});
