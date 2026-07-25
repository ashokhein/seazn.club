// Credit-pack checkout → wallet (v17 SPEC-2 §5.1/§6, Phase 3 Task 1).
//
// `checkout.session.completed` with `metadata.kind === "credit_pack"` grants
// the pack's credits into the buying org's wallet as a `pack_purchase`
// ledger row (bucket='pack'), via `recordPackPurchase` (lib/credits.ts).
// Idempotent on the Stripe payment_intent id — a webhook replay of the SAME
// completed checkout must not double-credit.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { balance, packBalance, walletIdFor } from "@/lib/credits";
import { CREDIT_PACKS } from "@/lib/credit-packs";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { processStripeEvent } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Credit Pack Org ${uniq()}`}, ${`credit-pack-org-${uniq()}`})
    returning id`;
  return org!.id;
}

/** Minimal checkout.session.completed event for a credit pack — only the
 *  fields handleCheckoutCompleted's credit_pack branch reads. `credits`
 *  defaults to the catalog amount for `packKey` (mirroring what
 *  `buildCreditPackCheckoutParams` snapshots at checkout-creation time);
 *  pass `credits: null` to simulate a pre-fix session with no snapshot at
 *  all, and an unknown `packKey` to simulate a removed catalog entry. */
function packCheckoutEvent(over: {
  orgId: string;
  packKey?: string;
  credits?: number | null;
  paymentIntent?: string | null;
  sessionId?: string;
  paymentStatus?: string;
  customer?: string | null;
}): Stripe.Event {
  const credits =
    over.credits === null
      ? undefined
      : (over.credits ?? (over.packKey ? CREDIT_PACKS[over.packKey]?.credits : undefined));
  return {
    id: `evt_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: over.sessionId ?? `cs_${uniq()}`,
        payment_status: over.paymentStatus ?? "paid",
        payment_intent: over.paymentIntent ?? `pi_${uniq()}`,
        customer: over.customer ?? null,
        currency: "usd",
        metadata: {
          kind: "credit_pack",
          org_id: over.orgId,
          ...(over.packKey ? { pack_key: over.packKey } : {}),
          ...(credits !== undefined ? { credits: String(credits) } : {}),
        },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("webhook → credit pack purchase", () => {
  it("a completed $10 pack checkout writes exactly one pack_purchase / bucket='pack' row for 40 credits", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;

    await processStripeEvent(packCheckoutEvent({ orgId, packKey: "credits_10", paymentIntent: intent }));

    const rows = await sql<{ delta: number; source: string; bucket: string; ref: string | null }[]>`
      select delta, source, bucket, ref from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'pack_purchase'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: 40, source: "pack_purchase", bucket: "pack", ref: intent });
    expect(await packBalance(walletId)).toBe(40);
    expect(await balance(walletId)).toBe(40);
  });

  it("grants the right amount for every catalog pack size", async () => {
    const cases: Array<[string, number]> = [
      ["credits_10", 40],
      ["credits_25", 105],
      ["credits_50", 220],
      ["credits_100", 460],
    ];
    for (const [packKey, credits] of cases) {
      const orgId = await seedOrg();
      const walletId = await walletIdFor(orgId);
      await processStripeEvent(packCheckoutEvent({ orgId, packKey }));
      expect(await packBalance(walletId)).toBe(credits);
    }
  });

  it("a replayed webhook for the SAME payment_intent is a no-op (idempotent)", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    const event = packCheckoutEvent({ orgId, packKey: "credits_25", paymentIntent: intent });

    await processStripeEvent(event);
    expect(await packBalance(walletId)).toBe(105);

    // Same event object replayed verbatim, as a webhook redelivery would.
    await processStripeEvent(event);
    expect(await packBalance(walletId)).toBe(105);

    const rows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'pack_purchase'`;
    expect(rows).toHaveLength(1);
  });

  it("a second, genuinely different pack purchase for the same org is NOT blocked by the replay guard", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    await processStripeEvent(
      packCheckoutEvent({ orgId, packKey: "credits_10", paymentIntent: `pi_${uniq()}` }),
    );
    await processStripeEvent(
      packCheckoutEvent({ orgId, packKey: "credits_10", paymentIntent: `pi_${uniq()}` }),
    );
    expect(await packBalance(walletId)).toBe(80);
  });

  it("credits land in the shared GROUP wallet, not a per-org one", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    expect(await walletIdFor(orgId)).toBe(subId);

    await processStripeEvent(packCheckoutEvent({ orgId, packKey: "credits_50" }));
    expect(await packBalance(subId)).toBe(220);
  });

  it("an unpaid session (payment_status !== 'paid') grants nothing", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    await processStripeEvent(
      packCheckoutEvent({ orgId, packKey: "credits_10", paymentStatus: "unpaid" }),
    );
    expect(await balance(walletId)).toBe(0);
  });

  it("an unknown pack_key with NO credits snapshot grants nothing rather than throwing (ACKs the webhook) — surfaced, not silent", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processStripeEvent(
        packCheckoutEvent({ orgId, packKey: "not_a_real_pack", credits: null }),
      );
      expect(await balance(walletId)).toBe(0);
      // Paid-but-ungranted must be visible, not a quiet no-op (review fix, P3 T1).
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("paid but ungranted"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a removed pack_key still grants the SNAPSHOTTED credits.metadata amount (catalog drift is safe)", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    await processStripeEvent(
      packCheckoutEvent({ orgId, packKey: "not_a_real_pack_anymore", credits: 40 }),
    );
    expect(await packBalance(walletId)).toBe(40);
  });

  it("no pack_key and no credits snapshot at all is surfaced as an error, not a silent no-op", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processStripeEvent(packCheckoutEvent({ orgId, credits: null }));
      expect(await balance(walletId)).toBe(0);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("paid but ungranted"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("purchased pack credits are spendable — reserve() draws from the pack bucket", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    await processStripeEvent(packCheckoutEvent({ orgId, packKey: "credits_10" }));
    expect(await packBalance(walletId)).toBe(40);

    const { reserve } = await import("@/lib/credits");
    await reserve(walletId, orgId, 12);

    expect(await packBalance(walletId)).toBe(28);
    expect(await balance(walletId)).toBe(28);
  });
});
