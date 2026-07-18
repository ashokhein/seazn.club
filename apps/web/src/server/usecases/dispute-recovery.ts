import "server-only";
// Shared dispute-recovery core (payments-hardening Task 5, extracted verbatim
// from registrations.ts's PROMPT-55 recovery so registration entry fees,
// sponsor orders, and platform subscriptions all reverse a lost dispute
// through one audited code path.
//
// The caller owns its entity/org context: it passes an `auditNote` sink that
// namespaces the audit type (e.g. `registration.` / `sponsor.`) and injects
// registration_id/org, plus `reversalMetadata` merged onto the Stripe reversal
// alongside the durable `dispute_id` guard key.
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";

export interface DisputeRecoveryOpts {
  /** Fire-and-forget audit sink. The caller builds the closure that maps the
   *  short recovery `type` (`dispute_recovered`, `dispute_recovery_skipped`,
   *  `dispute_recovery_failed`) into its own namespaced ledger event and folds
   *  in its entity/org context (registration_id, org, …). Never throws. */
  auditNote: (type: string, extra: Record<string, unknown>) => Promise<void>;
  /** Entity-specific metadata merged onto the transfer reversal next to the
   *  `dispute_id` guard key — e.g. `{ registration_id }` for entry fees,
   *  `{ sponsor_order_id }` for sponsor orders. Traceability only; the replay
   *  guard keys off `dispute_id` alone. */
  reversalMetadata?: Stripe.MetadataParam;
}

/**
 * PROMPT-55: on a LOST card dispute, pull the connected account's net back off
 * its balance so the platform's loss is Stripe's dispute fee only.
 *
 * Mechanics verified against the live API in test mode (2026-07-14, GBP):
 * destination charges transfer the FULL charge amount to the connected
 * account and collect the application fee from it separately, and a lost
 * dispute auto-reverses NEITHER — the platform is debited
 * dispute.amount + Stripe's dispute fee, the transfer stays unreversed and
 * the application fee stays earned. Worked example (fee 2000, app fee 100,
 * GBP dispute fee 2000): transfer = 2000, connected net = 1900; on loss the
 * platform is debited 4000. Reversing 1900 leaves the account exactly flat on
 * the charge (2000 in − 100 app fee − 1900 reversed = 0) and the platform's
 * net cost is the dispute fee alone (−4000 + 1900 recovered + 100 app fee
 * kept = −2000). Absorbing that fee is the cost of owning the dispute flow.
 *
 * The reversal may push the connected Express balance negative; Stripe then
 * recovers from future payouts or bank debits per the Connect settings —
 * that is the intended liability chain: the platform owns the dispute
 * response (Express accounts have no dispute surface), the connected account
 * owns the economic risk of its own charges.
 *
 * Never throws: recovery failure is audited and must not block the webhook
 * ACK or the caller's write-off. Stripe calls stay OUTSIDE any sql tx.
 */
export async function recoverDisputedTransfer(
  dispute: Stripe.Dispute,
  opts: DisputeRecoveryOpts,
): Promise<{ recoveredCents: number; already: boolean }> {
  const note = opts.auditNote;
  try {
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
    if (!chargeId) {
      await note("dispute_recovery_skipped", { reason: "no_charge" });
      return { recoveredCents: 0, already: false };
    }
    const stripe = getStripe();
    const charge = await stripe.charges.retrieve(chargeId, { expand: ["transfer"] });
    let transfer = charge.transfer;
    if (typeof transfer === "string") transfer = await stripe.transfers.retrieve(transfer);
    if (!transfer) {
      // e.g. the charge predates the Connect wiring.
      await note("dispute_recovery_skipped", { reason: "no_transfer" });
      return { recoveredCents: 0, already: false };
    }
    // Stripe idempotency keys expire (~24h) but /admin/billing-events can
    // replay a closed event much later — this metadata check is the durable
    // guard against double reversals; the key below covers webhook retries.
    const existing = await stripe.transfers.listReversals(transfer.id, { limit: 100 });
    if (existing.data.some((r) => r.metadata?.dispute_id === dispute.id)) {
      return { recoveredCents: 0, already: true };
    }
    // Connected account's net share of the disputed amount (partial disputes
    // exist), capped by whatever is still unreversed on the transfer.
    const net = transfer.amount - (charge.application_fee_amount ?? 0);
    const share = Math.round((dispute.amount * net) / charge.amount);
    const amount = Math.min(share, transfer.amount - transfer.amount_reversed);
    if (amount <= 0) {
      await note("dispute_recovery_skipped", { reason: "nothing_to_reverse" });
      return { recoveredCents: 0, already: false };
    }
    await stripe.transfers.createReversal(
      transfer.id,
      // dispute_id is spread LAST so a caller's reversalMetadata can never
      // clobber the durable replay-guard key the listReversals check reads.
      { amount, metadata: { ...opts.reversalMetadata, dispute_id: dispute.id } },
      { idempotencyKey: `dispute-reversal-${dispute.id}` },
    );
    await note("dispute_recovered", {
      transfer_id: transfer.id,
      reversed_cents: amount,
    });
    return { recoveredCents: amount, already: false };
  } catch (err) {
    await note("dispute_recovery_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { recoveredCents: 0, already: false };
  }
}
