import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { sendPassCreditReversalIncompleteAlertEmail } from "@/lib/email";
import type { PassKey } from "@/lib/currency";

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

/**
 * Name of the partial unique index that enforces the group's lifetime cap
 * (V335, `db/migration/deltas/V335__pass_credit_redemptions.sql`). This is
 * an explicit `create unique index ... name`, unlike `payment_intent`'s bare
 * `unique` column constraint, which Postgres auto-names
 * `pass_credit_redemptions_payment_intent_key`. postgres.js surfaces which
 * one fired on a 23505 via `err.constraint_name` — verified live 2026-07-26
 * against this exact table: a payment_intent conflict reports
 * `pass_credit_redemptions_payment_intent_key`, a group-cap conflict reports
 * `pass_credit_redemptions_group_cap`. The two mean opposite things for
 * whether a compensating Stripe transaction is owed — see the INSERT catch
 * in `creditPassTowardSubscription` below.
 */
const GROUP_CAP_CONSTRAINT = "pass_credit_redemptions_group_cap";

/**
 * Name of the bare `unique` column constraint on `payment_intent`
 * (`db/migration/deltas/V335__pass_credit_redemptions.sql`). Postgres
 * auto-names an unadorned `column unique` constraint `<table>_<column>_key`,
 * which is what this is — not derived from any naming convention, just what
 * V335 actually creates. Named explicitly (rather than reached by excluding
 * `GROUP_CAP_CONSTRAINT`) so a future migration that adds a THIRD unique
 * constraint to this table cannot silently fall into the same branch as this
 * one: an unrecognised constraint name must read as "we do not know what
 * happened" (`redemption_unrecorded`), not be guessed to be this one.
 */
const PAYMENT_INTENT_CONSTRAINT = "pass_credit_redemptions_payment_intent_key";

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
  | "already_credited"
  /**
   * The GROUP (not this org, not this intent) has already redeemed its one
   * lifetime pass credit — `pass_credit_redemptions` holds a live row for the
   * subscription. Deliberately its own outcome, not folded into
   * `already_credited`: that name means "this exact intent, already seen";
   * this means "a DIFFERENT pass already spent the group's one credit".
   */
  | "group_already_redeemed"
  /**
   * The Stripe credit succeeded but the local `pass_credit_redemptions` row
   * could not be written, for a reason that is NOT the payment_intent unique
   * constraint (which reads as `already_credited`, see below) or the
   * group-cap index (which reads as `group_already_redeemed`). A genuine
   * Postgres fault — connection, constraint we didn't anticipate, etc. — not
   * a Stripe one, so it gets its own honest label instead of folding into
   * `stripe_unreadable`.
   */
  | "redemption_unrecorded";

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
 * Does this billing GROUP already hold a live (un-reversed) pass credit?
 *
 * `pass_credit_redemptions_group_cap` (V335, widened by V337) is the real
 * backstop — a partial unique index on `subscription_id where reversed_at is
 * null or reversal_undetermined_at is not null` — so this read is only an
 * optimisation to avoid the Stripe round trip and the wasted
 * `createBalanceTransaction` call on the common case. A race that slips past
 * this SELECT is still caught by the index at INSERT time below. The
 * predicate here must MATCH that index's (#286): an undetermined reversal
 * (reversed_at stamped, nothing actually clawed back) still holds the cap.
 *
 * Exported (unlike `alreadyCredited`/`netPaidForIntent`) so the fail-closed
 * behaviour on a genuine DB fault can be pinned directly — the real suite
 * runs against real Postgres rather than a mock, so there is no other seam
 * to force this specific SELECT to fail without corrupting the whole test.
 */
export async function groupAlreadyRedeemed(subscriptionId: string): Promise<boolean> {
  try {
    const [row] = await sql<{ one: number }[]>`
      select 1 as one from pass_credit_redemptions
      where subscription_id = ${subscriptionId}
        and (reversed_at is null or reversal_undetermined_at is not null)
      limit 1`;
    return !!row;
  } catch {
    // Same rule as `alreadyCredited`: this function is load-bearing for the
    // lifetime cap even though it is only ever framed as an "optimisation"
    // above (the index at INSERT time is the real backstop) — but the cap
    // means nothing if a DB hiccup makes every request believe the SELECT
    // came back empty. `creditPassTowardSubscription` never throws, so
    // failing this check must fail toward "no credit", not toward "assume
    // clear and race the unique index".
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

  const [sub] = await sql<
    { id: string; stripe_customer_id: string | null; currency: string | null }[]
  >`
    select s.id, s.stripe_customer_id, s.currency from subscriptions s
    join organizations o on o.subscription_id = s.id
    where o.id = ${orgId}`;
  if (!sub?.stripe_customer_id) return none("no_customer", intent);
  // A balance credit is denominated: a gbp credit does nothing for a usd
  // invoice, it just sits there. NULL means we cannot prove what the upcoming
  // subscription will be billed in — preferredCurrency() would fall through to
  // a cookie or Accept-Language — so there is no match to assert.
  if (!sub.currency) return none("currency_unknown", intent);

  // The group's lifetime cap, checked BEFORE any Stripe read: cheaper than
  // `netPaidForIntent`, and it is the rule most likely to fire once a group has
  // redeemed once, so there is no reason to pay for a Stripe round trip first.
  if (await groupAlreadyRedeemed(sub.id)) return none("group_already_redeemed", intent);

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

  // Credit-then-insert, deliberately: the row can only be written with numbers
  // (amount/currency) Stripe has already confirmed, and it doubles as the
  // race backstop below (a lost-race loser needs to know money already moved
  // BEFORE it tries to record anything). The cost is a real crash window: if
  // the process dies between the createBalanceTransaction call above
  // returning and this INSERT committing, the customer keeps the credit but
  // no local row says so. The `already_credited` metadata scan still blocks a
  // retry of THIS SAME intent, so the narrow residual risk is a future,
  // different pass on the same group sailing through `groupAlreadyRedeemed`
  // and minting a second credit — exactly the defect this table exists to
  // close, just for a single non-blocking SQL statement's width of the code
  // rather than for every retry. The alternative, reserving the row first,
  // trades that sliver for a much wider one: every ordinary Stripe failure
  // (down, rate-limited, disputed) already returns cleanly with no side
  // effect today, and reserving first would mean unwinding that reservation
  // on every one of those paths too — each a new place a crash strands the
  // group PERMANENTLY capped with nothing ever credited, and with no Stripe
  // object to reconcile against to even notice. Under-crediting one retry
  // window is recoverable (buy another pass, try again); over-reserving with
  // no undo path is not.
  try {
    await sql`
      insert into pass_credit_redemptions
        (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency)
      values (${sub.id}, ${orgId}, ${pass.competition_id}, ${intent}, ${paid.amountMinor}, ${paid.currency})`;
  } catch (err) {
    // Two DIFFERENT unique constraints can trip 23505 here, and they mean
    // opposite things — postgres.js surfaces which one on `constraint_name`
    // (verified live 2026-07-26: same shape for both).
    //
    //   - GROUP_CAP_CONSTRAINT (the partial index on subscription_id where
    //     `reversed_at is null or reversal_undetermined_at is not null` — V337
    //     widened it so an undetermined reversal keeps holding the cap): a
    //     DIFFERENT intent won the group's one
    //     lifetime credit between `groupAlreadyRedeemed` above and this
    //     INSERT. The balance transaction above is a genuine SECOND credit
    //     for the group and must be compensated.
    //   - PAYMENT_INTENT_CONSTRAINT, the bare `payment_intent unique` column
    //     constraint (Postgres auto-names it
    //     `pass_credit_redemptions_payment_intent_key`): the SAME intent was
    //     already redeemed — two concurrent requests for the same pass both
    //     call createBalanceTransaction with idempotencyKey
    //     `pass-credit-${intent}`, so Stripe dedupes them into ONE real
    //     transaction and returns success to both callers. The loser did NOT
    //     create a second credit, so compensating here would cancel the one
    //     legitimate credit and leave the customer with a redemption row
    //     claiming money that isn't on the balance any more. This is an
    //     ordinary double-click, not a race, and `already_credited` is the
    //     outcome that already describes it.
    const pgErr = err as { code?: string; constraint_name?: string };
    if (pgErr.code === "23505" && pgErr.constraint_name === GROUP_CAP_CONSTRAINT) {
      try {
        await getStripe().customers.createBalanceTransaction(
          sub.stripe_customer_id,
          {
            amount: paid.amountMinor,
            currency: paid.currency,
            description: `Event Pass credit reversal — lost race, ${pass.name}`,
            metadata: { [PASS_CREDIT_INTENT_KEY]: intent, org_id: orgId, reversal: "lost_race" },
          },
          // Same belt as the grant above: a retried reversal (e.g. the first
          // response never arrived) must not double-debit the customer.
          { idempotencyKey: `pass-credit-reversal-${intent}` },
        );
      } catch {
        // Best-effort: nothing more to do without throwing out of a function
        // whose whole contract is "never throws".
      }
      return none("group_already_redeemed", intent);
    }
    if (pgErr.code === "23505" && pgErr.constraint_name === PAYMENT_INTENT_CONSTRAINT) {
      // Same-intent double-click. Stripe already collapsed the two
      // createBalanceTransaction calls into one credit — do NOT touch Stripe.
      return none("already_credited", intent);
    }
    // Anything else here — including a 23505 on a constraint name that is
    // NEITHER of the two named above — is an unexpected local-DB failure, not
    // a Stripe one. The Stripe credit already happened and is real, so this
    // must not read as `stripe_unreadable` (which would mislabel a DB fault
    // as a Stripe one and could mislead reconciliation). A genuinely unknown
    // constraint name is deliberately NOT assumed to be the payment_intent
    // case by exclusion: today this table has exactly two unique constraints,
    // but a future migration adding a third would otherwise silently route a
    // real race into `already_credited`, skip the compensation actually owed,
    // and quietly reopen the stacking bug this whole table exists to close.
    // `redemption_unrecorded` is the honest "we do not know what state this
    // is in" outcome for every one of those cases, known or not, rather than
    // a guess. No compensation either: unlike the group-cap case this is not
    // a proven second credit, just an unwritten row for a legitimate one.
    return none("redemption_unrecorded", intent);
  }

  return {
    outcome: "credited",
    amountMinor: paid.amountMinor,
    currency: paid.currency,
    paymentIntent: intent,
  };
}

/**
 * True when something OTHER than this pass's own grant has added credit to
 * the customer's balance pool since it was granted — a plan-downgrade
 * proration credit (`buildIntervalChangeParams`'s `always_invoice` posts a
 * negative invoice total, which Stripe auto-credits onto the same
 * `customer.balance` field `billing-manage.ts:256`/`:63` read) is the
 * concrete case, but ANY other credit source qualifies.
 *
 * `customer.balance` is one undifferentiated scalar with no per-transaction
 * attribution, so once a second credit source has touched it there is no way
 * to ask Stripe how much of the CURRENT balance is this pass's money vs the
 * other source. When this returns true, `reverseAmount`'s min() formula can
 * no longer be trusted — the caller must not guess a split it cannot prove.
 *
 * Same bounded/autopaging shape as `alreadyCredited`, and the same
 * fail-closed posture: a read failure is treated as "cannot prove the pool is
 * clean" (returns true), not "assume clean and reverse anyway".
 */
async function otherCreditActivitySince(
  customerId: string,
  intent: string,
  since: Date,
): Promise<boolean> {
  try {
    const seen = await getStripe()
      .customers.listBalanceTransactions(customerId, {
        limit: 100,
        created: { gte: Math.floor(since.getTime() / 1000) },
      })
      .autoPagingToArray({ limit: 1000 });
    // A credit is a NEGATIVE amount (mirrors the negative-is-credit comment on
    // the grant call below); the grant's own transaction is excluded by its
    // metadata, not by the `gte` bound alone — the grant's Stripe-side
    // `created` can land in the same second as `redeemed_at` (the grant call
    // happens, THEN the row is inserted with `now()`), so the window can
    // technically include it.
    return seen.some((t) => t.amount < 0 && t.metadata?.[PASS_CREDIT_INTENT_KEY] !== intent);
  } catch {
    return true;
  }
}

/**
 * The webhook backstop for a Dashboard refund (design §5). Nothing in this
 * codebase can stop support (or a chargeback) from refunding an Event Pass
 * charge directly in Stripe, and `revokePassForRefundedChargeAndNotify`
 * already claws back the pass entitlement and the 25 AI credits when that
 * happens — but not the £/$ subscription credit `creditPassTowardSubscription`
 * may have already granted. Left alone, a refunded pass would hand the money
 * back in cash while the org keeps the discount.
 *
 * Called unconditionally from that wrapper (not gated on whether the pass row
 * itself was deleted — a partial refund leaves it in place) with just the
 * charge's payment intent; this function does its own lookup and is a silent
 * no-op when there is nothing to reverse. Never throws — same contract as
 * `creditPassTowardSubscription` — and the caller discards its result.
 */
export async function reversePassCreditOnRefund(
  intent: string,
  /**
   * The RUNG the refunded pass was, for the staff alert below — or null when
   * the caller found no `competition_passes` row for this intent, in which case
   * there is no redemption row either and this function returns before ever
   * using it (v17 #294).
   *
   * REQUIRED and passed in rather than looked up here: the wrapper reads the
   * pass row BEFORE `revokePassForRefundedCharge` deletes it, which on a full
   * refund is the last moment the rung exists. A default would put the wave's
   * third silently-wrong-rung landmine on the one path that reports money the
   * business could not claw back.
   */
  passKey: PassKey | null,
): Promise<void> {
  const [redemption] = await sql<
    {
      subscription_id: string;
      org_id: string;
      competition_id: string;
      amount_minor: number;
      currency: string;
      redeemed_at: string | Date;
      reversed_at: string | Date | null;
    }[]
  >`
    select subscription_id, org_id, competition_id, amount_minor, currency, redeemed_at, reversed_at
    from pass_credit_redemptions
    where payment_intent = ${intent}`;
  // No row: covers three silent-no-op cases — a non-pass charge refund, a
  // duplicate-pass-payment refund (refundDuplicatePassPayment, lib/billing.ts:
  // that intent was never the one mostRecentPass credited, so it never earns a
  // row here), and a pass refunded before it ever earned a credit. Already
  // reversed: a webhook replay — in ADDITION to, not instead of, the Stripe
  // idempotency key below; this DB check protects the write and skips the
  // network round trip, the key protects the Stripe call itself. (It is only
  // a fast-path skip, not the sole race guard — the UPDATE below re-checks
  // `reversed_at is null` for two genuinely concurrent deliveries that both
  // pass this read before either writes.)
  if (!redemption || redemption.reversed_at) return;

  const [sub] = await sql<{ stripe_customer_id: string | null }[]>`
    select stripe_customer_id from subscriptions where id = ${redemption.subscription_id}`;
  if (!sub?.stripe_customer_id) {
    // Should not happen — the redemption row only ever gets written for a
    // group that already had a customer id at credit time — but never assume.
    // This file's rule is "unproven state yields no credit outcome"; the
    // mirror of that here is "unproven state performs no reversal".
    console.error(
      `[billing] pass credit reversal for intent ${intent}: subscription ` +
        `${redemption.subscription_id} has no stripe_customer_id`,
    );
    return;
  }

  // Checked BEFORE reading the live balance: if the pool is not provably
  // pass-money-only, no amount computed from `customer.balance` can be
  // trusted, so there is nothing safe to compute — skip straight to the
  // undetermined outcome without spending a second Stripe call on the
  // balance read.
  const unsafe = await otherCreditActivitySince(
    sub.stripe_customer_id,
    intent,
    new Date(redemption.redeemed_at),
  );

  let reverseAmount = 0;
  if (!unsafe) {
    let customer: Stripe.Customer | Stripe.DeletedCustomer;
    try {
      customer = await getStripe().customers.retrieve(sub.stripe_customer_id);
    } catch (err) {
      console.error(`[billing] pass credit reversal failed for intent ${intent}: ${err}`);
      return;
    }
    if (customer.deleted) {
      console.error(
        `[billing] pass credit reversal for intent ${intent}: customer ` +
          `${sub.stripe_customer_id} is deleted`,
      );
      return;
    }

    // Stripe's customer balance is ONE POOL per currency, shared with any
    // other credit source that customer might ever have — but `unsafe` above
    // has already proven nothing else has touched it since this grant, so
    // this min() is exactly correct here:
    //   - capped at redemption.amount_minor — never reverses more than THIS
    //     pass ever granted, however large the current balance is for
    //     unrelated reasons.
    //   - capped at max(-customer.balance, 0) — never creates a positive
    //     (debt-inducing) balance. If less credit remains than was granted,
    //     the difference was already consumed by an invoice and is written
    //     off — see the alert below.
    reverseAmount = Math.min(redemption.amount_minor, Math.max(-(customer.balance ?? 0), 0));

    if (reverseAmount > 0) {
      try {
        await getStripe().customers.createBalanceTransaction(
          sub.stripe_customer_id,
          {
            // POSITIVE = debit = reduces the customer's credit, mirroring the
            // negative-is-credit comment on the grant call above.
            amount: reverseAmount,
            currency: redemption.currency,
            description: `Event Pass credit reversal — pass refunded`,
            metadata: { [PASS_CREDIT_INTENT_KEY]: intent, reversal: "refunded" },
          },
          // Distinct namespace from the group-cap lost-race reversal above
          // (`pass-credit-reversal-${intent}`) even though the two can never
          // fire for the same intent (that path only runs when NO redemption
          // row was written for the insert; this path requires one to exist)
          // — a shared key string across two semantically different reversal
          // reasons is a landmine for whoever reads the Stripe dashboard or
          // greps for the key next.
          //
          // Two genuinely concurrent deliveries reaching here with DIFFERENT
          // `reverseAmount`s (each read `customer.balance` at a slightly
          // different moment) hit this SAME idempotency key with DIFFERENT
          // params — Stripe's documented behaviour is to reject the second
          // call outright (idempotency-key-reused-with-different-parameters),
          // landing it in the catch below: logged, no `reversed_at` write, a
          // later retry can still succeed cleanly. Degrades safely without
          // any extra handling.
          { idempotencyKey: `pass-credit-refund-reversal-${intent}` },
        );
      } catch (err) {
        // No `reversed_at` write below: a redelivered webhook must get a
        // genuine retry, not a false "already handled".
        console.error(`[billing] pass credit reversal failed for intent ${intent}: ${err}`);
        return;
      }
    }
  }

  // `and reversed_at is null` + `returning`: the earlier read-check above is
  // only a fast-path skip, not the real race guard. Two concurrent deliveries
  // can both pass that read before either writes; this UPDATE is the actual
  // optimistic-concurrency check — only the caller that flips the row from
  // NULL to set gets a row back, so only that caller sends the staff alert
  // below. The loser returns having done nothing further, exactly as if it
  // had lost the earlier read-check.
  // #286: `reversed_at` is stamped on every call — it still doubles as the
  // "this webhook delivery has been handled" idempotency guard the
  // early-return at the top of this function reads (line 524). But when
  // `unsafe` is true nothing was actually clawed back, so
  // `reversal_undetermined_at` is ALSO stamped, and V337's widened partial
  // index keeps pass_credit_redemptions_group_cap HELD for this row even
  // though reversed_at is set — the bug this migration exists to close.
  // This wave the hold is PERMANENT: nothing ever clears
  // `reversal_undetermined_at`, so the group's one lifetime pass credit stays
  // blocked until staff resolution tooling ships — there is no self-serve
  // release path, and resolving the balance in Stripe does not touch this row.
  // The staff alert below says so in as many words
  // (`sendPassCreditReversalIncompleteAlertEmail`, reason "undetermined"),
  // because holding the cap forever is only defensible while a human is being
  // told about every row that does it.
  const [won] = unsafe
    ? await sql<{ payment_intent: string }[]>`
        update pass_credit_redemptions
        set reversed_at = now(), reversed_minor = ${reverseAmount}, reversal_undetermined_at = now()
        where payment_intent = ${intent} and reversed_at is null
        returning payment_intent`
    : await sql<{ payment_intent: string }[]>`
        update pass_credit_redemptions
        set reversed_at = now(), reversed_minor = ${reverseAmount}
        where payment_intent = ${intent} and reversed_at is null
        returning payment_intent`;
  if (!won) return;

  if (unsafe || reverseAmount < redemption.amount_minor) {
    // Two distinct reasons to alert, both money the business is not (or
    // cannot safely) claw back: `unsafe` — other balance activity means the
    // split cannot be proven, so NOTHING was reversed and a human must read
    // the Stripe balance transaction history directly; otherwise, the
    // (provable) unreversed remainder was already consumed by an invoice and
    // is being written off. The redemption row already carries org_id and
    // competition_id, so this is a lookup rather than a value passed through
    // from the caller.
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (alertTo) {
      const [org] = await sql<{ name: string }[]>`
        select name from organizations where id = ${redemption.org_id}`;
      const [comp] = await sql<{ name: string }[]>`
        select name from competitions where id = ${redemption.competition_id}`;
      void sendPassCreditReversalIncompleteAlertEmail({
        to: alertTo,
        // A redemption row only ever exists for a charge that WAS a pass, so
        // the caller found a row and `passKey` is non-null here; the fallback
        // keeps the alert honest rather than inventing a rung.
        passKey: passKey ?? "event_pass",
        orgId: redemption.org_id,
        orgName: org?.name ?? "unknown",
        competitionName: comp?.name ?? "unknown",
        grantedMinor: redemption.amount_minor,
        reversedMinor: reverseAmount,
        currency: redemption.currency,
        reason: unsafe ? "undetermined" : "consumed",
      }).catch(() => {});
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * §6 — STAFF RESOLUTION of an undetermined reversal (#305, #286 phase 2)
 *
 * V337 (phase 1) made the undetermined branch hold `pass_credit_redemptions_
 * group_cap` PERMANENTLY: `reversed_at` is stamped (it is still the webhook
 * idempotency guard) but nothing was actually clawed back, so the widened
 * partial index keeps treating the row as live. That is the right default —
 * the customer provably still holds the £/$ credit, and freeing the cap would
 * let the same group mint a SECOND one — but phase 1 shipped with no way out.
 * Once staff settle the balance by hand in the Stripe dashboard, the row went
 * on blocking the group forever and the alert email said so in as many words.
 *
 * This is the way out. Two design rules, both load-bearing:
 *
 *  1. **Both outcomes are expressible.** `clawed_back` ("I removed the credit
 *     in Stripe") releases the cap; `kept` ("the customer keeps it") leaves
 *     the cap held and records that a human decided so. A tool offering only
 *     the first is a lever for handing out a second credit; one offering only
 *     the second cannot resolve anything. Neither is the safe default, so
 *     neither is a default — the caller must say which.
 *  2. **Nothing here touches Stripe.** The claw-back this records ALREADY
 *     HAPPENED, by hand, which is the only reason a human is in the loop at
 *     all: the undetermined branch exists precisely because the balance pool
 *     could not be attributed automatically. Creating a balance transaction
 *     from here would debit a customer whose money was already taken back.
 *
 * The write and its `staff_audit_log` row commit TOGETHER (the admin-addons.ts
 * / #272 adminAdjust pattern) — a crash between them could otherwise free a
 * money-bearing cap with nobody's name against it, and the audit row is the
 * ONLY record of who decided and which way (`reversal_undetermined_at` going
 * NULL says the decision happened, not who made it).
 *
 * NO entitlement-cache invalidation is needed here, deliberately and checked:
 * `pass_credit_redemptions` is read in exactly one place outside this file's
 * own reversal lookup — `groupAlreadyRedeemed`, called live inside
 * `creditPassTowardSubscription` on the checkout path. It feeds no
 * `lib/entitlements.resolve()` branch and no `ent:<org>:*` cache key, so there
 * is no TTL window in which a resolved row keeps behaving as unresolved.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a human concluded about an undetermined reversal.
 *
 * - `clawed_back` — staff removed the credit from the customer's Stripe
 *   balance themselves. The money is back, so the group's lifetime cap must be
 *   released: `reversal_undetermined_at` is cleared and `reversed_minor` is
 *   corrected to what was actually taken.
 * - `kept` — the customer keeps the credit (goodwill, un-splittable pool,
 *   whatever finance decided). The cap must GO ON holding, exactly as before;
 *   all that changes is that the row is no longer an unanswered question.
 */
export type PassCreditReversalResolution = "clawed_back" | "kept";

/** `open` = nobody has decided yet. Otherwise the decision that was recorded. */
export type PassCreditReversalStatus = "open" | PassCreditReversalResolution;

/**
 * `staff_audit_log.action` for a resolution. Exported so the admin surface and
 * the tests agree on the string rather than each spelling it out — this is the
 * only durable record of WHO decided, so a typo on one side silently splits
 * the history in two.
 */
export const PASS_CREDIT_RESOLVE_ACTION = "pass_credit_reversal_resolve";

export interface PassCreditReversalResolveInput {
  resolution: PassCreditReversalResolution;
  /**
   * Minor units staff actually removed from the customer balance in Stripe.
   * REQUIRED for `clawed_back` and bounded by the grant: the undetermined
   * branch wrote `reversed_minor = 0` (nothing moved), and leaving that 0 while
   * releasing the cap would leave the row claiming a reversal of nothing.
   * Ignored for `kept`, where nothing moved and 0 is the truth.
   */
  reversedMinor?: number;
  /** Free text — what staff checked, and where. Stored in the audit detail. */
  reason: string;
}

/**
 * Record a staff decision about ONE undetermined redemption.
 *
 * Unlike the other two exports in this file, this one THROWS: it is a staff
 * action behind an admin route, not a webhook or checkout path, so a refusal
 * must reach the operator as a typed error rather than be swallowed into a
 * silent no-op.
 *
 * Idempotent on replay (double-clicked button, retried request): re-recording
 * the decision the row already carries returns `{ resolved: false }` and writes
 * NO second audit row — a duplicate there reads as two separate decisions.
 * Changing one's mind is NOT a replay: a `kept` row can still be resolved
 * `clawed_back` later when finance does take the money back, and that writes a
 * second, genuine audit row.
 *
 * @returns whether this call actually recorded a decision.
 * @throws HttpError 404 unknown redemption, 409 nothing undetermined to
 *   resolve, 422 a claw-back amount that is not 0..grant.
 */
export async function resolveUndeterminedPassCreditReversal(
  actorId: string,
  redemptionId: string,
  input: PassCreditReversalResolveInput,
): Promise<{ resolved: boolean }> {
  const { resolution, reason } = input;

  return sql.begin(async (tx) => {
    // `for update` serialises two operators (or one double-click) on the same
    // row: without it both can read `reversal_undetermined_at` as set and both
    // write an audit row for a single decision.
    const [row] = await tx<
      { id: string; org_id: string; amount_minor: number; reversal_undetermined_at: Date | null }[]
    >`
      select id, org_id, amount_minor, reversal_undetermined_at
        from pass_credit_redemptions where id = ${redemptionId} for update`;
    if (!row) throw new HttpError(404, "No such pass credit redemption.");

    // The last decision recorded for this row, if any. There is no column for
    // it — the audit log IS the record (see the §6 header) — so the replay
    // guard reads it back from there.
    const [prior] = await tx<{ resolution: string | null }[]>`
      select detail->>'resolution' as resolution
        from staff_audit_log
       where action = ${PASS_CREDIT_RESOLVE_ACTION}
         and detail->>'redemption_id' = ${redemptionId}
       order by created_at desc, chain_seq desc
       limit 1`;

    if (row.reversal_undetermined_at === null) {
      // Cap already free. Either this exact decision already landed (replay),
      // or the row was never undetermined at all — an ordinary automatic
      // reversal, which has nothing for a human to decide.
      if (prior?.resolution === "clawed_back") return { resolved: false };
      throw new HttpError(409, "This redemption has no undetermined reversal to resolve.");
    }

    let reversedMinor = 0;
    if (resolution === "clawed_back") {
      const claimed = input.reversedMinor;
      if (!Number.isInteger(claimed) || claimed! < 0 || claimed! > row.amount_minor) {
        throw new HttpError(
          422,
          `reversed_minor must be a whole number between 0 and the ${row.amount_minor} minor units originally granted.`,
        );
      }
      reversedMinor = claimed!;
      // THE release. `reversed_at` is deliberately untouched — it is the
      // webhook-replay idempotency stamp, not a statement about money.
      await tx`
        update pass_credit_redemptions
           set reversal_undetermined_at = null, reversed_minor = ${reversedMinor}
         where id = ${redemptionId}`;
    } else if (prior?.resolution === "kept") {
      // Already reviewed and left standing — nothing changed, so nothing to log.
      return { resolved: false };
    }
    // `kept` writes no column at all: the cap stays held exactly as V337 left
    // it, and the audit row below is the whole of the change.

    // Mirror logStaffAction's columns (lib/admin.ts) on THIS tx — never call
    // logStaffAction itself here, it opens its own connection outside the tx.
    // target_type 'org' / target_id the org: that is the entity an operator
    // looks the decision up by, and the redemption is identified in `detail`.
    await tx`
      insert into staff_audit_log (actor_id, action, target_type, target_id, detail)
      values (${actorId}, ${PASS_CREDIT_RESOLVE_ACTION}, 'org', ${row.org_id}, ${tx.json({
        redemption_id: redemptionId,
        resolution,
        reversed_minor: reversedMinor,
        granted_minor: row.amount_minor,
        reason,
      } as never)})`;
    return { resolved: true };
  });
}

/** One undetermined (or since-resolved) redemption, for the staff worklist. */
export interface UndeterminedPassCreditReversal {
  id: string;
  paymentIntent: string;
  orgId: string;
  orgName: string | null;
  competitionName: string | null;
  subscriptionId: string;
  amountMinor: number;
  reversedMinor: number | null;
  currency: string;
  redeemedAt: string;
  reversedAt: string | null;
  /** NULL once resolved `clawed_back`; still set for `open` and for `kept`. */
  undeterminedAt: string | null;
  status: PassCreditReversalStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  reason: string | null;
}

const UNDETERMINED_LIST_LIMIT = 200;

/**
 * The staff worklist the issue's inventory query (`select * from
 * pass_credit_redemptions where reversal_undetermined_at is not null`) was a
 * stand-in for, joined to the decision each row carries.
 *
 * Includes THREE states, not one:
 *  - `open`        — still undetermined, nobody has decided. Cap held.
 *  - `kept`        — decided: customer keeps the credit. Cap held ON PURPOSE.
 *  - `clawed_back` — decided: staff took it back. Cap released.
 *
 * A `clawed_back` row no longer matches the inventory query at all, so it is
 * reached through its audit row instead — dropping it would make the tool look
 * like it had erased the record of its own most consequential action.
 * Unresolved rows sort first: the whole value of the list is the queue.
 */
export async function listUndeterminedPassCreditReversals(): Promise<
  UndeterminedPassCreditReversal[]
> {
  const rows = await sql<
    {
      id: string;
      payment_intent: string;
      org_id: string;
      org_name: string | null;
      competition_name: string | null;
      subscription_id: string;
      amount_minor: number;
      reversed_minor: number | null;
      currency: string;
      redeemed_at: Date;
      reversed_at: Date | null;
      reversal_undetermined_at: Date | null;
      resolution: string | null;
      resolved_at: Date | null;
      resolved_by: string | null;
      resolved_by_name: string | null;
      reason: string | null;
    }[]
  >`
    select r.id, r.payment_intent, r.org_id, o.name as org_name,
           c.name as competition_name, r.subscription_id, r.amount_minor,
           r.reversed_minor, r.currency, r.redeemed_at, r.reversed_at,
           r.reversal_undetermined_at,
           a.detail->>'resolution' as resolution,
           a.created_at as resolved_at,
           a.actor_id::text as resolved_by,
           coalesce(u.display_name, u.email) as resolved_by_name,
           a.detail->>'reason' as reason
      from pass_credit_redemptions r
      left join organizations o on o.id = r.org_id
      left join competitions c on c.id = r.competition_id
      left join lateral (
        select s.actor_id, s.created_at, s.detail
          from staff_audit_log s
         where s.action = ${PASS_CREDIT_RESOLVE_ACTION}
           and s.detail->>'redemption_id' = r.id::text
         order by s.created_at desc, s.chain_seq desc
         limit 1
      ) a on true
      left join users u on u.id = a.actor_id
     where r.reversal_undetermined_at is not null or a.actor_id is not null
     order by (a.actor_id is not null),
              coalesce(r.reversal_undetermined_at, a.created_at) desc
     limit ${UNDETERMINED_LIST_LIMIT}`;

  return rows.map((r) => ({
    id: r.id,
    paymentIntent: r.payment_intent,
    orgId: r.org_id,
    orgName: r.org_name,
    competitionName: r.competition_name,
    subscriptionId: r.subscription_id,
    amountMinor: r.amount_minor,
    reversedMinor: r.reversed_minor,
    currency: r.currency,
    redeemedAt: new Date(r.redeemed_at).toISOString(),
    reversedAt: r.reversed_at ? new Date(r.reversed_at).toISOString() : null,
    undeterminedAt: r.reversal_undetermined_at
      ? new Date(r.reversal_undetermined_at).toISOString()
      : null,
    // An unrecognised stored value must not be dressed up as a decision.
    status:
      r.resolution === "clawed_back" || r.resolution === "kept"
        ? (r.resolution as PassCreditReversalResolution)
        : "open",
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name,
    reason: r.reason,
  }));
}
