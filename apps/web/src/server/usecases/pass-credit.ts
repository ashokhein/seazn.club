import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";

/**
 * Pass-to-Pro upgrade credit (v3/07, D12). An org that bought a $29 Event Pass
 * and upgrades to Pro (or Pro Plus) soon afterwards gets that pass money back
 * against the subscription.
 *
 * Delivered as a CUSTOMER BALANCE CREDIT, not a coupon: Checkout rejects
 * `discounts` alongside `allow_promotion_codes`, and both of our session
 * builders set the latter. A negative customer balance transaction is the only
 * lever left, and it is what `getBillingOverview().creditMinor` already reads
 * back (`Math.max(-customer.balance, 0)`).
 *
 * ── Why every number here is a LIVE Stripe read ──────────────────────────────
 * `competition_passes` (V271) is five columns: competition_id, org_id, pass_key,
 * stripe_payment_intent (NULLABLE), purchased_at. No amount, no currency, no
 * refund flag. So the local row can only answer WHICH pass and WHEN; how much
 * was paid, in what currency, and whether any of it went back are all Stripe's
 * to say. Every one of those reads is a chance to be wrong about money, so the
 * rule throughout is: **anything unproven yields no credit.** Under-crediting is
 * a support ticket; over-crediting is cash we hand out for nothing.
 */

/** A pass older than this earns nothing. Inclusive — see `withinCreditWindow`. */
export const PASS_CREDIT_WINDOW_DAYS = 30;

/**
 * The metadata key that makes a credit traceable back to the pass that earned
 * it. This is the ONLY idempotency record — nothing is written locally — so it
 * is also what `alreadyCredited` scans for. Changing it re-credits every pass
 * ever credited under the old key.
 */
export const PASS_CREDIT_INTENT_KEY = "pass_payment_intent";

export type PassCreditOutcome =
  | "credited"
  /** No pass row at all for this org. */
  | "no_pass"
  /** The most recent pass predates the window. */
  | "outside_window"
  /** Staff grant / comp: `stripe_payment_intent is null`. Nobody ever paid. */
  | "unpaid_pass"
  /** Nowhere to put a balance credit — no Stripe customer on the org yet. */
  | "no_customer"
  /** `subscriptions.currency` is NULL, so no match can be proven. */
  | "currency_unknown"
  /** The pass was paid in a currency the subscription will not be billed in. */
  | "currency_mismatch"
  /** Stripe could not be read (down, keyless, intent gone). */
  | "stripe_unreadable"
  /** Fully refunded, disputed, or otherwise nothing net left to credit. */
  | "nothing_owed"
  /** This exact pass intent has already been credited to this customer. */
  | "already_credited";

export interface PassCreditResult {
  outcome: PassCreditOutcome;
  /** Positive minor units actually credited; 0 for every non-`credited` outcome. */
  amountMinor: number;
  currency: string | null;
  /** The pass payment intent the decision was made about, when there was one. */
  paymentIntent: string | null;
}

function none(outcome: PassCreditOutcome, paymentIntent: string | null = null): PassCreditResult {
  return { outcome, amountMinor: 0, currency: null, paymentIntent };
}

/**
 * Inclusive on the boundary: "bought ≤30 days ago" credits at exactly 30 days
 * and not at 31. Computed in JS rather than SQL so the boundary is pinned by a
 * unit test and not by the database's clock.
 */
export function withinCreditWindow(purchasedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - purchasedAt.getTime();
  return ageMs <= PASS_CREDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Does this org hold ANY Event Pass? Drives `requireCard` on the subscription
 * checkout (D13) — a pass buyer converting to Pro is asked for a card even
 * during the 14-day trial. Deliberately counts staff-granted passes too: the
 * question is "has this org used the pass path", not "did they pay".
 */
export async function orgHoldsAnyPass(orgId: string): Promise<boolean> {
  const [row] = await sql<{ one: number }[]>`
    select 1 as one from competition_passes where org_id = ${orgId} limit 1`;
  return !!row;
}

interface PassRow {
  competition_id: string;
  name: string;
  purchased_at: Date | string;
  stripe_payment_intent: string | null;
}

/**
 * The single pass a credit could be based on: the org's MOST RECENT one.
 *
 * Deliberately unfiltered. "Cap at one pass, the most recent — not the sum" is
 * taken literally, so a comp granted after a purchase shadows that purchase and
 * the explicit `unpaid_pass` guard below refuses it. Filtering
 * `stripe_payment_intent is not null` in SQL would instead reach PAST the comp
 * to an older paid pass — a defensible policy, but it would also turn the
 * null-intent rule into an invisible side effect of a WHERE clause rather than a
 * decision anyone can see or test. Shadowing under-credits; reaching past could
 * only ever credit more.
 */
async function mostRecentPass(orgId: string): Promise<PassRow | null> {
  const [row] = await sql<PassRow[]>`
    select cp.competition_id, c.name, cp.purchased_at, cp.stripe_payment_intent
    from competition_passes cp
    join competitions c on c.id = cp.competition_id
    where cp.org_id = ${orgId}
    order by cp.purchased_at desc, cp.competition_id desc
    limit 1`;
  return row ?? null;
}

/**
 * What this pass payment is worth NOW, straight from Stripe.
 *
 * Not `invoicePayments.list` (the route `getPassPurchases` takes): an invoice
 * says what was billed, never what came back. A refund leaves the invoice
 * `paid`, so crediting off invoice.total would hand a refunded customer their
 * money a second time. The PaymentIntent's latest charge is the only object
 * carrying `amount_refunded` and `disputed`.
 *
 * `amount_captured - amount_refunded` is what the customer paid AND KEPT
 * paying, which makes the brief's "no credit if the pass was refunded" fall out
 * of the arithmetic (a full refund nets to zero) and gives the partial-refund
 * case — which the brief does not name — the only answer that cannot over-credit.
 *
 * `stripe_unreadable` covers an unexpanded or absent charge as well as a failed
 * call: without the charge we cannot rule out a refund, and "probably not
 * refunded" is not a basis for moving money. A disputed charge is money that may
 * still be clawed back, so it is worth nothing here.
 */
type NetPaid =
  | { ok: true; amountMinor: number; currency: string }
  | { ok: false; reason: "stripe_unreadable" | "nothing_owed" };

async function netPaidForIntent(intent: string): Promise<NetPaid> {
  let pi: Stripe.PaymentIntent;
  try {
    pi = await getStripe().paymentIntents.retrieve(intent, { expand: ["latest_charge"] });
  } catch {
    return { ok: false, reason: "stripe_unreadable" };
  }
  if (pi.status !== "succeeded") return { ok: false, reason: "nothing_owed" };

  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return { ok: false, reason: "stripe_unreadable" };
  if (charge.status !== "succeeded" || charge.disputed)
    return { ok: false, reason: "nothing_owed" };

  const net = (charge.amount_captured ?? 0) - (charge.amount_refunded ?? 0);
  if (net <= 0) return { ok: false, reason: "nothing_owed" };
  return { ok: true, amountMinor: net, currency: pi.currency };
}

/**
 * Has this pass intent already bought this customer a credit?
 *
 * The sharp edge of the whole feature: the credit is granted when checkout is
 * CREATED, and a user who abandons checkout and starts again would otherwise be
 * credited twice, making the second attempt effectively free.
 *
 * `listBalanceTransactions` has no metadata filter, so the scan is client-side,
 * bounded two ways: `created: { gte: purchase }` (a credit for this pass cannot
 * predate the pass) and auto-pagination with a hard cap. Any failure reads as
 * "already credited" — refusing to credit is the safe answer when we cannot see
 * the history.
 */
async function alreadyCredited(
  customerId: string,
  intent: string,
  purchasedAt: Date,
): Promise<boolean> {
  try {
    const seen = await getStripe()
      .customers.listBalanceTransactions(customerId, {
        limit: 100,
        created: { gte: Math.floor(purchasedAt.getTime() / 1000) },
      })
      .autoPagingToArray({ limit: 1000 });
    return seen.some((t) => t.metadata?.[PASS_CREDIT_INTENT_KEY] === intent);
  } catch {
    return true;
  }
}

/**
 * Credit the org's most recent Event Pass toward the subscription it is about
 * to buy. Called by POST /api/billing/checkout BEFORE the session is created.
 *
 * Never throws: a checkout must not 500 because a credit could not be worked
 * out. Every failure mode is an outcome instead, so the caller (and the tests)
 * can see WHICH rule declined rather than just "no credit".
 *
 * Plan scope ("Pro and Pro Plus") is the caller's: `checkoutSchema.plan_key` is
 * `z.enum(["pro", "pro_plus"])`, so the only route that calls this cannot ask
 * for anything else.
 */
export async function creditPassTowardSubscription(orgId: string): Promise<PassCreditResult> {
  const pass = await mostRecentPass(orgId);
  if (!pass) return none("no_pass");

  const purchasedAt = new Date(pass.purchased_at);
  if (!withinCreditWindow(purchasedAt)) return none("outside_window");

  // A pass with no payment intent was never paid for — staff grants and comps
  // land this way. Crediting one hands the customer $29 of nothing.
  const intent = pass.stripe_payment_intent;
  if (!intent) return none("unpaid_pass");

  const [sub] = await sql<{ stripe_customer_id: string | null; currency: string | null }[]>`
    select stripe_customer_id, currency from subscriptions where org_id = ${orgId}`;
  if (!sub?.stripe_customer_id) return none("no_customer", intent);
  // A balance credit is denominated: a gbp credit does nothing for a usd
  // invoice, it just sits there. NULL means we cannot prove what the upcoming
  // subscription will be billed in — preferredCurrency() would fall through to
  // a cookie or Accept-Language — so there is no match to assert.
  if (!sub.currency) return none("currency_unknown", intent);

  const paid = await netPaidForIntent(intent);
  if (!paid.ok) return none(paid.reason, intent);
  if (paid.currency !== sub.currency) return none("currency_mismatch", intent);

  if (await alreadyCredited(sub.stripe_customer_id, intent, purchasedAt))
    return none("already_credited", intent);

  try {
    await getStripe().customers.createBalanceTransaction(
      sub.stripe_customer_id,
      {
        // NEGATIVE is the credit direction: "a negative value is a credit for
        // the customer's balance, and a positive value is a debit".
        amount: -paid.amountMinor,
        currency: paid.currency,
        description: `Event Pass credit — ${pass.name}`,
        metadata: { [PASS_CREDIT_INTENT_KEY]: intent, org_id: orgId },
      },
      // A 24-hour belt on top of the metadata scan, for the retry-after-timeout
      // case where the first create landed but the response never arrived.
      { idempotencyKey: `pass-credit-${intent}` },
    );
  } catch {
    return none("stripe_unreadable", intent);
  }

  return {
    outcome: "credited",
    amountMinor: paid.amountMinor,
    currency: paid.currency,
    paymentIntent: intent,
  };
}
