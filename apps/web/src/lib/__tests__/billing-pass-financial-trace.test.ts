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
import { reconcilePassCheckout } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";

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
        payment_intent: "pi_winner",
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
          payment_intent: "pi_loser",
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
      payment_intent: "pi_replay",
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
