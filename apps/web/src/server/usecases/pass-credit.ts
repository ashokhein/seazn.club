import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { sql } from "@/lib/db";
import { sendPassCreditReversalIncompleteAlertEmail } from "@/lib/email";

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
 * `pass_credit_redemptions_group_cap` (V335) is the real backstop — a partial
 * unique index on `subscription_id where reversed_at is null` — so this read
 * is only an optimisation to avoid the Stripe round trip and the wasted
 * `createBalanceTransaction` call on the common case. A race that slips past
 * this SELECT is still caught by the index at INSERT time below.
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
      where subscription_id = ${subscriptionId} and reversed_at is null limit 1`;
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
    //     reversed_at is null): a DIFFERENT intent won the group's one
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
export async function reversePassCreditOnRefund(intent: string): Promise<void> {
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
  const [won] = await sql<{ payment_intent: string }[]>`
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
