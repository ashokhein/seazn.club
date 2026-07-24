// Credit-pack refund → wallet claw-back (v17 SPEC-2 §5, Phase 3 Task 4).
//
// A `charge.refunded` for a credit-pack charge claws back only the credits the
// customer has NOT yet spent from the `pack` bucket — never more than the
// purchase granted, never below zero, never touching the `grant` bucket, and
// idempotent on a webhook replay. The pack charge is identified off the
// refunded charge's own metadata (Part A stamps `payment_intent_data.metadata`
// with `kind:'credit_pack'`, which Stripe copies onto the Charge), so a
// registration/sponsor/pass refund is a silent no-op here.
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

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Pack Refund Org ${uniq()}`}, ${`pack-refund-org-${uniq()}`})
    returning id`;
  return org!.id;
}

/** Minimal charge.refunded event for a credit-pack charge — only the fields the
 *  pack refund branch reads. `metadata.kind` defaults to `credit_pack`; pass
 *  `kind: null` for a non-pack charge (no metadata), or a different string to
 *  simulate a registration/sponsor charge. */
function packRefundEvent(over: {
  paymentIntent: string;
  chargeId?: string;
  refunded?: boolean;
  kind?: string | null;
  orgId?: string;
  packKey?: string;
}): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "charge.refunded",
    data: {
      object: {
        id: over.chargeId ?? `ch_${uniq()}`,
        refunded: over.refunded ?? true,
        amount_refunded: 0,
        payment_intent: over.paymentIntent,
        metadata:
          over.kind === null
            ? {}
            : {
                kind: over.kind ?? "credit_pack",
                ...(over.orgId ? { org_id: over.orgId } : {}),
                ...(over.packKey ? { pack_key: over.packKey } : {}),
              },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("webhook → credit pack refund claws back unspent pack credits", () => {
  const alertMock = vi.mocked(sendCreditPackGrantFailedAlertEmail);

  beforeEach(() => {
    alertMock.mockClear();
  });
  afterEach(() => {
    delete process.env.STAFF_ALERT_EMAIL;
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
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("partially-spent pack: claws back only what remains, never negative, grant bucket untouched", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    await recordPackPurchase(walletId, 40, intent);
    // grant bucket is 0, so this reserve draws the 12 from the pack bucket.
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
  });

  it("non-pack charge (no credit_pack metadata, no purchase row) is a silent no-op — no ledger row, no alert", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    await recordPackPurchase(walletId, 40, `pi_${uniq()}`);
    expect(await packBalance(walletId)).toBe(40);

    // A registration/sponsor/pass refund: different payment_intent, kind absent.
    await processStripeEvent(packRefundEvent({ paymentIntent: `pi_${uniq()}`, kind: null }));

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

  it("pack charge (kind=credit_pack) with NO purchase row fires the staff alert, writes no negative balance", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`; // never recorded a purchase for this intent

    await processStripeEvent(
      packRefundEvent({ paymentIntent: intent, orgId, packKey: "credits_10" }),
    );

    expect(await balance(walletId)).toBe(0);
    const rows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'refund'`;
    expect(rows).toHaveLength(0);
    expect(alertMock).toHaveBeenCalledTimes(1);
  });
});
