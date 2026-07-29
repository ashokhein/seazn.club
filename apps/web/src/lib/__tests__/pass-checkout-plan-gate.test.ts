// The pass-checkout route refuses a paid org — "Your plan already includes
// every Event Pass feature." It used to decide that from the raw
// `subscriptions.plan_key` column, which keeps saying 'pro' after a comp lapses
// or a subscription is cancelled. So a lapsed org was told its plan covered the
// pass when it no longer did, and was blocked from a purchase it was entitled to
// make. Task 21 then made the upgrade page render from `orgPlanKey`, which
// applies those read-time degradations — leaving a visible buy button that 400s.
//
// The route now judges eligibility through the same resolver as the page, so
// there is one answer to "is this org on a paid plan".
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn().mockResolvedValue({ client_secret: "cs_secret_test" });
  // v17 gap #326: the MINT guard reads the session's line items back off
  // Stripe. Its suite lives in this file for the reason the second describe
  // below spells out — one capture/restore of the global `plans` price ids.
  const listLineItems = vi.fn();
  const retrieve = vi.fn();
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test" });
  return {
    checkoutCreate,
    listLineItems,
    retrieve,
    refundCreate,
    stripe: {
      checkout: { sessions: { create: checkoutCreate, listLineItems, retrieve } },
      refunds: { create: refundCreate },
      paymentMethods: { list: vi.fn().mockResolvedValue({ data: [] }) },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// PARTIAL mock: lib/billing.ts and billing-events.ts import a dozen other
// senders from this module and a full replacement breaks them.
const emailMock = vi.hoisted(() => ({
  sendPassRungMismatchAlertEmail: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendPassRungMismatchAlertEmail: emailMock.sendPassRungMismatchAlertEmail,
}));

const authState = vi.hoisted(() => ({
  orgId: null as string | null,
  user: {
    id: "d0d0d0d0-0000-4000-8000-000000000009",
    display_name: "Gate Owner",
    email: "gate-owner@test.local",
    avatar_url: null,
    timezone: null as string | null,
    locale: null as string | null,
  },
}));
// The ONE export intercepted, and only while the flag is on: every other export
// stays REAL, so the mint-guard suite below still exercises the production
// `reconcilePassCheckout` / `passSessionRungMatchesPrice`. A full replacement
// would make that whole describe vacuous.
const billingState = vi.hoisted(() => ({ refusalReadThrows: false }));
vi.mock("@/lib/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing")>();
  return {
    ...actual,
    competitionHasRefusedPassPayment: async (competitionId: string) => {
      if (billingState.refusalReadThrows) {
        throw new Error('relation "pass_mint_refusals" does not exist');
      }
      return actual.competitionHasRefusedPassPayment(competitionId);
    },
  };
});

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getActiveOrgId: vi.fn(async () => authState.orgId),
  requireOrgRole: vi.fn(async () => ({ user: authState.user, role: "owner" as const })),
}));

import { sql } from "@/lib/db";
import { POST as passCheckoutPOST } from "@/app/api/billing/pass-checkout/route";
import { maybeAlertPassRungMismatch, reconcilePassCheckout } from "@/lib/billing";
import { passCheckoutErrorKey } from "@/lib/pass-ladder";
import { PASS_END_GRACE_DAYS } from "@/lib/entitlements";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { balance, walletIdFor } from "@/lib/credits";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrgWithComp(): Promise<{ orgId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Gate Org " + suffix}, ${"gate-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Gate Cup " + suffix}, ${"gate-cup-" + suffix}) returning id`;
  return { orgId, compId };
}

/** `seedOrgWithComp` plus the `subscriptions` row every org gets at creation,
 *  on the free plan — an org that is genuinely eligible to buy a pass, with
 *  `authState` already pointed at it. Module-scope (it was local to the #301
 *  describe) so the #353 suite below buys from the same fixture: a refusal is
 *  only meaningful against an org that could otherwise have bought. */
async function seedCommunityOrgWithComp(): Promise<{ orgId: string; compId: string }> {
  const { orgId, compId } = await seedOrgWithComp();
  await sql`with _owner as (
    insert into users (email, display_name, email_verified)
    values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
    returning id
  ),
  _seed_sub as (
    insert into subscriptions (owner_user_id, plan_key, status, currency)
    select coalesce(o.created_by, (select id from _owner)), 'community', 'active', 'usd' from organizations o where o.id = ${orgId}
    returning id
  )
  update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  authState.orgId = orgId;
  return { orgId, compId };
}

const req = (competitionId: string, body?: Record<string, unknown>) =>
  new Request("http://test.local/api/billing/pass-checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ competition_id: competitionId, ...body }),
  });

// `plans` is global; the route 503s without a one-time price id. Capture and
// restore it — the shared dev DB is the same database, and leaving a stub here
// breaks local Event Pass checkout for everyone (see billing-pass-duplicate).
let priorOnetime: string | null = null;
let captured = false;
// v17 #294: the L rung's one-time price is a SECOND global row this file now
// stubs, and it needs the same capture/restore discipline.
let priorOnetimeL: string | null = null;
let capturedL = false;

afterAll(async () => {
  if (!HAS_DB) return;
  if (captured) {
    await sql`update plans set stripe_price_id_onetime = ${priorOnetime}
              where key = 'event_pass'`;
  }
  if (capturedL) {
    await sql`update plans set stripe_price_id_onetime = ${priorOnetimeL}
              where key = 'event_pass_l'`;
  }
});

beforeEach(() => {
  stripeMock.checkoutCreate.mockClear();
  stripeMock.listLineItems.mockClear();
  stripeMock.retrieve.mockClear();
  stripeMock.refundCreate.mockClear();
  emailMock.sendPassRungMismatchAlertEmail.mockClear();
  billingState.refusalReadThrows = false;
});

/** Stub M's one-time price id, capturing the real one first. `price_test_pass`
 *  is the literal the sibling pass-checkout suites use too, so a concurrent
 *  worker writing the same global row writes the same value. */
const givePrice = async () => {
  if (!captured) {
    const [prior] = await sql<{ id: string | null }[]>`
      select stripe_price_id_onetime as id from plans where key = 'event_pass'`;
    priorOnetime = prior?.id ?? null;
    captured = true;
  }
  await sql`update plans set stripe_price_id_onetime = 'price_test_pass'
            where key = 'event_pass'`;
};

/** Same for L (v17 #294). `null` models an environment where `stripe:sync` has
 *  not pushed the rung's price yet. */
const giveLPrice = async (priceId: string | null) => {
  if (!capturedL) {
    const [prior] = await sql<{ id: string | null }[]>`
      select stripe_price_id_onetime as id from plans where key = 'event_pass_l'`;
    priorOnetimeL = prior?.id ?? null;
    capturedL = true;
  }
  await sql`update plans set stripe_price_id_onetime = ${priceId}
            where key = 'event_pass_l'`;
};

describe.skipIf(!HAS_DB)("pass-checkout eligibility uses the resolver, not raw plan_key", () => {

  it("lets an org whose COMP HAS LAPSED buy a pass, though plan_key still says pro", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await givePrice();
    // The row still reads 'pro'. `comped_until` is in the past, so the resolver
    // degrades the org to community — and a community org may buy a pass.
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency, comped_until)
      select coalesce(o.created_by, (select id from _owner)), 'pro', 'active', 'usd', now() - interval '1 day' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(200);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("still refuses an org on a genuinely live paid plan", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await givePrice();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'pro', 'active', 'usd' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(400);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("still lets a plain community org buy", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await givePrice();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active', 'usd' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(200);
  });
});

// v17 #294 — the route must buy the rung the caller ASKED for. Before this it
// hardcoded `where key = 'event_pass'` for the price AND `pass_key: "event_pass"`
// in the session metadata, so L was unbuyable; and had either half been widened
// without the other, the buyer would be charged one rung's price and entitled to
// the other's caps.
//
// Lives in this file rather than its own so it shares ONE capture/restore of the
// global `plans` price ids: vitest runs files in parallel workers, and a second
// file stubbing the same rows races this one.
describe.skipIf(!HAS_DB)("pass-checkout buys the rung it was asked for (v17 #294)", () => {
  /** A community org with a competition, eligible to buy either rung. The
   *  subscription's `currency` is not decoration: without it preferredCurrency
   *  falls through to next/headers `cookies()`, which throws outside a request
   *  scope and 500s the route. */
  const seedBuyer = async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('rungowner-' || gen_random_uuid() || '@test.local', 'Rung Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active', 'usd'
        from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    authState.orgId = orgId;
    // Both rungs priced, with DISTINCT ids — identical stubs would pass against
    // the old hardcoded lookup and prove nothing.
    await givePrice();
    await giveLPrice("price_test_pass_l");
    return { orgId, compId };
  };

  const createdParams = (n = 0) =>
    stripeMock.checkoutCreate.mock.calls[n]![0] as Stripe.Checkout.SessionCreateParams;
  const createdKey = (n = 0) =>
    (stripeMock.checkoutCreate.mock.calls[n]![1] as { idempotencyKey: string }).idempotencyKey;

  it("defaults to M when the body names no rung (every pre-#294 client)", async () => {
    const { compId } = await seedBuyer();

    expect((await passCheckoutPOST(req(compId))).status).toBe(200);
    expect(createdParams().line_items).toEqual([{ price: "price_test_pass", quantity: 1 }]);
    expect(createdParams().metadata).toMatchObject({ pass_key: "event_pass" });
  });

  it("buys L off L's own price id and stamps L into the metadata", async () => {
    const { orgId, compId } = await seedBuyer();

    expect((await passCheckoutPOST(req(compId, { pass_key: "event_pass_l" }))).status).toBe(200);
    // Price and metadata must move TOGETHER: L's price with M's metadata charges
    // $59 for M's caps, and the reverse charges $29 for L's.
    expect(createdParams().line_items).toEqual([{ price: "price_test_pass_l", quantity: 1 }]);
    expect(createdParams().metadata).toEqual({
      org_id: orgId,
      competition_id: compId,
      pass_key: "event_pass_l",
    });
    // The buyer's invoice names the rung too — both rungs otherwise render as
    // identical lines on the billing page, differing only in amount.
    expect(createdParams().invoice_creation?.invoice_data?.description).toMatch(/^Event Pass L — /);
  });

  it("503s on a rung whose price has not reached this environment yet", async () => {
    const { compId } = await seedBuyer();
    // stripe:sync has not been run here, so L has no one-time price id. Falling
    // back to M's would charge $29 for L's caps.
    await giveLPrice(null);

    expect((await passCheckoutPOST(req(compId, { pass_key: "event_pass_l" }))).status).toBe(503);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("rejects a rung that is not a pass key at all", async () => {
    const { compId } = await seedBuyer();

    for (const bogus of ["event_pass_xl", "pro", ""]) {
      const res = await passCheckoutPOST(req(compId, { pass_key: bogus }));
      expect(res.status, `pass_key=${JSON.stringify(bogus)} must not be accepted`).toBe(400);
    }
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("scopes the idempotency key by rung, so switching M→L mints a NEW session", async () => {
    const { compId } = await seedBuyer();

    await passCheckoutPOST(req(compId, { pass_key: "event_pass" }));
    // The same owner changes their mind before completing checkout. Without the
    // rung in the key, Stripe sees a key reuse with DIFFERENT params (a different
    // price) and 400s — the buyer is stuck on the rung they first clicked.
    await passCheckoutPOST(req(compId, { pass_key: "event_pass_l" }));

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(createdKey(0)).not.toBe(createdKey(1));
    expect(createdKey(0).endsWith("-event_pass")).toBe(true);
    expect(createdKey(1).endsWith("-event_pass_l")).toBe(true);
  });
});


// v17 gap #326 — the MINT guard. The suite above proves the checkout ROUTE
// builds a session whose price and metadata agree. Nothing checked it again
// after the sale: both mint paths (reconcilePassCheckout and the webhook) took
// the rung from `session.metadata.pass_key` and never compared it against the
// price the buyer was actually charged. A desync — a stale `stripe:sync`, a
// price id edited in the Dashboard, a future third rung wired to the wrong
// lookup key — therefore produced a customer who paid $29 and held the $59 rung
// (or the reverse) with no error, no failing test and nothing in the data to
// find it by afterwards. The two witnesses that DO catch it
// (e2e/event-pass.spec.ts and pass-checkout-l.live.test.ts) are both opt-in and
// neither runs in CI, and both look only BEFORE the sale.
//
// Lives in THIS file for the same reason the rung suite does: it stubs the
// global `plans.stripe_price_id_onetime` rows, and vitest runs files in
// parallel workers, so a second file stubbing them races this one.
describe.skipIf(!HAS_DB)("Event Pass mint refuses a rung/price desync (v17 gap #326)", () => {
  /** A community org + competition + the `subscriptions` row every org gets at
   *  creation (lib/auth.ts). A raw `insert into organizations` does not make
   *  one, and the wallet the pass credit lands in is that row. */
  const seedMintBuyer = async (): Promise<{ orgId: string; compId: string }> => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('mintowner-' || gen_random_uuid() || '@test.local', 'Mint Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active', 'usd'
        from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    return { orgId, compId };
  };

  /** A PAID pass session as either mint path sees it. `id` is load-bearing here
   *  (unlike the older pass fixtures): the guard reads the line items back BY
   *  session id. `customer: null` keeps linkStripeCustomer out of the way —
   *  this suite is about what is minted, not the money trace.
   *
   *  `passKey` is a raw string, not `PassKey`: two tests below feed the gate a
   *  rung it does NOT recognise, which is the whole point of them. */
  const paidSession = (
    orgId: string,
    compId: string,
    passKey: string,
    over?: { lineItems?: Stripe.LineItem[] },
  ): Stripe.Checkout.Session =>
    ({
      id: "cs_mint_" + randomUUID().slice(0, 8),
      metadata: { org_id: orgId, competition_id: compId, pass_key: passKey },
      payment_status: "paid",
      payment_intent: "pi_mint_" + randomUUID().slice(0, 8),
      customer: null,
      currency: "usd",
      ...(over?.lineItems ? { line_items: { data: over.lineItems } } : {}),
    }) as unknown as Stripe.Checkout.Session;

  const passEvent = (session: Stripe.Checkout.Session) =>
    ({ type: "checkout.session.completed", data: { object: session } }) as unknown as Stripe.Event;

  const lineItem = (priceId: string, lookupKey?: string) =>
    ({ price: { id: priceId, lookup_key: lookupKey ?? null } }) as unknown as Stripe.LineItem;

  /** What Stripe reports the session was actually BUILT ON, for the FETCHING
   *  path (the webhook, whose session comes off an event payload). */
  const builtOn = (priceId: string, lookupKey?: string) =>
    stripeMock.listLineItems.mockResolvedValue({ data: [lineItem(priceId, lookupKey)] });

  const passKeyHeld = async (compId: string): Promise<string | null> => {
    const [row] = await sql<{ pass_key: string }[]>`
      select pass_key from competition_passes where competition_id = ${compId}`;
    return row?.pass_key ?? null;
  };

  const refusalFor = async (compId: string) => {
    const [row] = await sql<
      {
        stripe_ref: string;
        session_id: string;
        pass_key: string;
        reason: string;
        expected_price_id: string | null;
        actual_price_id: string | null;
      }[]
    >`select stripe_ref, session_id, pass_key, reason, expected_price_id, actual_price_id
        from pass_mint_refusals where competition_id = ${compId}`;
    return row ?? null;
  };

  /** Both rungs priced, with DISTINCT ids — identical stubs would let a guard
   *  that compares nothing look correct. */
  const priceBothRungs = async () => {
    await givePrice(); // event_pass -> 'price_test_pass'
    await giveLPrice("price_test_pass_l");
  };

  // STAFF_ALERT_EMAIL is the first thing every alert wrapper in this codebase
  // checks, so it must be SET for the alert assertions to mean anything — and
  // restored afterwards, because it is process-wide.
  let priorAlertTo: string | undefined;
  const withAlertAddress = () => {
    priorAlertTo = process.env.STAFF_ALERT_EMAIL;
    process.env.STAFF_ALERT_EMAIL = "ops@test.local";
  };
  const restoreAlertAddress = () => {
    if (priorAlertTo === undefined) delete process.env.STAFF_ALERT_EMAIL;
    else process.env.STAFF_ALERT_EMAIL = priorAlertTo;
  };

  it("reconcile MINTS when the price paid IS the rung's own price", async () => {
    // The positive discriminator this whole describe rests on: without it, a
    // guard that refused every purchase outright would pass every other test
    // here. It also pins the SILENCE — no console.error, no staff alert, no
    // refusal row — because "did not mint" and "minted quietly" are the two
    // outcomes the negative tests must be told apart from.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = paidSession(orgId, compId, "event_pass_l", {
        lineItems: [lineItem("price_test_pass_l")],
      });
      stripeMock.retrieve.mockResolvedValue(session);

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
      expect(await balance(await walletIdFor(orgId))).toBe(PASS_CREDIT_GRANT);
      expect(await refusalFor(compId)).toBeNull();
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("reconcile reads the EXPANDED line items and never asks Stripe a second time", async () => {
    // The reconcile path re-runs on every render of the bookmarkable
    // `?checkout=success&session_id=` URL, so a second round trip here is paid
    // per VISIT, not per sale. `retrieve` expands line_items; the guard must use
    // them. `listLineItems` is stubbed to a MISMATCH, so if the guard fetched
    // anyway this would refuse — the assertion is not a restatement of the spy.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    builtOn("price_wrong_entirely");
    const session = paidSession(orgId, compId, "event_pass", {
      lineItems: [lineItem("price_test_pass")],
    });
    stripeMock.retrieve.mockResolvedValue(session);

    expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
    expect(await passKeyHeld(compId)).toBe("event_pass");
    expect(stripeMock.listLineItems).not.toHaveBeenCalled();
    expect(stripeMock.retrieve.mock.calls[0]![1]).toEqual({ expand: ["line_items"] });
  });

  it("reconcile REFUSES, records a row, grants nothing and alerts when the price is the OTHER rung's", async () => {
    // The exact state the W5 review reproduced: the checkout route resolved M's
    // price while stamping L into the metadata. Minting would hand out $59 caps
    // for a $29 charge.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = paidSession(orgId, compId, "event_pass_l", {
        lineItems: [lineItem("price_test_pass")], // M's price, L's metadata
      });
      stripeMock.retrieve.mockResolvedValue(session);

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(false);
      // No pass at ANY rung — minting the cheaper one would still be a guess.
      expect(await passKeyHeld(compId)).toBeNull();
      // ...and no credits either: the +25 rides recordPassPurchase, which never ran.
      expect(await balance(await walletIdFor(orgId))).toBe(0);
      // Not silently swallowed as a refund, either — the charge stands and a
      // human decides.
      expect(stripeMock.refundCreate).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();

      // THE DURABLE RECORD, keyed on the payment intent. A lost alert must not
      // be the difference between a traceable incident and none — and this row
      // is also the brake the checkout route reads.
      expect(await refusalFor(compId)).toMatchObject({
        stripe_ref: session.payment_intent,
        session_id: session.id,
        pass_key: "event_pass_l",
        reason: "price_mismatch",
        expected_price_id: "price_test_pass_l",
        actual_price_id: "price_test_pass",
      });

      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);
      expect(emailMock.sendPassRungMismatchAlertEmail.mock.calls[0]![0]).toMatchObject({
        to: "ops@test.local",
        sessionId: session.id,
        orgId,
        competitionId: compId,
        passKey: "event_pass_l",
        reason: "price_mismatch",
        expectedPriceId: "price_test_pass_l",
        actualPriceId: "price_test_pass",
        paymentIntent: session.payment_intent,
      });
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("a refused buyer CANNOT be charged again, until staff resolve it", async () => {
    // The finding that mattered most in review: the route's repeat guard reads
    // `competition_passes`, a refusal writes no such row, so one desync could
    // charge one customer once per attempt for ever.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    authState.orgId = orgId;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Sanity: this competition IS sellable before the refusal, or the 409
      // below would prove nothing about the refusal.
      expect((await passCheckoutPOST(req(compId))).status).toBe(200);
      stripeMock.checkoutCreate.mockClear();

      const session = paidSession(orgId, compId, "event_pass_l", {
        lineItems: [lineItem("price_test_pass")],
      });
      stripeMock.retrieve.mockResolvedValue(session);
      expect(await reconcilePassCheckout(orgId, session.id)).toBe(false);

      const refused = await passCheckoutPOST(req(compId));
      expect(refused.status).toBe(409);
      // 409 and not the "already has a pass" 400: the two have opposite
      // remedies, and passCheckoutErrorKey turns this one into copy that does
      // not tell an already-charged buyer to reload and try again.
      expect(passCheckoutErrorKey(409)).toBe("upgrade.buyError.underReview");
      expect(passCheckoutErrorKey(409)).not.toBe(passCheckoutErrorKey(400));
      // Nothing was opened at Stripe — the brake is before the session create.
      expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();

      // ...and it lifts the moment staff resolve it, with no code change.
      await sql`update pass_mint_refusals set resolved_at = now()
                 where competition_id = ${compId}`;
      expect((await passCheckoutPOST(req(compId))).status).toBe(200);
    } finally {
      errors.mockRestore();
    }
  });

  it("refuses and records a session that does not carry exactly one line item", async () => {
    // NOT lumped in with the transient-Stripe-failure fail-open. A session with
    // zero or two lines does not have the shape buildPassCheckoutParams
    // produces, which is the same desync class the guard exists for — and the
    // alert email already had a "(no line item)" rendering with no branch that
    // could reach it.
    for (const [label, items] of [
      ["none", [] as Stripe.LineItem[]],
      ["two", [lineItem("price_test_pass"), lineItem("price_test_pass_l")]],
    ] as const) {
      const { orgId, compId } = await seedMintBuyer();
      await priceBothRungs();
      withAlertAddress();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const session = paidSession(orgId, compId, "event_pass", { lineItems: [...items] });
        stripeMock.retrieve.mockResolvedValue(session);
        // `line_items` present but empty must still take the expanded path, not
        // fall through to a fetch that would answer something else.
        builtOn("price_test_pass");

        expect(await reconcilePassCheckout(orgId, session.id), label).toBe(false);
        expect(await passKeyHeld(compId), label).toBeNull();
        expect(await refusalFor(compId), label).toMatchObject({
          reason: "line_items",
          expected_price_id: "price_test_pass",
          actual_price_id: null,
        });
        expect(
          emailMock.sendPassRungMismatchAlertEmail.mock.calls.at(-1)![0],
          label,
        ).toMatchObject({ reason: "line_items", actualPriceId: null });
      } finally {
        errors.mockRestore();
        restoreAlertAddress();
        emailMock.sendPassRungMismatchAlertEmail.mockClear();
      }
    }
  });

  it("accepts a price id that MOVED, when its lookup_key still names the rung", async () => {
    // The false positive a routine deploy would otherwise cause: the route
    // resolves the price at session-create time and this runs at mint time, so a
    // `stripe:sync` that re-mints a rung's price in between would refuse every
    // in-flight session — charging those buyers and minting nothing, which is
    // the exact outcome the guard exists to prevent. transfer_lookup_key moves
    // `seazn_event_pass` onto the replacement, so the lookup key is the rung's
    // durable identity.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    try {
      const session = paidSession(orgId, compId, "event_pass", {
        lineItems: [lineItem("price_REMINTED_by_sync", "seazn_event_pass")],
      });
      stripeMock.retrieve.mockResolvedValue(session);

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
      expect(await passKeyHeld(compId)).toBe("event_pass");
      expect(await refusalFor(compId)).toBeNull();
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();
    } finally {
      restoreAlertAddress();
    }
  });

  it("refuses a moved price id carrying the OTHER rung's lookup_key", async () => {
    // The discriminator for the acceptance above: it must key on THIS rung, not
    // on "has a lookup_key". Without this, a session built on L's replacement
    // price under M's metadata would sail through.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = paidSession(orgId, compId, "event_pass", {
        lineItems: [lineItem("price_REMINTED_L", "seazn_event_pass_l")],
      });
      stripeMock.retrieve.mockResolvedValue(session);

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(false);
      expect(await refusalFor(compId)).toMatchObject({ reason: "price_mismatch" });
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("keeps passKeyForSession's M fallback where it is TRUE, and refuses where it is not", async () => {
    // The two halves of one policy, which read as contradictory until both are
    // pinned (review finding 3). An unrecognised `pass_key` still falls back to
    // M — and that fallback now has to survive the guard.
    const good = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Built on M's price: the robustness net works exactly as documented.
      const ok = paidSession(good.orgId, good.compId, "event_pass_xl", {
        lineItems: [lineItem("price_test_pass")],
      });
      stripeMock.retrieve.mockResolvedValue(ok);
      expect(await reconcilePassCheckout(good.orgId, ok.id)).toBe(true);
      expect(await passKeyHeld(good.compId)).toBe("event_pass");
      expect(await refusalFor(good.compId)).toBeNull();

      // Built on anything else: filing a $59 charge under the $29 rung is not
      // "leaving the buyer entitled", it is under-delivering silently.
      const bad = await seedMintBuyer();
      const no = paidSession(bad.orgId, bad.compId, "event_pass_xl", {
        lineItems: [lineItem("price_test_pass_l")],
      });
      stripeMock.retrieve.mockResolvedValue(no);
      expect(await reconcilePassCheckout(bad.orgId, no.id)).toBe(false);
      expect(await passKeyHeld(bad.compId)).toBeNull();
      expect(await refusalFor(bad.compId)).toMatchObject({ pass_key: "event_pass" });
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("the WEBHOOK mints on a match and refuses the same desync (one guard, two paths)", async () => {
    // Both mint paths, or the guard is a hole wearing a fix: reconcile-on-return
    // usually lands first, but the webhook is the path that runs when the buyer
    // closes the tab. Its session comes off an EVENT payload with no expansion,
    // so it exercises the fetching fallback rather than `session.line_items`.
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ok = await seedMintBuyer();
      builtOn("price_test_pass");
      await processStripeEvent(passEvent(paidSession(ok.orgId, ok.compId, "event_pass")));
      expect(await passKeyHeld(ok.compId)).toBe("event_pass");
      expect(stripeMock.listLineItems).toHaveBeenCalled();
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();

      const bad = await seedMintBuyer();
      builtOn("price_test_pass"); // M's price under L's metadata again
      // ACKs rather than throwing: nothing here is retryable into a better
      // outcome, and a webhook that threw would retry for ever.
      await expect(
        processStripeEvent(passEvent(paidSession(bad.orgId, bad.compId, "event_pass_l"))),
      ).resolves.toBeUndefined();
      expect(await passKeyHeld(bad.compId)).toBeNull();
      expect(await balance(await walletIdFor(bad.orgId))).toBe(0);
      expect(await refusalFor(bad.compId)).toMatchObject({ reason: "price_mismatch" });
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("MINTS unverified, without calling Stripe, when the rung has no configured price", async () => {
    // The deliberate fail-open. Every environment `stripe:sync` has not been run
    // against — including this test database by default — has a NULL
    // stripe_price_id_onetime, and refusing there would break every pass
    // purchase to close an internal-only desync. Checked BEFORE any Stripe call,
    // so the common unconfigured case costs one indexed read.
    const { orgId, compId } = await seedMintBuyer();
    await givePrice();
    await giveLPrice(null);
    withAlertAddress();
    try {
      // Stubbed to a price that MISMATCHES on purpose: had the guard compared at
      // all it would have refused, so `toBe(true)` below is a real discriminator
      // rather than a restatement of `not.toHaveBeenCalled()`.
      const session = paidSession(orgId, compId, "event_pass_l", {
        lineItems: [lineItem("price_that_would_mismatch")],
      });
      stripeMock.retrieve.mockResolvedValue(session);
      builtOn("price_that_would_mismatch");

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
      expect(stripeMock.listLineItems).not.toHaveBeenCalled();
      expect(await refusalFor(compId)).toBeNull();
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();
    } finally {
      restoreAlertAddress();
    }
  });

  it("mints unverified when the line-item READ fails, and catches it on the next good read", async () => {
    // The one arm that still fails open silently: a Stripe read that THREW says
    // nothing about the session, and converting a transient outage into a
    // non-purchase is a far bigger harm than the internal desync being guarded.
    //
    // It is not "silent for ever", though, and that is what makes leaving it
    // alone defensible rather than lazy: the guard runs BEFORE recordPassPurchase
    // on BOTH mint paths and is not skipped once a pass exists, so the first
    // successful read afterwards — the buyer revisiting the bookmarkable return
    // URL, or the webhook landing — does the comparison and records it. This
    // test is that whole sequence, because "it self-corrects" is a claim about
    // behaviour and belongs in a test rather than in a comment.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // No expanded items, and the fetch fails.
      const session = paidSession(orgId, compId, "event_pass_l");
      stripeMock.retrieve.mockResolvedValue(session);
      stripeMock.listLineItems.mockRejectedValueOnce(new Error("stripe is down"));

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
      // Logged, but nothing durable and nobody alerted — the deliberate gap.
      expect(errors).toHaveBeenCalled();
      expect(await refusalFor(compId)).toBeNull();
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();

      // Stripe comes back. The SAME session is re-read on the next visit to the
      // return URL, the comparison finally happens, and the desync is recorded
      // and alerted even though the pass is already minted.
      builtOn("price_test_pass");
      expect(await reconcilePassCheckout(orgId, session.id)).toBe(false);
      expect(await refusalFor(compId)).toMatchObject({ reason: "price_mismatch" });
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);
      // The pass STAYS — it is already live and the buyer is entitled to
      // whatever was minted; this second pass is a detector, not a revoker.
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("the WEBHOOK self-corrects the same way, which is the half that matters", async () => {
    // The load-bearing half (#326 review round 3). In the scenario the
    // fail-open exists for — a buyer who never returns to the bookmarkable URL —
    // reconcile never runs again, so the webhook is the ONLY path that can ever
    // do the comparison. An "already minted, skip the Stripe call" fast path in
    // front of the guard is exactly the plausible future optimisation that would
    // silently kill it, and it would leave the reconcile-side test green.
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { orgId, compId } = await seedMintBuyer();
      const session = paidSession(orgId, compId, "event_pass_l");
      // Delivery 1: Stripe read fails, so the rung cannot be verified.
      stripeMock.listLineItems.mockRejectedValueOnce(new Error("stripe is down"));
      await processStripeEvent(passEvent(session));
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
      expect(await refusalFor(compId)).toBeNull();
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();

      // Delivery 2 (a redelivery, or the next event carrying this session):
      // Stripe answers, the guard finally compares, and the desync is recorded.
      builtOn("price_test_pass");
      await expect(processStripeEvent(passEvent(session))).resolves.toBeUndefined();
      expect(await refusalFor(compId)).toMatchObject({ reason: "price_mismatch" });
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);
      // Detector, not revoker — same rule as the reconcile path above.
      expect(await passKeyHeld(compId)).toBe("event_pass_l");
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("does NOT sell when the refusal brake cannot be read at all", async () => {
    // The route's read of `pass_mint_refusals` is deliberately UNWRAPPED, and
    // until now that was prose in a comment: wrapping it `.catch(() => false)`
    // left every suite in the repo green, because only two files reference the
    // function at all. That mutation re-opens the round-1 defect verbatim — a
    // buyer whose refusal row is merely UNREADABLE becomes chargeable again.
    //
    // Pinned BEHAVIOURALLY rather than by scanning the source for `.catch`,
    // because the contract is "an unreadable brake must not sell", not "this
    // expression has no catch". A source scan would red on a future
    // `catch → throw 409`, which is a BETTER implementation of the same
    // contract, and would stay green if someone moved the check after
    // `sessions.create` — passing for the shape while the behaviour was broken.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    authState.orgId = orgId;

    // Baseline first: this competition is genuinely sellable, so the refusal
    // below is what changes the answer — not a fixture that could never buy.
    expect((await passCheckoutPOST(req(compId))).status).toBe(200);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    stripeMock.checkoutCreate.mockClear();

    billingState.refusalReadThrows = true;
    const res = await passCheckoutPOST(req(compId));
    // The status is not the point and is not pinned to 500 — a future
    // `catch → 409` would be fine. What must hold is that no charge is opened.
    expect(res.status).not.toBe(200);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("emails staff ONCE however many times the buyer reloads the return URL", async () => {
    // Measured before the fix: five reconciles produced one row and FIVE emails.
    // The return URL is bookmarkable and re-runs reconcile on every render, and
    // the buyer is looking at a banner that has just told them something is
    // wrong — which is an invitation to refresh. One incident must page staff
    // once, or the channel stops being read.
    const { orgId, compId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = paidSession(orgId, compId, "event_pass_l", {
        lineItems: [lineItem("price_test_pass")],
      });
      stripeMock.retrieve.mockResolvedValue(session);

      for (let i = 0; i < 5; i++) {
        expect(await reconcilePassCheckout(orgId, session.id), `visit ${i}`).toBe(false);
      }
      // The row was always deduped; the alert is what was not.
      const rows = await sql<{ n: string }[]>`
        select count(*)::text as n from pass_mint_refusals where competition_id = ${compId}`;
      expect(rows[0]!.n).toBe("1");
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);
      // ...and the refusal itself is unchanged on every visit — the dedupe must
      // quieten the email, not weaken the guard.
      expect(await passKeyHeld(compId)).toBeNull();
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("still alerts EVERY time when the row could not be written", async () => {
    // The documented "degrades to alert-only" path, and the discriminator for
    // the dedupe above: gating the alert on `inserted` alone would silence the
    // one case where the email is the only record that will ever exist. A
    // non-uuid competition id in the metadata fails the insert's cast — caught,
    // logged, and the incident still has to reach a human.
    const { orgId } = await seedMintBuyer();
    await priceBothRungs();
    withAlertAddress();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = paidSession(orgId, "not-a-uuid", "event_pass_l", {
        lineItems: [lineItem("price_test_pass")],
      });
      stripeMock.retrieve.mockResolvedValue(session);

      expect(await reconcilePassCheckout(orgId, session.id)).toBe(false);
      expect(await reconcilePassCheckout(orgId, session.id)).toBe(false);
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(2);
      expect(emailMock.sendPassRungMismatchAlertEmail.mock.calls[0]![0]).toMatchObject({
        competitionId: "not-a-uuid",
      });
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });

  it("the alert is gated on STAFF_ALERT_EMAIL and can never throw at its caller", async () => {
    // The contract every maybeAlert* in this codebase carries, tested DIRECTLY
    // rather than through a caller's catch — which would hide a missing wrapper.
    const opts = {
      sessionId: "cs_alert_probe",
      orgId: "org-probe",
      competitionId: "comp-probe",
      passKey: "event_pass_l" as const,
      reason: "price_mismatch" as const,
      expectedPriceId: "price_test_pass_l",
      actualPriceId: "price_test_pass",
      paymentIntent: "pi_probe",
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    priorAlertTo = process.env.STAFF_ALERT_EMAIL;
    try {
      delete process.env.STAFF_ALERT_EMAIL;
      await maybeAlertPassRungMismatch(opts);
      expect(emailMock.sendPassRungMismatchAlertEmail).not.toHaveBeenCalled();
      // The absence above is only meaningful against a positive: the SAME call
      // with an address configured does send.
      process.env.STAFF_ALERT_EMAIL = "ops@test.local";
      await maybeAlertPassRungMismatch(opts);
      expect(emailMock.sendPassRungMismatchAlertEmail).toHaveBeenCalledTimes(1);

      // A dead mailbox must never be what fails a mint the buyer already paid
      // for — and the swallow must be visible in the log, not silent.
      emailMock.sendPassRungMismatchAlertEmail.mockRejectedValueOnce(new Error("mailbox down"));
      await expect(maybeAlertPassRungMismatch(opts)).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      restoreAlertAddress();
    }
  });
});

describe.skipIf(!HAS_DB)("pass-checkout refuses a re-buy truthfully, locked or not", () => {
  // v17 gap #301. The refusal said "This competition already HAS an Event
  // Pass." — present tense, and false the moment the pass locks. A buyer whose
  // competition had finished was told by the checkout that they hold something
  // the upgrade page had just told them had ended, with no way to square the
  // two. The rule itself never changes (decision #248 Q4: one pass per
  // competition, forever), so the sentence is now true in BOTH states rather
  // than branching — and these two cases pin exactly that.
  //
  // The fixture moved to module scope so the #353 suite below shares it.

  it("refuses a re-buy on an ACTIVE pass, without claiming present-tense possession", async () => {
    const { compId, orgId } = await seedCommunityOrgWithComp();
    await givePrice();
    await sql`insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId})`;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/on file/i);
    expect(body.error).toMatch(/one-time/i);
    // The exact sentence this replaced, pinned so a revert is loud.
    expect(body.error).not.toBe("This competition already has an Event Pass.");
  });

  it("refuses a re-buy on an ENDED pass with the very same sentence", async () => {
    // A completed competition: `passLockReason` returns "terminal" and every
    // display surface now says the pass has ended. The checkout must still
    // refuse — and must not start describing the pass differently from the
    // page the buyer just came from.
    const { compId, orgId } = await seedCommunityOrgWithComp();
    await givePrice();
    await sql`update competitions set status = 'completed' where id = ${compId}`;
    await sql`insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId})`;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/on file/i);
    expect(body.error).toMatch(/one-time/i);
  });

  it("gives the two states the identical refusal, not two different stories", async () => {
    const live = await seedCommunityOrgWithComp();
    await givePrice();
    await sql`insert into competition_passes (competition_id, org_id) values (${live.compId}, ${live.orgId})`;
    const liveBody = await (await passCheckoutPOST(req(live.compId))).json();

    const ended = await seedCommunityOrgWithComp();
    await sql`update competitions set status = 'completed' where id = ${ended.compId}`;
    await sql`insert into competition_passes (competition_id, org_id) values (${ended.compId}, ${ended.orgId})`;
    const endedBody = await (await passCheckoutPOST(req(ended.compId))).json();

    expect(endedBody.error).toBe(liveBody.error);
  });
});

// v17 gap #353 — an Event Pass could be SOLD for a competition the lock rule
// had already ended.
//
// The route read `slug, name, org_id` and nothing else, so a FIRST purchase was
// never judged against `status`/`ends_on`. The money landed, the pass minted,
// and every surface in the product said "Event Pass ended" the same second —
// and on the terminal arm the buyer could not even try again, because decision
// #248 Q4 (one pass per competition, forever, enforced by the
// `competition_passes` PK) means there is no second purchase to make. They lost
// the $29/$59 AND their one chance at it.
//
// Dates are written as explicit UTC CALENDAR strings, derived from the UTC
// getters rather than from a local-midnight `new Date(...)`: the grace boundary
// is a date-only comparison against the UTC day, and a local-midnight date sits
// hours off it — exactly where `<` and `<=` become indistinguishable.
describe.skipIf(!HAS_DB)("pass-checkout refuses a competition that has already ended (#353)", () => {
  /** The UTC calendar date `offsetDays` from today, as 'YYYY-MM-DD'. */
  const utcDay = (offsetDays: number): string => {
    const now = new Date();
    const dayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return new Date(dayMs + offsetDays * 86_400_000).toISOString().slice(0, 10);
  };

  /** Did the route mint anything? A refusal that still wrote the row would be
   *  the same defect with a different status code. */
  const passExists = async (compId: string): Promise<boolean> => {
    const rows = await sql<{ competition_id: string }[]>`
      select competition_id from competition_passes where competition_id = ${compId}`;
    return rows.length > 0;
  };

  it("410s a LIVE competition whose end date is past the grace window", async () => {
    // Still 'live' — the organiser never marked it completed. Only the date has
    // moved, which is the arm a status-only filter misses entirely, and the one
    // that is RECOVERABLE (moving the end date makes the pass buyable again).
    const { compId } = await seedCommunityOrgWithComp();
    await givePrice();
    await sql`update competitions set ends_on = ${utcDay(-(PASS_END_GRACE_DAYS + 1))}
               where id = ${compId}`;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(410);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    expect(await passExists(compId)).toBe(false);
    // The buyer reads a localised sentence, never the server's English. 410 is
    // its OWN arm and not the generic 4xx "reload and try again", which would be
    // a confident lie: reloading an ended competition changes nothing.
    expect(passCheckoutErrorKey(410)).toBe("upgrade.buyError.ended");
    expect(passCheckoutErrorKey(410)).not.toBe(passCheckoutErrorKey(400));
  });

  it("410s an ARCHIVED competition — the arm the buyer can never recover from", async () => {
    const { compId } = await seedCommunityOrgWithComp();
    await givePrice();
    await sql`update competitions set status = 'archived' where id = ${compId}`;

    const res = await passCheckoutPOST(req(compId));
    expect(res.status).toBe(410);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    expect(await passExists(compId)).toBe(false);
  });

  it("still SELLS a competition sitting exactly on the grace boundary", async () => {
    // ends_on + grace landing ON today is still applying (`passLockReason`'s
    // strictly-less `<`). The discriminator for both refusals above: a gate that
    // simply refused anything with an `ends_on` in the past would pass them and
    // would stop selling passes for every competition in its final week.
    const { compId } = await seedCommunityOrgWithComp();
    await givePrice();
    await sql`update competitions set ends_on = ${utcDay(-PASS_END_GRACE_DAYS)}
               where id = ${compId}`;

    expect((await passCheckoutPOST(req(compId))).status).toBe(200);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });
});
