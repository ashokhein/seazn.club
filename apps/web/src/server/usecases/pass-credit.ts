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
