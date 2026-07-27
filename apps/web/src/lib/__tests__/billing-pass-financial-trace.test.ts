// An Event Pass is a $29 purchase that used to leave NO financial trace.
//
//  1. reconcilePassCheckout recorded the pass but never called
//     linkStripeCustomer (its subscription sibling reconcileCheckout does), and
//     nor did the webhook's pass branch — so a pass-only org's
//     subscriptions.stripe_customer_id stayed NULL. The billing page lists
//     stripe.invoices.list({ customer }), so with a NULL customer the buyer saw
//     nothing at all about money they spent, and any later credit would land on
//     an orphan customer.
//  2. subscriptions.currency was only ever written by syncSubscription, so a
//     pass-only org kept NULL and preferredCurrency fell through to a cookie /
//     Accept-Language — someone who paid £25 for a pass could be quoted USD for
//     Pro later. The org's billing currency must be fixed at its FIRST purchase
//     of ANY kind, and never overwritten after.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// checkout.sessions.retrieve is the only Stripe call reconcilePassCheckout
// makes on the happy path; refunds.create covers the duplicate arm. Stub both
// so no network is hit (sibling convention: billing-reconcile-invalidate).
const stripeMock = vi.hoisted(() => {
  const retrieve = vi.fn();
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test" });
  return {
    retrieve,
    refundCreate,
    stripe: {
      checkout: { sessions: { retrieve } },
      refunds: { create: refundCreate },
      // linkStripeCustomer re-derives has_payment_method from the customer's
      // card list when the id CHANGES; an empty list is the honest answer for a
      // customer minted by an embedded pass checkout in this test.
      paymentMethods: { list: vi.fn().mockResolvedValue({ data: [] }) },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import {
  reconcilePassCheckout,
  recordPassPurchase,
  revokePassForRefundedCharge,
} from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { balance, packBalance, reserve, walletIdFor } from "@/lib/credits";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A fresh org + competition + the community subscriptions row every org gets
 *  at creation (lib/auth.ts) — a raw `insert into organizations` does not make
 *  one, and without it both writes under test are silent no-ops. */
async function seedPassBuyer(over?: { currency?: string | null }): Promise<{
  orgId: string;
  compId: string;
}> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Trace Org " + suffix}, ${"trace-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Trace Cup " + suffix}, ${"trace-cup-" + suffix}) returning id`;
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active', ${over?.currency ?? null} from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  return { orgId, compId };
}

/** A paid pass checkout session as reconcilePassCheckout retrieves it. */
function passSession(
  orgId: string,
  compId: string,
  over?: Partial<{ customer: string | null; currency: string | null; payment_intent: string }>,
): Stripe.Checkout.Session {
  return {
    metadata: { org_id: orgId, competition_id: compId, pass_key: "event_pass" },
    payment_status: "paid",
    payment_intent: over?.payment_intent ?? "pi_trace_" + uniq(),
    customer: over && "customer" in over ? over.customer : "cus_trace_" + uniq(),
    currency: over && "currency" in over ? over.currency : "gbp",
  } as unknown as Stripe.Checkout.Session;
}

/** The same session as a checkout.session.completed webhook event. */
const passEvent = (session: Stripe.Checkout.Session) =>
  ({ type: "checkout.session.completed", data: { object: session } }) as unknown as Stripe.Event;

/** A fully-refunded pass charge as revokePassForRefundedCharge sees it. */
const refundedCharge = (intent: string) =>
  ({ payment_intent: intent, refunded: true }) as unknown as Stripe.Charge;

/** A charge.dispute.closed webhook event carrying the pass's payment intent. */
const disputeClosedEvent = (intent: string, status: Stripe.Dispute["status"]) =>
  ({
    type: "charge.dispute.closed",
    data: {
      object: { id: "dp_" + uniq(), payment_intent: intent, status, amount: 2900, currency: "gbp" },
    },
  }) as unknown as Stripe.Event;

const readSub = (orgId: string) =>
  sql<{ stripe_customer_id: string | null; currency: string | null }[]>`
    select s.stripe_customer_id, s.currency from subscriptions s
    join organizations o on o.subscription_id = s.id
    where o.id = ${orgId}`;

beforeEach(() => {
  stripeMock.retrieve.mockReset();
  stripeMock.refundCreate.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("Event Pass leaves a financial trace (reconcile-on-return)", () => {
  it("links the Stripe customer so the invoice reaches the billing page", async () => {
    const { orgId, compId } = await seedPassBuyer();
    // Unique per run: V314's partial unique index on stripe_customer_id means a
    // fixed id would collide with a prior run's leftover (this suite runs in two
    // CI DB steps against one schema and does not delete its rows).
    const cid = "cus_pass_link_" + uniq();
    const session = passSession(orgId, compId, { customer: cid });
    stripeMock.retrieve.mockResolvedValue(session);

    expect(await reconcilePassCheckout(orgId, "cs_pass")).toBe(true);

    const [sub] = await readSub(orgId);
    // NULL before this branch: the billing page's invoices.list({ customer })
    // had no customer to list against.
    expect(sub.stripe_customer_id).toBe(cid);
  });

  it("pins the org's billing currency at its first purchase", async () => {
    const { orgId, compId } = await seedPassBuyer();
    stripeMock.retrieve.mockResolvedValue(passSession(orgId, compId, { currency: "gbp" }));

    expect(await reconcilePassCheckout(orgId, "cs_pass_gbp")).toBe(true);

    const [sub] = await readSub(orgId);
    // Without the pin this stays NULL and preferredCurrency falls through to a
    // cookie / Accept-Language — a £ pass buyer quoted $ for Pro.
    expect(sub.currency).toBe("gbp");
  });

  it("never overwrites a currency the org already has", async () => {
    const { orgId, compId } = await seedPassBuyer({ currency: "eur" });
    stripeMock.retrieve.mockResolvedValue(passSession(orgId, compId, { currency: "usd" }));

    expect(await reconcilePassCheckout(orgId, "cs_pass_eur")).toBe(true);

    const [sub] = await readSub(orgId);
    expect(sub.currency).toBe("eur");
  });

  it("is a no-op on the money fields when the session carries neither", async () => {
    const { orgId, compId } = await seedPassBuyer();
    stripeMock.retrieve.mockResolvedValue(
      passSession(orgId, compId, { customer: null, currency: null }),
    );

    expect(await reconcilePassCheckout(orgId, "cs_pass_bare")).toBe(true);

    const [sub] = await readSub(orgId);
    expect(sub.stripe_customer_id).toBeNull();
    expect(sub.currency).toBeNull();
  });

  it("still reports success when the money-trace write hiccups on an already-recorded pass", async () => {
    // The pass is recorded and live the moment recordPassPurchase returns; the
    // trace writes (linkStripeCustomer / pinBillingCurrency) run AFTER it and
    // are best-effort. A DB hiccup on the trace must not flip the return to
    // false for a pass that already exists (issue #210). Force a real hiccup:
    // another subscription already owns this customer id, so linkStripeCustomer's
    // UPDATE trips V314's partial unique index on stripe_customer_id and throws.
    const { orgId, compId } = await seedPassBuyer();
    const cid = "cus_pass_hiccup_" + uniq();
    await sql`
      with _owner as (
        insert into users (email, display_name, email_verified)
        values ('conflict-' || gen_random_uuid() || '@test.local', 'Conflict Owner', true)
        returning id
      )
      insert into subscriptions (owner_user_id, plan_key, status, stripe_customer_id)
      select id, 'community', 'active', ${cid} from _owner`;
    stripeMock.retrieve.mockResolvedValue(passSession(orgId, compId, { customer: cid }));

    // Before the fix the trace fault propagated to the function-wide catch and
    // returned false — a lie, since the pass is already recorded below.
    expect(await reconcilePassCheckout(orgId, "cs_pass_hiccup")).toBe(true);

    const [pass] = await sql<{ competition_id: string }[]>`
      select competition_id from competition_passes
      where competition_id = ${compId} and org_id = ${orgId}`;
    expect(pass?.competition_id).toBe(compId);
  });

  it("does not link the customer of a session that is not paid", async () => {
    const { orgId, compId } = await seedPassBuyer();
    stripeMock.retrieve.mockResolvedValue({
      ...passSession(orgId, compId, { customer: "cus_unpaid" }),
      payment_status: "unpaid",
    } as unknown as Stripe.Checkout.Session);

    expect(await reconcilePassCheckout(orgId, "cs_pass_unpaid")).toBe(false);

    const [sub] = await readSub(orgId);
    expect(sub.stripe_customer_id).toBeNull();
    expect(sub.currency).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("Event Pass leaves a financial trace (webhook)", () => {
  it("links the customer and pins the currency on the pass branch too", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const cid = "cus_pass_hook_" + uniq();

    await processStripeEvent(
      passEvent(passSession(orgId, compId, { customer: cid, currency: "aud" })),
    );

    const [sub] = await readSub(orgId);
    // The pass branch `return`s before the shared linkStripeCustomer call at the
    // bottom of handleCheckoutCompleted, so it needed its own.
    expect(sub.stripe_customer_id).toBe(cid);
    expect(sub.currency).toBe("aud");
  });

  it("a refunded duplicate does NOT repoint the org's customer or currency", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const winner = "cus_pass_winner_" + uniq();
    // First owner's purchase is the one that counts.
    stripeMock.retrieve.mockResolvedValue(
      passSession(orgId, compId, {
        customer: winner,
        currency: "gbp",
        // Run-unique like every other intent in this file. These trace tests
        // assert customer/currency, not balance, so a literal here never went
        // red — it just quietly stopped granting from run 2 onward, hollowing
        // out the money half of the path they exercise.
        payment_intent: "pi_winner_" + uniq(),
      }),
    );
    expect(await reconcilePassCheckout(orgId, "cs_first")).toBe(true);

    // A second owner pays for the same comp; the charge goes straight back, so
    // their customer is NOT this org's billing customer. Repointing it would
    // aim the billing page's invoices.list at someone who was refunded and, via
    // linkStripeCustomer, wipe the has_payment_method mirror as well.
    await processStripeEvent(
      passEvent(
        passSession(orgId, compId, {
          customer: "cus_pass_loser_" + uniq(),
          currency: "usd",
          payment_intent: "pi_loser_" + uniq(),
        }),
      ),
    );

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    const [sub] = await readSub(orgId);
    expect(sub.stripe_customer_id).toBe(winner);
    expect(sub.currency).toBe("gbp");
  });

  it("a REPLAY of the same payment re-runs both writes idempotently", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const replay = "cus_pass_replay_" + uniq();
    const session = passSession(orgId, compId, {
      customer: replay,
      currency: "eur",
      // Run-unique: this test's whole claim is that a replay "re-runs BOTH
      // writes idempotently". With a literal intent, run 2+ found the grant
      // already keyed and no-oped it, so the assertion stood over a path that
      // had quietly lost its grant half.
      payment_intent: "pi_replay_" + uniq(),
    });
    stripeMock.retrieve.mockResolvedValue(session);

    // Webhook and reconcile racing on ONE payment: the second is a replay, not
    // a duplicate, and must still be free to heal a half-finished first pass.
    await processStripeEvent(passEvent(session));
    expect(await reconcilePassCheckout(orgId, "cs_replay")).toBe(true);

    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
    const [sub] = await readSub(orgId);
    expect(sub.stripe_customer_id).toBe(replay);
    expect(sub.currency).toBe("eur");
  });
});

// SPEC-1 fn3 / SPEC-2 §5, SPEC-6 §A7: a paid Event Pass tops the buyer's wallet
// up by the one-time PASS_CREDIT_GRANT the /pricing card advertises. This is the
// MONEY path — the grant must fire exactly once per competition no matter how
// many times the webhook / reconcile redeliver, and never for a refunded
// duplicate second charge.
describe.skipIf(!HAS_DB)("Event Pass grants one-time AI credits", () => {
  it("a bought pass grants PASS_CREDIT_GRANT credits to the org's wallet", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);
    expect(await balance(walletId)).toBe(0);

    const res = await recordPassPurchase({
      orgId,
      competitionId: compId,
      paymentIntent: "pi_grant_" + uniq(),
    });
    expect(res.recorded).toBe(true);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);
  });

  it("a webhook + reconcile replay of the same payment does NOT double-grant", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);
    const session = passSession(orgId, compId, {
      customer: "cus_grant_replay_" + uniq(),
      currency: "gbp",
      // Run-unique, like every sibling: recordPassGrant's idempotency key is
      // `pass_grant:${paymentIntent}` (lib/credits.ts), so a fixed intent makes
      // the grant single-use PER DATABASE — green on CI's fresh container,
      // permanently red on the second run against the persistent local test DB.
      // The replay under test is expressed by reusing THIS session, not by
      // hardcoding a literal.
      payment_intent: "pi_grant_replay_" + uniq(),
    });
    stripeMock.retrieve.mockResolvedValue(session);

    // A paid Event Pass grants ONLY the SPEC-2 pass credits (25). The SPEC-5 §2
    // first_paid earn does NOT stack here: buying a pass is not the org taking a
    // paid registration, so the earn hook lives in confirmPaidRegistration, not
    // the pass webhook branch. Both writes are one-time and idempotent, so the
    // replay below adds nothing.
    await processStripeEvent(passEvent(session));
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);
    // A second delivery of the same payment is a replay, not a new purchase:
    // recordPassGrant's per-payment-intent idempotency key makes it a no-op.
    expect(await reconcilePassCheckout(orgId, "cs_grant_replay")).toBe(true);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);
  });

  it("a refunded duplicate second charge does NOT grant a second time", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);
    // First owner records the pass and earns the grant.
    stripeMock.retrieve.mockResolvedValue(
      // Run-unique for the same reason as the replay test above: a hardcoded
      // winning intent grants once per DATABASE, so the wallet reads 0 on
      // every re-run and this test accuses the code of a bug it does not have.
      passSession(orgId, compId, { payment_intent: "pi_grant_winner_" + uniq() }),
    );
    expect(await reconcilePassCheckout(orgId, "cs_grant_winner")).toBe(true);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);

    // A second owner pays for the SAME competition; the charge is refunded and
    // the wallet must NOT be credited again (a duplicate second charge is sent
    // back, never granted — recordPassPurchase's `if (!dup)` guard).
    await processStripeEvent(
      passEvent(passSession(orgId, compId, { payment_intent: "pi_grant_loser_" + uniq() })),
    );
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);
  });

  it("in a billing group the credits land in the shared group pool", async () => {
    // Two orgs sharing ONE subscription (a real billing group): walletIdFor
    // resolves both to the group's subscription id, so a pass bought by the
    // second org credits the pool the first org also spends from (SPEC-2 §11.1).
    const { orgId: payerOrg } = await seedPassBuyer();
    const [{ subscription_id }] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${payerOrg}`;
    const suffix = uniq();
    const [{ id: memberOrg }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, subscription_id)
      values (${"Group Member " + suffix}, ${"group-member-" + suffix}, ${subscription_id})
      returning id`;
    const [{ id: memberComp }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${memberOrg}, ${"Member Cup " + suffix}, ${"member-cup-" + suffix})
      returning id`;

    const groupWallet = await walletIdFor(memberOrg);
    expect(groupWallet).toBe(subscription_id);
    expect(await walletIdFor(payerOrg)).toBe(subscription_id);

    const res = await recordPassPurchase({
      orgId: memberOrg,
      competitionId: memberComp,
      paymentIntent: "pi_grant_group_" + uniq(),
    });
    expect(res.recorded).toBe(true);
    // The 25 lands in the ONE shared pool, visible from either org's walletId.
    expect(await balance(groupWallet)).toBe(PASS_CREDIT_GRANT);
    expect(await balance(await walletIdFor(payerOrg))).toBe(PASS_CREDIT_GRANT);
  });
});

// SPEC-2 §5 money-safety: revoking a pass (refund or lost dispute) must claw back
// its one-time credit grant, or the 25 credits stay after the entitlement is gone
// (~$6.25/cycle, farmable by cycling buy→refund). The sibling pack path already
// claws back; this closes the asymmetry. MONEY path — no double-claw, no
// below-zero, never touch credits the buyer already spent.
describe.skipIf(!HAS_DB)("Event Pass claws back its credits on refund/dispute", () => {
  it("a fully-refunded pass claws back the UNSPENT grant to 0", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);
    const intent = "pi_refund_" + uniq();

    expect((await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: intent })).recorded).toBe(true);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);

    expect(await revokePassForRefundedCharge(refundedCharge(intent))).toBe(true);
    // Nothing was spent, so the whole grant is clawed — wallet back to 0.
    expect(await balance(walletId)).toBe(0);
    expect(await packBalance(walletId)).toBe(0);
  });

  it("after spending 10 it claws only the 15 unspent — floors at 0, never negative, never touches the spent 10", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);
    const intent = "pi_partial_" + uniq();

    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: intent });
    // Consume 10 of the 25 (a real AI run's hold from the pack bucket).
    await reserve(walletId, orgId, 10);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT - 10); // 15 left

    expect(await revokePassForRefundedCharge(refundedCharge(intent))).toBe(true);
    // Claws only the 15 unspent; the 10 already consumed is gone (not retro-
    // charged), so the wallet floors at exactly 0 — never negative.
    expect(await balance(walletId)).toBe(0);
    expect(await packBalance(walletId)).toBe(0);
  });

  it("a lost dispute claws back the grant the same way", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);
    const intent = "pi_dispute_" + uniq();

    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: intent });
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);

    await processStripeEvent(disputeClosedEvent(intent, "lost"));
    expect(await balance(walletId)).toBe(0);
    // The pass entitlement is revoked too.
    const [pass] = await sql`select 1 from competition_passes where stripe_payment_intent = ${intent}`;
    expect(pass).toBeUndefined();
  });

  it("refund then dispute (or a double webhook) does NOT double-claw", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);
    const intent = "pi_dbl_" + uniq();

    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: intent });
    // First claw-back (refund) takes the wallet to 0.
    await revokePassForRefundedCharge(refundedCharge(intent));
    expect(await balance(walletId)).toBe(0);

    // A redelivered refund and a trailing lost dispute must each be a no-op —
    // the `pass_refund:${intent}` idempotency key already won. No below-zero.
    await revokePassForRefundedCharge(refundedCharge(intent));
    await processStripeEvent(disputeClosedEvent(intent, "lost"));
    expect(await balance(walletId)).toBe(0);
  });

  it("a genuine RE-purchase of the same competition re-grants after a refund", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const walletId = await walletIdFor(orgId);

    // Buy → refund: the pass row is deleted and its 25 clawed.
    await recordPassPurchase({ orgId, competitionId: compId, paymentIntent: "pi_first_" + uniq() });
    await revokePassForRefundedCharge(refundedCharge((await lastPassIntent(compId)) ?? ""));
    expect(await balance(walletId)).toBe(0);

    // Re-buy the SAME competition under a NEW payment intent — the grant is keyed
    // on the intent, not the competition, so this genuinely re-grants (MINOR-2).
    const second = await recordPassPurchase({
      orgId,
      competitionId: compId,
      paymentIntent: "pi_second_" + uniq(),
    });
    expect(second.recorded).toBe(true);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);
  });

  it("in a billing group the claw-back debits the shared group pool it credited", async () => {
    const { orgId: payerOrg } = await seedPassBuyer();
    const [{ subscription_id }] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${payerOrg}`;
    const suffix = uniq();
    const [{ id: memberOrg }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, subscription_id)
      values (${"Claw Member " + suffix}, ${"claw-member-" + suffix}, ${subscription_id})
      returning id`;
    const [{ id: memberComp }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${memberOrg}, ${"Claw Cup " + suffix}, ${"claw-cup-" + suffix})
      returning id`;
    const groupWallet = await walletIdFor(memberOrg);
    const intent = "pi_grp_" + uniq();

    await recordPassPurchase({ orgId: memberOrg, competitionId: memberComp, paymentIntent: intent });
    expect(await balance(groupWallet)).toBe(PASS_CREDIT_GRANT);

    expect(await revokePassForRefundedCharge(refundedCharge(intent))).toBe(true);
    // Debited from the ONE shared pool, visible from either org's walletId.
    expect(await balance(groupWallet)).toBe(0);
    expect(await balance(await walletIdFor(payerOrg))).toBe(0);
  });
});

/** The payment intent the pass row for `compId` currently carries — the anchor
 *  the refund path keys the claw-back on. */
async function lastPassIntent(compId: string): Promise<string | null> {
  const [row] = await sql<{ stripe_payment_intent: string | null }[]>`
    select stripe_payment_intent from competition_passes where competition_id = ${compId}`;
  return row?.stripe_payment_intent ?? null;
}
