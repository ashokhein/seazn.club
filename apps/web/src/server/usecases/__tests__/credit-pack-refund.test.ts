// Credit-pack refund → wallet claw-back (v17 SPEC-2 §5, Phase 3 Task 4).
//
// A `charge.refunded` for a credit-pack charge claws back only the credits the
// customer has NOT yet spent from the `pack` bucket — never more than the
// purchase granted, never below zero, never touching the `grant` bucket, and
// idempotent on a webhook replay.
//
// The pack charge is identified by matching the charge's `payment_intent`
// against the seeded `pack_purchase` ledger row — NOT off `charge.metadata`.
// Stripe does NOT copy `payment_intent_data.metadata` onto the Charge object
// (Charge and PaymentIntent metadata are distinct fields), so these fixtures
// carry NO `metadata.kind` — the real Checkout-created shape. A `matched`
// ledger row is what proves a charge is a pack; the only time the PaymentIntent
// metadata is consulted is the ungranted-pack alert branch, where a guarded
// `paymentIntents.retrieve` (mocked here) distinguishes a paid-but-never-granted
// pack from a genuine non-pack (registration/sponsor/pass) refund.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { balance, grantBalance, packBalance, recordPackPurchase, reserve, walletIdFor } from "@/lib/credits";
import { processStripeEvent } from "../billing-events";
import { sendCreditPackGrantFailedAlertEmail } from "@/lib/email";

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, sendCreditPackGrantFailedAlertEmail: vi.fn().mockResolvedValue(true) };
});

// The guarded PaymentIntent retrieve the matched===false branch uses to tell an
// ungranted pack from a non-pack charge. Only that branch calls it; the common
// matched path (cases 1/2/4) never does, so `retrieveIntent` stays unused there.
const stripeMock = vi.hoisted(() => ({ retrieveIntent: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ paymentIntents: { retrieve: stripeMock.retrieveIntent } }),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Pack Refund Org ${uniq()}`}, ${`pack-refund-org-${uniq()}`})
    returning id`;
  return org!.id;
}

/** Minimal `charge.refunded` event for a pack charge — only the fields the pack
 *  refund branch reads. Deliberately carries NO `metadata.kind`: Stripe never
 *  copies `payment_intent_data.metadata` onto a Charge, so the real object's
 *  `charge.metadata` is `{}`. Identification is by `payment_intent` → ledger
 *  row, exactly as production sees it. */
function packRefundEvent(over: { paymentIntent: string; chargeId?: string; refunded?: boolean }): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "charge.refunded",
    data: {
      object: {
        id: over.chargeId ?? `ch_${uniq()}`,
        refunded: over.refunded ?? true,
        amount_refunded: 0,
        payment_intent: over.paymentIntent,
        metadata: {}, // real Checkout charge: PI metadata is NOT copied here.
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("webhook → credit pack refund claws back unspent pack credits", () => {
  const alertMock = vi.mocked(sendCreditPackGrantFailedAlertEmail);

  beforeEach(() => {
    alertMock.mockClear();
    stripeMock.retrieveIntent.mockReset();
    // A key must be present for the guarded retrieve branch to be reachable.
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  });
  afterEach(() => {
    delete process.env.STAFF_ALERT_EMAIL;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("fully-unspent pack: refund claws back exactly the grant, packBalance → 0", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    await recordPackPurchase(walletId, 40, intent);
    expect(await packBalance(walletId)).toBe(40);

    await processStripeEvent(packRefundEvent({ paymentIntent: intent }));

    expect(await packBalance(walletId)).toBe(0);
    expect(await balance(walletId)).toBe(0);
    const rows = await sql<{ delta: number; source: string; bucket: string; ref: string | null }[]>`
      select delta, source, bucket, ref from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'refund'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: -40, source: "refund", bucket: "pack", ref: intent });
    // Matched off the ledger row — never a Stripe round-trip on the happy path.
    expect(stripeMock.retrieveIntent).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("partially-spent pack: claws back only what remains, never negative, grant bucket untouched", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    await recordPackPurchase(walletId, 40, intent);
    // grant bucket is 0, so this reserve draws the 12 from the pack bucket via
    // the REAL spend path (reserve), not a hand-written ledger row.
    await reserve(walletId, orgId, 12);
    expect(await packBalance(walletId)).toBe(28);

    await processStripeEvent(packRefundEvent({ paymentIntent: intent }));

    expect(await packBalance(walletId)).toBe(0); // 28 clawed, min(40, 28), never below 0
    expect(await grantBalance(walletId)).toBe(0);
    const refundRows = await sql<{ delta: number; bucket: string }[]>`
      select delta, bucket from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'refund'`;
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({ delta: -28, bucket: "pack" });
    // No refund ever touches the grant bucket.
    const grantRefunds = refundRows.filter((r) => r.bucket === "grant");
    expect(grantRefunds).toHaveLength(0);
    expect(stripeMock.retrieveIntent).not.toHaveBeenCalled();
  });

  it("non-pack charge (no pack_purchase row, PI metadata not credit_pack) is a silent no-op — no ledger row, no alert", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    // A registration/sponsor/pass refund: the PI retrieve resolves, but its
    // metadata.kind is NOT credit_pack, so it must stay silent.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: { kind: "registration" } });
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    await recordPackPurchase(walletId, 40, `pi_${uniq()}`);
    expect(await packBalance(walletId)).toBe(40);

    // Different payment_intent — no pack_purchase row matches it.
    await processStripeEvent(packRefundEvent({ paymentIntent: `pi_${uniq()}` }));

    expect(await packBalance(walletId)).toBe(40);
    const refundRows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'refund'`;
    expect(refundRows).toHaveLength(0);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("replayed charge.refunded is idempotent — exactly one refund row, clawed once", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    await recordPackPurchase(walletId, 40, intent);
    const event = packRefundEvent({ paymentIntent: intent });

    await processStripeEvent(event);
    expect(await packBalance(walletId)).toBe(0);
    await processStripeEvent(event); // verbatim redelivery
    expect(await packBalance(walletId)).toBe(0);

    const rows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'refund'`;
    expect(rows).toHaveLength(1);
  });

  it("pack charge with NO purchase row but PI metadata=credit_pack fires the staff alert, writes no negative balance", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`; // never recorded a purchase for this intent
    // The guarded retrieve reveals it WAS a pack (Part A stamps the PI) — an
    // ungranted-then-refunded pack, which must alert rather than no-op.
    stripeMock.retrieveIntent.mockResolvedValue({
      metadata: { kind: "credit_pack", org_id: orgId, pack_key: "credits_10" },
    });

    await processStripeEvent(packRefundEvent({ paymentIntent: intent }));

    expect(await balance(walletId)).toBe(0);
    const rows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'refund'`;
    expect(rows).toHaveLength(0);
    expect(stripeMock.retrieveIntent).toHaveBeenCalledWith(intent);
    expect(alertMock).toHaveBeenCalledTimes(1);
  });
});
